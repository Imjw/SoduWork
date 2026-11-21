'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPiSessionBridge, RUNTIME_RECORD } = require('./pi-session-bridge');
const { MemoryGoalCheckpointStore } = require('./goal-checkpoint-store');

function fakeSessionModule() {
  const opened = [];
  const handles = [];
  let serial = 0;
  const module = {
    opened,
    handles,
    execution: {},
    sessionStatus: 'idle',
    running: false,
    controls: [],
    closeHook: null,
    async probe(app) { return { ok: true, app: app && app.name || '' }; },
    async open(options) {
      opened.push(options);
      serial += 1;
      const listeners = new Set();
      const handle = {
        ref: options.ref || 'chat-' + serial,
        sessionId: 'pi-' + serial,
        cwd: options.cwd || 'C:\\work',
        model: { id: 'model-' + serial },
        closed: false,
        on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(touched, snapshot) { listeners.forEach((listener) => listener(touched, snapshot)); },
        snapshot() {
          return {
            status: module.sessionStatus,
            messages: [], tools: [],
            execution: { ...module.execution },
          };
        },
        status() { return module.sessionStatus; },
        inFlight() { return module.running; },
        submit() { return { accepted: true, queued: false, completion: Promise.resolve({ ok: true }) }; },
        cancel() {},
        outputs() { return []; },
        answerUi() {},
        continueGoal() { module.controls.push('continue'); return { ok: true }; },
        pauseGoal() { module.controls.push('pause'); return { ok: true }; },
        disableGoal() { module.controls.push('disable'); return { ok: true }; },
        async close() { if (module.closeHook) await module.closeHook(); handle.closed = true; },
      };
      handles.push(handle);
      return { ok: true, session: handle, seeded: 3 };
    },
    history() { return Promise.resolve({ ok: true, chats: [] }); },
    prewarm() { return Promise.resolve({ ok: true }); },
  };
  return module;
}

test('Pi bridge opens a real legacy handle through the runtime registry', async () => {
  const raw = fakeSessionModule();
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-a', cwd: 'C:\\work', identity: { id: 'u-1' } });

  assert.equal(result.ok, true);
  assert.equal(result.seeded, 3);
  assert.equal(result.session.ref, 'chat-a');
  assert.equal(bridge.get('chat-a'), result.session);
  assert.equal(bridge.findBySessionId('pi-1'), result.session);
  assert.equal(result.session[RUNTIME_RECORD].consumer, 'chat');
  assert.equal(bridge.runtimeSession('chat-a').adapterId, 'pi');
  assert.equal(raw.opened[0].identity.id, 'u-1');

  await bridge.dispose();
});

