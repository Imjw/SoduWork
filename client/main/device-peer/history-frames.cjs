'use strict';

const crypto = require('node:crypto');
const METHODS = new Set(['history.list', 'history.read']);
const CHUNK_BYTES = 128 * 1024, MAX_BYTES = 128 * 1024 * 1024;
const failure = message => Object.assign(Error(message), { code: 'PEER_HISTORY_INVALID' });
const interrupted = () => Object.assign(Error('历史读取已中断，请重新读取所选设备'), { code: 'PEER_HISTORY_INTERRUPTED' });

function create({ socket, send, assertCurrent, frameLimit }) {
  const receiving = new Map();
  let receivedBudget = 0, sendingBudget = 0, queue = Promise.resolve();
  function drop(id) {
    const state = receiving.get(id);
    if (state) { receivedBudget -= state.total; receiving.delete(id); }
  }
  async function write(packet) {
    assertCurrent();
    if (send(packet) === false) await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); socket.off('drain', drain); socket.off('close', close); socket.off('error', close);
        if (error) reject(error); else resolve();
      };
      const drain = () => finish(), close = () => finish(interrupted());
      const timer = setTimeout(close, 15000);
      socket.once('drain', drain); socket.once('close', close); socket.once('error', close);
      if (socket.destroyed) close();
      else if (!socket.writableNeedDrain) drain();
    });
    assertCurrent();
  }
  function reply(id, result) {
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length > MAX_BYTES || sendingBudget + bytes.length > MAX_BYTES)
      throw Object.assign(Error('历史页超过传输限额，请缩小分页后重新读取'), { code: 'PEER_HISTORY_TOO_LARGE' });
    sendingBudget += bytes.length;
    const work = queue.then(async () => {
      // Small history pages retain the normal response format. Only history
      // results can use chunks; requests and migration frames stay unchanged.
      if (bytes.length + Buffer.byteLength(id) + 80 < frameLimit) {
        await write({ type: 'response', id, ok: true, result }); return;
      }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        await write({ type: 'history-response', id, offset, total: bytes.length, sha256,
          data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
      }
    }).finally(() => { sendingBudget -= bytes.length; });
    queue = work.catch(() => {}); return work;
  }
  function receive(packet, method) {
    assertCurrent();
    if (!METHODS.has(method) || !Number.isSafeInteger(packet.total) || packet.total < 1 || packet.total > MAX_BYTES ||
        !Number.isSafeInteger(packet.offset) || packet.offset < 0 || !/^[a-f0-9]{64}$/.test(packet.sha256) ||
        typeof packet.data !== 'string' || packet.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.data))
      throw failure('历史分片格式或限额无效');
    const bytes = Buffer.from(packet.data, 'base64');
    if (!bytes.length || bytes.length !== Math.min(CHUNK_BYTES, packet.total - packet.offset) ||
        bytes.toString('base64') !== packet.data || packet.offset + bytes.length > packet.total)
      throw failure('历史分片长度无效');
    let state = receiving.get(packet.id);
    if (!state) {
      if (packet.offset !== 0 || receivedBudget + packet.total > MAX_BYTES) throw failure('历史分片顺序或总限额无效');
      state = { total: packet.total, sha256: packet.sha256, offset: 0, chunks: [], hash: crypto.createHash('sha256') };
      receiving.set(packet.id, state); receivedBudget += packet.total;
    }
    if (packet.offset !== state.offset || packet.total !== state.total || packet.sha256 !== state.sha256)
      throw failure('历史分片顺序或校验标识不一致');
    state.chunks.push(bytes); state.hash.update(bytes); state.offset += bytes.length;
    if (state.offset !== state.total) return { complete: false };
    drop(packet.id);
    if (state.hash.digest('hex') !== state.sha256) throw failure('历史分片校验失败');
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(state.chunks, state.total))); }
    catch (_) { throw failure('历史响应内容无效'); }
    assertCurrent(); return { complete: true, result };
  }
  return { reply, receive, drop, has: id => receiving.has(id), clear() { receiving.clear(); receivedBudget = 0; } };
}
module.exports = { create, METHODS, CHUNK_BYTES, MAX_BYTES, interrupted };
