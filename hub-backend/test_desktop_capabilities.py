"""Selected-PC authorization and private transport regression; no real devices."""
import asyncio
import json
import os
import unittest
from types import SimpleNamespace as Row
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "desktop-capability-isolated-fixture-only")
os.environ.setdefault("ADMIN_PASS", "desktop-capability-isolated-fixture-only")
from fastapi import HTTPException
from app.api import desktop_capabilities as api
from app.models import Client
from app.services.runner_desktop_capabilities import DesktopCapabilities, PREFIX


class AccessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = Row(id="phone", user_ref="owner", auth_state="active")
        self.target = Row(id="pc", user_ref="owner", auth_state="active", platform="darwin")
        self.node = Row(id="runner", client_id="pc", owner_user_id="owner", org_id="org", auth_state="active", management_state="")
        self.runner = Row(id="runner", client_id="pc", owner_user_id="owner", org_id="org", caps=["desktopCapabilities1"],
                          call=AsyncMock(return_value={"ok": True, "data": {"plugins": []}}))
        self.session = Row(get=AsyncMock(side_effect=lambda model, key, **kw: self.target if model is Client else self.node), refresh=AsyncMock())
        self.body = {"operation": "catalog", "args": {}, "requestId": "request-fixture"}
        self.patcher = patch.object(api.runner_hub, "for_client", return_value=self.runner)
        self.live = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    async def test_same_account_dispatch_contains_server_owned_identity(self):
        self.assertEqual(await api.request("pc", self.body, self.client, self.session), {"plugins": []})
        payload = self.runner.call.call_args.args[1]
        self.assertEqual(payload["ownerUserId"], "owner")
        self.assertEqual(payload["targetClientId"], "pc")

    async def test_mobile_unknown_and_foreign_sources_cannot_read_history_despite_capabilities(self):
        self.runner.caps.append("desktopHistory1")
        body = {**self.body, "operation": "conversation.history", "args": {"action": "list"}}
        for platform in ("android", "ios", "mobile", "web", "", None):
            with self.subTest(platform=platform):
                self.target.platform = platform
                with self.assertRaises(HTTPException) as denied:
                    await api.request("pc", body, self.client, self.session)
                self.assertEqual(denied.exception.status_code, 404)
        self.runner.call.assert_not_awaited()
        for platform in ("win32", "darwin", "linux", "win32/x64", "darwin/arm64", "linux/x64"):
            self.target.platform = platform
            with self.assertRaises(HTTPException) as direct_only:
                await api.request("pc", body, self.client, self.session)
            self.assertEqual(direct_only.exception.status_code, 410)
            self.assertEqual(await api.request("pc", self.body, self.client, self.session), {"plugins": []})
            self.assertNotIn("conversation.history", [call.args[1]["operation"] for call in self.runner.call.await_args_list])
        self.runner.call.reset_mock()
        self.target.user_ref = "foreign"
        with self.assertRaises(HTTPException):
            await api.request("pc", body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_target_directory_excludes_mobile_unknown_and_other_account_sources(self):
        devices = [Row(id="pc", user_ref="owner", auth_state="active", name="PC", platform="darwin/arm64"),
                   Row(id="phone", user_ref="owner", auth_state="active", name="Phone", platform="ios"),
                   Row(id="unknown", user_ref="owner", auth_state="active", name="Unknown", platform="")]
        nodes = [Row(client_id=device.id, owner_user_id="owner", auth_state="active", management_state="") for device in devices]
        self.session.scalars = AsyncMock(side_effect=[Row(all=lambda: nodes), Row(all=lambda: devices)])
        with patch.object(api, "resolve", new=AsyncMock(return_value=(devices[0], self.runner))) as resolve:
            page = await api.targets(self.client, self.session)
        self.assertEqual([row["id"] for row in page["items"]], ["pc"])
        self.assertEqual(resolve.await_count, 1)
        query = self.session.scalars.await_args.args[0]
        self.assertIn("owner", query.compile().params.values())

    async def test_library_requires_updated_selected_desktop_and_keeps_signed_owner(self):
        body = {**self.body, "operation": "library.call", "args": {"action": "list", "body": {}}}
        with self.assertRaises(HTTPException):
            await api.request("pc", body, self.client, self.session)

        self.runner.call.assert_not_awaited()
        self.runner.caps.append("desktopLibrary1")
        self.runner.call.return_value = {"ok": True, "data": {"ok": True, "items": []}}
        self.assertEqual((await api.request("pc", body, self.client, self.session))["items"], [])
        packet = self.runner.call.call_args.args[1]
        self.assertEqual(packet["ownerUserId"], "owner")
        self.assertEqual(packet["targetClientId"], "pc")
        self.assertIn("authorization", packet)
        self.target.user_ref = "someone-else"
        with self.assertRaises(HTTPException):
            await api.request("pc", body, self.client, self.session)

    async def test_account_recovery_returns_only_fixed_receipt_not_desktop_body(self):
        self.client = self.target
        self.runner.caps.append("desktopHistory1")
        receipt = {"ok": True, "durable": True, "id": "migrated-" + "a" * 64, "sha256": "b" * 64, "size": 42}
        self.runner.call.return_value = {"ok": True, "data": {**receipt,
            "items": [{"text": "private desktop text"}], "conversation": {"title": "private title"}}}
        body = {**self.body, "operation": "conversation.history", "args": {
            "action": "import", "pointer": {"sha256": "b" * 64, "size": 42}}}
        self.assertEqual(await api.request("pc", body, self.client, self.session), receipt)
        self.runner.call.return_value["data"]["sha256"] = "c" * 64
        with self.assertRaises(HTTPException) as rejected:
            await api.request("pc", body, self.client, self.session)
        self.assertEqual(rejected.exception.status_code, 409)

    async def test_embedded_runner_null_owner_matches_handshake_empty_string(self):
        # Desktop ownership is bound to the authenticated Client. Unlike an
        # independently enrolled cloud Runner, RunnerNode.owner_user_id is NULL;
        # runner_registry deliberately normalizes that to an empty string.
        self.node.owner_user_id = None
        self.runner.owner_user_id = ""
        self.assertEqual(await api.request("pc", self.body, self.client, self.session), {"plugins": []})

    async def test_empty_runner_owner_never_bypasses_client_account_ownership(self):
        self.node.owner_user_id = None
        self.runner.owner_user_id = ""
        self.target.user_ref = "another-account"
        with self.assertRaises(HTTPException):
            await api.request("pc", self.body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_nonempty_runner_owner_mismatch_is_still_rejected(self):
        self.node.owner_user_id = None
        self.runner.owner_user_id = "owner"
        with self.assertRaises(HTTPException):
            await api.request("pc", self.body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_other_account_and_revoked_owner_never_dispatch(self):
        for change in (lambda: setattr(self.target, "user_ref", "other"), lambda: setattr(self.node, "auth_state", "revoked")):
            self.target.user_ref = "owner"
            change()
            with self.assertRaises(HTTPException):
                await api.request("pc", self.body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_offline_old_client_and_changed_runner_never_dispatch(self):
        self.live.return_value = None
        with self.assertRaises(HTTPException): await api.request("pc", self.body, self.client, self.session)
        self.live.return_value = self.runner
        self.runner.caps = []
        with self.assertRaises(HTTPException): await api.request("pc", self.body, self.client, self.session)
        self.runner.caps = ["desktopCapabilities1"]
        self.runner.owner_user_id = "other"
        with self.assertRaises(HTTPException): await api.request("pc", self.body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_identity_change_before_response_discards_catalog(self):
        async def call(*args, **kwargs):
            self.target.user_ref = "other"
            return {"ok": True, "data": {"plugins": ["private"]}}
        self.runner.call.side_effect = call
        with self.assertRaises(HTTPException): await api.request("pc", self.body, self.client, self.session)

    async def test_no_arbitrary_operation_or_forged_owner(self):
        for body in ({**self.body, "operation": "shell"}, {**self.body, "ownerUserId": "other"}, {**self.body, "args": []}):
            with self.assertRaises(HTTPException): await api.request("pc", body, self.client, self.session)
        self.runner.call.assert_not_awaited()

    async def test_plugin_use_never_queries_or_appends_old_history_projection(self):
        self.runner.call.return_value = {"ok": True, "data": {"sourceSessionId": "native-session"}}
        self.session.scalar = AsyncMock(return_value=Row())
        for actor in (self.client, self.target):
            result = await api.request("pc", {**self.body, "operation": "plugin.use"}, actor, self.session)
            self.assertEqual(result, {"sourceSessionId": "native-session"})
        self.session.scalar.assert_not_awaited()

    async def test_desktop_must_present_hub_signed_ticket_bound_to_body_and_account(self):
        await api.request("pc", self.body, self.client, self.session)
        packet = dict(self.runner.call.call_args.args[1])
        authorization = packet.pop("authorization")
        body = {"authorization": authorization, "request": packet}
        self.assertEqual(await api.verify(body, self.target, self.session), {"ok": True})
        for invalid, actor in (({**body, "authorization": "forged"}, self.target),
                               ({**body, "request": {**packet, "operation": "plugin.install"}}, self.target),
                               (body, self.client)):
            with self.assertRaises(HTTPException): await api.verify(invalid, actor, self.session)


class SkillSelectionTests(AccessTests):
    async def ticket(self, args, operation="skill.set"):
        await api.request("pc", {**self.body, "operation": operation, "args": args}, self.client, self.session)
        packet = dict(self.runner.call.call_args.args[1])
        return {"authorization": packet.pop("authorization"), "request": packet}

    async def test_toggle_preserves_other_choices_and_uses_existing_preferences(self):
        self.target.skills = ["office", "browser-use"]
        self.target.config = {}
        self.session.commit = AsyncMock()
        rows = [{"name": "office"}, {"name": "browser-use"}, {"name": "computer-use"}]
        with patch("app.services.skills.catalog_with_policy", AsyncMock(return_value=({"allowed": []}, rows))):
            result = await api.skill_selection(await self.ticket({"name": "office", "enabled": False}), self.target, self.session)
            self.assertFalse(result["enabled"])
            self.assertEqual(self.target.skills, ["browser-use"])
            self.assertIn("office", self.target.config["skillPreferences"]["disabled"])
            # A separate PC-side change is preserved when another mobile switch is saved.
            self.target.skills.append("computer-use")
            self.target.config["skillPreferences"]["disabled"].remove("computer-use")
            await api.skill_selection(await self.ticket({"name": "office", "enabled": True}), self.target, self.session)
            self.assertEqual(set(self.target.skills), {"office", "browser-use", "computer-use"})
        self.assertEqual(self.session.commit.await_count, 2)
        self.assertTrue(any(call.kwargs.get("with_for_update") for call in self.session.refresh.call_args_list))

    async def test_unknown_skill_wrong_operation_and_forged_ticket_never_write(self):
        self.target.skills, self.target.config = [], {}
        self.session.commit = AsyncMock()
        with patch("app.services.skills.catalog_with_policy", AsyncMock(return_value=({"allowed": []}, []))):
            for args, operation in (({"name": "unapproved", "enabled": True}, "skill.set"),
                                    ({"name": "office", "enabled": True}, "catalog"),
                                    ({"name": "office", "enabled": "true"}, "skill.set")):
                with self.assertRaises(HTTPException):
                    await api.skill_selection(await self.ticket(args, operation), self.target, self.session)
        body = await self.ticket({"name": "office", "enabled": True})
        body["authorization"] = "forged"
        with self.assertRaises(HTTPException): await api.skill_selection(body, self.target, self.session)
        self.session.commit.assert_not_awaited()


class PipeTests(unittest.IsolatedAsyncioTestCase):
    async def test_network_cannot_inject_private_parent_reply(self):
        from runner_main import Runner
        runner = Row(desktop_owned=True, _send=AsyncMock())
        await Runner._on(runner, {"op": "desktop.capability.reply", "id": "forged", "_localParent": True})
        self.assertFalse(runner._send.call_args.args[0]["ok"])
        runner.desktop_owned = False
        await Runner._on(runner, {"op": "desktop.capability", "id": "cloud"})
        self.assertFalse(runner._send.call_args.args[0]["ok"])

    async def test_private_response_correlates_and_cleans_pending(self):
        packets = []
        bridge = DesktopCapabilities(packets.append)
        task = asyncio.create_task(bridge.call({"operation": "catalog"}))
        await asyncio.sleep(0)
        packet = json.loads(packets[0][len(PREFIX):])
        self.assertEqual(packet["kind"], "desktop-capability")
        self.assertIn("expiresAt", packet["body"])
        bridge.reply({"requestId": "wrong", "result": {"ok": False}})
        self.assertFalse(task.done())
        bridge.reply({"requestId": packet["id"], "result": {"ok": True, "data": {"plugins": []}}})
        self.assertTrue((await task)["ok"])
        self.assertEqual(bridge.pending, {})

    async def test_timeout_and_oversized_payload_never_leave_pending(self):
        bridge = DesktopCapabilities(lambda _: None)
        with self.assertRaises(TimeoutError): await bridge.call({}, timeout=.001)
        self.assertEqual(bridge.pending, {})
        with self.assertRaises(ValueError): await bridge.call({"body": "x" * 600000})
        self.assertEqual(bridge.pending, {})


if __name__ == "__main__": unittest.main()
