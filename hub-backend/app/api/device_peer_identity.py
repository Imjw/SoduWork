"""Issue public peer credentials during an authenticated login phase."""
from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import authenticated_client
from ..models import Client
from ..services import device_peer_identity

router = APIRouter(prefix="/api/v1/client-auth", tags=["client-auth"])


@router.post("/peer-identity")
async def issue(body: dict = Body(), client: Client = Depends(authenticated_client),
                session: AsyncSession = Depends(get_session),
                x_device_key: str = Header(default="", alias="X-Device-Key")):
    # A renderer's short-lived account token cannot enroll a replacement native key.
    if not device_peer_identity.device_auth.secret_matches(client, x_device_key):
        raise HTTPException(401, "设备直连登记需要本机设备凭据")
    try:
        return await device_peer_identity.issue(session, client, body)
    except device_peer_identity.device_auth.DeviceAuthError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
