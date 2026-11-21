"""Read only exact, local Codex Harness image receipts omitted by older ACP bridges."""

import datetime
import fnmatch
import json
import os
import uuid

from . import native_history_archive as archive

_MAX_ARCHIVE = 128 * 1024 * 1024


def _rollout(root, session):
    thread = uuid.UUID(session)
    if thread.version != 7 or str(thread) != session:
        raise ValueError("Invalid native session")
    # Private rollout directories use the native thread creation date in local
    # time. Cover UTC offsets without scanning other histories or native homes.
    date = datetime.datetime.fromtimestamp((thread.int >> 80) / 1000, datetime.timezone.utc).date()
    found = []
    for offset in (-1, 0, 1):
        folder = root / ".codex-harness" / "sessions" / (date + datetime.timedelta(days=offset)).strftime("%Y/%m/%d")
        if folder.resolve() != folder:
            raise ValueError("Invalid native session directory")
        # glob suppresses directory read errors, which cannot prove absence.
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if fnmatch.fnmatchcase(entry.name, f"rollout-????-??-??T??-??-??-{session}.jsonl"):
                        if found:
                            raise ValueError("Ambiguous native archive")
                        found.append(folder / entry.name)
        except FileNotFoundError:
            continue
    return found[0] if found else None


def lookup(store, request):
    """Return correlated IDs, or confirm the absence of this exact native archive."""
    ref = request.get("ref")
    requested = request.get("calls")
    revision = request.get("revision")
    if not isinstance(requested, list) or not 0 < len(requested) <= 1024:
        return {}
    try:
        paths = {}
        for row in requested:
            call, path = row["callId"], row["path"]
            if not isinstance(call, str) or not 0 < len(call) <= 360 or call in paths:
                return {}
            if not isinstance(path, str) or not 0 < len(path) <= 4096:
                return {}
            paths[call] = path
        root, meta_file, meta_stamp, meta, envelope = archive.generation(store, ref, revision, "codex-harness")
        session = meta.get("cliSid")
        if not isinstance(session, str):
            return {}
        file = _rollout(root, session)
        if not file:
            if archive.stamp(meta_file.lstat()) != meta_stamp:
                return {}
            return {**envelope, "archiveMissing": True, "callIds": []}
        records = archive.records(root, file, _MAX_ARCHIVE)
        header = next(records)
        identity = header.get("payload") or {}
        if (header.get("type") != "session_meta" or identity.get("id") != session
                or identity.get("cwd") != meta["ws"] or identity.get("forked_from_id")):
            return {}
        declared, confirmed, ambiguous = set(), set(), set()
        for row in records:
            if row.get("type") == "session_meta":
                return {}
            if row.get("type") != "response_item":
                continue
            item = row.get("payload") or {}
            call, kind = item.get("call_id"), item.get("type")
            if call not in paths:
                continue
            if kind == "function_call":
                if call in declared or item.get("name") != "view_image":
                    ambiguous.add(call)
                elif json.loads(item.get("arguments", "{}")).get("path") != paths[call]:
                    ambiguous.add(call)
                declared.add(call)
            elif kind == "function_call_output":
                blocks = item.get("output")
                if (call not in declared or call in confirmed or not isinstance(blocks, list) or not blocks
                        or not all(isinstance(b, dict) and b.get("type") == "input_image"
                                   and isinstance(b.get("image_url"), str) and b["image_url"] for b in blocks)):
                    ambiguous.add(call)
                confirmed.add(call)
            else:
                ambiguous.add(call)
        if archive.stamp(meta_file.lstat()) != meta_stamp:
            return {}
        return {**envelope, "callIds": sorted(confirmed - ambiguous)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration, OverflowError, RecursionError, RuntimeError):
        return {}