test('independent device history opens a new native segment under the original public identity', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-resume-'));
  const app = { getPath: () => root }, identity = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  const raw = fakeSessionModule(), open = raw.open, bindings = [];
  raw.open = async options => {
    const result = await open(options);
    result.session.bindTask = async (id, title) => { bindings.push({ id, title }); return { ok: true }; };
    return result;
  };
  const bridge = createPiSessionBridge({ app, sessionModule: raw, runnerAdapters: [] });
  t.after(async () => { await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const recovery = { row: { id: 'original-public-id', title: 'Saved task', adapterId: 'pi',
    taskBindings: [{ taskId: 'task-one', title: 'Existing task' }] },
    prefix: { messages: [{ role: 'user', text: 'Completed historical request' }], tools: [
      { id: 'receipt', name: 'write', state: 'done', result: 'Already written', after: 0 }] },
    historyRecovery: { mode: 'device-history', nativeArchiveMissing: true } };
  const result = await bridge.open({ app, identity, cwd: root, ref: 'restored-window', deviceHistoryRecovery: recovery });
  assert.equal(result.ok, true);
  assert.equal(result.session.sessionId, 'original-public-id');
  assert.equal(raw.handles[0].sessionId, 'pi-1');
  assert.equal(raw.opened[0].resumePath, undefined);
  assert.match(raw.opened[0].contextPrompts.join('\n'), /Completed historical request/);
  assert.match(raw.opened[0].contextPrompts.join('\n'), /Already written/);
  assert.match(raw.opened[0].contextPrompts.join('\n'), /task-one/);
  assert.doesNotMatch(raw.opened[0].contextPrompts.join('\n'), /user explicitly changed Agent/);
  assert.equal(result.session.snapshot().messages[0].text, 'Completed historical request');
  assert.equal(result.session.snapshot().tools[0].result, 'Already written');
  assert.equal(result.session.snapshot().historyRecovery.nativeArchiveMissing, true);
  assert.deepEqual(bindings, [{ id: 'task-one', title: 'Existing task' }]);
  const record = require('../conversation/runtime-segments').read(app, 'original-public-id');
  assert.equal(record.deviceHistoryComplete, true);
  assert.equal(record.active.sessionId, 'pi-1');
  assert.equal(record.deviceHistoryContext.taskBindings[0].taskId, 'task-one');
});

test('a passive desktop history view can coexist with execution and closes independently', async t => {
  const raw = fakeSessionModule(), bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  t.after(() => bridge.dispose());
  let closed = 0;
  const history = { ref: 'reader', sessionId: 'pi-1', readOnly: true, localReplica: true,
    snapshot: () => ({ messages: [{ role: 'user', text: 'Past turn' }] }),
    close: async () => { closed++; return true; } };
  const view = bridge.attachView(history, { historyPreview: true });
  assert.equal(bridge.get('reader'), view);
  assert.equal(bridge.findBySessionId('pi-1'), null);
  assert.throws(() => bridge.attachView({ ...history, ref: 'writable', readOnly: false }, { historyPreview: true }));
  const result = await bridge.open({ ref: 'live' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(await view.close(), true);
  assert.equal(closed, 1);
  assert.equal(bridge.get('reader'), null);
  assert.equal(bridge.findBySessionId('pi-1'), result.session);
  assert.equal(raw.handles[0].closed, false);
});

test('selecting a new runtime for a saved transcript retains its native lineage across repeated opens', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-selection-'));
  const app = { getPath: () => root }, identity = require('../../tests/helpers/platform-session-fixture.cjs').identity();
  const raw = fakeSessionModule(), bridge = createPiSessionBridge({ app, sessionModule: raw, runnerAdapters: [] });
  t.after(async () => { await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const segments = require('../conversation/runtime-segments');
  const original = { sessionId: 'recorded-run', adapterId: 'retired-adapter', path: 'original-session' };
  const previous = { sessionId: 'previous-run', adapterId: 'qwen', path: 'previous-session' };
  const row = { id: 'logical-chat', adapterId: previous.adapterId, modelName: 'retired-model' };
  const artifacts = require('../conversation/runtime-artifacts.cjs');
  function indexedFile(name, source) {
    const file = path.join(root, name);
    fs.writeFileSync(file, name);
    const stat = fs.statSync(file);
    return artifacts.capture(root, { items: [{ artifactId: name, path: file, at: Math.round(stat.mtimeMs),
      size: stat.size, primary: true }] }, source);
  }
  const oldImage = indexedFile('old.png', original);
  const retired = indexedFile('removed.png', original);
  oldImage.items.push(...retired.items);
  fs.unlinkSync(path.join(root, 'removed.png'));
  const recoveredPage = indexedFile('index.html', previous);
  await segments.save(app, { id: row.id, version: 1, owner: segments.scope(identity), originAdapter: original.adapterId,
    segments: [original], active: previous, artifactHistory: oldImage });
  const recovery = { row, artifactHistory: recoveredPage, prefix: { messages: [{ role: 'user', text: 'Earlier turn' }], tools: [] },
    historyRecovery: { mode: 'device-history', nativeArchiveMissing: false } };
  const options = { app, identity, cwd: root, adapterId: 'pi', modelName: 'new-selection', deviceHistoryRecovery: recovery };
  const [first, duplicate] = await Promise.all([bridge.open({ ...options, ref: 'new' }), bridge.open({ ...options, ref: 'duplicate' })]);
  assert.equal(first.ok, true, first.reason);
  assert.equal(duplicate.ok, false);
  assert.equal(raw.opened.length, 1);
  assert.equal(raw.opened[0].modelName, 'new-selection');
  assert.equal(raw.opened[0].startDeviceSegment, true);
  assert.equal(raw.opened[0].deviceHistoryRecovery, undefined);
  assert.equal(raw.opened[0].resumePath, undefined);
  assert.equal(first.session.sessionId, row.id);
  const saved = segments.read(app, row.id);
  assert.equal(saved.originAdapter, original.adapterId);
  assert.deepEqual(saved.segments, [original, previous]);
  assert.equal(saved.active.adapterId, 'pi');
  assert.equal(saved.active.sessionId, raw.handles[0].sessionId);
  const files = artifacts.restore(root, saved.artifactHistory);
  assert.deepEqual(files.map(file => file.relative).sort(), ['index.html', 'old.png']);
  assert.ok(files.every(file => file.historical && !file.primary));
  assert.deepEqual(artifacts.restore(path.dirname(root), saved.artifactHistory), []);
  assert.equal(raw.opened[0].artifactHistory, undefined);
  await assert.rejects(segments.save(app, { ...saved, segments: Array(1001).fill(previous) }), /达到上限/);
  assert.deepEqual(segments.read(app, row.id), saved);
});

test('native replay rechecks an indexed failure after the unavailable handle finishes disposal', async () => {
  const raw = fakeSessionModule(), bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  let indexed = { state: 'completed' }, release;
  bridge.setReplicaHistory({ indexedRow: async () => indexed });
  await bridge.open({ ref: 'before-loss' });
  const handle = raw.handles[0], snapshot = handle.snapshot.bind(handle);
  handle.snapshot = () => ({ ...snapshot(), runtimeUnavailable: true });
  raw.closeHook = () => new Promise(resolve => { release = () => {
    indexed = { state: 'failed', status: 'unreachable' }; raw.closeHook = null; resolve();
  }; });
  assert.equal(bridge.findBySessionId(handle.sessionId), null);
  const reopening = bridge.open({ ref: 'after-loss', resumePath: 'synthetic.jsonl',
    retainedHistoryId: handle.sessionId, retainedExecutionFailure: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(raw.opened.length, 1);
  release();
  assert.equal((await reopening).ok, true);
  assert.equal(raw.opened[1].retainedExecutionFailure, true);
  await bridge.dispose();
});

test('Pi task binding mismatch remains a typed refusal through the runtime adapter and bridge', async () => {
  const raw = fakeSessionModule();
  raw.open = async () => ({ ok: false, code: 'TASK_BINDING_MISMATCH', reason: '这条会话不是该需求的协作会话' });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  for (const resumePath of ['', 'old-session.jsonl']) {
    const result = await bridge.open({ ref: 'wrong-task', taskRef: 'new-task', requireTaskBinding: true, resumePath });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TASK_BINDING_MISMATCH');
    assert.equal(result.runtimeError, 'TASK_BINDING_MISMATCH');
    assert.equal(bridge.get('wrong-task'), null);
  }
  raw.open = async () => ({ ok: false, code: 'LOCAL_HISTORY_MODEL_UNAVAILABLE', reason: 'Missing recorded local model' });
  assert.equal((await bridge.open({ resumePath: 'old-session.jsonl' })).runtimeError, 'LOCAL_HISTORY_MODEL_UNAVAILABLE');
  raw.open = async () => ({ ok: false, reason: '其他初始化失败' });
  const failed = await bridge.open({ ref: 'ordinary-error' });
  assert.equal(failed.code, undefined, 'unrelated failures must not trigger task mapping recovery');
  assert.equal(failed.runtimeError, 'PI_SESSION_OPEN_FAILED');
  await bridge.dispose();
});

test('cloud history uses the existing archive lifecycle without requiring a native Agent archive', async () => {
  const raw = fakeSessionModule(), archived = {}, row = { id: 'cloud1', cloud: true, adapterId: 'pi', title: 'Cloud', state: 'running', at: 1 };
  let hidden = false;
  Object.assign(raw, { historyEntry: async () => ({ ok: false, notFound: true }),
    archiveRoot: () => 'fixture', archiveState: { read: () => ({ conversations: archived }) },
    isArchived: (_app, id) => Boolean(archived[id]),
    setArchived: (_app, id, value) => { if (value) archived[id] = 1; else delete archived[id]; return archived[id]; } });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: hidden ? [] : [row] }),
    forget: async id => { assert.equal(id, 'cloud1'); hidden = true; return { ok: true }; } });
  assert.equal((await bridge.history()).chats[0].id, 'cloud1');
  assert.equal((await bridge.archiveHistory(null, 'cloud1')).ok, false);
  row.state = 'completed'; assert.equal((await bridge.archiveHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 0);
  assert.equal((await bridge.archivedHistory()).chats[0].id, 'cloud1');
  assert.equal((await bridge.restoreHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 1);
  await bridge.archiveHistory(null, 'cloud1');
  assert.equal((await bridge.permanentlyDeleteHistory(null, 'cloud1')).ok, true);
  assert.equal((await bridge.history()).chats.length, 0); assert.equal(raw.opened.length, 0);
});

test('local and cloud history rows keep separate directory scopes and cloud wins an id collision', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'same-id', title: 'local copy', cwd: 'C:\\projects\\local', at: 200 },
    { id: 'local-only', title: 'local only', cwd: 'C:\\projects\\other', at: 100 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({
    history: async () => ({ ok: true, chats: [
      { id: 'same-id', title: 'cloud copy', cwd: 'C:\\Users\\me\\AppData\\cloud-cache', cloud: true, at: 1 },
      { id: 'cloud-only', title: 'cloud only', cwd: 'C:\\Users\\me\\AppData\\cloud-cache-2', cloud: true, at: 300 },
    ] }),
    isRemote: id => id === 'same-id',
  });
  const rows = (await bridge.history()).chats;
  const local = rows.find(row => row.id === 'local-only');
  const cloud = rows.find(row => row.id === 'cloud-only');
  const collision = rows.find(row => row.id === 'same-id');
  assert.equal(rows.length, 3);
  assert.equal(local.cwd, 'C:\\projects\\other');
  assert.equal(local.location, 'local');
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.location, 'cloud');
  assert.equal(cloud.locationMode, 'remote');
  assert.equal(cloud.cwd, '');
  assert.equal(collision.title, 'cloud copy');
  assert.equal(collision.cwd, '');
  await bridge.dispose();
});

test('account projections, native records and downloaded copies keep independent identities without verified aliases', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'native-1', title: 'Same conversation', sourceSessionId: 'native-1', at: 30 },
    { id: 'independent', title: 'Same conversation', at: 20 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [
    { id: 'acct-1', title: 'Same conversation', accountProjection: true,
      sourceClientId: 'desktop', sourceSessionId: 'native-1', at: 40 },
    { id: 'acct-independent', title: 'Same conversation', accountProjection: true,
      sourceClientId: 'desktop', sourceSessionId: 'other-native', at: 10 },
  ] }) });
  bridge.setReplicaHistory({
    projectRows: async rows => rows,
    indexedRows: async () => [{ id: 'copy-1', title: 'Same conversation', cached: true,
      source: { id: 'acct-1' }, sourceSessionId: 'native-1', at: 35 }],
    lifecycleRows: () => [],
  });
  const rows = (await bridge.history()).chats;
  assert.equal(rows.filter(row => row.title === 'Same conversation').length, 5);
  const merged = rows.find(row => row.id === 'copy-1');
  assert.ok(merged);
  assert.equal(merged.historyAliasIds?.includes('acct-1'), undefined);
  assert.equal(merged.historyAliasIds?.includes('native-1'), undefined);
  assert.ok(rows.some(row => row.id === 'independent'));
  assert.ok(rows.some(row => row.id === 'acct-independent'));
  await bridge.dispose();
});

