'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const frames = require('../main/device-peer/history-frames.cjs');
const transport = require('../main/device-peer/transport.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function receiver() {
  const socket = new EventEmitter(); socket.destroyed = false;
  return frames.create({ socket, send: () => true, assertCurrent() {}, frameLimit: transport.LIMIT });
}
function fragment(bytes, offset = 0, total = bytes.length, sha256 = hash(bytes), id = 'read-one') {
  return { type: 'history-response', id, offset, total, sha256, data: bytes.toString('base64') };
}

test('history chunks obey the frame limit and socket drain backpressure before exact reassembly', async () => {
  const socket = new EventEmitter(); socket.destroyed = false; socket.writableNeedDrain = false;
  const packets = [], result = { items: [{ text: '完整正文🙂'.repeat(100000) }], cursor: 1, hasMore: true };
  const sender = frames.create({ socket, frameLimit: transport.LIMIT, assertCurrent() {}, send(packet) {
    assert.ok(Buffer.byteLength(JSON.stringify(packet) + '\n') <= transport.LIMIT);
    packets.push(packet);
    if (packets.length === 1) { socket.writableNeedDrain = true; return false; }
    return true;
  } });
  const pending = sender.reply('read-one', result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.length, 1, 'No additional history body is queued until the socket drains');
  socket.writableNeedDrain = false; socket.emit('drain'); await pending;
  assert.ok(packets.length > 1);
  const reader = receiver(); let received;
  for (const packet of packets) received = reader.receive(packet, 'history.read');
  assert.deepEqual(received, { complete: true, result });
  assert.equal(reader.has('read-one'), false);
});

test('history reassembly rejects unexpected methods, malformed chunks, gaps, and altered content', async () => {
  const all = Buffer.from(JSON.stringify({ text: 'x'.repeat(frames.CHUNK_BYTES) }));
  const first = all.subarray(0, frames.CHUNK_BYTES), last = all.subarray(frames.CHUNK_BYTES);
  for (const mutate of [packet => ({ ...packet, total: frames.MAX_BYTES + 1 }), packet => ({ ...packet, offset: 1 }),
    packet => ({ ...packet, data: packet.data + ' ' }), packet => ({ ...packet, sha256: 'invalid' })]) {
    assert.throws(() => receiver().receive(mutate(fragment(first, 0, all.length, hash(all))), 'history.read'), { code: 'PEER_HISTORY_INVALID' });
  }
  assert.throws(() => receiver().receive(fragment(Buffer.from('{}')), 'conversation.send'), { code: 'PEER_HISTORY_INVALID' });
  assert.throws(() => receiver().receive(fragment(Buffer.from('x'), 0, frames.MAX_BYTES), 'history.read'),
    { code: 'PEER_HISTORY_INVALID' }, 'Tiny fragments cannot create an unbounded chunk array');
  const gap = receiver(); gap.receive(fragment(first, 0, all.length, hash(all)), 'history.read');
  assert.throws(() => gap.receive(fragment(last, frames.CHUNK_BYTES + 1, all.length, hash(all)), 'history.read'), { code: 'PEER_HISTORY_INVALID' });
  const changed = receiver(); changed.receive(fragment(first, 0, all.length, hash(all)), 'history.read');
  const bad = Buffer.from(last); bad[0] ^= 1;
  assert.throws(() => changed.receive(fragment(bad, frames.CHUNK_BYTES, all.length, hash(all)), 'history.read'), { code: 'PEER_HISTORY_INVALID' });
  const invalidUtf8 = Buffer.from([0x22, 0xff, 0x22]);
  assert.throws(() => receiver().receive(fragment(invalidUtf8), 'history.read'), { code: 'PEER_HISTORY_INVALID' });
});

test('aggregate history allocation is bounded and abandoned fragments release their reservation', () => {
  const reader = receiver(), chunk = Buffer.alloc(frames.CHUNK_BYTES, 120);
  reader.receive(fragment(chunk, 0, frames.MAX_BYTES, hash(chunk)), 'history.read');
  assert.throws(() => reader.receive(fragment(Buffer.from('{}'), 0, 2, hash('{}'), 'another-read'), 'history.list'), { code: 'PEER_HISTORY_INVALID' });
  reader.drop('read-one');
  assert.equal(reader.receive(fragment(Buffer.from('{}'), 0, 2, hash('{}'), 'another-read'), 'history.list').complete, true);
  reader.clear(); assert.equal(reader.has('another-read'), false);
});

test('history sender rechecks identity after drain and never queues another fragment after revocation', async () => {
  const socket = new EventEmitter(); socket.destroyed = false; socket.writableNeedDrain = true;
  let active = true, sent = 0;
  const sender = frames.create({ socket, frameLimit: transport.LIMIT,
    assertCurrent() { if (!active) throw Object.assign(Error('Changed identity'), { code: 'CHANGED' }); },
    send() { sent++; return false; } });
  const pending = sender.reply('read', { text: 'x'.repeat(transport.LIMIT + 1) });
  await new Promise(resolve => setImmediate(resolve));
  active = false; socket.writableNeedDrain = false; socket.emit('drain');
  await assert.rejects(pending, { code: 'CHANGED' }); assert.equal(sent, 1);
});
