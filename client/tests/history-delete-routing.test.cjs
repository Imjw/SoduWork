'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');

async function fixture(t, adapterId = 'pi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-delete-routing-')), app = { getPath: () => root }, actor = identity();
  const auth = require('../main/device-auth');
  t.mock.method(auth, 'identity', () => actor); t.mock.method(auth, 'session', () => actor.session);
  t.mock.method(auth, 'profiles', () => []); t.mock.method(auth, 'localOwner', () => require('../main/platform-connections/runtime.cjs').scope(actor));
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), unexpected = new Promise(resolve => { entered = resolve; });
  const calls = [], flags = new Set(), runs = new Map(), pi = new Map();
  const delayed = async name => { calls.push(name); entered(name); await held; return { ok: true, chats: [] }; };
  const sessionModule = { open: async () => { throw Error('Deletion cannot start a model session'); },
    probe: async () => ({ ok: true }),
    historyEntry: async (_app, id) => pi.has(id) ? { ok: true, entry: pi.get(id) } : { ok: false, notFound: true },
    isArchived: (_app, id) => flags.has(id), setArchived: (_app, id, value) => { if (value) flags.add(id); else flags.delete(id); },
    permanentlyDeleteHistory: async (_app, id) => { calls.push('pi-forget:' + id); pi.delete(id); return { ok: true }; } };
  let selectedFailure = false, selectedBusy = false;
  const runtime = { rpc: async (operation, input) => {
    calls.push(operation + (input?.ref ? ':' + input.ref : ''));
    if (operation === 'runtime.sessions') return selectedFailure ? { ok: false, error: 'Selected provider unavailable' }
      : { ok: true, data: { runs: [...runs.values()].map(row => ({ ...row, state: selectedBusy ? 'running' : 'done' })) } };
    if (operation === 'runtime.session.forget') { runs.delete(input.ref); return { ok: true, data: { ok: true } }; }
    throw Error('Unexpected runtime operation');
  } };
  const selected = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime('qwen'), runnerRuntime: runtime });
  const unrelated = createRunnerRuntimeAdapter({ app, runtimeSpec: catalog.runtime('opencode'),
    runnerRuntime: { rpc: async () => { await delayed('unrelated-provider'); return { ok: true, data: { runs: [] } }; } } });
  const bridge = createPiSessionBridge({ app, sessionModule, runnerAdapters: [selected, unrelated] });
  bridge.setExternalHistory({ historyEntry: async () => { await delayed('hub-exact'); return null; }, history: () => delayed('hub-directory') });
  t.mock.method(require('../main/conversation/task-output-journal'), 'usedHarnesses', async () => { await delayed('tool-journal'); return []; });
  const store = require('../main/conversation/replica-store.cjs').createWorker(path.join(root, 'history.sqlite'));
  const history = require('../main/conversation/shared-history.cjs').create({ app, session: bridge, store, identityOf: () => actor });
  bridge.setReplicaHistory(history);
  const row = { id: 'native', adapterId, title: 'Synthetic deletion target', path: path.join(root, 'pi-agent', 'sessions', 'native.jsonl'),
    creator: { account: 'one', hub: actor.hub }, workOwner: require('../main/platform-connections/runtime.cjs').scope(actor) };
  await history.register([row]);
  const handlers = new Map();
  require('../main/pi-session/history-ipc').install({ app, session: bridge, sharedHistory: history,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, BrowserWindow: { getAllWindows: () => [] },
    trash: async () => { calls.push('trash'); }, accountHistory: { resolveLifecycle: () => delayed('account-lifecycle') } });
  t.after(async () => { release(); await history.close(); await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, actor, row, bridge, history, calls, runs, pi, flags, set failure(value) { selectedFailure = value; }, set busy(value) { selectedBusy = value; },
    async remove(expectedDiscovery) {
      const operation = handlers.get('pi-session-history-delete')({}, row.id, { confirmed: true });
      const first = await Promise.race([operation.then(result => ({ result })), unexpected.then(blocked => ({ blocked }))]);
      release(); const result = await operation;
      assert.equal(first.blocked, expectedDiscovery, 'Deletion waited on unexpected discovery: ' + first.blocked);
      return result;
    } };
}

