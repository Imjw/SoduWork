"""Revision-checked sidebar edits; omission never deletes a project."""
import json
import re
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from ..db import get_session
from ..deps import current_client, identity_only
from ..models import Client, Task
from ..account_conversation_models import ConversationProject
from ..conversation_handoff_models import ConversationHandoff
from .account_conversations import _owner

router = APIRouter(prefix="/api/v1/conversation-projects", tags=["conversation-projects"])

def _cloud_member(member, allowed):
    return str(member.get("session") or "") in allowed


async def _cloud_ids(session, owner, values):
    identities = {value.split(":", 1)[1] for value in values
                  if isinstance(value, str) and value.startswith(("task:", "cloud-task:"))}
    if not identities:
        return set()
    committed_handoff = select(ConversationHandoff.id).where(
        ConversationHandoff.task_id == Task.id, ConversationHandoff.owner_user_id == owner,
        ConversationHandoff.phase == "committed").exists()
    rows = await session.scalars(select(Task.id).where(Task.owner_user_id == owner,
        Task.id.in_(identities), or_(Task.origin == "cloud-conversation",
            and_(Task.origin == "conversation-handoff", committed_handoff))))
    return {"cloud-task:" + identity for identity in rows}


def _canonical(value, allowed):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise HTTPException(422, "会话标识无效")
    if value.startswith("task:") or value.startswith("cloud-task:"):
        identity = "cloud-task:" + value.split(":", 1)[1]
        if identity not in allowed:
            raise HTTPException(404, "云端会话不存在或不属于当前账号")
        return {"client": "", "session": identity}
    raise HTTPException(422, "PC 本地会话不再同步到账号分组，请更新客户端")


def _json(row, allowed):
    # Retained native members never become account-visible aliases or opaque IDs.
    ids = [member["session"] for member in json.loads(row.members) if _cloud_member(member, allowed)]
    return {"id": row.id, "name": row.name if ids else "", "revision": row.revision,
            "deleted": row.deleted, "chatIds": list(dict.fromkeys(ids))}


def _visible(row, allowed):
    members = json.loads(row.members)
    return row.deleted or any(_cloud_member(member, allowed) for member in members)


@router.get("")
@identity_only
async def list_projects(client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    owner = _owner(client)
    rows = (await session.scalars(select(ConversationProject).where(
        ConversationProject.owner_user_id == owner).order_by(ConversationProject.id))).all()
    allowed = await _cloud_ids(session, owner,
        [member["session"] for row in rows for member in json.loads(row.members)])
    return {"items": [_json(row, allowed) for row in rows if _visible(row, allowed)]}

@router.put("/{project_id}")
async def save_project(project_id: str, data: dict = Body(...), client: Client = Depends(current_client),
                       session: AsyncSession = Depends(get_session)):
    owner = _owner(client)
    if not re.fullmatch(r"project-[\w-]{1,110}", project_id):
        raise HTTPException(422, "项目标识无效")
    name = str(data.get("name") or "").strip()
    if not name or len(name) > 120:
        raise HTTPException(422, "项目名称需要1至120个字")
    revision = data.get("revision")
    if type(revision) is not int or revision < 0:
        raise HTTPException(422, "缺少项目版本")
    values = data.get("chatIds", [])
    if not isinstance(values, list) or len(values) > 1000:
        raise HTTPException(422, "项目会话数量无效")
    existing = await session.get(ConversationProject, (owner, project_id))
    existing_members = json.loads(existing.members) if existing else []
    allowed = await _cloud_ids(session, owner, values + [member["session"] for member in existing_members])
    members = []
    for value in values:
        member = _canonical(value, allowed)
        if member not in members:
            members.append(member)
    # Cloud membership edits cannot discard retained local history associations.
    if existing and "chatIds" not in data:
        members = existing_members
    else:
        members.extend(member for member in existing_members if not _cloud_member(member, allowed))
    has_cloud = any(_cloud_member(member, allowed) for member in members)
    had_cloud = any(_cloud_member(member, allowed) for member in existing_members)
    if not has_cloud and not existing:
        raise HTTPException(422, "只有包含云端会话的分组才会同步")
    if existing and not had_cloud and not has_cloud and not existing.deleted:
        raise HTTPException(404, "云端会话分组不存在")
    # Clearing the last cloud member publishes a tombstone while keeping native
    # associations in storage. Other devices can remove their stale projection.
    attrs = dict(name=name, revision=revision + 1,
                 deleted=data.get("deleted") is True or not has_cloud,
                 members=json.dumps(members, ensure_ascii=False))
    if existing:
        result = await session.execute(update(ConversationProject).where(
            ConversationProject.owner_user_id == owner, ConversationProject.id == project_id,
            ConversationProject.revision == revision).values(**attrs))
        if result.rowcount != 1:
            await session.rollback()
            raise HTTPException(409, "项目已在其他设备更新，请刷新后重试")
    else:
        if revision != 0:
            raise HTTPException(409, "项目版本已变化，请刷新后重试")
        session.add(ConversationProject(owner_user_id=owner, id=project_id, **attrs))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "项目已在其他设备更新，请刷新后重试")
    row = await session.get(ConversationProject, (owner, project_id), populate_existing=True)
    from ..services.client_domain_events import account_changed
    await account_changed(session, owner, "conversation-projects")
    return _json(row, allowed)
