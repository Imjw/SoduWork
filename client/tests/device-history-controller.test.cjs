'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, install } = require('../main/device-history-controller.cjs');

function fixture() {
  const identity = user => ({ hub: 'https://hub.example', clientId: 'desktop-a',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'desktop-a', uid: user })).toString('base64url') + '.test' });
  let current = identity('owner-a'), connected = true, sends = 0, reads = 0;
  const records = new Map(), snapshot = { status: 'idle', messages: [] }, window = {};
  const handle = { ref: 'ref-a', sessionId: 'session-a', adapterId: 'pi', cwd: '/synthetic',
    attachedWindow: window, snapshot: () => snapshot, inFlight: () => false, ui: { selectedSkills: ['writing'] } };
  const mobile = { peerId: 'phone-a', deviceId: 'phone-a', accountId: 'owner-a', role: 'mobile',
    async assertCurrent() { if (!connected) throw Error('peer-revoked'); } };
  const journal = { read: key => records.get(key), write: (key, value) => records.set(key, value) };
  const conversation = {
    async history(input, guard) { reads++; await guard(); return { conversation: { id: input.id }, items: [] }; },
    find: id => id === handle.sessionId ? handle : null,
    async open() { return { ok: true, ref: handle.ref }; },
    async send(ref, text, files, options) { await options.nativeRelayGuard(); sends++; return { ok: true, accepted: true }; },
  };
  const session = { get: ref => ref === handle.ref ? handle : null };
  const transferCalls = [];
  const transfer = Object.fromEntries(['preview', 'start', 'status', 'resume', 'cancel'].map(name => [name, async input => {
    transferCalls.push({ name, input }); return { state: name, operationId: input.operationId };
  }]));
  transfer.receive = async input => { transferCalls.push(input); return { ok: true }; };
  const peer = Object.fromEntries(['status', 'listen', 'stop', 'createPairingOffer', 'connect', 'peers', 'disconnect'].map(name => [name, async () => ({ ok: true })]));
  const options = { app: { getPath: () => '/unused' }, identityOf: () => current, conversation, session, peer, transfer, journal };
  return { options, service: create(options), mobile, handle, snapshot, window, records, conversation, transferCalls,
    readCount: () => reads, sends: () => sends, revoke: () => { connected = false; }, switchAccount: () => { current = identity('owner-b'); } };
}
const message = { sessionId: 'session-a', messageId: 'message-0001', text: 'Continue the existing work.' };

test('desktop peers cannot read history or continue chats, while mobile cannot migrate', async () => {
  const f = fixture();
  for (const method of ['history.list', 'history.read', 'conversation.send', 'conversation.status'])
    await assert.rejects(f.service.receive({ ...f.mobile, role: 'desktop' }, method, message), /访问方向/);
  await assert.rejects(f.service.receive(f.mobile, 'migration.offer', {}), /访问方向/);
  assert.equal(f.readCount(), 0); assert.equal(f.sends(), 0);
  assert.deepEqual(await f.service.receive({ ...f.mobile, role: 'desktop' }, 'migration.offer', { operationId: 'op-a' }), { ok: true });
  assert.equal(f.transferCalls[0].operation, 'offer');
});

test('account mismatch and missing authenticated connection fail before a history read', async () => {
  const f = fixture();
  await assert.rejects(f.service.receive({ ...f.mobile, accountId: 'other' }, 'history.list', {}), /身份/);
  await assert.rejects(f.service.receive({ ...f.mobile, assertCurrent: undefined }, 'history.list', {}), /身份/);
  assert.equal(f.readCount(), 0);
});

test('the same message ID sends once across concurrent retries and controller recreation', async () => {
  const f = fixture();
  const results = await Promise.all([f.service.receive(f.mobile, 'conversation.send', message), f.service.receive(f.mobile, 'conversation.send', message)]);
  assert.equal(f.sends(), 1); assert.equal(results[0].phase, 'accepted'); assert.deepEqual(results[1], results[0]);
  const reopened = create(f.options);
  assert.deepEqual(await reopened.receive(f.mobile, 'conversation.send', message), results[0]); assert.equal(f.sends(), 1);
  await assert.rejects(reopened.receive(f.mobile, 'conversation.send', { ...message, text: 'Different text' }), /其他内容/);
});

test('an uncertain receipt never causes another native submission after a crash', async () => {
  const f = fixture();
  await f.service.receive(f.mobile, 'conversation.send', message);
  const key = [...f.records.keys()][0], record = f.records.get(key);
  f.records.set(key, { digest: record.digest, sessionId: record.sessionId });
  const result = await create(f.options).receive(f.mobile, 'conversation.send', message);
  assert.equal(result.phase, 'uncertain'); assert.equal(f.sends(), 1);
});

test('a revoked peer cannot cross the native submit boundary or retrieve a saved receipt', async () => {
  const f = fixture(); let submitCalls = 0;
  f.conversation.send = async (ref, text, files, options) => { f.revoke(); await options.nativeRelayGuard(); submitCalls++; return { ok: true, accepted: true }; };
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', message), /peer-revoked/);
  assert.equal(submitCalls, 0);
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', message), /peer-revoked/);
});

