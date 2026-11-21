'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { certificateIdentity } = require('./transport.cjs');
const { accountId } = require('../device-auth-request.js');

function create({ app, safeStorage, deviceAuth, fetchImpl = global.fetch, onChange = () => {} }) {
  const credentials = require('../device-credential-store.cjs').create({ app, safeStorage });
  const file = path.join(app.getPath('userData'), 'device-peer-identities.json');
  let active = null, issuance = 0;
  const slot = id => crypto.createHash('sha256').update(id.hub + '\n' + id.clientId).digest('hex');
  function read() {
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error();
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.v !== 1 || !data.keys || typeof data.keys !== 'object') throw Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { v: 1, keys: {}, peers: {} };
      throw Object.assign(Error('直连身份存储无法读取，原记录已保留'), { code: 'PEER_STORE_UNAVAILABLE' });
    }
  }
  function write(doc) {
    const next = file + '.' + crypto.randomUUID() + '.next';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(next, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(doc)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(next, file);
    } finally { try { fs.unlinkSync(next); } catch (_) {} }
  }
  function keyFor(id) {
    if (!credentials.available()) throw Error('系统安全存储不可用，无法启用直连');
    const doc = read(), key = slot(id);
    if (!doc.keys[key]) {
      const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      doc.keys[key] = { hub: id.hub, clientId: id.clientId,
        cipher: credentials.encrypt(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
        storage: 'electron-safe-storage' };
      write(doc);
    }
    const row = doc.keys[key];
    if (row.hub !== id.hub || row.clientId !== id.clientId) throw Error('直连身份归属不匹配');
    return crypto.createPrivateKey(credentials.decrypt(file, row));
  }
  function identityOf() {
    if (!active) return null;
    const id = deviceAuth.identity(app);
    if (!id || id.hub !== active.hub || id.clientId !== active.deviceId ||
        deviceAuth.historyEpoch(id) !== active.epoch || active.expiresAt <= Date.now() ||
        accountId({ ...id, session: deviceAuth.session(app, id.hub, id.clientId) }) !== active.accountId) return null;
    return active;
  }
  async function issued(id) {
    const request = ++issuance, epoch = deviceAuth.historyEpoch(id), owner = accountId(id);
    const current = () => {
      const latest = deviceAuth.identity(app);
      return request === issuance && latest && latest.hub === id.hub && latest.clientId === id.clientId &&
        deviceAuth.historyEpoch(latest) === epoch && accountId({ ...latest, session: deviceAuth.session(app, latest.hub, latest.clientId) }) === owner;
    };
    if (!owner || !current()) return;
    // Offline verification trusts only the authority acquired through authenticated TLS.
    // Loopback HTTP remains available for isolated source development.
    const url = new URL(id.hub);
    if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return;
    try {
      const privateKey = keyFor(id), publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
      const role = 'desktop', issuedAt = Math.floor(Date.now() / 1000);
      const proof = crypto.sign('sha256', Buffer.from(`soduwork-peer-key/v1\n${id.clientId}\n${role}\n${issuedAt}\n${publicKey}`), privateKey).toString('base64');
      const response = await fetchImpl(id.hub + '/api/v1/client-auth/peer-identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Device ' + id.session, 'X-Device-Key': id.secret },
        body: JSON.stringify({ publicKey, role, issuedAt, proof }), redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!current()) return;
      const certificate = new crypto.X509Certificate(data.certificate), authority = new crypto.X509Certificate(data.authority);
      const claims = certificateIdentity(certificate);
      if (!certificate.verify(authority.publicKey) || !certificate.checkPrivateKey(privateKey) ||
          claims.deviceId !== id.clientId || claims.accountId !== owner || claims.role !== role ||
          claims.expiresAt <= Date.now() || claims.expiresAt > Date.now() + 31 * 60000) throw Error('Invalid peer credential');
      active = { ...claims, certificate: data.certificate, authority: data.authority, privateKey,
        hub: id.hub, epoch, scope: id.hub + '\n' + owner + '\n' + id.clientId + '\n' + epoch };
      onChange(active);
    } catch (_) { /* Normal sign-in survives unavailable peer enrollment; direct access fails closed. */ }
  }
  function trustedPeers(id) {
    const rows = read().peers?.[slot({ hub: id.hub, clientId: id.deviceId }) + ':' + id.accountId];
    return Array.isArray(rows) ? rows : [];
  }
  function rememberPeer(id, peer) {
    if (!identityOf() || identityOf().scope !== id.scope) throw Error('账号已变化，配对未保存');
    const doc = read(), key = slot({ hub: id.hub, clientId: id.deviceId }) + ':' + id.accountId;
    doc.peers ||= {};
    const rows = doc.peers[key] || [];
    const old = rows.find(row => row.deviceId === peer.deviceId);
    if (old && old.keyFingerprint !== peer.keyFingerprint) throw Error('设备公钥已变化，未替换原配对');
    doc.peers[key] = [...rows.filter(row => row.deviceId !== peer.deviceId), {
      deviceId: peer.deviceId, keyFingerprint: peer.keyFingerprint, role: peer.role }];
    write(doc);
  }
  const unsubscribe = deviceAuth.onSessionIssued(issued);
  return { identityOf, trustedPeers, rememberPeer, dispose: () => { issuance++; active = null; unsubscribe(); } };
}
module.exports = { create };
