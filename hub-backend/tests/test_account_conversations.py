"""Integration checks for the account conversation checkpoint contract."""
import os
import uuid
from datetime import datetime
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-account-conversation-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-account-conversation-test-password")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import account_conversation_models  # noqa: F401
from app.account_conversation_models import (
    AccountConversation,
    AccountConversationCursor,
    AccountConversationMessage,
)
from app.api import account_conversations
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, Task


async def seed_legacy_checkpoint(sessions, body, owner="user-1"):
    """Represent an existing pre-upgrade database without calling retired sync."""
    async with sessions() as session:
        cursor = await session.get(AccountConversationCursor, owner)
        if cursor is None:
            cursor = AccountConversationCursor(owner_user_id=owner, revision=0)
            session.add(cursor)
        cursor.revision += 1
        row = AccountConversation(id="acct-" + uuid.uuid4().hex, owner_user_id=owner,
            source_client_id=body["sourceClientId"], source_session_id=body["sourceSessionId"],
            source_epoch=body["sourceEpoch"], source_revision=body["sourceRevision"],
            revision=cursor.revision, title=body.get("title", ""), state=body.get("state", "idle"),
            archived=body.get("archived", False), deleted=body.get("deleted", False),
            storage_mode=body.get("storageMode", "legacy"), message_count=body.get("messageCount", 0),
            task_projection_id=body.get("taskProjectionId", ""))
        session.add(row)
        await session.flush()
        for message in body["messages"]:
            session.add(AccountConversationMessage(id=message["id"], conversation_id=row.id,
                position=message["position"], role=message["role"], text=message["text"],
                done=message.get("done", False), deleted=message.get("deleted", False),
                revision=message["position"] + 1,
                created_at=datetime.fromisoformat(message["createdAt"].replace("Z", "+00:00"))))
        await session.commit()
        return row.id


class AccountConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        notifications = patch.object(account_conversations, "SessionLocal", self.sessions)
        notifications.start()
        self.addCleanup(notifications.stop)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(
                sync,
                tables=[
                    Client.__table__, AccountConversationCursor.__table__,
                    AccountConversation.__table__, AccountConversationMessage.__table__,
                    Task.__table__,
                ],
            ))
        self.client = Client(
            id="desktop-1", name="desktop", user_ref="user-1", auth_state="active",
        )
        async with self.sessions() as session:
            session.add(self.client)
            await session.commit()

        app = FastAPI()
        self.app = app
        app.include_router(account_conversations.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return self.client

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        )

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    @staticmethod
    def checkpoint(revision, messages, **extra):
        return {
            "sourceClientId": "desktop-1",
            "sourceSessionId": "native-1",
            "sourceEpoch": "native-1:desktop",
            "sourceRevision": revision,
            "title": "test",
            "state": "idle",
            "messages": messages,
            "snapshotComplete": True,
            **extra,
        }

    async def create_conversation(self, **extra):
        conversation_id = await seed_legacy_checkpoint(self.sessions, self.checkpoint(1, [], **extra))
        source = await self.http.get(f"/api/v1/account-conversations/{conversation_id}/source")
        self.assertEqual(source.status_code, 200, source.text)
        return source.json()["conversation"]

    async def lifecycle(self, row, action, **extra):
        return await self.http.post(f"/api/v1/account-conversations/{row['id']}/lifecycle",
            json={"action": action, "expectedRevision": row["revision"], **extra})

    async def test_real_auth_hides_legacy_history_from_other_devices_and_accounts(self):
        from app.models import User
        from app.services import device_auth
        from app.services.auth_cache_transactions import AuthSession
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False, sync_session_class=AuthSession)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[User.__table__]))
        async with self.sessions() as session:
            session.add_all([User(id="user-1", username="alice", is_active=True),
                             User(id="user-other", username="bob", is_active=True)])
            second = Client(id="desktop-2", user_ref="user-1", auth_state="active", auth_version=1)
            stranger = Client(id="desktop-other", user_ref="user-other", auth_state="active", auth_version=1)
            session.add_all([second, stranger])
            source = await session.get(Client, "desktop-1")
            headers = {value.id: {"Authorization": "Device " + device_auth.issue_session(value)[0]}
                       for value in (source, second, stranger)}
            await session.commit()
        row = await self.create_conversation()
        self.app.dependency_overrides.pop(current_client)
        with patch.object(account_conversations.hub, "publish", new=AsyncMock()) as publish, \
             patch.object(device_auth, "_LAST_SEEN_WRITES", {}):
            for device in ("desktop-2", "desktop-other"):
                listed = await self.http.get("/api/v1/account-conversations", headers=headers[device])
                self.assertEqual(listed.status_code, 200, listed.text)
                self.assertEqual(listed.json()["items"], [])
                for suffix in ("source", "messages"):
                    response = await self.http.get(f"/api/v1/account-conversations/{row['id']}/{suffix}", headers=headers[device])
                    self.assertEqual(response.status_code, 404)
                for action in ("archive", "restore", "delete"):
                    response = await self.http.post(f"/api/v1/account-conversations/{row['id']}/lifecycle",
                        headers=headers[device], json={"action": action, "expectedRevision": row["revision"]})
                    self.assertEqual(response.status_code, 404)
                branch = await self.http.post("/api/v1/account-conversations/branches/new-branch",
                    headers=headers[device], json={"accountConversationId": row["id"]})
                self.assertEqual(branch.status_code, 410)
                self.assertEqual(branch.json()["detail"]["code"], "LOCAL_CONVERSATION_BRANCH_DISABLED")
            publish.assert_not_awaited()
            archived = await self.http.post(f"/api/v1/account-conversations/{row['id']}/lifecycle",
                headers=headers["desktop-1"], json={"action": "archive", "expectedRevision": row["revision"]})
            self.assertEqual(archived.status_code, 200, archived.text)
            self.assertTrue(archived.json()["conversation"]["archived"])
            self.assertEqual([call.args[0] for call in publish.await_args_list], ["desktop-1"])
            async with self.sessions() as session:
                device_auth.revoke(await session.get(Client, "desktop-1"))
                await session.commit()
            revoked = await self.http.get("/api/v1/account-conversations", headers=headers["desktop-1"])
            self.assertEqual(revoked.status_code, 403)

    async def test_retired_sync_rejects_legacy_and_endpoint_without_creating_records(self):
        with patch.object(account_conversations, "_publish_account_update", new=AsyncMock()) as publish:
            for mode in ("legacy", "endpoint"):
                response = await self.http.post("/api/v1/account-conversations/sync", json=self.checkpoint(
                    1, [], storageMode=mode, snapshotComplete=mode == "legacy"))
                self.assertEqual(response.status_code, 410, response.text)
                self.assertEqual(response.json()["detail"]["code"], "LOCAL_CONVERSATION_SYNC_DISABLED")
            self.assertEqual((await self.http.get("/api/v1/account-conversations")).json()["items"], [])
            async with self.sessions() as session:
                self.assertEqual(list((await session.scalars(select(AccountConversation))).all()), [])
                self.assertEqual(list((await session.scalars(select(AccountConversationMessage))).all()), [])
            publish.assert_not_awaited()

    async def test_retired_branch_never_copies_old_body_or_starts_a_cloud_task(self):
        from app.services import cloud_conversations
        body = self.checkpoint(1, [{"id": "m1", "position": 0, "role": "user", "text": "retained private body",
                                    "createdAt": "2026-11-01T00:00:00Z"}])
        identity = await seed_legacy_checkpoint(self.sessions, body)
        with patch.object(cloud_conversations, "create", new=AsyncMock()) as create:
            for account_id in (identity, "unknown-conversation"):
                response = await self.http.post("/api/v1/account-conversations/branches/retired-branch", json={
                    "accountConversationId": account_id, "instruction": "new private instruction", "expectedRevision": 1})
                self.assertEqual(response.status_code, 410)
                self.assertEqual(response.json()["detail"]["code"], "LOCAL_CONVERSATION_BRANCH_DISABLED")
                self.assertNotIn("private", response.text)
            create.assert_not_awaited()
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversationMessage, "m1")).text, "retained private body")

    async def test_retired_sync_cannot_change_or_tombstone_retained_messages(self):
        body = self.checkpoint(1, [
            {"id": "m1", "position": 0, "role": "user", "text": "hello", "createdAt": "2026-11-01T00:00:00Z"},
            {"id": "m2", "position": 1, "role": "assistant", "text": "reply", "createdAt": "2026-11-01T00:00:01Z"},
        ], taskProjectionId="mine")
        identity = await seed_legacy_checkpoint(self.sessions, body)
        url = f"/api/v1/account-conversations/{identity}/messages"
        before = (await self.http.get(url)).json()
        for changed in ({**body, "sourceRevision": 2, "title": "replaced", "messages": [body["messages"][0]]},
                        {**body, "taskProjectionId": "foreign", "deleted": True}, body):
            response = await self.http.post("/api/v1/account-conversations/sync", json=changed)
            self.assertEqual(response.status_code, 410)
            self.assertEqual((await self.http.get(url)).json(), before)
        self.assertEqual([item["text"] for item in before["items"]], ["hello", "reply"])
        self.assertTrue(all(not item["deleted"] for item in before["items"]))
        self.assertEqual(before["conversation"]["taskProjectionId"], "mine")

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_source_device_can_archive_and_restore_without_changing_source(self, publish):
        row = await self.create_conversation()
        archived = await self.lifecycle(row, "archive")
        self.assertEqual(archived.status_code, 200, archived.text)
        changed = archived.json()["conversation"]
        self.assertTrue(changed["archived"])
        self.assertFalse(changed["deleted"])
        self.assertGreater(changed["revision"], row["revision"])
        self.assertEqual(changed["lifecycleRevision"], changed["revision"])
        self.assertEqual(changed["sourceClientId"], "desktop-1")
        self.assertEqual(changed["sourceRevision"], 1)
        self.assertTrue(changed["canSend"])
        delta = (await self.http.get("/api/v1/account-conversations",
            params={"after": row["revision"]})).json()
        self.assertEqual(delta["items"][0]["lifecycleRevision"], changed["revision"])
        restored = await self.lifecycle(changed, "restore")
        self.assertEqual(restored.status_code, 200, restored.text)
        final = restored.json()["conversation"]
        self.assertFalse(final["archived"])
        self.assertEqual(final["lifecycleRevision"], final["revision"])
        self.assertGreater(final["revision"], changed["revision"])
        self.assertEqual(publish.await_count, 2)  # archive and restore

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_does_not_reveal_other_accounts_or_accept_unbound_devices(self, publish):
        row = await self.create_conversation()
        self.client = Client(id="desktop-other", user_ref="user-other", auth_state="active")
        for action in ("archive", "restore", "delete"):
            with self.subTest(action=action):
                denied = await self.lifecycle(row, action)
                absent = await self.lifecycle({**row, "id": "missing"}, action)
                self.assertEqual(denied.status_code, 404)
                self.assertEqual(denied.json(), absent.json())
        self.client = Client(id="unbound", user_ref="", auth_state="active")
        self.assertEqual((await self.lifecycle(row, "archive")).status_code, 403)
        self.assertEqual(publish.await_count, 0)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_validates_action_and_revision_before_mutation(self, publish):
        row = await self.create_conversation()
        bad_bodies = [
            {}, {"action": "archive"},
            *({"action": action, "expectedRevision": row["revision"]}
              for action in ("remove", "", None, {}, [])),
            *({"action": "archive", "expectedRevision": value}
              for value in (None, True, False, 0, -1, "1", 1.5)),
        ]
        for body in bad_bodies:
            with self.subTest(body=body):
                response = await self.http.post(
                    f"/api/v1/account-conversations/{row['id']}/lifecycle", json=body)
                self.assertEqual(response.status_code, 422, response.text)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertEqual(current, row)
        self.assertEqual(publish.await_count, 0)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_lifecycle_cas_and_lost_receipts_cannot_reverse_later_intent(self, publish):
        row = await self.create_conversation()
        archived = (await self.lifecycle(row, "archive")).json()["conversation"]
        duplicate = await self.lifecycle(row, "archive")  # lost success receipt
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["conversation"], archived)
        self.assertEqual(publish.await_count, 1)
        # A stale request acting on the old directory cannot reverse archive.
        stale_restore = await self.lifecycle(row, "restore")
        self.assertEqual(stale_restore.status_code, 409)
        self.assertEqual(stale_restore.json()["detail"]["code"], "ACCOUNT_CONVERSATION_CHANGED")
        self.assertEqual(stale_restore.json()["detail"]["conversation"], archived)
        restored = (await self.lifecycle(archived, "restore")).json()["conversation"]
        old_archive = await self.lifecycle(row, "archive")
        self.assertEqual(old_archive.status_code, 409)
        self.assertEqual(old_archive.json()["detail"]["conversation"], restored)
        self.assertEqual((await self.lifecycle(row, "delete")).status_code, 409)
        self.assertEqual(publish.await_count, 2)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_first_explicit_intent_requires_cas_even_when_state_already_matches(self, publish):
        for action, flags in (("restore", {}), ("archive", {"archived": True}),
                              ("delete", {"deleted": True})):
            with self.subTest(action=action):
                row = await self.create_conversation(sourceSessionId="native-" + action, **flags)
                self.assertEqual(row["lifecycleRevision"], 0)
                stale = await self.lifecycle(row, action, expectedRevision=row["revision"] + 1)
                self.assertEqual(stale.status_code, 409)
                explicit = await self.lifecycle(row, action)
                self.assertEqual(explicit.status_code, 200)
                changed = explicit.json()["conversation"]
                self.assertGreater(changed["revision"], row["revision"])
                self.assertEqual(changed["lifecycleRevision"], changed["revision"])
                self.assertEqual(changed["archived"], row["archived"])
                self.assertEqual(changed["deleted"], row["deleted"])
                duplicate = await self.lifecycle(row, action)
                self.assertEqual(duplicate.json()["conversation"], changed)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_retired_checkpoints_preserve_lifecycle_and_existing_content(self, publish):
        row = await self.create_conversation()
        for revision, action, flags in (
            (2, "archive", {"archived": False, "deleted": False}),
            (3, "restore", {"archived": True, "deleted": True}),
            (4, "delete", {"archived": False, "deleted": False}),
        ):
            with self.subTest(action=action):
                changed = (await self.lifecycle(row, action)).json()["conversation"]
                message = {"id": "m1", "position": 0, "role": "user", "text": str(revision),
                           "createdAt": "2026-11-01T00:00:00Z", "done": True}
                payload = self.checkpoint(revision, [message], title="updated " + str(revision), **flags)
                synced = await self.http.post("/api/v1/account-conversations/sync", json=payload)
                self.assertEqual(synced.status_code, 410, synced.text)
                transcript = (await self.http.get(
                    f"/api/v1/account-conversations/{row['id']}/messages")).json()
                row = transcript["conversation"]
                self.assertEqual(row["archived"], changed["archived"])
                self.assertEqual(row["deleted"], changed["deleted"])
                self.assertEqual(row["lifecycleRevision"], changed["lifecycleRevision"])
                self.assertEqual(row["revision"], changed["revision"])
                self.assertEqual(row["sourceRevision"], 1)
                self.assertEqual(row["title"], "test")
                self.assertEqual(transcript["items"], [])
        self.assertFalse(row["canContinue"])
        self.assertFalse(row["canSend"])
        for action in ("archive", "restore"):
            closed = await self.lifecycle(row, action)
            self.assertEqual(closed.status_code, 410)
            self.assertEqual(closed.json()["detail"]["code"], "ACCOUNT_CONVERSATION_DELETED")
        repeated_delete = await self.lifecycle(row, "delete", expectedRevision=1)
        self.assertEqual(repeated_delete.status_code, 200)
        self.assertEqual(repeated_delete.json()["conversation"], row)

    @patch.object(account_conversations, "_publish_account_update", new_callable=AsyncMock)
    async def test_sync_cannot_clear_legacy_lifecycle_flags_or_bypass_source_fences(self, publish):
        initial = self.checkpoint(1, [], archived=True)
        row = await self.create_conversation(archived=True)
        payload = self.checkpoint(2, [], archived=False, deleted=False)
        synced = await self.http.post("/api/v1/account-conversations/sync", json=payload)
        self.assertEqual(synced.status_code, 410)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertTrue(current["archived"])
        self.assertEqual(current["lifecycleRevision"], 0)
        deleted = (await self.lifecycle(current, "delete")).json()["conversation"]
        # A repeated source receipt stays idempotent without rewinding directory state.
        duplicate = await self.http.post("/api/v1/account-conversations/sync", json=payload)
        self.assertEqual(duplicate.status_code, 410)
        for conflict in (initial, {**payload, "title": "changed"},
                         {**payload, "sourceRevision": 3, "sourceEpoch": "different"}):
            with self.subTest(conflict=conflict):
                response = await self.http.post("/api/v1/account-conversations/sync", json=conflict)
                self.assertEqual(response.status_code, 410)
        current = (await self.http.get(
            f"/api/v1/account-conversations/{row['id']}/source")).json()["conversation"]
        self.assertEqual(current, deleted)


if __name__ == "__main__":
    unittest.main()
