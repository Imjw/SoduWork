"""Reject retired Hub-mediated reads of device-owned history."""
from fastapi import HTTPException


def _reject(client, row):
    if (client.auth_state != "active" or not client.user_ref
            or row.owner_user_id != client.user_ref or row.source_client_id != client.id):
        raise HTTPException(404, "会话不存在或无权访问")
    raise HTTPException(410, "本地会话不再经 Hub 读取，请在来源设备查看或使用设备直连")


async def page(session, client, row, after=0, limit=100):
    _reject(client, row)


async def context(session, client, row, maximum=1000):
    _reject(client, row)