test('deleted account origins do not delete independently managed cached copies or same-title chats', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [
    { id: 'independent', title: 'Same conversation', at: 20 },
  ] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true,
    chats: [{ id: 'acct-deleted', title: 'Same conversation', accountProjection: true, at: 30 }],
    lifecycle: [{ id: 'acct-deleted', deleted: true, lifecycleRevision: 4, revision: 4 }] }) });
  bridge.setReplicaHistory({
    projectRows: async rows => rows,
    indexedRows: async () => [{ id: 'copy-deleted', title: 'Same conversation', cached: true,
      source: { id: 'acct-deleted' }, at: 35 }],
    lifecycleRows: () => [],
  });
  const rows = (await bridge.history()).chats;
  assert.deepEqual(rows.map(row => row.id), ['copy-deleted', 'independent']);
  await bridge.dispose();
});

test('bridge does not merge different device projections by a shared source locator', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [
    { id: 'acct-current', title: 'Shared', accountConversation: true, sourceClientId: 'current', sourceSessionId: 'source-1', at: 20 },
    { id: 'acct-old', title: 'Shared', accountConversation: true, sourceClientId: 'other', sourceSessionId: 'source-1', at: 30 },
    { id: 'acct-other', title: 'Shared', accountConversation: true, sourceSessionId: 'source-2', at: 10 },
  ] }) });
  bridge.setReplicaHistory({ projectRows: async rows => rows, indexedRows: async () => [],
    lifecycleRows: () => [] });
  const rows = (await bridge.history()).chats;
  assert.deepEqual(rows.map(row => row.id), ['acct-old', 'acct-current', 'acct-other']);
  assert.equal(rows[0].historyAliasIds?.includes('acct-current'), undefined);
  await bridge.dispose();
});

