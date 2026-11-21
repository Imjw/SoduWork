import importlib.util
import hashlib
import json
import uuid
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
import httpx
from sqlalchemy import select, create_engine, inspect
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.db import Base
from app.models import Client, User, AppSetting
from app.services import device_auth
from app.account_conversation_models import AccountConversation, PersonalConversationRelay as Relay
from app.api import personal_conversation_relay as api


class PersonalRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = create_async_engine('sqlite+aiosqlite:///' + str(Path(self.directory.name) / 'relay.db'))
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                Client.__table__, User.__table__, AppSetting.__table__, AccountConversation.__table__, Relay.__table__]))
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.pc = Client(id='pc', name='My PC', user_ref='u1', auth_state='active')
        self.phone = Client(id='phone', user_ref='u1', auth_state='active')
        self.foreign = Client(id='foreign', user_ref='u2', auth_state='active')
        self.source = AccountConversation(id='conversation-1', owner_user_id='u1', source_client_id='pc',
            source_session_id='native-1', source_epoch='e1', source_revision=2, revision=8, state='idle')
        self.session.add_all([self.pc, self.phone, self.foreign, self.source,
            User(id='u1', username='first', display_name='First', is_active=True),
            User(id='u2', username='second', display_name='Second', is_active=True)])
        await self.session.commit()
        await api.poll(client=self.pc, session=self.session)

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.directory.cleanup()

    def body(self, **values):
        return dict(conversationId='conversation-1', targetClientId='pc', expectedRevision=8,
                    instruction='continue locally', **values)

    async def seed_legacy(self, request='m1', phase='prepared'):
        # Represent pre-upgrade records directly; retired APIs cannot create them.
        body = self.body()
        row = Relay(id=str(uuid.uuid5(uuid.NAMESPACE_URL, "personal-relay:" + self.phone.id + ":" + request)),
            owner_user_id='u1', requester_client_id=self.phone.id, source_client_id=self.pc.id,
            conversation_id=self.source.id, active_conversation_id=self.source.id if request == 'm1' else None,
            request_id=request, request_hash=hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
            instruction=body['instruction'], source_epoch='e1', source_revision=2,
            phase=phase, reason='', expires_at=api.now() + timedelta(seconds=60))
        self.session.add(row)
        await self.session.commit()
        return row

    async def gone(self, operation):
        with self.assertRaises(HTTPException) as caught:
            await operation
        self.assertEqual(caught.exception.status_code, 410)

    async def test_target_location_and_new_requests_are_retired_without_writing(self):
        for identity in (self.phone, self.pc, self.foreign):
            await self.gone(api.target('conversation-1', identity, self.session))
            await self.gone(api.target('unknown', identity, self.session))
            await self.gone(api.prepare('new', self.body(), identity, self.session))
        self.assertEqual(list((await self.session.scalars(select(Relay))).all()), [])

    async def test_foreign_account_cannot_read_or_ack_historical_receipts(self):
        row = await self.seed_legacy(phase='claimed')
        for operation in (api.status('m1', self.foreign, self.session),
                          api.acknowledge(row.id, {'phase': 'accepted'}, self.foreign, self.session),
                          api.acknowledge(row.id, {'phase': 'accepted'}, self.phone, self.session)):
            with self.assertRaises(HTTPException) as caught:
                await operation
            self.assertEqual(caught.exception.status_code, 404)
        await self.gone(api.claim(row.id, self.phone, self.session))

    async def test_retired_retry_cannot_replace_existing_request_or_instruction(self):
        row = await self.seed_legacy()
        previous = (row.request_hash, row.instruction, row.source_client_id)
        for body in (self.body(), {**self.body(), 'instruction': 'different'},
                     {**self.body(), 'targetClientId': 'another-pc'}):
            await self.gone(api.prepare('m1', body, self.phone, self.session))
        await self.session.refresh(row)
        self.assertEqual((row.request_hash, row.instruction, row.source_client_id), previous)
        self.assertEqual(len(list((await self.session.scalars(select(Relay))).all())), 1)

    async def test_poll_never_releases_prepared_claimed_or_endpoint_instructions(self):
        from unittest.mock import AsyncMock, patch
        one = await self.seed_legacy('one')
        two = await self.seed_legacy('two', 'claimed')
        two.active_conversation_id = None
        two.content_ref = {'runnerId': 'synthetic', 'scope': 'private'}
        await self.session.commit()
        config = dict(self.pc.config or {})
        with patch('app.services.conversation_content.get_json', new_callable=AsyncMock) as read:
            for protocol in ({}, {'discoveryProtocol': 1}):
                result = await api.poll(self.pc, self.session, protocol)
                self.assertEqual(result, {'requests': [], 'discoveryProtocol': 1, 'syncDisabled': True})
            read.assert_not_awaited()
        await self.session.refresh(self.pc)
        self.assertEqual(self.pc.config, config)
        self.assertEqual(one.phase, 'prepared')
        self.assertEqual(two.phase, 'claimed')

    async def test_claim_never_releases_legacy_work_and_ack_requires_prior_claim(self):
        row = await self.seed_legacy()
        for _ in range(2):
            await self.gone(api.claim(row.id, self.pc, self.session))
        with self.assertRaises(HTTPException):
            await api.acknowledge(row.id, {'phase': 'accepted'}, self.pc, self.session)
        await self.session.refresh(row)
        self.assertEqual(row.phase, 'prepared')

    async def test_historical_ack_is_idempotent_fixed_and_does_not_store_body(self):
        row = await self.seed_legacy(phase='claimed')
        accepted = await api.acknowledge(row.id, {'phase': 'accepted', 'reason': 'must not persist private content'}, self.pc, self.session)
        self.assertEqual(accepted['phase'], 'accepted')
        self.assertNotIn('private content', accepted['reason'])
        self.assertEqual(await api.acknowledge(row.id, {'phase': 'accepted'}, self.pc, self.session), accepted)
        with self.assertRaises(HTTPException):
            await api.acknowledge(row.id, {'phase': 'rejected'}, self.pc, self.session)
        with self.assertRaises(HTTPException):
            await api.acknowledge(row.id, {'phase': 'accepted', 'instruction': 'new'}, self.pc, self.session)
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'accepted')

    async def test_unclaimed_expiry_does_not_execute_after_reconnect(self):
        row = await self.seed_legacy()
        row.expires_at = api.now() - timedelta(seconds=1)
        await self.session.commit()
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'rejected')
        await self.gone(api.claim(row.id, self.pc, self.session))

    async def test_uncertain_resolution_is_explicit_and_never_replays(self):
        row = await self.seed_legacy(phase='claimed')
        with self.assertRaises(HTTPException):
            await api.resolve('m1', {'checkedOnSourcePC': True}, self.phone, self.session)
        await api.acknowledge(row.id, {'phase': 'uncertain'}, self.pc, self.session)
        for body, identity in (({}, self.phone), ({'checkedOnSourcePC': True}, self.foreign)):
            with self.assertRaises(HTTPException):
                await api.resolve('m1', body, identity, self.session)
        self.assertEqual((await api.resolve('m1', {'checkedOnSourcePC': True}, self.phone, self.session))['phase'], 'closed')
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])
        await self.gone(api.claim(row.id, self.pc, self.session))
        await self.gone(api.prepare('second', self.body(), self.phone, self.session))

    async def test_logout_or_reassigned_source_cannot_read_receipts(self):
        row = await self.seed_legacy(phase='claimed')
        self.pc.user_ref = 'u2'
        await self.session.commit()
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])
        with self.assertRaises(HTTPException):
            await api.status('m1', self.phone, self.session)
        with self.assertRaises(HTTPException):
            await api.acknowledge(row.id, {'phase': 'accepted'}, self.pc, self.session)

    async def test_archiving_after_send_does_not_hide_the_historical_receipt(self):
        row = await self.seed_legacy(phase='claimed')
        self.source.archived = True
        await self.session.commit()
        await api.acknowledge(row.id, {'phase': 'accepted'}, self.pc, self.session)
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'accepted')

    async def test_http_device_auth_and_cross_account_boundaries(self):
        row = await self.seed_legacy('http-request', 'claimed')
        application = FastAPI()
        application.include_router(api.router)
        async def database():
            yield self.session
        application.dependency_overrides[api.get_session] = database
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://fixture') as http:
            base = '/api/v1/personal-conversation-relay'
            self.assertEqual((await http.get(base + '/targets/conversation-1')).status_code, 401)
            phone = {'Authorization': 'Device ' + device_auth.issue_session(self.phone)[0]}
            pc = {'Authorization': 'Device ' + device_auth.issue_session(self.pc)[0]}
            foreign = {'Authorization': 'Device ' + device_auth.issue_session(self.foreign)[0]}
            self.assertEqual((await http.get(base + '/targets/conversation-1', headers=foreign)).status_code, 410)
            self.assertEqual((await http.get(base + '/targets/conversation-1', headers=phone)).status_code, 410)
            self.assertEqual((await http.post(base + '/requests/new', headers=phone, json=self.body())).status_code, 410)
            self.assertEqual((await http.post(base + '/claims/' + row.id, headers=pc)).status_code, 410)
            self.assertEqual((await http.post(base + '/acks/' + row.id, headers=phone, json={'phase': 'accepted'})).status_code, 404)
            self.assertEqual((await http.post(base + '/acks/' + row.id, headers=pc, json={'phase': 'accepted'})).status_code, 200)
            self.assertEqual((await http.get(base + '/requests/http-request', headers=phone)).json()['phase'], 'accepted')
            self.assertEqual((await http.get(base + '/requests/http-request', headers=foreign)).status_code, 404)
            self.pc.auth_version += 1
            await self.session.commit()
            self.assertEqual((await http.post(base + '/poll', headers=pc)).status_code, 401)


