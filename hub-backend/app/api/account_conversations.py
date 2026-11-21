"""Source-device recovery of legacy local conversation records."""
from __future__ import annotations

import logging
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from ..account_conversation_models import (
    AccountConversation,
    AccountConversationCursor,
    AccountConversationMessage,
)
from ..db import SessionLocal, get_session
from ..deps import current_client, identity_only
from ..models import Client
from ..realtime import hub

router = APIRouter(prefix="/api/v1/account-conversations", tags=["account-conversations"])

_MAX_DIRECTORY = 100
_MAX_TRANSCRIPT = 100
log = logging.getLogger("uvicorn.error")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _publish_account_update(owner: str, row: AccountConversation) -> None:
    """Wake only the source device after a legacy record changes.

    The event contains only an invalidation hint.  Clients must re-read the
    account directory/transcript with their normal authorization, so a stale
    or forged event can never grant access or become the source of truth.
    """
    try:
        async with SessionLocal() as notify_session:
            device_ids = list((await notify_session.scalars(select(Client.id).where(
                Client.user_ref == owner,
                Client.id == row.source_client_id,
                Client.auth_state == "active",
            ))).all())
        event = {
            "type": "account-conversation",
            "conversationId": row.id,
            "revision": int(row.revision or 0),
            "sourceRevision": int(row.source_revision or 0),
            "state": row.state,
            "deleted": bool(row.deleted),
        }
        await asyncio.gather(*(
            hub.publish(str(device_id), event, user_id=owner)
            for device_id in device_ids
        ), return_exceptions=True)
    except Exception as exc:  # noqa: BLE001 - a wake-up must not fail a committed sync
        log.warning("账号会话实时通知失败: %s", type(exc).__name__)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _owner(client: Client) -> str:
    owner = str(client.user_ref or "").strip()
    if not owner:
        raise HTTPException(status_code=403, detail="设备尚未绑定企业账号")
    return owner


def _content_location(row: AccountConversation) -> str:
    if (row.storage_mode or "legacy") == "legacy":
        return "hub"
    if row.storage_mode != "endpoint":
        return "unknown"
    pointer = row.content_ref
    if pointer is None or isinstance(pointer, dict) and not pointer:
        return "source"
    if isinstance(pointer, dict) and all(isinstance(pointer.get(key), str) and pointer[key]
                                         for key in ("localReplicaId", "targetClientId")) and \
            type(pointer.get("sourceRevision")) is int and pointer["sourceRevision"] == row.source_revision:
        return "replica"
    # Uncertain references must not authorize hiding a potentially independent copy.
    return "unknown"


def _conversation_json(row: AccountConversation, client_id: str) -> dict:
    return {
        "id": row.id,
        "sourceSessionId": row.source_session_id,
        "taskProjectionId": row.task_projection_id or "",
        "sourceClientId": row.source_client_id,
        "sourceDeviceName": row.source_device_name or "",
        "title": row.title or "",
        "state": row.state or "idle",
        "archived": bool(row.archived),
        "deleted": bool(row.deleted),
        "lifecycleRevision": int(row.lifecycle_revision or 0),
        "revision": int(row.revision or 0),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
        "sourceRevision": int(row.source_revision or 0),
        "storageMode": row.storage_mode or "legacy",
        "contentLocation": _content_location(row),
        "canView": True,
        # Legacy account records are recoverable only by their source device.
        "canContinue": not row.deleted,
        "canSend": row.source_client_id == client_id and not row.deleted,
    }


def _message_json(row: AccountConversationMessage) -> dict:
    return {
        "id": row.id,
        "position": int(row.position),
        "role": row.role,
        "text": row.text or "",
        "deleted": bool(row.deleted),
        "revision": int(row.revision or 0),
        "createdAt": _iso(row.created_at),
        "done": bool(row.done),
    }


