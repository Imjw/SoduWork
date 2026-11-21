"""Read Qwen's native tool-cancellation receipts for interrupted local writes."""

import os
import uuid

from . import native_history_archive as archive


def _not_started(session, records, workspace, calls):
    confirmed, ambiguous, seen_rows = set(), set(), set()
    previous = None
    for row in records:
        # Never combine sibling branches, copied sessions or model-authored tool claims.
        row_id = row.get("uuid")
        if (not isinstance(row_id, str) or not row_id or row_id in seen_rows or row.get("parentUuid") != previous
                or row.get("sessionId") != session or row.get("cwd") != workspace):
            raise ValueError("Invalid Qwen session lineage")
        if not seen_rows and (row.get("type"), row.get("subtype"), row.get("provenance")) != ("system", "session_model", "system"):
            raise ValueError("Invalid Qwen session header")
        seen_rows.add(row_id)
        previous = row_id
        if (row.get("type"), row.get("subtype"), row.get("provenance")) != ("system", "ui_telemetry", "system"):
            continue
        event = row.get("systemPayload", {}).get("uiEvent", {})
        call = event.get("callId")
        if call not in calls or event.get("event.name") != "tool_lifecycle":
            continue
        if (call in confirmed or event.get("v") != 1 or event.get("kind") != "tool"
                or event.get("sessionId") != session or event.get("toolName") != "write_file"
                or event.get("phase") != "ended" or event.get("outcome") != "cancelled"
                or event.get("executionStatus") != "not_started" or type(event.get("endedAt")) is not int
                or event["endedAt"] <= 0 or str(uuid.UUID(event["executionId"])) != event["executionId"]):
            ambiguous.add(call)
        else:
            confirmed.add(call)
    return sorted(confirmed - ambiguous)


def lookup(store, request):
    """Return exact cancelled-before-start write IDs. Do not grant a new permission."""
    try:
        calls = request.get("calls")
        if not isinstance(calls, list) or not 0 < len(calls) <= 1024:
            return {}
        if not all(isinstance(call, str) and 0 < len(call) <= 360 for call in calls) or len(set(calls)) != len(calls):
            return {}
        root, file, before, meta, envelope = archive.generation(store, request.get("ref"), request.get("revision"), "qwen")
        if meta.get("failureKind") != "access_reauthorization" or meta.get("state") != "interrupted":
            return {}
        session, workspace = meta["cliSid"], meta["ws"]
        if str(uuid.UUID(session)) != session or not os.path.isabs(workspace):
            return {}
        # Qwen Storage.sanitizeCwd uses a JS regex (one dash per UTF-16 code unit).
        cwd = workspace.lower() if os.name == "nt" else workspace
        key = "".join(
            char if char.isascii() and char.isalnum() else "-" * (2 if ord(char) > 0xffff else 1) for char in cwd)
        native = root / ".qwen" / "projects" / key / "chats" / (session + ".jsonl")
        if native.resolve() != native:
            return {}
        try:
            native.lstat()
        except FileNotFoundError:
            result = {**envelope, "archiveMissing": True, "callIds": []}
        else:
            result = {**envelope, "callIds": _not_started(session, archive.records(root, native, 128 * 1024 * 1024),
                                                          workspace, set(calls))}
        return result if archive.stamp(file.lstat()) == before else {}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError, RecursionError, RuntimeError):
        return {}
