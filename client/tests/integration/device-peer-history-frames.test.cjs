'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const tls = require('node:tls');
const transport = require('../../main/device-peer/transport.cjs');
const certificates = require('../helpers/device-peer-fixture.cjs').certificates;

async function productionHistory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mobile-history-'));
  const app = { getPath: () => root }, now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'https://peer.invalid', clientId: 'peer-source',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'peer-source', uid: 'peer-owner', iat: now, exp: now + 3600 }))
      .toString('base64url') + '.' + 'a'.repeat(64) };
  const session = { history: async () => ({ ok: true, chats: [] }), archivedHistory: async () => ({ ok: true, chats: [] }),
    historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null, findBySessionId: () => null };
  const store = require('../../main/conversation/replica-store.cjs').createWorker(path.join(root, 'history.sqlite'));
  const history = require('../../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity });
  const rows = Array.from({ length: 105 }, (_, index) => ({ id: 'history-' + index, adapterId: 'pi', count: 4,
    title: '本机历史'.repeat(550) + index, creator: { hub: identity.hub, account: 'peer-owner' },
    workOwner: require('../../main/platform-connections/runtime.cjs').scope(identity), deviceHistory: true, at: index + 1 }));
  await history.register(rows);
  const messages = [{ role: 'user', text: '原始需求🙂'.repeat(90000) }, { role: 'assistant', text: 'Second message' },
    { role: 'user', text: 'Third message' }, { role: 'assistant', text: 'Final message' }];
  await store.saveDeviceHistory(rows[0].id, { snapshot: { messages, tools: [] }, coverage: { complete: true } }, { expectedRevision: 0 });
  const reader = require('../../main/pi-session/local-history-remote.cjs').create({ app, session, history,
    identityOf: () => { throw Error('Direct reads must not renew a Hub session'); } });
  const controller = require('../../main/device-history-controller.cjs').create({ app, session, identityOf: async () => identity,
    conversation: { history: reader, deviceHistory: history }, peer: {}, transfer: {} });
  const handlers = Object.fromEntries(['history.list', 'history.read'].map(method => [method,
    (params, remote) => controller.receive(remote, method, params)]));
  const created = [];
  function device(name, options = {}) {
    const cert = certificates()[name]; let current = { ...cert, privateKey: crypto.createPrivateKey(cert.privateKey) };
    const trusted = [];
    const peer = transport.create({ identityOf: () => current, handlers, confirmPair: async () => true,
      trustedPeers: () => trusted, rememberPeer: (_identity, value) => trusted.push(value), ...options });
    created.push(peer);
    return { ...peer, identity: () => current, changeIdentity: value => { current = value; } };
  }
  const source = device('peer-source'), mobile = device('peer-mobile');
  t.after(async () => { await Promise.all(created.map(peer => peer.dispose())); await history.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await source.listen({ host: '127.0.0.1', port: 0 });
  async function connect() {
    const offer = source.createPairingOffer();
    await mobile.connect({ endpoint: offer.endpoints[0], offer: offer.offer, expectedDeviceId: offer.deviceId });
  }
  return { source, mobile, connect, device, messages, id: rows[0].id };
}

test('real mobile TLS reads long SQLite history and continuous directory/message pages without Hub access', async t => {
  const f = await productionHistory(t); await f.connect();
  const all = []; let after = 0, page;
  do {
    page = await f.mobile.request({ peerId: 'peer-source', method: 'history.list', params: { after, limit: 100 } });
    all.push(...page.items); after = page.cursor;
  } while (page.hasMore);
  assert.equal(all.length, 105); assert.equal(new Set(all.map(row => row.id)).size, 105);
  const messages = []; after = 0;
  do {
    page = await f.mobile.request({ peerId: 'peer-source', method: 'history.read', params: { id: f.id, after, limit: 1 } });
    messages.push(...page.items); after = page.cursor;
  } while (page.hasMore);
  assert.ok(Buffer.byteLength(messages[0].text) > transport.LIMIT);
  assert.deepEqual(messages.map(row => row.text), f.messages.map(row => row.text));
  await assert.rejects(f.mobile.request({ peerId: 'peer-source', method: 'history.read', params: { id: f.id, text: 'x'.repeat(transport.LIMIT) } }),
    { code: 'PEER_PAYLOAD_TOO_LARGE' });
});

test('real TLS interrupted fragments are discarded and the selected device can be read again after reconnecting', async t => {
  const f = await productionHistory(t), connect = tls.connect;
  let interrupt = 'disconnect', interrupted = 0;
  t.mock.method(tls, 'connect', (...args) => {
    const socket = connect(...args); let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (let at; (at = pending.indexOf('\n')) >= 0;) {
        const raw = pending.slice(0, at); pending = pending.slice(at + 1);
        const packet = JSON.parse(raw);
        if (packet.type !== 'history-response' || !interrupt) continue;
        const mode = interrupt; interrupt = ''; interrupted++;
        if (mode === 'disconnect') socket.destroy();
        else f.mobile.changeIdentity({ ...f.mobile.identity(), scope: 'different-account' });
      }
    });
    return socket;
  });
  const request = () => f.mobile.request({ peerId: 'peer-source', method: 'history.read', params: { id: f.id, limit: 1 } });
  await f.connect();
  await assert.rejects(request(), { code: 'PEER_HISTORY_INTERRUPTED' });
  assert.equal(interrupted, 1);
  await f.connect(); assert.equal((await request()).items[0].text, f.messages[0].text);
  const identity = f.mobile.identity(); interrupt = 'account';
  await assert.rejects(request(), { code: 'PEER_HISTORY_INTERRUPTED' });
  assert.equal(interrupted, 2);
  f.mobile.changeIdentity(identity);
  await f.connect(); assert.equal((await request()).items[0].text, f.messages[0].text);
});

test('unpaired and other-account TLS clients cannot reach history handlers or fragment assembly', async t => {
  const f = await productionHistory(t), foreign = f.device('peer-foreign');
  const offer = f.source.createPairingOffer();
  await assert.rejects(f.mobile.connect({ endpoint: offer.endpoints[0], expectedDeviceId: offer.deviceId }), { code: 'PEER_PAIR_REQUIRED' });
  await assert.rejects(foreign.connect({ endpoint: offer.endpoints[0], offer: offer.offer, expectedDeviceId: offer.deviceId }));
  assert.equal(f.source.peers().length, 0);
});