class MigrationTests(unittest.TestCase):
    def test_upgrade_matches_model_and_downgrade_preserves_other_tables(self):
        spec = importlib.util.spec_from_file_location('relay_migration',
            Path(__file__).resolve().parents[1] / 'migrations/versions/0074_personal_conversation_relay.py')
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        endpoint_spec = importlib.util.spec_from_file_location('endpoint_migration',
            Path(__file__).resolve().parents[1] / 'migrations/versions/0082_endpoint_conversation_content.py')
        endpoint = importlib.util.module_from_spec(endpoint_spec)
        endpoint_spec.loader.exec_module(endpoint)
        engine = create_engine('sqlite://')
        try:
            with engine.begin() as connection:
                connection.exec_driver_sql('CREATE TABLE preserved (id INTEGER PRIMARY KEY)')
                connection.exec_driver_sql('INSERT INTO preserved VALUES (42)')
                connection.exec_driver_sql('CREATE TABLE account_conversation (id TEXT PRIMARY KEY)')
                for table, column in (("automation_execution_event", "detail"),
                                      ("conversation_handoff", "options"),
                                      ("conversation_message_receipt", "payload"),
                                      ("ai_schedule_run", "receipt")):
                    connection.exec_driver_sql(f'CREATE TABLE {table} ({column} TEXT)')
                preserved_tables = inspect(connection).get_table_names()
                original_columns = {"id", "owner_user_id", "requester_client_id", "source_client_id",
                    "conversation_id", "active_conversation_id", "request_id", "request_hash", "instruction",
                    "source_epoch", "source_revision", "phase", "reason", "created_at", "expires_at"}
                with Operations.context(MigrationContext.configure(connection)):
                    migration.upgrade()
                    columns = {row['name'] for row in inspect(connection).get_columns(Relay.__tablename__)}
                    self.assertEqual(columns, original_columns)
                    endpoint.upgrade()
                    columns = {row['name'] for row in inspect(connection).get_columns(Relay.__tablename__)}
                    self.assertEqual(columns, set(Relay.__table__.columns.keys()))
                    endpoint.downgrade()
                    self.assertEqual({row['name'] for row in inspect(connection).get_columns(Relay.__tablename__)}, original_columns)
                    migration.downgrade()
                self.assertEqual(inspect(connection).get_table_names(), preserved_tables)
                self.assertEqual(connection.exec_driver_sql('SELECT id FROM preserved').all(), [(42,)])
        finally:
            engine.dispose()


if __name__ == '__main__':
    unittest.main()