async def _load_owned(
    conversation_id: str,
    owner: str,
    session: AsyncSession,
    *,
    client_id: str,
    lock: bool = False,
) -> AccountConversation:
    query = select(AccountConversation).where(
        AccountConversation.id == conversation_id,
        AccountConversation.owner_user_id == owner,
        AccountConversation.source_client_id == client_id,
    )
    row = await session.scalar(query.with_for_update() if lock else query)
    if row is None:
        # Do not reveal whether another account owns the id.
        raise HTTPException(status_code=404, detail="会话不存在或无权访问")
    return row


async def _next_directory_revision(owner: str, session: AsyncSession) -> int:
    cursor = await session.scalar(
        select(AccountConversationCursor)
        .where(AccountConversationCursor.owner_user_id == owner)
        .with_for_update()
    )
    if cursor is None:
        cursor = AccountConversationCursor(owner_user_id=owner, revision=0)
        session.add(cursor)
        await session.flush()
    cursor.revision = int(cursor.revision or 0) + 1
    return cursor.revision


@router.get("")
@identity_only
async def list_account_conversations(
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=_MAX_DIRECTORY, ge=1, le=_MAX_DIRECTORY),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    owner = _owner(client)
    rows = list((await session.scalars(
        select(AccountConversation)
        .where(AccountConversation.owner_user_id == owner, AccountConversation.source_client_id == client.id,
               AccountConversation.revision > after)
        .order_by(AccountConversation.revision.asc(), AccountConversation.id.asc())
        .limit(limit + 1)
    )).all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    cursor = rows[-1].revision if rows else after
    counts = dict((await session.execute(
        select(AccountConversationMessage.conversation_id, func.count())
        .where(AccountConversationMessage.conversation_id.in_([row.id for row in rows]),
               AccountConversationMessage.deleted.is_(False))
        .group_by(AccountConversationMessage.conversation_id)
    )).all()) if rows else {}
    return {
        "items": [{**_conversation_json(row, client.id), "messageCount": row.message_count if row.storage_mode == "endpoint" else counts.get(row.id, 0)}
                  for row in rows],
        "cursor": int(cursor),
        "hasMore": has_more,
    }


@router.get("/{conversation_id}/messages")
async def list_account_conversation_messages(
    conversation_id: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=_MAX_TRANSCRIPT, ge=1, le=_MAX_TRANSCRIPT),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = await _load_owned(conversation_id, _owner(client), session, client_id=client.id)
    if row.storage_mode == "endpoint":
        from ..services import account_endpoint_history
        return await account_endpoint_history.page(session, client, row, after, limit)
    messages = list((await session.scalars(
        select(AccountConversationMessage)
        .where(
            AccountConversationMessage.conversation_id == row.id,
            AccountConversationMessage.revision > after,
        )
        .order_by(AccountConversationMessage.revision.asc(), AccountConversationMessage.id.asc())
        .limit(limit + 1)
    )).all())
    has_more = len(messages) > limit
    messages = messages[:limit]
    cursor = messages[-1].revision if messages else after
    return {
        "conversation": _conversation_json(row, client.id),
        "items": [_message_json(item) for item in messages],
        "cursor": int(cursor),
        "hasMore": has_more,
    }


@router.get("/{conversation_id}/source")
async def account_conversation_source(
    conversation_id: str,
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    row = await _load_owned(conversation_id, _owner(client), session, client_id=client.id)
    return {
        "conversation": _conversation_json(row, client.id),
        "sourceEpoch": row.source_epoch,
        "sourceRevision": int(row.source_revision or 0),
    }


@router.post("/{conversation_id}/lifecycle")
async def update_account_conversation_lifecycle(
    conversation_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Preserve source-device lifecycle intent independently of retained content."""
    action = body.get("action")
    if not isinstance(action, str) or action not in {"archive", "restore", "delete"}:
        raise HTTPException(status_code=422, detail="会话操作必须为 archive、restore 或 delete")
    expected_revision = body.get("expectedRevision")
    if type(expected_revision) is not int or expected_revision < 1:
        raise HTTPException(status_code=422, detail="请提供有效的会话目录版本")
    owner = _owner(client)
    # Keep the legacy row -> account cursor lock order for concurrent recovery
    # operations issued by the source device.
    row = await _load_owned(conversation_id, owner, session, client_id=client.id, lock=True)
    if row.deleted and action != "delete":
        raise HTTPException(status_code=410, detail={
            "code": "ACCOUNT_CONVERSATION_DELETED",
            "message": "会话已删除，无法归档或恢复",
            "conversation": _conversation_json(row, client.id),
        })
    reached = bool(row.deleted) if action == "delete" else bool(row.archived) == (action == "archive")
    if reached and int(row.lifecycle_revision or 0) > 0:
        # A lost receipt may be retried with the old revision, but this is only
        # a read: it must never reverse a newer archive/restore/delete action.
        return {"ok": True, "conversation": _conversation_json(row, client.id)}
    if expected_revision != int(row.revision or 0):
        raise HTTPException(status_code=409, detail={
            "code": "ACCOUNT_CONVERSATION_CHANGED",
            "message": "会话已更新，请刷新后重试",
            "conversation": _conversation_json(row, client.id),
        })
    # SQLite does not implement SELECT FOR UPDATE. Claim the observed version
    # with an explicit conditional write on every supported database before
    # allocating a directory revision. ORM dirty-field updates could otherwise
    # acknowledge a restore without writing archived=False from a stale object.
    changes = {"deleted": True} if action == "delete" else {"archived": action == "archive"}
    try:
        changed = await session.execute(update(AccountConversation).where(
            AccountConversation.id == conversation_id,
            AccountConversation.owner_user_id == owner,
            AccountConversation.revision == expected_revision,
        ).values(**changes).execution_options(synchronize_session=False))
    except OperationalError as exc:
        await session.rollback()
        if session.get_bind().dialect.name == "sqlite" and any(
                reason in str(exc.orig).lower() for reason in ("locked", "busy")):
            raise HTTPException(status_code=409, detail="会话状态更新发生并发冲突，请刷新后重试") from exc
        raise
    if changed.rowcount != 1:
        await session.rollback()
        latest = await _load_owned(conversation_id, owner, session, client_id=client.id)
        raise HTTPException(status_code=409, detail={
            "code": "ACCOUNT_CONVERSATION_CHANGED",
            "message": "会话已更新，请刷新后重试",
            "conversation": _conversation_json(latest, client.id),
        })
    await session.refresh(row)
    # Even a first explicit restore of an active row records intent, allowing
    # clients to distinguish it from an old source snapshot's default false.
    row.revision = await _next_directory_revision(owner, session)
    row.lifecycle_revision = row.revision
    row.updated_at = _now()
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="会话状态更新发生并发冲突，请刷新后重试") from exc
    await _publish_account_update(owner, row)
    return {"ok": True, "conversation": _conversation_json(row, client.id)}


@router.post("/sync")
async def sync_account_conversation(client: Client = Depends(current_client)):
    """Retire automatic local history publication without removing old copies."""
    _owner(client)
    raise HTTPException(status_code=410, detail={
        "code": "LOCAL_CONVERSATION_SYNC_DISABLED",
        "message": "PC 本地会话不再同步到账号目录，请更新客户端；原有记录仍保留在来源电脑和历史存储中。",
    })


@router.post("/branches/{conversation_id}")
async def branch_account_conversation(
    conversation_id: str,
    client: Client = Depends(current_client),
):
    """Retire branching retained PC history through Hub; explicit handoff is separate."""
    _owner(client)
    raise HTTPException(status_code=410, detail={
        "code": "LOCAL_CONVERSATION_BRANCH_DISABLED",
        "message": "本地会话不再经 Hub 分支，请在来源设备显式转云或使用设备直连迁移。",
    })
