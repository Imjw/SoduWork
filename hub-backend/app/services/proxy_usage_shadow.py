"""Best-effort observations of OpenAI-compatible proxy responses. Never a quota source."""
import asyncio
import hashlib
import json
import logging

from ..config import get_settings
from ..db import SessionLocal
from ..models import ProxyUsageObservation

log = logging.getLogger(__name__)
_MAX_EVENT = 256 * 1024
_MAX_COUNT = 2**63 - 1


class UsageEvidence:
    def __init__(self, protocol):
        self.protocol = protocol
        self.counts = {}
        self.status = "unknown"
        self.provider_response_hash = ""
        self._line = bytearray()
        self._data = bytearray()
        self._skip_event = False

    def _remember_id(self, obj):
        response_id = obj.get("id")
        if not self.provider_response_hash and isinstance(response_id, str) and 0 < len(response_id) <= 256:
            self.provider_response_hash = hashlib.sha256(response_id.encode("utf-8", "surrogatepass")).hexdigest()

    def observe(self, obj):
        if not isinstance(obj, dict):
            return
        self._remember_id(obj)
        if not isinstance(obj.get("usage"), dict):
            return
        usage = obj["usage"]
        inp, out = (("input_tokens", "output_tokens") if self.protocol == "responses"
                    else ("prompt_tokens", "completion_tokens"))
        fields = {"input": usage.get(inp), "output": usage.get(out), "total": usage.get("total_tokens")}
        for key, name, detail, alias, nested_alias in (
                (inp, "cached", "cached_tokens", "inputTokensDetails", "cachedTokens"),
                (out, "reasoning", "reasoning_tokens", "outputTokensDetails", "reasoningTokens")):
            details = usage.get(key + "_details")
            if not isinstance(details, dict):
                details = usage.get(alias)
            if isinstance(details, dict):
                fields[name] = details.get(detail, details.get(nested_alias))
        counts = {key: value for key, value in fields.items() if value is not None}
        if any(type(value) is not int or not 0 <= value <= _MAX_COUNT for value in counts.values()):
            self.status = "conflict"
            return
        if "input" in counts and "output" in counts:
            calculated = counts["input"] + counts["output"]
            if counts.setdefault("total", calculated) != calculated or calculated > _MAX_COUNT:
                self.status = "conflict"
                return
        for subset, parent in (("cached", "input"), ("reasoning", "output"), ("input", "total"), ("output", "total")):
            if subset in counts and parent in counts and counts[subset] > counts[parent]:
                self.status = "conflict"
                return
        if "total" not in counts or self.status == "conflict":
            return
        if self.counts and self.counts != counts:
            self.status = "conflict"
            return
        self.counts = counts
        self.status = "reported"

    def _stream_event(self, raw):
        try:
            obj = json.loads(raw)
        except (ValueError, RecursionError):
            return
        if not isinstance(obj, dict):
            return
        if self.protocol == "responses":
            if obj.get("type") == "response.completed":
                self.observe(obj.get("response"))
            elif obj.get("type") == "response.created" and isinstance(obj.get("response"), dict):
                self._remember_id(obj["response"])
        elif obj.get("choices") == []:
            self.observe(obj)
        elif isinstance(obj.get("choices"), list):
            self._remember_id(obj)

    def feed(self, chunk):
        """Consume SSE data lines without retaining an oversized model response."""
        offset = 0
        while offset < len(chunk):
            end = chunk.find(b"\n", offset)
            stop = len(chunk) if end == -1 else end
            if len(self._line) + stop - offset > _MAX_EVENT:
                self._skip_event = True
                self._line[:] = b"x"  # An unfinished oversized line is nonempty.
            elif not self._skip_event or not self._line:
                self._line.extend(chunk[offset:stop])
            if end == -1:
                break
            line = self._line.rstrip(b"\r")
            if not line:
                if not self._skip_event and (b'"usage"' in self._data or
                        (not self.provider_response_hash and b'"id"' in self._data)):
                    self._stream_event(self._data)
                self._data.clear()
                self._skip_event = False
            elif not self._skip_event and line.startswith(b"data:"):
                if len(self._data) + len(line) > _MAX_EVENT:
                    self._skip_event = True
                else:
                    self._data.extend(line[5:])
                    self._data.append(10)
            self._line.clear()
            offset = end + 1


class ProxyObservation(UsageEvidence):
    def __init__(self, client, conf, protocol):
        super().__init__(protocol)
        self.row = ProxyUsageObservation(
            client_id=client.id, user_id=str(client.user_ref or ""),
            agent=str(getattr(client, "_proxy_quota_runtime", "") or ""),
            provider=str(conf.get("provider") or ""), model=str(conf["model"]),
            funding=str(conf.get("quotaScope") or "unknown"), protocol=protocol)

    @classmethod
    def start(cls, client, conf, protocol):
        if get_settings().proxy_usage_shadow_enabled:
            return cls(client, conf, protocol)
        return None

    async def save(self, outcome):
        self.row.outcome = outcome
        self.row.evidence = self.status
        self.row.counts = self.counts if self.status == "reported" else {}
        self.row.provider_response_hash = self.provider_response_hash
        try:
            async with asyncio.timeout(1), SessionLocal() as session:
                session.add(self.row)
                await session.commit()
        except Exception as exc:
            # A missing migration, pool pressure or a database outage is never a model error.
            log.warning("Proxy usage shadow write missed (%s)", type(exc).__name__)
