"""Validate bounded local Agent archives against the owning Runner generation."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat

from . import runner_event_scope


def stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def records(root, path, limit):
    # Reject links, junctions, devices, replacement and concurrent writes. No
    # archive path is taken from the desktop, a model response or a tool event.
    if not path.is_relative_to(root) or path.resolve(strict=True) != path:
        raise ValueError("Invalid native archive location")
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise ValueError("Invalid native archive")
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                           getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)), "rb") as stream:
        if stamp(os.fstat(stream.fileno())) != stamp(before):
            raise ValueError("Archive replaced")
        remaining = limit
        while line := stream.readline(remaining + 1):
            remaining -= len(line)
            if remaining < 0:
                raise ValueError("Archive exceeds its read boundary")
            yield json.loads(line)
        if stamp(os.fstat(stream.fileno())) != stamp(before) or stamp(path.lstat()) != stamp(before):
            raise ValueError("Archive changed")


def generation(store, ref, revision, cli):
    if not isinstance(ref, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", ref) or type(revision) is not int:
        raise ValueError("Invalid native history request")
    root = Path(store).parent.resolve(strict=True)
    file = root / "local-runs" / ref / "meta.json"
    before = stamp(file.lstat())
    (meta,) = records(root, file, 2 * 1024 * 1024)
    if (meta.get("ref") != ref or meta.get("cli") != cli or meta.get("seq") != revision
            or not runner_event_scope.is_local(meta, ref) or not meta.get("ws")):
        raise ValueError("Native history generation mismatch")
    directory = file.parent.stat()
    binding = hashlib.sha256(json.dumps([str(root), directory.st_dev, directory.st_ino, ref,
                                        meta.get("cliSid"), meta["ws"], meta.get("firstStarted")]).encode()).hexdigest()
    return root, file, before, meta, {"ref": ref, "revision": revision, "binding": binding}
