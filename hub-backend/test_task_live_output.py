import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from fastapi import HTTPException
from app.api import tasks
from app.services import ai_exec, execution_sessions, local_stream, runtime_messages


class LiveOutputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # These tests isolate transcript routing; acceptance/access have their
        # own integration coverage and require real database models.
        from app.services import cloud_acceptance, task_access
        acceptance = patch.object(cloud_acceptance, 'status', AsyncMock(return_value=None))
        access = patch.object(task_access, 'can_continue_execution', return_value=True)
        acceptance.start()
        access.start()
        self.addCleanup(acceptance.stop)
        self.addCleanup(access.stop)

    async def test_foreign_execution_is_rejected_before_runner_access(self):
        session = SimpleNamespace(execute=AsyncMock(return_value=Mock(scalar_one_or_none=Mock(return_value=None))))
        with patch.object(tasks, '_view_task', AsyncMock(return_value=SimpleNamespace(id='t'))), patch.object(ai_exec, 'load', AsyncMock()) as load:
            with self.assertRaises(HTTPException) as error:
                await tasks.ai_session_task(tid='t', ref='another-task-ref', since=0, client=None, session=session)
            self.assertEqual(error.exception.status_code, 404)
            load.assert_not_called()

    async def test_exact_ref_and_incremental_cursor_survive_read_through(self):
        row = SimpleNamespace(runner_id='runner', engine='pi', model='test')
        session = SimpleNamespace(execute=AsyncMock(return_value=Mock(scalar_one_or_none=Mock(return_value=row))), commit=AsyncMock())
        with patch.object(tasks, '_view_task', AsyncMock(return_value=SimpleNamespace(id='t'))), patch.object(ai_exec, 'load', AsyncMock(return_value={})), patch.object(ai_exec, 'read_session', AsyncMock(return_value={'ok': True})) as read, patch.object(execution_sessions, 'ingest_live_snapshot', AsyncMock()), patch.object(execution_sessions, 'read_task', AsyncMock(return_value={'ok': True, 'ref': 'r', 'items': []})) as cached:
            await tasks.ai_session_task(tid='t', ref='r', since=401, client=None, session=session)
            read.assert_awaited_once_with({}, 'r', 401, runner_id='runner', limit=400)
            cached.assert_awaited_once_with(session, 't', 'r', 401, limit=400)

    async def test_legacy_dispatch_uses_durable_execution_owner_before_discovery(self):
        session = SimpleNamespace(scalar=AsyncMock(return_value=SimpleNamespace(runner_id='original')))
        with patch.object(tasks, '_view_task', AsyncMock(return_value=SimpleNamespace(id='t'))), \
                patch.object(ai_exec, 'last_dispatch_event', AsyncMock(return_value=SimpleNamespace(detail={'ref': 'r'}))), \
                patch.object(ai_exec, 'load', AsyncMock(return_value={})), \
                patch.object(ai_exec, 'read_session', AsyncMock(return_value={'ok': False})) as read, \
                patch.object(execution_sessions, 'read_task', AsyncMock(return_value={'ok': True, 'last': 7})):
            result = await tasks.ai_session_task(tid='t', ref='', since=7, client=None, session=session)
        read.assert_awaited_once_with({}, 'r', 7, runner_id='original', limit=400)
        self.assertEqual(result['last'], 7)

    def test_pi_tool_identity_error_and_complete_output_are_preserved(self):
        rows = local_stream._items_from({'type': 'tool_execution_end', 'toolCallId': 'call', 'toolName': 'bash', 'isError': True,
            'result': {'content': [{'type': 'text', 'text': 'result' * 900}]}})
        self.assertEqual(rows[0]['callId'], 'call')
        self.assertTrue(rows[0]['isError'])
        self.assertEqual(len(rows[0]['full']), 5400)
        value = execution_sessions._event_api(SimpleNamespace(seq=1, kind='out', tool='bash', text='preview', at=None, detail=rows[0]))
        self.assertEqual(value['full'], rows[0]['full'])
        self.assertEqual(value['callId'], 'call')

    def test_native_tool_receipts_are_visible_in_regular_runner_history(self):
        cases = [
            ('codex', {'type': 'item.completed', 'item': {'type': 'command_execution',
             'id': 'native-1', 'status': 'completed', 'exit_code': 0, 'aggregated_output': 'test output'}}),
            ('opencode', {'type': 'tool_use', 'part': {'tool': 'bash', 'id': 'part-1', 'callID': 'native-1',
             'state': {'status': 'completed', 'input': {'command': 'test'}, 'output': 'test output'}}}),
        ]
        for cli, event in cases:
            with self.subTest(cli=cli):
                rows = local_stream._items_from(event, {'cli': cli})
                self.assertEqual([(r['kind'], r['callId']) for r in rows], [('do', 'native-1'), ('out', 'native-1')])
                self.assertEqual(rows[1]['full'], 'test output')
                self.assertIs(rows[1]['isError'], False)

    def test_incomplete_native_tools_and_private_mcp_fields_do_not_become_public_results(self):
        without_exit = {'id': 'call', 'type': 'command_execution', 'status': 'completed'}
        for event in ({'type': 'item.started', 'item': without_exit}, {'type': 'item.completed', 'item': without_exit}):
            self.assertEqual(runtime_messages.native_tool_results({'cli': 'codex'}, event), [])
        item = {'id': 'mcp', 'type': 'mcp_tool_call', 'status': 'completed', 'result': {
            'content': [{'type': 'text', 'text': 'visible'}], '_meta': {'private': 'not-for-history'}}}
        rows = local_stream._items_from({'type': 'item.completed', 'item': item}, {'cli': 'codex'})
        self.assertEqual(rows[-1]['full'], 'visible')
        self.assertNotIn('not-for-history', str(rows))

    def test_acp_plan_updates_preserve_text_without_starting_an_execution(self):
        from app.services import acp_bridge
        bridge = acp_bridge.AcpBridge([], '.', 'qwen', 'readonly')
        with patch.object(acp_bridge, '_emit') as emit:
            bridge._update({'sessionUpdate': 'plan', 'entries': [{'content': 'Inspect the fixture'}]})
        rows = local_stream._items_from(emit.call_args.args[0], {'cli': 'qwen'})
        self.assertNotIn('do', [r['kind'] for r in rows])
        self.assertIn('Inspect the fixture', rows[0]['text'])

    def test_structured_cloud_preview_metadata_is_public(self):
        value = execution_sessions._event_api(SimpleNamespace(
            seq=2, kind='out', tool='bash', text='ready', at=None,
            detail={'serviceUrl': 'http://192.0.2.20:4173/', 'host': '192.0.2.20',
                    'port': 4173, 'services': [{'url': 'http://192.0.2.20:4173/'}]}))
        self.assertEqual(value['serviceUrl'], 'http://192.0.2.20:4173/')
        self.assertEqual(value['host'], '192.0.2.20')
        self.assertEqual(value['port'], 4173)
        self.assertEqual(value['services'][0]['url'], 'http://192.0.2.20:4173/')
        projected = runtime_messages.public_fields({
            'serviceUrl': 'http://192.0.2.20:4173/', 'host': '192.0.2.20',
            'port': 4173, 'services': [{'url': 'http://192.0.2.20:4173/'}]})
        self.assertEqual(projected['serviceUrl'], 'http://192.0.2.20:4173/')
        self.assertEqual(projected['port'], 4173)


if __name__ == '__main__': unittest.main()
