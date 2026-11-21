'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { create } = require('../main/device-peer/identity.cjs');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-peer-identity-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = path.resolve(__dirname, '../../hub-backend');
  const python = process.env.SODUWORK_TEST_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let callback, epoch = 'epoch-a', fetches = 0, issuerError = '';
  const id = { hub: 'https://peer.invalid', clientId: 'peer-source', secret: 'isolated-main-only-device-credential',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'peer-source', uid: 'peer-owner' })).toString('base64url') + '.fixture' };
  const deviceAuth = { identity: () => id, session: () => id.session, historyEpoch: () => epoch,
    onSessionIssued: fn => { callback = fn; return () => { callback = null; }; } };
  const fetchImpl = async (url, options) => {
    fetches++;
    assert.equal(url, id.hub + '/api/v1/client-auth/peer-identity');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Device ' + id.session);
    assert.equal(options.headers['X-Device-Key'], id.secret);
    const input = path.join(root, 'public-request.json'), output = path.join(root, 'public-response.json');
    fs.writeFileSync(input, options.body);
    const result = spawnSync(python, ['-m', 'tests.device_peer_fixture', '--issue', input, output], { cwd: backend, encoding: 'utf8' });
    if (result.status !== 0) issuerError = result.stderr;
    assert.equal(result.status, 0, result.stderr);
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(output, 'utf8')) };
  };
  const manager = create({ app: { getPath: () => root }, safeStorage: createSafeStorage(), deviceAuth, fetchImpl, ...extra });
  t.after(() => manager.dispose());
  return { manager, id, root, file: path.join(root, 'device-peer-identities.json'), fetches: () => fetches,
    issue: () => callback(id), changeEpoch: () => { epoch = 'epoch-b'; }, issuer: fetchImpl, issuerError: () => issuerError };
}

test('login hook registers only a possessed public key and stores the private key encrypted', async t => {
  const f = fixture(t);
  assert.equal(f.manager.identityOf(), null);
  await f.issue();
  const first = f.manager.identityOf();
  assert.ok(first, f.issuerError()); assert.equal(first.role, 'desktop'); assert.equal(first.accountId, 'peer-owner');
  const stored = fs.readFileSync(f.file, 'utf8');
  assert.ok(!stored.includes('PRIVATE KEY')); assert.ok(!stored.includes(f.id.session)); assert.ok(!stored.includes(f.id.secret));
  await f.issue();
  assert.equal(f.manager.identityOf().keyFingerprint, first.keyFingerprint);
  assert.equal(f.fetches(), 2);
  f.manager.identityOf(); f.manager.trustedPeers(first);
  assert.equal(f.fetches(), 2);
});

test('current login epoch bounds cached credentials and persisted pairing writes', async t => {
  const f = fixture(t); await f.issue();
  const id = f.manager.identityOf();
  f.manager.rememberPeer(id, { deviceId: 'peer-target', keyFingerprint: 'fixture-public-key', role: 'desktop' });
  assert.equal(f.manager.trustedPeers(id).length, 1);
  f.changeEpoch();
  assert.equal(f.manager.identityOf(), null);
  assert.throws(() => f.manager.rememberPeer(id, { deviceId: 'other' }), /账号/);
});

test('locked safe storage neither creates a key nor contacts the issuer', async t => {
  const f = fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await f.issue();
  assert.equal(f.manager.identityOf(), null); assert.equal(f.fetches(), 0); assert.equal(fs.existsSync(f.file), false);
});

test('corrupted key storage is retained instead of silently replacing the key', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, 'interrupted fixture record');
  await f.issue();
  assert.equal(f.manager.identityOf(), null); assert.equal(f.fetches(), 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'interrupted fixture record');
});

test('issuer failure leaves direct access disabled without failing ordinary login', async t => {
  const f = fixture(t, { fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.doesNotReject(f.issue());
  assert.equal(f.manager.identityOf(), null);
});

test('non-TLS remote Hub cannot establish an offline trust anchor', async t => {
  const f = fixture(t); f.id.hub = 'http://peer.invalid';
  await f.issue();
  assert.equal(f.fetches(), 0); assert.equal(f.manager.identityOf(), null);
});

test('late certificate response after account transition never activates direct transport', async t => {
  let proceed, entered;
  const signal = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { fetchImpl: async (...args) => {
    entered(); await new Promise(resolve => { proceed = resolve; }); return f.issuer(...args);
  } });
  const pending = f.issue(); await signal; f.changeEpoch(); proceed(); await pending;
  assert.equal(f.issuerError(), '');
  assert.equal(f.manager.identityOf(), null);
});

test('cached peer identity follows an enrollment account change within the same login epoch', async t => {
  const f = fixture(t);
  await f.issue();
  const id = f.manager.identityOf();
  assert.ok(id);
  f.id.session = Buffer.from(JSON.stringify({ typ: 'device', cid: 'peer-source', uid: 'other-owner' })).toString('base64url') + '.fixture';
  assert.equal(f.manager.identityOf(), null);
  assert.throws(() => f.manager.rememberPeer(id, { deviceId: 'peer-target' }), /账号/);
});
