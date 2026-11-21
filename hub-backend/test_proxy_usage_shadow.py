import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-shadow-usage-fixture")
os.environ.setdefault("ADMIN_PASS", "isolated-shadow-usage-password")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import ai_proxy
from app.models import ProxyUsageObservation
from app.services import proxy_usage_shadow
from app.services.proxy_usage_shadow import UsageEvidence
from model_test_support import FakeResponse


class ShadowEvidenceTests(unittest.TestCase):
    def test_subsets_and_conflicts(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200,
                 "prompt_tokens_details": {"cached_tokens": 600},
                 "completion_tokens_details": {"reasoning_tokens": 80}}
        evidence = UsageEvidence("chat")
        evidence.observe({"usage": usage})
        self.assertEqual(evidence.counts, {"input": 1000, "output": 200, "total": 1200,
                                           "cached": 600, "reasoning": 80})
        evidence.observe({"usage": {**usage, "total_tokens": 1880}})
        self.assertEqual(evidence.status, "conflict")

    def test_fragmented_terminal_frames_and_duplicate(self):
        event = {"type": "response.completed", "response": {"usage": {
            "input_tokens": 3, "output_tokens": 0, "total_tokens": 3}}}
        frame = b"data: " + json.dumps(event).encode() + b"\r\n\r\n"
        evidence = UsageEvidence("responses")
        for byte in frame * 2:
            evidence.feed(bytes([byte]))
        self.assertEqual(evidence.status, "reported")
        self.assertEqual(evidence.counts["total"], 3)

    def test_empty_partial_and_explicit_zero(self):
        evidence = UsageEvidence("chat")
        evidence.feed(b'data: {"id":"response-a","choices":[{}],"usage":{"total_tokens":5}}\n\n')
        self.assertEqual(evidence.status, "unknown")
        self.assertEqual(len(evidence.provider_response_hash), 64)
        evidence.feed(b'data: {"choices":[],"usage":{"total_tokens":0}}\n\n')
        self.assertEqual(evidence.counts, {"total": 0})
        self.assertEqual(evidence.status, "reported")

    def test_oversized_event_does_not_swallow_next_receipt(self):
        evidence = UsageEvidence("chat")
        evidence.feed(b"data: " + b"x" * 300000)
        evidence.feed(b"\r\n\r\ndata: {\"choices\":[],\"usage\":{\"total_tokens\":42}}\r\n\r\n")
        self.assertEqual(evidence.counts["total"], 42)


class ProxyShadowIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def test_disabled_path_does_not_inspect_identity(self):
        with patch.object(proxy_usage_shadow, "get_settings", return_value=SimpleNamespace(
                proxy_usage_shadow_enabled=False)):
            self.assertIsNone(proxy_usage_shadow.ProxyObservation.start(None, None, "chat"))

    async def test_write_failure_isolated_from_proxy_response(self):
        observation = proxy_usage_shadow.ProxyObservation(
            SimpleNamespace(id="device", user_ref="user"), {"model": "fixture"}, "chat")
        with patch.object(proxy_usage_shadow, "SessionLocal", side_effect=RuntimeError("fixture")), \
                self.assertLogs(proxy_usage_shadow.log, level="WARNING"):
            await observation.save("completed")

    async def test_endpoints_stream_and_complete_with_isolated_ledger(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            await conn.run_sync(ProxyUsageObservation.__table__.create)
        sessions = async_sessionmaker(engine)
        conf = {"provider": "fixture-provider", "model": "fixture-model", "quotaScope": "personal",
                "kind": "openai-compat"}
        client = SimpleNamespace(id="device", user_ref="user", _proxy_quota_runtime="qwen")
        for protocol, endpoint in (("chat", ai_proxy.chat_completions), ("responses", ai_proxy.responses)):
            for stream in (False, True):
                receipt = {"id": "fixture-response", "usage": {"total_tokens": 1200}}
                packet = receipt
                if stream:
                    packet = ({"choices": [], **receipt} if protocol == "chat" else
                              {"type": "response.completed", "response": receipt})
                raw = json.dumps(packet).encode()
                if stream:
                    raw = b"data: " + raw + b"\n\n"
                request = MagicMock()
                request.json = AsyncMock(return_value={"model": "fixture-model", "stream": stream})
                request.is_disconnected = AsyncMock(return_value=False)
                with patch.object(proxy_usage_shadow, "get_settings", return_value=SimpleNamespace(
                        proxy_usage_shadow_enabled=True)), patch.object(proxy_usage_shadow, "SessionLocal", sessions), \
                        patch.object(ai_proxy.model_catalog, "usable", AsyncMock(return_value=[{"name": "fixture-model"}])), \
                        patch.object(ai_proxy, "_resolve_catalog", AsyncMock(return_value=conf)), \
                        patch.object(ai_proxy.multimodal_proxy, "open_request", AsyncMock(return_value=FakeResponse(raw))):
                    response = await endpoint(request=request, session=None, client=client)
                    if stream:
                        chunks = [chunk async for chunk in response.body_iterator]
                        self.assertEqual(b"".join(chunks), ai_proxy.OPEN_KEEPALIVE_COMMENT + raw)
                    else:
                        self.assertEqual(response.body, raw)
                    await response.background()
        async with sessions() as session:
            rows = list(await session.scalars(select(ProxyUsageObservation)))
            self.assertEqual(len(rows), 4)
            for row in rows:
                self.assertEqual((row.agent, row.funding, row.counts), ("qwen", "personal", {"total": 1200}))
                self.assertEqual(row.evidence, "reported")
                self.assertEqual(len(row.provider_response_hash), 64)


if __name__ == "__main__":
    unittest.main()