test('bridge retains verified native aliases while a downloaded origin remains an independent record', async () => {
  const raw = fakeSessionModule();
  raw.history = async () => ({ ok: true, chats: [{ id: 'runtime-child', title: 'Native', at: 10 }] });
  const bridge = createPiSessionBridge({ sessionModule: raw, runnerAdapters: [] });
  bridge.setExternalHistory({ history: async () => ({ ok: true, chats: [{
    id: 'public-native', title: 'Native', historyAliasIds: ['runtime-child', 'acct-owned'], at: 20,
  }] }) });
  bridge.setReplicaHistory({ projectRows: async rows => rows,
    indexedRows: async () => [{ id: 'independent-copy', cached: true, source: { id: 'acct-owned' }, at: 30 }],
    lifecycleRows: () => [] });
  const rows = (await bridge.history()).chats;
  assert.deepEqual(rows.map(row => row.id), ['independent-copy', 'public-native']);
  assert.deepEqual(new Set(rows[1].historyAliasIds), new Set(['runtime-child', 'acct-owned']));
  await bridge.dispose();
});

test('Pi bridge keeps mutable legacy fields while exposing normalized events', async () => {
  const raw = fakeSessionModule();
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-b' });
  const events = [];
  bridge.runtimeSession('chat-b').subscribe((event) => events.push(event));

  result.session.ui = { mode: 'full' };
  result.session.detached = true;
  raw.handles[0].emit({ kind: 'turn-finished' }, {
    status: 'idle', messages: [], tools: [], execution: {},
  });

  assert.deepEqual(raw.handles[0].ui, { mode: 'full' });
  assert.equal(raw.handles[0].detached, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn.completed');
  assert.equal(events[0].native.namespace, 'pi');

  result.session.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(raw.handles[0].closed, true);
  assert.equal(bridge.get('chat-b'), null);
  assert.equal(bridge.runtimeSession('chat-b'), null);
  await bridge.dispose();
});

test('Pi bridge uses the goal consumer and resume path without changing open options', async () => {
  const raw = fakeSessionModule();
  raw.execution = {
    configured: true, visible: true, active: false, paused: true,
    harness: {
      runId: 'goal-run-1', node: 'verify', phase: 'verify', state: 'paused',
      revision: 7, iteration: 2,
    },
    quality: { required: true, phase: 'paused', reason: 'step limit' },
    limitRequest: { kind: 'steps', reason: 'step limit', used: 30, limit: 30 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw, checkpointStore: new MemoryGoalCheckpointStore(),
  });
  const result = await bridge.open({
    ref: 'chat-goal', intent: 'goal', goal: 'deliver', resumePath: 'C:\\state\\session.jsonl',
  });

  assert.equal(result.ok, true);
  assert.equal(result.session[RUNTIME_RECORD].consumer, 'goal');
  assert.equal(raw.opened[0].intent, 'goal');
  assert.equal(raw.opened[0].goal, 'deliver');
  assert.equal(raw.opened[0].resumePath, 'C:\\state\\session.jsonl');
  assert.equal(bridge.goalCheckpoint('chat-goal').goal.harnessRevision, 7);
  assert.equal(bridge.goalCheckpoint('pi-1').safeBoundary, true);

  const continued = result.session.continueGoal();
  assert.equal(continued.ok, true);
  assert.deepEqual(raw.controls, ['continue']);
  const checkpoint = bridge.goalCheckpoint('chat-goal');
  assert.equal(checkpoint.action.name, 'continue');
  assert.equal(checkpoint.action.state, 'accepted');
  await bridge.dispose();
});

test('Pi bridge keeps ordinary chat outside Goal Supervisor persistence', async () => {
  const raw = fakeSessionModule();
  const store = new MemoryGoalCheckpointStore();
  const bridge = createPiSessionBridge({ sessionModule: raw, checkpointStore: store });
  const result = await bridge.open({ ref: 'chat-plain' });

  assert.equal(result.ok, true);
  assert.equal(bridge.goalCheckpoint('chat-plain'), null);
  assert.deepEqual(result.session.continueGoal(), { ok: true });
  assert.deepEqual(raw.controls, ['continue']);
  await bridge.dispose();
});

test('Pi bridge allows emergency pause mid-turn but only continues at a safe boundary', async () => {
  const raw = fakeSessionModule();
  raw.sessionStatus = 'streaming';
  raw.running = true;
  raw.execution = {
    configured: true, active: true, running: true,
    harness: { runId: 'goal-run-active', state: 'running', revision: 2 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw, checkpointStore: new MemoryGoalCheckpointStore(),
  });
  const result = await bridge.open({ ref: 'chat-active', intent: 'goal' });

  assert.equal(result.session.continueGoal().code, 'GOAL_TURN_ACTIVE');
  assert.deepEqual(raw.controls, []);
  assert.equal(bridge.runtimeSession('chat-active').controlGoal('pause').ok, true);
  assert.deepEqual(raw.controls, ['pause']);
  assert.equal(result.session.disableGoal().ok, true);
  assert.deepEqual(raw.controls, ['pause', 'disable']);
  assert.equal(bridge.runtimeSession('chat-active').controlGoal('continue').code,
    'GOAL_TURN_ACTIVE');
  await bridge.dispose();
});

test('Pi bridge refuses a goal session when durable checkpoints cannot be written', async () => {
  const raw = fakeSessionModule();
  raw.execution = {
    configured: true,
    harness: { runId: 'goal-no-store', state: 'paused', revision: 1 },
  };
  const bridge = createPiSessionBridge({
    sessionModule: raw,
    checkpointDurable: true,
    checkpointStore: {
      load() { return null; },
      save() { throw new Error('disk is read only'); },
    },
  });
  const result = await bridge.open({ ref: 'chat-no-store', intent: 'goal' });

  assert.equal(result.ok, false);
  assert.equal(result.runtimeError, 'GOAL_CHECKPOINT_WRITE_FAILED');
  assert.equal(bridge.list().length, 0);
  assert.equal(raw.handles[0].closed, true);
  await bridge.dispose();
});

test('Pi bridge preserves the legacy failure result shape', async () => {
  const raw = fakeSessionModule();
  raw.open = async () => ({ ok: false, reason: 'model unavailable' });
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-fail' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /model unavailable/);
  assert.equal(bridge.list().length, 0);
  await bridge.dispose();
});
test('Pi bridge close waits for the runtime handle before archive deletion can continue', async () => {
  const raw = fakeSessionModule();
  let releaseClose;
  raw.closeHook = () => new Promise((resolve) => { releaseClose = resolve; });
  const bridge = createPiSessionBridge({ sessionModule: raw });
  const result = await bridge.open({ ref: 'chat-delete' });

  const closing = result.session.close();
  assert.equal(typeof closing.then, 'function');
  assert.equal(bridge.get('chat-delete'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(raw.handles[0].closed, false);

  releaseClose();
  assert.equal(await closing, true);
  assert.equal(raw.handles[0].closed, true);
  await bridge.dispose();
});
