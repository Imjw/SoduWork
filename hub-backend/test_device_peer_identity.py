"""Synthetic enrollment and certificate checks; no business identities or keys."""
import base64
import os
import time
import unittest
from unittest.mock import patch
from importlib import import_module

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "device-peer-isolated-test-only")
os.environ.setdefault("ADMIN_PASS", "device-peer-isolated-test-only")

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy import create_engine, inspect, text
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.api import device_peer_identity as api
from app.db import Base, get_session
from app.deps import authenticated_client
from app.models import Client, ClientPeerIdentity, User
from app.services import device_peer_identity as service


def request_body(key, device="peer-desktop", role="desktop", issued_at=None):
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    body = {"publicKey": base64.b64encode(public).decode(), "role": role,
            "issuedAt": int(time.time()) if issued_at is None else issued_at}
    body["proof"] = base64.b64encode(key.sign(service.proof_text(
        device, role, body["publicKey"], body["issuedAt"]).encode(), ec.ECDSA(hashes.SHA256()))).decode()
    return body


class DevicePeerIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                Client.__table__, User.__table__, ClientPeerIdentity.__table__]))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.sessions()
        self.device_secret = "isolated-peer-device-credential-over-32-characters"
        self.client = Client(id="peer-desktop", user_ref="peer-owner", auth_state="active", platform="darwin/arm64",
                             secret_hash=service.device_auth.hash_secret(self.device_secret))
        self.user = User(id="peer-owner", username="peer-owner", password_hash="unused", is_active=True)
        self.session.add_all([self.client, self.user])
        await self.session.commit()
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.app = FastAPI()
        self.app.include_router(api.router)
        async def session_override():
            yield self.session
        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[authenticated_client] = lambda: self.client
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://peer-test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.session.close()
        await self.engine.dispose()

    async def issue(self, body=None):
        return await self.http.post("/api/v1/client-auth/peer-identity", json=body or request_body(self.key),
                                    headers={"X-Device-Key": self.device_secret})

    async def test_session_without_native_device_key_cannot_enroll_peer_key(self):
        response = await self.http.post("/api/v1/client-auth/peer-identity", json=request_body(self.key))
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(await self.session.get(ClientPeerIdentity, self.client.id))

    async def test_certificate_binds_authenticated_account_device_key_and_role(self):
        response = await self.issue()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        cert = x509.load_pem_x509_certificate(data["certificate"].encode())
        ca = x509.load_pem_x509_certificate(data["authority"].encode())
        ca.public_key().verify(cert.signature, cert.tbs_certificate_bytes)
        self.assertEqual(cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value, self.client.id)
        self.assertEqual(cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)[0].value, self.user.id)
        self.assertEqual(cert.subject.get_attributes_for_oid(NameOID.ORGANIZATION_NAME)[0].value, "soduwork-peer-desktop")
        self.assertEqual(cert.public_key().public_numbers(), self.key.public_key().public_numbers())
        self.assertLessEqual(data["expiresAt"] / 1000 - time.time(), 1800)
        self.assertNotIn("privateKey", data)

    async def test_public_key_cannot_be_replaced_even_with_new_key_possession(self):
        self.assertEqual((await self.issue()).status_code, 200)
        response = await self.issue(request_body(ec.generate_private_key(ec.SECP256R1())))
        self.assertEqual(response.status_code, 409)
        row = await self.session.get(ClientPeerIdentity, self.client.id)
        self.assertEqual(row.public_key, request_body(self.key)["publicKey"])

    async def test_mobile_role_cannot_be_promoted_by_editing_platform(self):
        self.client.platform = "ios"
        await self.session.commit()
        self.assertEqual((await self.issue(request_body(self.key, role="mobile"))).status_code, 200)
        self.client.platform = "darwin"
        await self.session.commit()
        self.assertEqual((await self.issue()).status_code, 409)

    async def test_mobile_cannot_initially_claim_desktop(self):
        self.client.platform = "android"
        await self.session.commit()
        self.assertEqual((await self.issue()).status_code, 403)

    async def test_unknown_platform_is_not_a_peer_source(self):
        self.client.platform = "web"
        await self.session.commit()
        self.assertEqual((await self.issue()).status_code, 403)

    async def test_signature_cannot_be_replayed_as_other_role_or_device(self):
        for body in (request_body(self.key, device="other-device"),
                     {**request_body(self.key), "role": "mobile"},
                     {**request_body(self.key), "proof": "invalid"}):
            self.assertEqual((await self.issue(body)).status_code, 422)

    async def test_stale_proof_is_rejected(self):
        self.assertEqual((await self.issue(request_body(self.key, issued_at=int(time.time()) - 120))).status_code, 422)

    async def test_revoked_owner_cannot_receive_certificate(self):
        self.user.is_active = False
        await self.session.commit()
        with self.assertRaises(service.device_auth.DeviceAuthError):
            await service.issue(self.session, self.client, request_body(self.key))

    async def test_missing_login_is_rejected(self):
        del self.app.dependency_overrides[authenticated_client]
        self.assertEqual((await self.issue()).status_code, 401)

    async def test_real_device_session_requires_both_credentials_and_current_authorization(self):
        del self.app.dependency_overrides[authenticated_client]
        token = service.device_auth.issue_session(self.client)[0]
        headers = {"Authorization": "Device " + token, "X-Device-Key": self.device_secret}
        response = await self.http.post("/api/v1/client-auth/peer-identity", json=request_body(self.key), headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        response = await self.http.post("/api/v1/client-auth/peer-identity", json=request_body(self.key),
                                        headers={**headers, "X-Device-Key": "wrong-device-credential"})
        self.assertEqual(response.status_code, 401)
        self.client.auth_version += 1
        await self.session.commit()
        response = await self.http.post("/api/v1/client-auth/peer-identity", json=request_body(self.key), headers=headers)
        self.assertEqual(response.status_code, 401)

    async def test_renewal_keeps_ca_and_public_identity(self):
        one, two = (await self.issue()).json(), (await self.issue()).json()
        self.assertEqual(one["authority"], two["authority"])
        self.assertEqual(one["keyFingerprint"], two["keyFingerprint"])
        self.assertNotEqual(one["certificate"], two["certificate"])


class PeerIdentityMigrationTests(unittest.TestCase):
    def test_upgrade_matches_model_and_downgrade_preserves_other_data(self):
        migration = import_module("migrations.versions.0093_device_peer_identity")
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.begin() as connection:
                connection.execute(text("CREATE TABLE client (id TEXT PRIMARY KEY)"))
                connection.execute(text("INSERT INTO client VALUES ('preserved-device')"))
                with Operations.context(MigrationContext.configure(connection)):
                    migration.upgrade()
                    self.assertEqual({row["name"] for row in inspect(connection).get_columns("client_peer_identity")},
                                     set(ClientPeerIdentity.__table__.columns.keys()))
                    migration.downgrade()
                self.assertEqual(connection.scalar(text("SELECT id FROM client")), "preserved-device")
        finally:
            engine.dispose()

    def test_downgrade_cannot_erase_enrolled_key_or_role(self):
        migration = import_module("migrations.versions.0093_device_peer_identity")
        engine = create_engine("sqlite:///:memory:")
        try:
            with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                connection.execute(text("INSERT INTO client_peer_identity VALUES ('fixture-device','mobile','fixture-public-key')"))
                with self.assertRaisesRegex(RuntimeError, "enrolled peer keys"):
                    migration.downgrade()
                self.assertEqual(connection.scalar(text("SELECT role FROM client_peer_identity")), "mobile")
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
