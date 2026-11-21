"""Real database checks around endpoint migration and late source updates."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from tests import test_account_conversations as fixtures
from app.api import desktop_capabilities, conversation_content_migrations
from app.account_conversation_models import AccountConversation, AccountConversationMessage
from app.services import conversation_content, conversation_content_migration as migration
from sqlalchemy import select
from fastapi import HTTPException


class EndpointMigrationTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AccountConversationTests.asyncSetUp
    asyncTearDown = fixtures.AccountConversationTests.asyncTearDown
    checkpoint = staticmethod(fixtures.AccountConversationTests.checkpoint)

    async def seed(self):
        body = self.checkpoint(1, [{"id": "message-a", "position": 0, "role": "user", "text": "sole old Hub copy", "createdAt": "2026-11-07T00:00:00Z"}])
        return await fixtures.seed_legacy_checkpoint(self.sessions, body)

    async def test_retired_local_directory_sync_preserves_existing_endpoint_records(self):
        body = self.checkpoint(1, [], storageMode="endpoint", snapshotComplete=False, messageCount=12345)
        identity = await fixtures.seed_legacy_checkpoint(self.sessions, body)
        directory = await self.http.get("/api/v1/account-conversations")
        self.assertEqual(directory.json()["items"][0]["messageCount"], 12345)
        old = self.checkpoint(2, [{"id": "x", "position": 0, "role": "user", "text": "must not persist", "createdAt": "2026-11-07T00:00:00Z"}])
        for payload in (old, body):
            response = await self.http.post("/api/v1/account-conversations/sync", json=payload)
            self.assertEqual(response.status_code, 410)
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversation, identity)).storage_mode, "endpoint")
            self.assertEqual(list((await session.scalars(select(AccountConversationMessage))).all()), [])

    async def test_directory_distinguishes_source_and_migrated_content_without_exposing_pointer(self):
        identity = await self.seed()
        source_url = f"/api/v1/account-conversations/{identity}/source"
        self.assertEqual((await self.http.get(source_url)).json()["conversation"]["contentLocation"], "hub")
        async with self.sessions() as session:
            row = await session.get(AccountConversation, identity)
            row.storage_mode, row.source_revision = "endpoint", 2
            await session.commit()
        self.assertEqual((await self.http.get(source_url)).json()["conversation"]["contentLocation"], "source")

        pointer = {"localReplicaId": "migrated-private-copy", "targetClientId": "private-target-device",
                   "sourceRevision": 2, "sha256": "a" * 64, "scope": "private-content-scope"}
        async with self.sessions() as session:
            row = await session.get(AccountConversation, identity)
            row.content_ref = pointer
            await session.commit()
        for url in (source_url, "/api/v1/account-conversations"):
            response = await self.http.get(url)
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            item = data["conversation"] if "conversation" in data else data["items"][0]
            self.assertEqual(item["contentLocation"], "replica")
            for private_value in (pointer["localReplicaId"], pointer["targetClientId"], pointer["scope"], pointer["sha256"]):
                self.assertNotIn(private_value, response.text)
            self.assertNotIn("contentRef", item)

        with patch.object(desktop_capabilities, "request", new=AsyncMock()) as request:
            response = await self.http.get(f"/api/v1/account-conversations/{identity}/messages")
            self.assertEqual(response.status_code, 410, response.text)
            self.assertNotIn(pointer["localReplicaId"], response.text)
            request.assert_not_awaited()

        self.client.user_ref = "unrelated-account"
        self.assertEqual((await self.http.get(source_url)).status_code, 404)
        self.assertEqual((await self.http.get("/api/v1/account-conversations")).json()["items"], [])

    async def test_retired_endpoint_service_cannot_read_any_device_or_build_branch_context(self):
        from app.services import account_endpoint_history
        identity = await self.seed()
        with patch.object(desktop_capabilities, "request", new=AsyncMock()) as request:
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                row.storage_mode = "endpoint"
                for reader in (account_endpoint_history.page, account_endpoint_history.context):
                    for reference in (None, {"localReplicaId": "migrated-copy", "targetClientId": "another-pc",
                                             "sourceRevision": row.source_revision}):
                        row.content_ref = reference
                        with self.assertRaises(HTTPException) as retired:
                            await reader(session, self.client, row)
                        self.assertEqual(retired.exception.status_code, 410)
                    for actor in (SimpleNamespace(id="other-pc", user_ref=self.client.user_ref, auth_state="active"),
                                  SimpleNamespace(id=self.client.id, user_ref="foreign", auth_state="active"),
                                  SimpleNamespace(id=self.client.id, user_ref=self.client.user_ref, auth_state="revoked")):
                        with self.assertRaises(HTTPException) as denied:
                            await reader(session, actor, row)
                        self.assertEqual(denied.exception.status_code, 404)
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")
            request.assert_not_awaited()

    async def test_uncertain_endpoint_reference_never_claims_source_content(self):
        identity = await self.seed()
        source_url = f"/api/v1/account-conversations/{identity}/source"
        references = [
            {"localReplicaId": "copy", "targetClientId": "target", "sourceRevision": 0},
            {"localReplicaId": "copy", "sourceRevision": 1},
            {"sha256": "a" * 64}, [], "invalid-reference", False,
        ]
        for reference in references:
            with self.subTest(reference=reference):
                async with self.sessions() as session:
                    row = await session.get(AccountConversation, identity)
                    row.storage_mode, row.content_ref = "endpoint", reference
                    await session.commit()
                response = await self.http.get(source_url)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["conversation"]["contentLocation"], "unknown")
        for reference in (None, {}):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                row.content_ref = reference
                await session.commit()
            self.assertEqual((await self.http.get(source_url)).json()["conversation"]["contentLocation"], "source")

    async def test_wrong_receipt_keeps_sole_copy_then_verified_retry_clears_only_the_body(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30, "scope": "b" * 64, "runnerId": "runner", "schema": 1}
        endpoint = SimpleNamespace(caps=["desktopHistory1"])
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, endpoint))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", AsyncMock(return_value={"ok": True, "durable": True, "sha256": "wrong", "size": 30})) as imported:
            endpoint.id = "runner"
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                message = await session.get(AccountConversationMessage, "message-a")
                self.assertEqual(message.text, "sole old Hub copy")
            imported.return_value = {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, "sha256": pointer["sha256"], "size": 30}
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                result = await migration.account(session, self.client, row, self.client.id)
                self.assertTrue(result["ok"])
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "")
                self.assertEqual(row.content_ref["sha256"], pointer["sha256"])
                self.assertEqual(row.storage_mode, "endpoint")

    async def test_source_change_during_import_prevents_cleanup(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_change(*args):
            async with self.sessions() as changed:
                row = await changed.get(AccountConversation, identity)
                row.source_revision += 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_change):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_other_account_cannot_start_migration_or_enumerate_candidates(self):
        identity = await self.seed()
        self.app.include_router(conversation_content_migrations.router)
        self.client.user_ref = "different-user"
        response = await self.http.post("/api/v1/conversation-content-migrations/account/" + identity, json={})
        self.assertEqual(response.status_code, 404)
        response = await self.http.get("/api/v1/conversation-content-migrations?kind=account")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])

    async def test_same_account_other_device_cannot_enumerate_or_migrate_legacy_pc_history(self):
        identity = await self.seed()
        self.app.include_router(conversation_content_migrations.router)
        self.client.id = "another-pc"
        response = await self.http.get("/api/v1/conversation-content-migrations?kind=account")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])
        with patch.object(migration, "account", new=AsyncMock()) as move:
            response = await self.http.post("/api/v1/conversation-content-migrations/account/" + identity, json={})
            self.assertEqual(response.status_code, 404)
            move.assert_not_awaited()
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_legacy_relay_inventory_and_recovery_require_the_original_source_device(self):
        from datetime import datetime, timezone
        from app.account_conversation_models import PersonalConversationRelay
        async with self.engine.begin() as connection:
            await connection.run_sync(PersonalConversationRelay.__table__.create)
        async with self.sessions() as session:
            session.add(PersonalConversationRelay(id="legacy-relay", owner_user_id=self.client.user_ref,
                requester_client_id="old-phone", source_client_id=self.client.id, conversation_id="old-conversation",
                request_id="old-request", request_hash="a" * 64, source_epoch="old-epoch", source_revision=1,
                instruction="sole retained legacy relay instruction", expires_at=datetime.now(timezone.utc)))
            await session.commit()
        self.app.include_router(conversation_content_migrations.router)
        source_id = self.client.id
        for device, expected in ((source_id, ["legacy-relay"]), ("another-pc", [])):
            self.client.id = device
            response = await self.http.get("/api/v1/conversation-content-migrations?kind=relay")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual([item["id"] for item in response.json()["items"]], expected)
            self.assertNotIn("instruction", response.text)
        with patch.object(migration, "relay", new=AsyncMock()) as recover:
            response = await self.http.post("/api/v1/conversation-content-migrations/relay/legacy-relay", json={})
            self.assertEqual(response.status_code, 404)
            recover.assert_not_awaited()
        with patch.object(desktop_capabilities, "resolve", new=AsyncMock()) as resolve:
            async with self.sessions() as session:
                row = await session.get(PersonalConversationRelay, "legacy-relay")
                with self.assertRaises(HTTPException) as denied:
                    await migration.relay(session, self.client, row)
                self.assertEqual(denied.exception.status_code, 403)
                self.assertEqual(row.instruction, "sole retained legacy relay instruction")
            resolve.assert_not_awaited()
        self.client.id = source_id

    async def test_account_recovery_service_cannot_export_to_another_device(self):
        identity = await self.seed()
        with patch.object(desktop_capabilities, "resolve", new=AsyncMock()) as resolve:
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as denied:
                    await migration.account(session, self.client, row, "another-pc")
                self.assertEqual(denied.exception.status_code, 403)
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")
            resolve.assert_not_awaited()

    async def test_lifecycle_change_during_import_keeps_hub_body(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_delete(*args):
            async with self.sessions() as changed:
                row = await changed.get(AccountConversation, identity)
                row.deleted, row.revision = True, row.revision + 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_delete):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_final_mode_rejects_new_legacy_body_writers(self):
        with patch.object(conversation_content, "metadata_only", return_value=True):
            legacy = self.checkpoint(1, [])
            response = await self.http.post("/api/v1/account-conversations/sync", json=legacy)
            self.assertEqual(response.status_code, 410)
            response = await self.http.post("/api/v1/account-conversations/sync", json={**legacy, "storageMode": "endpoint", "snapshotComplete": False})
            self.assertEqual(response.status_code, 410, response.text)

    async def test_same_revision_upgrade_retains_the_only_body_until_migration(self):
        identity = await self.seed()
        upgrade = self.checkpoint(1, [], storageMode="endpoint", snapshotComplete=False, messageCount=1)
        first = await self.http.post("/api/v1/account-conversations/sync", json=upgrade)
        self.assertEqual(first.status_code, 410, first.text)
        retry = await self.http.post("/api/v1/account-conversations/sync", json=upgrade)
        self.assertEqual(retry.status_code, 410)
        async with self.sessions() as session:
            self.assertEqual((await session.get(AccountConversation, identity)).storage_mode, "legacy")
            self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_revoked_login_during_import_cannot_authorize_hub_body_removal(self):
        identity = await self.seed()
        pointer = {"sha256": "a" * 64, "size": 30}
        async def import_and_revoke(*args):
            from app.models import Client
            async with self.sessions() as changed:
                row = await changed.get(Client, self.client.id)
                row.auth_version += 1
                await changed.commit()
            return {"ok": True, "durable": True, "id": "migrated-" + "c" * 64, **pointer}
        with patch.object(desktop_capabilities, "resolve", AsyncMock(return_value=(None, SimpleNamespace(id="runner", caps=["desktopHistory1"])))), \
             patch.object(conversation_content, "put_json", AsyncMock(return_value=pointer)), \
             patch.object(desktop_capabilities, "request", import_and_revoke):
            async with self.sessions() as session:
                row = await session.get(AccountConversation, identity)
                with self.assertRaises(HTTPException) as rejected:
                    await migration.account(session, self.client, row, self.client.id)
                self.assertEqual(rejected.exception.status_code, 409)
                await session.rollback()
                self.assertEqual((await session.get(AccountConversationMessage, "message-a")).text, "sole old Hub copy")

    async def test_global_gate_counts_orphaned_and_other_account_bodies_without_exposing_text(self):
        from app.db import Base
        from app.models import User, Task, TaskEvent, Attachment, AiScheduleRun
        from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
        from app.account_conversation_models import PersonalConversationRelay
        from app.automation_models import ExecutionSession, ExecutionEvent
        from app.services import conversation_content_inventory as inventory
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                User.__table__, TaskEvent.__table__, Attachment.__table__, ConversationHandoff.__table__,
                ConversationMessageReceipt.__table__, PersonalConversationRelay.__table__,
                ExecutionSession.__table__, ExecutionEvent.__table__, AiScheduleRun.__table__]))
        await self.seed()
        async with self.sessions() as session:
            session.add(User(id=self.client.user_ref, username="isolated-migration-owner", is_active=True))
            session.add(ConversationMessageReceipt(id="orphan-receipt", task_id="gone", owner_client_id="gone",
                message_id="one", content_hash="a" * 64, payload={"instruction": "private orphan"}))
            for i, payload in enumerate([None, {}]):
                session.add(ConversationMessageReceipt(id="empty-receipt-" + str(i), task_id="gone", owner_client_id="gone",
                    message_id="empty-" + str(i), content_hash="b" * 64, payload=payload))
            session.add(ExecutionSession(id="orphan-execution", task_id="gone", ref="orphan-ref"))
            session.add(ExecutionEvent(id="orphan-event", session_id="orphan-execution", seq=1, text="private event"))
            session.add(ExecutionEvent(id="missing-execution-event", session_id="missing-execution", seq=1, text="private detached event"))
            session.add(Task(id="orphan-task", title="metadata", origin="cloud-conversation", note="private note"))
            session.add(TaskEvent(id="orphan-brief", task_id="orphan-task", kind="dispatched", detail={"carried": {"brief": "private brief"}}))
            await session.commit()
            owned = await inventory.counts(session, self.client.user_ref)
            self.assertEqual(owned["account"], 1)
            self.assertEqual(owned["message"], 0)
            report = await inventory.audit(session)
            self.assertFalse(report["complete"])
            self.assertEqual(report["pending"]["message"], 1)
            self.assertEqual(report["pending"]["execution"], 1)
            self.assertEqual(report["blocked"]["messageUnowned"], 1)
            self.assertEqual(report["blocked"]["executionUnowned"], 1)
            self.assertEqual(report["blocked"]["orphanConversationNotes"], 1)
            self.assertEqual(report["blocked"]["orphanExecutionEvents"], 1)
            self.assertEqual(report["blocked"]["orphanConversationBriefs"], 1)
            self.assertNotIn("private", str(report))


if __name__ == "__main__":
    unittest.main()
