"""Project membership follows account identities without copying chat content."""
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.account_conversation_models import AccountConversation, ConversationProject
from app.conversation_handoff_models import ConversationHandoff
from app.api import conversation_projects
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, Task
from app.services import client_domain_events


class ConversationProjectsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await client_domain_events.stop()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                AccountConversation.__table__, ConversationProject.__table__, Client.__table__, Task.__table__, ConversationHandoff.__table__]))
        async with self.sessions() as session:
            session.add_all([Client(id="pc", user_ref="alice", auth_state="active"),
                             Client(id="phone", user_ref="alice", auth_state="active"),
                             Client(id="other", user_ref="bob", auth_state="active")])
            await session.flush()
            session.add_all([Task(id=identity, owner_client_id="pc", owner_user_id="alice", origin="cloud-conversation")
                             for identity in ("one", "task-two")])
            session.add_all([Task(id="local-task", owner_client_id="pc", owner_user_id="alice", origin="local"),
                             Task(id="foreign-cloud", owner_client_id="other", owner_user_id="bob", origin="cloud-conversation")])
            await session.commit()
        app = FastAPI()
        app.include_router(conversation_projects.router)

        async def session():
            async with self.sessions() as value:
                yield value

        async def client(request: Request):
            return Client(id=request.headers.get("device", "pc"),
                          user_ref=request.headers.get("owner", "alice"))

        app.dependency_overrides[get_session] = session
        app.dependency_overrides[current_client] = client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await client_domain_events.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def test_committed_edits_wake_only_owner_devices_and_conflicts_do_not_publish(self):
        with patch("app.services.native_discovery.wake", new_callable=AsyncMock) as wake:
            response = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "One", "revision": 0, "chatIds": ["cloud-task:one"]})
            self.assertEqual(response.status_code, 200)
            wake.assert_not_awaited()
            await client_domain_events.flush_for_test(self.sessions)
            self.assertEqual(set(response.json()), {"id", "name", "revision", "deleted", "chatIds"})
            self.assertEqual({tuple(call.args) for call in wake.await_args_list},
                             {("pc", "alice", "conversation-projects"),
                              ("phone", "alice", "conversation-projects")})
            wake.reset_mock()
            conflict = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "Conflict", "revision": 0})
            self.assertEqual(conflict.status_code, 409)
            await client_domain_events.flush_for_test(self.sessions)
            wake.assert_not_awaited()

    async def test_failed_push_does_not_change_committed_write_response(self):
        with patch("app.services.native_discovery.wake", new_callable=AsyncMock, side_effect=OSError("offline")):
            response = await self.http.put("/api/v1/conversation-projects/project-one",
                                           json={"name": "Saved", "revision": 0, "chatIds": ["cloud-task:one"]})
            await client_domain_events.flush_for_test(self.sessions)
        self.assertEqual(response.status_code, 200)
        rows = (await self.http.get("/api/v1/conversation-projects")).json()["items"]
        self.assertEqual(rows[0]["name"], "Saved")

    async def save(self, body, **headers):
        return await self.http.put("/api/v1/conversation-projects/project-one", json=body, headers=headers)

    async def directory(self, **headers):
        return (await self.http.get("/api/v1/conversation-projects", headers=headers)).json()["items"]

    async def seed_legacy(self, members):
        async with self.sessions() as session:
            session.add(ConversationProject(owner_user_id="alice", id="project-one", name="Legacy",
                                            revision=1, members=json.dumps(members)))
            await session.commit()

    async def test_native_only_legacy_group_is_not_discovered_on_other_devices(self):
        await self.seed_legacy([{"client": "pc", "session": "native"}])
        self.assertEqual(await self.directory(device="phone"), [])
        self.assertEqual(await self.directory(), [])
        async with self.sessions() as session:
            row = await session.get(ConversationProject, ("alice", "project-one"))
            self.assertEqual(json.loads(row.members), [{"client": "pc", "session": "native"}])

    async def test_revision_conflicts_and_explicit_tombstones_do_not_overwrite(self):
        await self.save({"name": "Original", "revision": 0, "chatIds": ["cloud-task:one"]})
        conflict = await self.save({"name": "Stale", "revision": 0, "chatIds": ["cloud-task:one"]}, device="phone")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual((await self.directory())[0]["name"], "Original")
        deleted = await self.save({"name": "Original", "revision": 1, "deleted": True})
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(deleted.json()["revision"], 2)
        self.assertEqual((await self.directory(device="phone"))[0]["revision"], 2)

    async def test_another_account_cannot_read_cloud_groups_or_publish_native_aliases(self):
        await self.save({"name": "Private", "revision": 0, "chatIds": ["cloud-task:one"]})
        self.assertEqual(await self.directory(owner="bob"), [])
        for native in ("native", "account:private", "member:eyJjbGllbnQiOiJwYyJ9"):
            response = await self.save({"name": "Other", "revision": 0, "chatIds": [native]}, owner="bob")
            self.assertEqual(response.status_code, 422)
        self.assertEqual(await self.directory(owner="bob"), [])

    async def test_hidden_legacy_members_survive_cloud_membership_edits_without_leaking(self):
        old = {"client": "pc", "session": "native"}
        await self.seed_legacy([old, {"client": "", "session": "cloud-task:one"}])
        phone = (await self.directory(device="phone"))[0]
        self.assertEqual(phone["chatIds"], ["cloud-task:one"])
        changed = await self.save({"name": "Project", "revision": 1,
                                   "chatIds": ["task:task-two"]}, device="phone")
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["chatIds"], ["cloud-task:task-two"])
        async with self.sessions() as session:
            row = await session.get(ConversationProject, ("alice", "project-one"))
            self.assertEqual(json.loads(row.members), [{"client": "", "session": "cloud-task:task-two"}, old])
        self.assertEqual((await self.directory())[0]["chatIds"], ["cloud-task:task-two"])
        removed = await self.save({"name": "Project", "revision": 2, "chatIds": []}, device="phone")
        self.assertEqual(removed.status_code, 200)
        tombstone = (await self.directory(device="phone"))[0]
        self.assertTrue(tombstone["deleted"])
        self.assertEqual(tombstone["name"], "")
        self.assertEqual(tombstone["chatIds"], [])
        async with self.sessions() as session:
            row = await session.get(ConversationProject, ("alice", "project-one"))
            self.assertEqual(json.loads(row.members), [old])

    async def test_empty_native_and_forged_cloud_groups_cannot_be_published(self):
        for chat_ids, status in (([], 422), (["native"], 422), (["task:local-task"], 404),
                                 (["cloud-task:local-task"], 404), (["cloud-task:foreign-cloud"], 404),
                                 (["cloud-task:missing"], 404)):
            with self.subTest(chat_ids=chat_ids):
                response = await self.save({"name": "Private", "revision": 0, "chatIds": chat_ids})
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(await self.directory(), [])

    async def test_only_committed_owned_handoffs_join_shared_cloud_projects(self):
        async with self.sessions() as session:
            for identity, phase, owner in (("committed", "committed", "alice"),
                                           ("prepared", "prepared", "alice"),
                                           ("forged-owner", "committed", "bob")):
                session.add(Task(id=identity, owner_client_id="pc", origin="conversation-handoff"))
                session.add(ConversationHandoff(id=identity, task_id=identity, owner_client_id="pc",
                    owner_user_id=owner, transfer_id=identity, phase=phase))
            session.add(Task(id="missing-handoff", owner_client_id="pc", origin="conversation-handoff"))
            await session.commit()
        for identity in ("prepared", "forged-owner", "missing-handoff"):
            response = await self.save({"name": "Project", "revision": 0,
                                        "chatIds": ["cloud-task:" + identity]})
            self.assertEqual(response.status_code, 404)
        response = await self.save({"name": "Project", "revision": 0,
                                    "chatIds": ["cloud-task:committed"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((await self.directory(device="phone"))[0]["chatIds"], ["cloud-task:committed"])
