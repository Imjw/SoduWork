'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { create, certificateIdentity } = require('../main/device-peer/transport.cjs');
let fixtures;
test.before(() => {
  const backend = path.resolve(__dirname, '../../hub-backend');
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(python), 'Set SODUWORK_TEST_PYTHON to the isolated backend test interpreter');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-peer-test-'));
  try {
    const file = path.join(temporary, 'certificates.json');
    const child = spawnSync(python, ['-m', 'tests.device_peer_fixture', file], { cwd: backend, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    fixtures = JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

function peer(t, name, options = {}) {
  let identity = { ...fixtures[name], privateKey: crypto.createPrivateKey(fixtures[name].privateKey) };
  const remembered = [];
  const runtime = create({ identityOf: () => identity, confirmPair: async () => true,
    trustedPeers: () => remembered,
    rememberPeer: (_identity, row) => { remembered.push(row); },
    handlers: { 'migration.ping': async (body, remote) => ({ body, deviceId: remote.deviceId, role: remote.role }),
      'history.list': async () => ({ items: [] }), 'history.read': async body => body,
      'conversation.send': async body => body, 'conversation.status': async body => body }, ...options });
  t.after(() => runtime.dispose());
  return { ...runtime, changeIdentity: value => { identity = value; }, identity: () => identity };
}
async function pair(source, target) {
  await source.listen({ host: '127.0.0.1', port: 0 });
  const invitation = source.createPairingOffer();
  await target.connect({ endpoint: invitation.endpoints[0], offer: invitation.offer, expectedDeviceId: invitation.deviceId });
  return invitation;
}

test('real TLS binds same-account device identities and transfers 128 KiB chunks without Hub', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  await pair(source, target);
  const body = { chunk: Buffer.alloc(128 * 1024, 37).toString('base64') };
  const result = await target.request({ peerId: 'peer-source', method: 'migration.ping', params: body });
  assert.deepEqual(result, { body, deviceId: 'peer-target', role: 'desktop' });
  assert.equal(source.peers()[0].accountId, 'peer-owner');
});

test('IPv4 wildcard listeners advertise only their address family and the advertised endpoint accepts real TLS', async t => {
  t.mock.method(os, 'networkInterfaces', () => ({ synthetic: [
    { address: '127.0.0.1', internal: false, family: 'IPv4' },
    { address: '2001:db8::5', internal: false, family: 'IPv6' },
    { address: '127.0.0.2', internal: true, family: 'IPv4' },
  ] }));
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  const status = await source.listen({ host: '0.0.0.0', port: 0 });
  assert.equal(status.endpoints.length, 1);
  assert.match(status.endpoints[0], /^tls:\/\/127\.0\.0\.1:\d+$/);
  const invitation = source.createPairingOffer();
  assert.deepEqual(invitation.endpoints, status.endpoints);
  await target.connect({ endpoint: invitation.endpoints[0], offer: invitation.offer, expectedDeviceId: invitation.deviceId });
  assert.deepEqual((await target.request({ peerId: 'peer-source', method: 'migration.ping', params: { selected: true } })).body,
    { selected: true });
});

test('desktop peers cannot browse or continue another desktop history', async t => {
  let reads = 0;
  const source = peer(t, 'peer-source', { handlers: { 'history.list': async () => { reads++; } } });
  const target = peer(t, 'peer-target');
  await pair(source, target);
  for (const method of ['history.list', 'history.read', 'conversation.send', 'conversation.status']) {
    await assert.rejects(target.request({ peerId: 'peer-source', method, params: {} }), { code: 'PEER_OPERATION_FORBIDDEN' });
  }
  assert.equal(reads, 0);
});

test('CA-signed mobile role can read exactly its paired same-account desktop', async t => {
  const source = peer(t, 'peer-source'), mobile = peer(t, 'peer-mobile');
  await pair(source, mobile);
  assert.deepEqual(await mobile.request({ peerId: 'peer-source', method: 'history.list', params: {} }), { items: [] });
  await assert.rejects(mobile.request({ peerId: 'peer-source', method: 'migration.ping', params: {} }), { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(mobile.request({ peerId: 'unselected', method: 'history.list', params: {} }), { code: 'PEER_DISCONNECTED' });
});

test('mobile certificate cannot serve as a target even if local metadata claims desktop', async t => {
  const mobile = peer(t, 'peer-mobile');
  await assert.rejects(mobile.listen({ host: '127.0.0.1' }), { code: 'PEER_LISTEN_FORBIDDEN' });
  assert.equal(certificateIdentity(fixtures['peer-mobile'].certificate).role, 'mobile');
});

test('same CA does not grant another account access', async t => {
  const source = peer(t, 'peer-source'), foreign = peer(t, 'peer-foreign');
  await source.listen({ host: '127.0.0.1' });
  const invitation = source.createPairingOffer();
  await assert.rejects(foreign.connect({ endpoint: invitation.endpoints[0], offer: invitation.offer, expectedDeviceId: 'peer-source' }));
  assert.equal(source.peers().length, 0);
});

test('target device mismatch fails closed without fallback', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  await source.listen({ host: '127.0.0.1' });
  const invitation = source.createPairingOffer();
  await assert.rejects(target.connect({ endpoint: invitation.endpoints[0], offer: invitation.offer, expectedDeviceId: 'other-device' }), { code: 'PEER_TARGET_CHANGED' });
});

test('native confirmation denial prevents the authenticated pairing', async t => {
  let prompted = 0;
  const source = peer(t, 'peer-source', { confirmPair: async () => { prompted++; return false; } }), target = peer(t, 'peer-target');
  await assert.rejects(pair(source, target));
  assert.equal(prompted, 1);
  assert.equal(source.peers().length, 0);
});

test('real TLS mobile continuation uses the production durable message receipt once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-peer-message-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sent = 0;
  const identity = { hub: 'https://peer.invalid', clientId: 'peer-source',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'peer-source', uid: 'peer-owner' })).toString('base64url') + '.fixture' };
  const handle = { ref: 'ref', sessionId: 'native-a', snapshot: () => ({ status: 'idle', messages: [] }), inFlight: () => false, ui: { selectedSkills: [] } };
  const controller = require('../main/device-history-controller.cjs').create({
    app: { getPath: () => root }, identityOf: async () => identity,
    conversation: { history: async (args, guard) => { await guard(); return { conversation: { id: args.id }, items: [] }; },
      find: () => handle, open: async () => handle,
      send: async (_ref, _text, _files, options) => { await options.nativeRelayGuard(); sent++; return { ok: true, accepted: true }; } },
    session: {}, peer: {}, transfer: {},
  });
  const handlers = Object.fromEntries(['history.list', 'history.read', 'conversation.send', 'conversation.status']
    .map(method => [method, (params, remote) => controller.receive(remote, method, params)]));
  const source = peer(t, 'peer-source', { handlers }), mobile = peer(t, 'peer-mobile');
  await pair(source, mobile);
  assert.deepEqual((await mobile.request({ peerId: 'peer-source', method: 'history.read', params: { id: 'native-a' } })).items, []);
  const request = { peerId: 'peer-source', method: 'conversation.send', params: { sessionId: 'native-a', messageId: 'message-0001', text: 'hello' } };
  const first = await mobile.request(request), second = await mobile.request(request);
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(sent, 1);
});

