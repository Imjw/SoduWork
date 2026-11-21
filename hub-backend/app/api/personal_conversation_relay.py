"""Authenticated native-session admission, without creating another task queue."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select, update

from ..account_conversation_models import AccountConversation, PersonalConversationRelay as Relay
from ..db import get_session
from ..deps import current_client, identity_only
from ..models import Client

router = APIRouter(prefix="/api/v1/personal-conversation-relay", tags=["account-conversations"])
PREFIX = "personalConversationRelay"


def now():
    return datetime.now(timezone.utc)


def utc(value):
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def owner(client):
    if not client.user_ref or client.auth_state != "active":
        raise HTTPException(403, "请先登录当前账号")
    return str(client.user_ref)


async def conversation(session, client, cid, *, receipt_only=False):
    row = await session.get(AccountConversation, cid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "会话不存在或当前账号无权访问")
    if not receipt_only and (row.deleted or row.archived):
        raise HTTPException(409, "原会话已关闭，请在来源电脑检查")
    source = await session.get(Client, row.source_client_id)
    if not source or source.auth_state != "active" or source.user_ref != row.owner_user_id:
        raise HTTPException(403, "来源电脑的账号归属已变化")
    return row, source




def public(row):
    return {"id": row.id, "requestId": row.request_id, "conversationId": row.conversation_id,
            "targetClientId": row.source_client_id, "phase": row.phase, "reason": row.reason,
            "nativeSession": True}


async def expire(session, row):
    if row.phase == "prepared" and utc(row.expires_at) <= now():
        await session.execute(update(Relay).where(Relay.id == row.id, Relay.phase == "prepared").values(
            phase="rejected", reason="电脑未及时接收，未自动执行；请确认电脑在线后重新发送", active_conversation_id=None))
        await session.commit()
        await session.refresh(row)
    return row


@router.get("/targets/{cid}")
async def target(cid: str, client=Depends(current_client), session=Depends(get_session)):
    owner(client)
    raise HTTPException(410, "本机会话仅支持设备直连；Hub 不再定位来源电脑")


@router.post("/requests/{request_id}")
async def prepare(request_id: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    owner(client)
    raise HTTPException(410, "本机会话仅支持设备直连；Hub 不再创建或重发续聊")


@router.get("/requests/{request_id}")
async def status(request_id: str, client=Depends(current_client), session=Depends(get_session)):
    rid = str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + client.id + ":" + request_id))
    row = await session.get(Relay, rid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "未找到接力回执")
    await conversation(session, client, row.conversation_id, receipt_only=True)
    return public(await expire(session, row))


@router.post("/requests/{request_id}/resolve")
async def resolve(request_id: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    rid = str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + client.id + ":" + request_id))
    row = await session.get(Relay, rid)
    if not row or row.owner_user_id != owner(client):
        raise HTTPException(404, "未找到接力回执")
    if set(body) != {"checkedOnSourcePC"} or body["checkedOnSourcePC"] is not True:
        raise HTTPException(422, "请先在来源电脑核对实际发送结果")
    source, _ = await conversation(session, client, row.conversation_id, receipt_only=True)
    if row.phase == "closed":
        return public(row)
    if source.state == "responding" or row.phase != "uncertain":
        raise HTTPException(409, "仍在确认或执行中，暂不能关闭回执")
    result = await session.execute(update(Relay).where(Relay.id == rid, Relay.phase == "uncertain").values(
        phase="closed", active_conversation_id=None, reason="用户已在来源电脑核对并关闭回执；未重新发送"))
    await session.commit()
    if result.rowcount != 1:
        raise HTTPException(409, "回执已变化，请重新核对")
    await session.refresh(row)
    return public(row)


@router.post("/poll")
@identity_only
async def poll(client=Depends(current_client), session=Depends(get_session), body: dict = Body(default_factory=dict)):
    owner(client)
    # Upgrade never releases old prepared/claimed instructions for execution.
    return {"requests": [], "discoveryProtocol": 1, "syncDisabled": True}


async def source_request(session, client, rid, *, receipt_only=False):
    row = await session.get(Relay, rid)
    if not row or row.source_client_id != client.id or row.owner_user_id != owner(client):
        raise HTTPException(404, "接力请求不可访问")
    source, _ = await conversation(session, client, row.conversation_id, receipt_only=receipt_only)
    return row, source


@router.post("/claims/{rid}")
async def claim(rid: str, client=Depends(current_client), session=Depends(get_session)):
    owner(client)
    raise HTTPException(410, "Hub 接力执行已停用；请在来源电脑核对历史回执")


@router.post("/acks/{rid}")
async def acknowledge(rid: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    row, _ = await source_request(session, client, rid, receipt_only=True)
    phase = body.get("phase")
    if phase not in {"accepted", "rejected", "uncertain"} or set(body) - {"phase", "reason"}:
        raise HTTPException(422, "接力回执不正确")
    reason = body.get("reason", "")
    if not isinstance(reason, str):
        raise HTTPException(422, "回执说明不正确")
    if row.phase in {"accepted", "rejected"}:
        if phase != row.phase:
            raise HTTPException(409, "接力回执已固定")
        return public(row)
    if row.phase != "claimed":
        raise HTTPException(409, "请先领取接力")
    # Uncertainty never grants permission to retry the external side effect.
    result = await session.execute(update(Relay).where(Relay.id == rid, Relay.phase == "claimed").values(
        phase=phase, reason={"accepted": "来源电脑已确认历史消息被接收", "rejected": "来源电脑已确认历史消息未被接收", "uncertain": "历史发送结果待在来源电脑核实；不会自动重发"}[phase], active_conversation_id=row.conversation_id if phase == "uncertain" else None))
    await session.commit()
    await session.refresh(row)
    if result.rowcount != 1 and row.phase != phase:
        raise HTTPException(409, "接力回执已固定")
    return public(row)
