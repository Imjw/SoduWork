'use strict';
const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const LIMIT = 512 * 1024;
const historyFrames = require('./history-frames.cjs');
const fail = (code, message) => Object.assign(Error(message), { code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tlsKey = value => value instanceof crypto.KeyObject ? value.export({ type: 'pkcs8', format: 'pem' }) : value;

function certificateIdentity(certificate) {
  const cert = certificate instanceof crypto.X509Certificate ? certificate : new crypto.X509Certificate(certificate);
  const subject = cert.toLegacyObject().subject;
  const role = { 'soduwork-peer-desktop': 'desktop', 'soduwork-peer-mobile': 'mobile' }[subject.O];
  if (!role || typeof subject.CN !== 'string' || typeof subject.OU !== 'string') throw fail('PEER_IDENTITY_INVALID', '直连设备身份无效');
  return { deviceId: subject.CN, accountId: subject.OU, role,
    keyFingerprint: hash(cert.publicKey.export({ type: 'spki', format: 'der' })),
    publicKey: cert.publicKey, expiresAt: Date.parse(cert.validTo) };
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw fail('PEER_ENDPOINT_INVALID', '请输入设备的 TLS 直连地址'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'tls:' || !net.isIP(host) || !url.port || +url.port > 65535 ||
      url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/') ||
      host === '0.0.0.0' || host === '::') throw fail('PEER_ENDPOINT_INVALID', '直连地址必须明确指定设备 IP 和端口');
  return { host, port: +url.port };
}

function create({ identityOf, confirmPair, handlers = {}, trustedPeers = () => [], rememberPeer = () => {}, onChange = () => {} }) {
  let server = null, offer = null, listenerScope = '';
  const connections = new Map(), sockets = new Set();
  const snapshot = () => {
    const identity = identityOf();
    if (!identity || identity.expiresAt <= Date.now()) throw fail('PEER_IDENTITY_UNAVAILABLE', '直连身份尚未就绪或已过期，请重新登录');
    const signed = certificateIdentity(identity.certificate);
    if (signed.deviceId !== identity.deviceId || signed.accountId !== identity.accountId ||
        signed.role !== identity.role || signed.keyFingerprint !== identity.keyFingerprint || signed.expiresAt <= Date.now()) {
      throw fail('PEER_IDENTITY_INVALID', '直连身份与签发证书不一致');
    }
    return identity;
  };
  const current = identity => {
    const now = snapshot();
    if (now.scope !== identity.scope || now.keyFingerprint !== identity.keyFingerprint) throw fail('PEER_IDENTITY_CHANGED', '账号或设备身份已变化，直连已停止');
    return now;
  };
  function allowed(method, callerRole, targetRole) {
    if (!Object.hasOwn(handlers, method) || targetRole !== 'desktop') return false;
    return method.startsWith('migration.') ? callerRole === 'desktop'
      : /^(history\.(list|read)|conversation\.(send|status))$/.test(method) && callerRole === 'mobile';
  }
  const publicPeer = peer => ({ peerId: peer.peerId, deviceId: peer.deviceId, accountId: peer.accountId,
    role: peer.role, keyFingerprint: peer.keyFingerprint, connected: true, expiresAt: peer.expiresAt });

  function attach(socket, local, outbound) {
    const peer = certificateIdentity(socket.getPeerCertificate(true).raw);
    if (!socket.authorized || peer.accountId !== local.accountId || peer.deviceId === local.deviceId ||
        peer.expiresAt <= Date.now() || (outbound && peer.role !== 'desktop') ||
        (!outbound && local.role !== 'desktop')) throw fail('PEER_FORBIDDEN', '仅允许同账号指定的非移动设备直连');
    peer.peerId = peer.deviceId;
    const pending = new Map();
    let buffer = Buffer.alloc(0), paired = false, processing = 0;
    let handshakeResolve, handshakeReject;
    const handshake = new Promise((resolve, reject) => { handshakeResolve = resolve; handshakeReject = reject; });
    handshake.catch(() => {});
    function assertCurrent() {
      current(local);
      if (socket.destroyed || peer.expiresAt <= Date.now()) throw fail('PEER_DISCONNECTED', '设备直连已断开或身份已过期');
    }
    peer.assertCurrent = assertCurrent;
    peer.verifyGrant = (text, signature) => { assertCurrent(); return verify(peer.publicKey, text, signature); };
    function send(packet) {
      assertCurrent();
      if (socket.writableLength > 2 * LIMIT) throw fail('PEER_BUSY', '设备传输队列已满，请等待当前操作完成');
      const bytes = Buffer.from(JSON.stringify(packet) + '\n');
      if (bytes.length > LIMIT) throw fail('PEER_PAYLOAD_TOO_LARGE', '直连消息过大，请分块传输');
      return socket.write(bytes);
    }
    const history = historyFrames.create({ socket, send, assertCurrent, frameLimit: LIMIT });
    function ready() {
      assertCurrent();
      paired = true;
      const previous = connections.get(peer.peerId);
      if (previous && previous.socket !== socket) previous.socket.destroy();
      connections.set(peer.peerId, { peer, local, socket, send, pending, history });
      handshakeResolve(publicPeer(peer)); onChange();
    }
    async function receive(packet) {
      assertCurrent();
      if (!paired) {
        if (outbound) {
          if (packet.type !== 'paired') throw fail('PEER_PAIR_REJECTED', '对方设备未确认配对');
          await rememberPeer(local, publicPeer(peer)); ready(); return;
        }
        if (packet.type !== 'pair') throw fail('PEER_PAIR_REQUIRED', '请先在两台设备上明确配对');
        const known = trustedPeers(local).find(row => row.deviceId === peer.deviceId);
        if (known && known.keyFingerprint !== peer.keyFingerprint) throw fail('PEER_KEY_CHANGED', '对方设备公钥已变化，未自动替换配对');
        const remembered = !!known;
        if (!remembered) {
          const supplied = String(packet.offer || '');
          if (!offer || offer.scope !== local.scope || offer.expiresAt <= Date.now() ||
              !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(offer.secret))) {
            throw fail('PEER_PAIR_REQUIRED', '配对码无效或已过期');
          }
          offer = null;
          if (!await confirmPair?.(publicPeer(peer))) throw fail('PEER_PAIR_REJECTED', '本机未允许此次配对');
          assertCurrent();
          await rememberPeer(local, publicPeer(peer));
        }
        send({ type: 'paired' }); ready(); return;
      }
      if (packet.type === 'response') {
        const job = pending.get(packet.id);
        if (!job) return;
        if (packet.ok && history.has(packet.id)) throw fail('PEER_HISTORY_INVALID', '历史分片未完整接收');
        history.drop(packet.id);
        pending.delete(packet.id); clearTimeout(job.timer);
        if (packet.ok) job.resolve(packet.result);
        else job.reject(fail(String(packet.code || 'PEER_REQUEST_FAILED'), String(packet.error || '设备操作失败')));
        return;
      }
      if (packet.type === 'history-response') {
        const job = pending.get(packet.id);
        if (!job) return;
        const result = history.receive(packet, job.method);
        if (result.complete) { pending.delete(packet.id); clearTimeout(job.timer); job.resolve(result.result); }
        return;
      }
      if (packet.type !== 'request' || typeof packet.id !== 'string' || packet.id.length > 80 ||
          typeof packet.method !== 'string' || !allowed(packet.method, peer.role, local.role)) {
        throw fail('PEER_OPERATION_FORBIDDEN', '当前设备角色不允许此直连操作');
      }
      if (++processing > 8) { processing--; send({ type: 'response', id: packet.id, ok: false, code: 'PEER_BUSY', error: '设备直连繁忙' }); return; }
      try {
        const result = await handlers[packet.method](packet.params, peer);
        assertCurrent();
        if (historyFrames.METHODS.has(packet.method)) await history.reply(packet.id, result);
        else send({ type: 'response', id: packet.id, ok: true, result });
      } catch (error) {
        send({ type: 'response', id: packet.id, ok: false, code: error.code || 'PEER_REQUEST_FAILED', error: error.message || '设备操作失败' });
      } finally { processing--; }
    }
    let authenticating = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let at; (at = buffer.indexOf(10)) >= 0;) {
        if (at > LIMIT) { socket.destroy(); return; }
        const row = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
        let packet;
        try { packet = JSON.parse(row); if (!packet || typeof packet !== 'object') throw Error(); }
        catch (_) { socket.destroy(); return; }
        if (!paired && authenticating) { socket.destroy(); return; }
        if (!paired) authenticating = true;
        Promise.resolve(receive(packet)).catch(error => { handshakeReject(error); socket.destroy(); });
      }
      if (buffer.length > LIMIT) socket.destroy();
    });
    const timer = setTimeout(() => { handshakeReject(fail('PEER_PAIR_TIMEOUT', '设备配对超时')); socket.destroy(); }, 30000);
    handshake.finally(() => clearTimeout(timer)).catch(() => {});
    socket.on('error', error => { handshakeReject(fail('PEER_CONNECT_FAILED', '设备直连失败')); });
    socket.on('close', () => {
      clearTimeout(timer); sockets.delete(socket);
      if (connections.get(peer.peerId)?.socket === socket) connections.delete(peer.peerId);
      handshakeReject(fail('PEER_DISCONNECTED', '设备直连已断开'));
      for (const job of pending.values()) { clearTimeout(job.timer); job.reject(historyFrames.METHODS.has(job.method)
        ? historyFrames.interrupted() : fail('PEER_RESULT_UNKNOWN', '直连中断，操作结果待核实，请勿重新执行')); }
      pending.clear(); history.clear(); onChange();
    });
    if (outbound) {
      if (peer.deviceId !== outbound.expectedDeviceId) throw fail('PEER_TARGET_CHANGED', '直连设备与选择的目标不一致');
      const remembered = trustedPeers(local).find(row => row.deviceId === peer.deviceId);
      if (remembered && remembered.keyFingerprint !== peer.keyFingerprint) throw fail('PEER_KEY_CHANGED', '对方设备公钥已变化，未自动替换配对');
      if (!remembered && !outbound.offer) throw fail('PEER_PAIR_REQUIRED', '请使用对方设备提供的配对码');
      send({ type: 'pair', offer: outbound.offer || '' });
    }
    return handshake;
  }
  function status() {
    let id;
    try { id = snapshot(); } catch (_) {}
    const address = server?.address();
    const hosts = address && (address.address === '0.0.0.0' || address.address === '::')
      ? Object.values(os.networkInterfaces()).flat().filter(row => row && !row.internal &&
        net.isIP(row.address) === net.isIP(address.address)).map(row => row.address)
      : address ? [address.address] : [];
    return { ready: !!id, listening: !!address, deviceId: id?.deviceId || '', accountId: id?.accountId || '',
      role: id?.role || '', scope: id?.scope || '', expiresAt: id?.expiresAt || 0,
      endpoints: hosts.map(host => 'tls://' + (net.isIP(host) === 6 ? '[' + host + ']' : host) + ':' + address.port),
      peers: [...connections.values()].map(row => publicPeer(row.peer)) };
  }
  async function stop() {
    offer = null;
    for (const socket of sockets) socket.destroy();
    connections.clear();
    if (server) { const old = server; server = null; await new Promise(resolve => old.close(resolve)); }
    onChange(); return status();
  }
  async function listen({ host = '127.0.0.1', port = 0 } = {}) {
    const local = snapshot();
    if (local.role !== 'desktop' || !net.isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw fail('PEER_LISTEN_FORBIDDEN', '仅桌面设备可以启用指定地址的直连');
    if (server) return status();
    listenerScope = local.scope;
    server = tls.createServer({ key: tlsKey(local.privateKey), cert: local.certificate, ca: local.authority,
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', handshakeTimeout: 10000 }, socket => {
      sockets.add(socket);
      try { current(local); attach(socket, local).catch(() => socket.destroy()); }
      catch (_) { socket.destroy(); }
    });
    server.maxConnections = 16;
    server.on('tlsClientError', () => {});
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
    catch (error) { server = null; throw fail('PEER_LISTEN_FAILED', '无法监听设备直连地址'); }
    onChange(); return status();
  }
  async function connect(options) {
    const local = snapshot(), address = endpoint(options.endpoint);
    if (!options.expectedDeviceId) throw fail('PEER_TARGET_REQUIRED', '请选择明确的目标设备');
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ ...address, key: tlsKey(local.privateKey), cert: local.certificate,
        ca: local.authority, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
        // Identity comes from the CA-signed device ID and the selected target, not a DNS alias.
        checkServerIdentity: () => undefined }, () => {
        clearTimeout(timer);
        try { current(local); attach(socket, local, options).then(resolve, error => { socket.destroy(); reject(error); }); }
        catch (error) { socket.destroy(); reject(error); }
      });
      sockets.add(socket);
      const timer = setTimeout(() => { socket.destroy(); reject(fail('PEER_CONNECT_FAILED', '设备无法直连；未切换到 Hub 或其他设备')); }, 10000);
      socket.once('error', () => { clearTimeout(timer); socket.destroy(); reject(fail('PEER_CONNECT_FAILED', '设备无法直连；未切换到 Hub 或其他设备')); });
      socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    });
  }
  async function request({ peerId, method, params }) {
    const connection = connections.get(peerId);
    if (!connection) throw fail('PEER_DISCONNECTED', '指定设备未连接');
    const { peer, local, pending, send, history } = connection;
    peer.assertCurrent();
    if (!allowed(method, local.role, peer.role)) throw fail('PEER_OPERATION_FORBIDDEN', '当前设备角色不允许此直连操作');
    if (pending.size >= 8) throw fail('PEER_BUSY', '设备直连繁忙');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); history.drop(id); reject(historyFrames.METHODS.has(method)
        ? historyFrames.interrupted() : fail('PEER_RESULT_UNKNOWN', '操作回执超时，请核实原操作状态')); }, 60000);
      pending.set(id, { resolve, reject, timer, method });
      try { send({ type: 'request', id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const guardTimer = setInterval(() => {
    for (const { peer, socket } of connections.values()) { try { peer.assertCurrent(); } catch (_) { socket.destroy(); } }
  }, 1000);
  guardTimer.unref();
  return { status, listen, stop, connect, request,
    refreshCredentials() {
      const id = snapshot();
      if (server && listenerScope !== id.scope) { void stop(); return; }
      if (server) server.setSecureContext({ key: tlsKey(id.privateKey), cert: id.certificate, ca: id.authority });
    },
    createPairingOffer() {
      const id = snapshot();
      if (!server?.listening || id.role !== 'desktop') throw fail('PEER_NOT_LISTENING', '请先明确启用本机直连');
      offer = { secret: crypto.randomBytes(32).toString('base64url'), expiresAt: Date.now() + 120000, scope: id.scope };
      return { offer: offer.secret, expiresAt: offer.expiresAt, deviceId: id.deviceId, endpoints: status().endpoints };
    },
    peers: () => status().peers,
    grantIdentity(peerId) {
      if (peerId) {
        const connection = connections.get(peerId);
        if (!connection) throw fail('PEER_DISCONNECTED', '指定设备未连接');
        connection.peer.assertCurrent();
        const remote = connection.peer;
        return { deviceId:remote.deviceId, accountId:remote.accountId, role:remote.role,
          publicKey:remote.publicKey.export({type:'spki',format:'der'}).toString('base64') };
      }
      const local = snapshot(), signed = certificateIdentity(local.certificate);
      return { deviceId:local.deviceId, accountId:local.accountId, role:local.role,
        publicKey:signed.publicKey.export({type:'spki',format:'der'}).toString('base64') };
    },
    disconnect({ peerId }) { connections.get(peerId)?.socket.destroy(); return { ok: true }; },
    signGrant(text) {
      const id = snapshot();
      if (typeof text !== 'string' || text.length > LIMIT) throw fail('PEER_GRANT_INVALID', '交权凭证格式无效');
      return crypto.sign('sha256', Buffer.from('soduwork-device-grant/v1\0' + text), id.privateKey).toString('base64');
    },
    verifyGrant(peer, text, signature) {
      const connection = connections.get(typeof peer === 'string' ? peer : peer.peerId);
      if (!connection) return false;
      connection.peer.assertCurrent(); return verify(connection.peer.publicKey, text, signature);
    },
    dispose: async () => { clearInterval(guardTimer); await stop(); },
  };
}
function verify(key, text, signature) {
  try { return typeof text === 'string' && text.length <= LIMIT && typeof signature === 'string' && signature.length <= 256 &&
    crypto.verify('sha256', Buffer.from('soduwork-device-grant/v1\0' + text), key, Buffer.from(signature, 'base64')); } catch (_) { return false; }
}
module.exports = { create, certificateIdentity, endpoint, LIMIT };
