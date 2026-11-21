"""Purpose-isolated certificates; Hub receives identity/public keys, never peer data."""
from __future__ import annotations

import base64
import hashlib
import re
import time
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from ..config import get_settings
from ..models import ClientPeerIdentity
from . import device_auth

TTL_SECONDS = 1800
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")


def authority():
    # Domain separation keeps this CA unrelated to Hub bearer-token signing.
    seed = HKDF(algorithm=hashes.SHA256(), length=32,
                salt=b"SoduWork direct peer identity v1",
                info=b"certificate authority\0" + get_settings().hub_public_url.rstrip("/").encode()).derive(get_settings().auth_secret.encode())
    key = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SoduWork peer identity v1")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(datetime(2020, 1, 1, tzinfo=timezone.utc))
            .not_valid_after(datetime(2100, 1, 1, tzinfo=timezone.utc))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .sign(key, None))
    return key, cert


def proof_text(device_id, role, public_key, issued_at):
    return f"soduwork-peer-key/v1\n{device_id}\n{role}\n{issued_at}\n{public_key}"


async def issue(session, client, body):
    await device_auth.assert_active_owner(session, client)
    role = body.get("role")
    if role not in {"desktop", "mobile"}:
        raise HTTPException(422, "设备直连角色无效")
    if not _ID.fullmatch(client.id) or not _ID.fullmatch(str(client.user_ref or "")):
        raise HTTPException(422, "设备直连身份格式无效")
    expected_owner = client.user_ref
    expected_version = client.auth_version
    try:
        if set(body) != {"role", "publicKey", "issuedAt", "proof"} or not isinstance(body["proof"], str) or len(body["proof"]) > 256:
            raise ValueError("Invalid proof fields")
        public = str(body["publicKey"])
        if len(public) > 256 or type(body["issuedAt"]) is not int or abs(time.time() - body["issuedAt"]) > 60:
            raise ValueError("Invalid key proof")
        raw = base64.b64decode(public, validate=True)
        key = serialization.load_der_public_key(raw)
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("Invalid peer key")
        canonical = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if raw != canonical:
            raise ValueError("Noncanonical peer key")
        key.verify(base64.b64decode(body["proof"], validate=True),
                   proof_text(client.id, role, public, body["issuedAt"]).encode(), ec.ECDSA(hashes.SHA256()))
    except Exception as exc:
        raise HTTPException(422, "设备直连公钥证明无效") from exc
    row = await session.get(ClientPeerIdentity, client.id)
    if row is None:
        platform = str(client.platform or "").split("/", 1)[0].lower()
        expected = "desktop" if platform in {"darwin", "linux", "win32"} else "mobile" if platform in {"android", "ios", "mobile"} else ""
        if role != expected:
            raise HTTPException(403, "登记的设备类型不允许此直连角色")
        # This is an application enrollment role, not OS hardware attestation.
        row = ClientPeerIdentity(client_id=client.id, role=role, public_key=public)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            row = await session.get(ClientPeerIdentity, client.id)
    if row is None or row.role != role or row.public_key != public:
        raise HTTPException(409, "已登记的直连公钥或设备角色不匹配；未替换原身份")
    await session.refresh(client)
    await device_auth.assert_active_owner(session, client)
    if client.user_ref != expected_owner or client.auth_version != expected_version:
        raise HTTPException(409, "设备所属账号已变化，请重新登录")
    now = datetime.now(timezone.utc)
    ca_key, ca = authority()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, client.id),
                      x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, client.user_ref),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "soduwork-peer-" + row.role)])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(ca.subject)
            .public_key(key).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(seconds=30))
            .not_valid_after(now + timedelta(seconds=TTL_SECONDS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, None))
    pem = lambda value: value.public_bytes(serialization.Encoding.PEM).decode()
    return {"certificate": pem(cert), "authority": pem(ca), "expiresAt": int((now + timedelta(seconds=TTL_SECONDS)).timestamp() * 1000),
            "deviceId": client.id, "accountId": client.user_ref, "role": row.role,
            "keyFingerprint": hashlib.sha256(canonical).hexdigest()}