test('late history replies are withheld after an account change', async () => {
  const f = fixture(); f.conversation.history = async () => { f.switchAccount(); return { items: [{ text: 'private' }] }; };
  await assert.rejects(f.service.receive(f.mobile, 'history.read', { id: 'session-a' }), /账号/);
});

test('paired mobile directory and history reads never renew a Hub device session', async () => {
  const f = fixture();
  const row = { id: 'session-a', title: 'Local history', cached: true };
  let hubCalls = 0;
  f.conversation.history = require('../main/pi-session/local-history-remote.cjs').create({
    app: f.options.app, history: {
      directory: async () => ({ items: [row] }), resolve: async () => row,
      read: async () => ({ items: [{ role: 'user', text: 'saved on desktop' }], cursor: 1 })
    },
    identityOf: async () => { hubCalls++; throw Error('Hub unavailable'); }
  });
  assert.equal((await f.service.receive(f.mobile, 'history.list', {})).items[0].title, row.title);
  assert.equal((await f.service.receive(f.mobile, 'history.read', {id: row.id})).items[0].text, 'saved on desktop');
  assert.equal(hubCalls, 0);
});

test('task follow-ups inherit the source task and cannot take task authority from the peer', async () => {
  const f = fixture(); f.handle.activeTaskId = 'task-owned'; let received;
  f.conversation.send = async (ref, text, files, options) => { received = options; await options.nativeRelayGuard(); return { ok: true, accepted: true }; };
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', { ...message, taskId: 'forged' }), /请求不正确/);
  const result = await f.service.receive(f.mobile, 'conversation.send', message);
  assert.equal(result.phase, 'accepted'); assert.equal(received.taskId, 'task-owned');
  assert.deepEqual(received.taskExecution, { reuseConversation: true, followUp: true });
  assert.deepEqual(received.skills, ['writing']);
});

test('cloud views and busy native sessions cannot be continued through direct messages', async () => {
  const f = fixture(); f.snapshot.cloudHandoff = { phase: 'committed' };
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', message), /本机会话/);
  delete f.snapshot.cloudHandoff; f.snapshot.status = 'running';
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', message), /正在执行/);
  assert.equal(f.records.size, 0); assert.equal(f.sends(), 0);
});

test('title-only and incomplete histories never advertise continuation or send from a read-only view', async () => {
  const f = fixture();
  let row = { id: 'session-a', adapterId: 'pi', historyContentState: 'missing' };
  f.conversation.deviceHistory = { resolve: async () => row };
  for (const state of ['missing', 'partial']) {
    row.historyContentState = state;
    const reply = await f.service.receive(f.mobile, 'history.read', { id: 'session-a' });
    assert.equal(reply.conversation.canContinue, false);
    assert.equal(reply.conversation.continuationId, '');
  }
  row = { id: 'session-a', adapterId: 'pi' };
  assert.equal((await f.service.receive(f.mobile, 'history.read', { id: 'session-a' })).conversation.canContinue, true);
  f.handle.localReplica = true;
  await assert.rejects(f.service.receive(f.mobile, 'conversation.send', message), /本机会话/);
  assert.equal(f.records.size, 0); assert.equal(f.sends(), 0);
});

test('IPC requires the trusted window and binds migration start to its attached session', async () => {
  const f = fixture(), handlers = new Map();
  install({ ...f.options, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, trustedWindow: event => event.trusted ? f.window : null });
  await assert.rejects(handlers.get('device-direct-listen')({}, { host: '0.0.0.0' }), /主窗口/);
  await assert.rejects(handlers.get('device-migration-start')({ trusted: true }, { ref: 'other', sessionId: 'session-a' }), /打开/);
  const input = { ref: 'ref-a', sessionId: 'session-a', targetDeviceId: 'desktop-b', operationId: 'op-a', selectedPaths: ['chosen.txt'] };
  await handlers.get('device-migration-start')({ trusted: true }, input);
  assert.deepEqual(f.transferCalls[0].input, { sessionId: 'session-a', targetDeviceId: 'desktop-b', operationId: 'op-a', selectedPaths: ['chosen.txt'] });
  await handlers.get('device-migration-resume')({ trusted: true }, { operationId: 'op-a' });
  assert.equal(f.transferCalls[1].name, 'resume');
  assert.equal(handlers.has('device-direct-history'), false);
  assert.equal(handlers.has('device-direct-send'), false);
});

test('a release without device-owned history starts without registering a peer identity or opening a listener', async () => {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const url = pathToFileURL(path.join(root, 'desk.html')).href;
  const webContents = { isDestroyed: () => false, getURL: () => url, mainFrame: { url } };
  const window = { isDestroyed: () => false, webContents };
  const handlers = new Map();
  const installed = require('../main/device-direct-install.cjs').install({
    app: { getAppPath: () => root },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    BrowserWindow: { fromWebContents: () => window }, conversation: {},
  });
  assert.equal(installed.controller, null);
  assert.equal(handlers.size, 12);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  for (const handler of handlers.values()) {
    await assert.rejects(handler(event, {}), /请更新桌面客户端/);
  }
});
