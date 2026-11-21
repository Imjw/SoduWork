"""Generate disposable TLS identities for real local socket contract tests."""
import asyncio
import json
import os
from pathlib import Path
import sys

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "device-peer-isolated-test-only"
os.environ["ADMIN_PASS"] = "device-peer-isolated-test-only"

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.db import Base
from app.models import Client, ClientPeerIdentity, User
from app.services.device_peer_identity import issue
from test_device_peer_identity import request_body


async def main():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
            Client.__table__, User.__table__, ClientPeerIdentity.__table__]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    fixtures = {}
    async with sessions() as session:
        if sys.argv[1] == "--issue":
            request = json.loads(Path(sys.argv[2]).read_text())
            owner = User(id="peer-owner", username="peer-owner", password_hash="unused", is_active=True)
            client = Client(id="peer-source", user_ref=owner.id, auth_state="active", platform="darwin")
            session.add_all([owner, client])
            await session.commit()
            result = await issue(session, client, request)
            Path(sys.argv[3]).write_text(json.dumps(result))
            await session.close()
            await engine.dispose()
            return
        for owner in ("peer-owner", "other-owner"):
            session.add(User(id=owner, username=owner, password_hash="unused", is_active=True))
        for device, role, owner in (("peer-source", "desktop", "peer-owner"),
                                    ("peer-target", "desktop", "peer-owner"),
                                    ("peer-third", "desktop", "peer-owner"),
                                    ("peer-mobile", "mobile", "peer-owner"),
                                    ("peer-foreign", "desktop", "other-owner")):
            client = Client(id=device, user_ref=owner, auth_state="active", platform="ios" if role == "mobile" else "darwin")
            session.add(client)
            await session.commit()
            key = ec.generate_private_key(ec.SECP256R1())
            result = await issue(session, client, request_body(key, device, role))
            fixtures[device] = {**result, "scope": device + ":" + owner, "hub": "https://peer.invalid",
                "privateKey": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()).decode()}
    target = Path(sys.argv[1])
    target.write_text(json.dumps(fixtures))
    target.chmod(0o600)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
