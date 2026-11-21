'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');
const cardsModule = require('../main/conversation/work-conversation-cards');
const { createWorker } = require('../main/conversation/replica-store.cjs');

test('a stopped retired Claude inventory does not block a verified local transcript or grant card and execution access', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-retired-cards-')), app = { getPath: () => root };
  const a = identity(), b = identity('two');
  const store = createWorker(path.join(root, 'fixture.sqlite'));
  const legacy = require('../main/agent-runtime/runner-history.cjs').createRunnerHistoryProvider({ app, adapterId: 'claude' });
  const missing = { ok: false, notFound: true };
  let strictPi = missing;
  const noRuntime = { historyEntry: async (_app, _id, options) => options?.strict ? strictPi : missing, probe: async () => ({ available: false }),
    open() { throw Error('Must not start an Agent'); } };
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({ app, sessionModule: noRuntime,
    runnerAdapters: [], historyAdapters: [legacy] });
  let current = b;
  const history = require('../main/conversation/shared-history.cjs').create({ app, store, session: bridge, identityOf: () => current });
  t.after(async () => { await history.close(); await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const [row] = await store.register([{ id: 'retired', adapterId: 'claude', deviceHistory: true, historyContentState: 'available',
    historyAliasIds: ['old-native'], creator: { account: 'one', hub: a.hub }, workOwner: scope(a), count: 1 }]);
  const saved = await store.saveDeviceHistory(row.id, { snapshot: { messages: [{ role: 'user', text: 'Synthetic retained text' }], tools: [] },
    coverage: { complete: true, sources: [{ id: row.id, adapterId: 'claude', revision: '1' }] } }, { expectedRevision: row.replicaRevision });
  assert.equal(saved.ok, true);
  await assert.rejects(bridge.archivedConversation(app, row.id), { code: 'RUNNER_HISTORY_UNAVAILABLE' });
  let remoteReads = 0;
  bridge.setExternalHistory({ historyEntry() { remoteReads++; return null; } });
  const cards = cardsModule.create({ app, sharedHistory: history, session: bridge, identityOf: () => current });
  const empty = { ok: true, sessionId: row.id, cards: [], workOnly: false, draftSelection: null, draftSelectionRevision: 0 };
  assert.deepEqual(await cards.read('old-native'), empty);
  assert.equal(remoteReads, 0);
  const view = await history.open(row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.snapshot().messages[0].text, 'Synthetic retained text');
  assert.equal(view.snapshot().execution.canContinueOnDevice, false);
  assert.equal((await view.send('Do not replay')).accepted, false);
  await view.close();
  const [piRow] = await store.register([{ id: 'cleaned-pi', adapterId: 'pi', deviceHistory: true, historyContentState: 'available',
    creator: row.creator, workOwner: row.workOwner, count: 1 }]);
  assert.equal((await store.saveDeviceHistory(piRow.id, { snapshot: { messages: [{ role: 'user', text: 'Independent Pi text' }], tools: [] },
    coverage: { complete: true, sources: [{ id: piRow.id, adapterId: 'pi', revision: 'sha' }] } },
    { expectedRevision: piRow.replicaRevision })).ok, true);
  assert.deepEqual(await cards.read(piRow.id), { ...empty, sessionId: piRow.id });
  const piView = await history.open(piRow.id, { historyPreview: true, allowContinuation: true });
  assert.equal(piView.snapshot().messages[0].text, 'Independent Pi text');
  await piView.close();
  assert.equal((await cards.saveDraftSelection(row.id, { selection: {}, revision: 0 })).ok, false);
  current = { ...b, hub: 'https://other.invalid' };
  assert.equal((await cards.read('old-native')).ok, false);
  current = b;
  for (const failed of [{ ok: false, reason: 'Index unreadable' }, { ok: true, entry: { id: 'mismatched' } },
    { ok: true, entry: { id: row.id, taskId: 'native-task' } }]) {
    strictPi = failed;
    assert.equal((await cards.read('old-native')).ok, false);
    assert.equal((await cards.read(piRow.id)).ok, false);
  }
  strictPi = missing;
  await store.register([{ ...row, historyProtection: 'account' }]);
  assert.equal((await cards.read('old-native')).ok, false);
});

test('ordinary device history prepares an empty work-card view for another account without granting private reads or writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-device-work-cards-'));
  const app = { getPath: () => root }, a = identity();
  const b = identity('two'), row = { id: 'ordinary', title: 'Native chat', adapterId: 'pi', count: 1,
    creator: { account: 'one', hub: a.hub }, workOwner: scope(a), localReplica: true };
  const store = createWorker(path.join(root, 'fixture.sqlite'));
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let native = row, current = b;
  const session = { findBySessionId: () => null, archivedConversation: async () => native };
  const cards = cardsModule.create({ app, session, sharedHistory: { store }, identityOf: () => current });
  const empty = { ok: true, sessionId: row.id, cards: [], workOnly: false, draftSelection: null, draftSelectionRevision: 0 };
  assert.deepEqual(await cards.read(row.id), empty, 'The cold native path must allow the chat opener to proceed');
  await store.register([{ ...row, deviceHistory: true, historyAliasIds: ['native-segment'] }]);
  native = { ...row, taskId: 'task-on-native' };
  assert.equal((await cards.read('native-segment')).ok, false, 'A new native task restriction overrides the retained ordinary row');
  native = null;
  assert.deepEqual(await cards.read('native-segment'), empty, 'Use the verified canonical ID when opening a retained alias');
  native = row;
  current = { ...b, hub: 'https://other.invalid' };
  assert.equal((await cards.read(row.id)).ok, false);
  current = b;
  assert.equal((await cards.saveDraftSelection(row.id, { selection: {}, revision: 0 })).ok, false);
  const card = { id: 'task-card', actionId: 'work.requirement.create', prompt: 'Private form', seed: {}, state: {}, files: [] };
  assert.equal((await cards.save(row.id, card)).ok, false);
  current = a;
  const saved = await cards.save(row.id, card);
  assert.equal(saved.ok, true, saved.reason);
  assert.equal((await cards.read('native-segment')).cards.length, 1);
  current = b;
  const denied = await cards.read('native-segment');
  assert.equal(denied.ok, false);
  assert.equal(denied.cards, undefined);
  assert.equal(denied.draftSelection, undefined);
  await store.lifecycle(row.id, 'delete');
  native = null;
  assert.equal((await cards.read(row.id)).ok, false);
});