test('pairing capability is consumed and cannot pair a second identity', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target'), mobile = peer(t, 'peer-mobile');
  const invitation = await pair(source, target);
  await assert.rejects(mobile.connect({ endpoint: invitation.endpoints[0], offer: invitation.offer, expectedDeviceId: 'peer-source' }));
  assert.equal(source.peers().length, 1);
});

test('grants verify against actual peer TLS key and reject alteration', async t => {
  let receiver;
  const source = peer(t, 'peer-source', { handlers: { 'migration.ping': async (body, remote) => {
    receiver = remote; return remote.verifyGrant(body.text, body.signature);
  } } });
  const target = peer(t, 'peer-target');
  await pair(source, target);
  const text = 'transfer:synthetic:source:target:generation-2';
  const signature = target.signGrant(text);
  assert.equal(await target.request({ peerId: 'peer-source', method: 'migration.ping', params: { text, signature } }), true);
  assert.equal(source.verifyGrant(receiver, text + ':changed', signature), false);
  assert.equal(source.verifyGrant(receiver, text, source.signGrant(text)), false);
});

test('logout/account switch invalidates already-open connections before handlers', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  await pair(source, target);
  target.changeIdentity({ ...target.identity(), scope: 'different-account' });
  await assert.rejects(target.request({ peerId: 'peer-source', method: 'migration.ping', params: {} }), { code: 'PEER_IDENTITY_CHANGED' });
});

test('expired credential is not renewed through Hub by transport', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  await pair(source, target);
  target.changeIdentity({ ...target.identity(), expiresAt: Date.now() - 1 });
  await assert.rejects(target.request({ peerId: 'peer-source', method: 'migration.ping', params: {} }), { code: 'PEER_IDENTITY_UNAVAILABLE' });
});

test('unknown methods and oversized frames are rejected', async t => {
  const source = peer(t, 'peer-source'), target = peer(t, 'peer-target');
  await pair(source, target);
  await assert.rejects(target.request({ peerId: 'peer-source', method: 'migration.runShell', params: {} }), { code: 'PEER_OPERATION_FORBIDDEN' });
  await assert.rejects(target.request({ peerId: 'peer-source', method: 'migration.ping', params: 'x'.repeat(600000) }), { code: 'PEER_PAYLOAD_TOO_LARGE' });
});