test('deleting an indexed missing Pi archive does not wait for Runner or Hub discovery', async t => {
  const f = await fixture(t);
  const result = await f.remove(); assert.equal(result.ok, true, result.reason);
  assert.equal((await f.history.resolve('native')).deleted, true);
  assert.deepEqual(f.calls, []);
});

test('a missing Pi entry with known aliases or migration identity still verifies its native Runner source', async t => {
  for (const extra of [{ historyAliasIds: ['previous-native'] }, { runtimeConversationId: 'native' }, { deviceTransferId: 'accepted-transfer' }])
    await t.test(Object.keys(extra)[0], async t => {
      const f = await fixture(t);
      await f.history.register([{ ...f.row, ...extra }]);
      f.runs.set('native', { ref: 'native', cli: 'qwen', taskId: 'chat-synthetic', seq: 10 });
      const result = await f.remove('unrelated-provider'); assert.equal(result.ok, true, result.reason);
      assert.ok(f.calls.includes('runtime.session.forget:native'));
      assert.equal(f.calls.some(call => call.startsWith('hub-')), false);
    });
});

test('an unavailable recorded Runner provider cannot be replaced by an unrelated provider during deletion', async t => {
  const f = await fixture(t, 'removed-provider');
  const result = await f.remove(); assert.equal(result.ok, false); assert.match(result.reason, /历史底座不可用/);
  assert.equal((await f.history.resolve('native')).deleted, false);
  assert.deepEqual(f.calls, []);
});

test('deleting a known Runner uses only its fresh metadata and never loads tool journals', async t => {
  const f = await fixture(t, 'qwen');
  f.runs.set('native', { ref: 'native', cli: 'qwen', taskId: 'chat-synthetic', seq: 10 });
  const result = await f.remove(); assert.equal(result.ok, true, result.reason);
  assert.deepEqual(f.calls, ['runtime.sessions', 'runtime.session.forget:native']);
  assert.equal(f.runs.size, 0);
});

test('local multi-runtime deletion follows every manifest segment without querying Hub or unrelated providers', async t => {
  const f = await fixture(t);
  f.pi.set('native', f.row);
  for (const id of ['runner-before', 'runner-current']) f.runs.set(id, { ref: id, cli: 'qwen', taskId: 'chat-synthetic', seq: 10 });
  await require('../main/conversation/runtime-segments').save(f.app, { version: 1, id: 'native', owner: f.row.workOwner,
    cwd: path.dirname(f.row.path), prefix: { messages: [], tools: [] },
    segments: [{ sessionId: 'native', adapterId: 'pi', path: f.row.path }, { sessionId: 'runner-before', adapterId: 'qwen' }],
    active: { sessionId: 'runner-current', adapterId: 'qwen' } });
  const result = await f.remove(); assert.equal(result.ok, true, result.reason);
  assert.equal(f.runs.size, 0); assert.equal(f.pi.size, 0);
  assert.deepEqual(f.calls.filter(call => call.includes('forget')), ['runtime.session.forget:runner-before', 'runtime.session.forget:runner-current', 'pi-forget:native']);
});

test('selected runtime failure or active execution still prevents the final deletion tombstone', async t => {
  for (const kind of ['failure', 'busy']) await t.test(kind, async t => {
    const f = await fixture(t, 'qwen');
    f.runs.set('native', { ref: 'native', cli: 'qwen', taskId: 'chat-synthetic', seq: 10 }); f[kind] = true;
    const result = await f.remove(); assert.equal(result.ok, false);
    assert.match(result.reason, kind === 'failure' ? /Selected provider unavailable/ : /还在执行/);
    const row = await f.history.resolve('native'); assert.equal(row.archived, true); assert.equal(row.deleted, false);
    assert.equal(f.calls.some(call => call.includes('forget')), false);
  });
});
