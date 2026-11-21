'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lineage = require('../main/conversation/device-transfer-lineage.cjs');
const DOMAIN = 'soduwork-device-grant/v1\0';
const keys = Object.fromEntries(['A', 'B', 'C', 'D'].map(id => [id,
  crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })]));
const encoded = id => lineage.publicKey(keys[id].publicKey);
const copy = value => JSON.parse(JSON.stringify(value));
function fields(source, target, generation) {
  return { scope: JSON.stringify(['https://hub.example', 'owner']), account: 'owner', sid: 'native-owned-session',
    gen: generation, op: crypto.randomUUID(), source, target, sourceKey: encoded(source), targetKey: encoded(target),
    digest: crypto.createHash('sha256').update('content-generation-' + generation).digest('hex') };
}
function sign(grant, source = grant.source) {
  const signature = crypto.sign('sha256', Buffer.from(DOMAIN + lineage.text(grant)), keys[source].privateKey).toString('base64');
  return lineage.signed(grant, signature);
}
function chain() {
  const first = sign(lineage.draft(fields('A', 'B', 1), []));
  const second = sign(lineage.draft(fields('B', 'C', 2), [first]));
  const expected = fields('C', 'A', 3), grant = lineage.draft(expected, [first, second]);
  return { first, second, expected, grant, ancestors: [first, second] };
}

test('A to B to C to A validates a continuous signed chain anchored in A own released grant', () => {
  const c = chain();
  assert.deepEqual(lineage.validate(c.ancestors, c.grant, c.expected, c.first),
    { head: lineage.hash(c.second), generation: 3 });
  const final = sign(c.grant);
  assert.match(lineage.hash(final), /^[a-f0-9]{64}$/);
  const next = fields('A', 'D', 4);
  assert.equal(lineage.validate([...c.ancestors, final], lineage.draft(next, [...c.ancestors, final]), next, c.first).generation, 4);
});

test('current authenticated source key and receiving key are independently bound by expected fields', () => {
  const c = chain();
  for (const patch of [{ sourceKey: encoded('D') }, { targetKey: encoded('D') }, { source: 'D' }, { target: 'D' },
    { account: 'other-owner' }, { scope: JSON.stringify(['https://another.example', 'owner']) },
    { sid: 'other-session' }, { digest: 'f'.repeat(64) }, { op: crypto.randomUUID() }, { gen: 4 }]) {
    assert.throws(() => lineage.validate(c.ancestors, c.grant, { ...c.expected, ...patch }, c.first), /交权链/);
  }
});

test('a valid alternative branch cannot replace the exact locally released anchor', () => {
  const c = chain();
  const alternative = sign(lineage.draft({ ...fields('A', 'B', 1), op: c.first.op, digest: 'e'.repeat(64) }, []));
  const next = sign(lineage.draft(fields('B', 'C', 2), [alternative]));
  const returning = lineage.draft(c.expected, [alternative, next]);
  assert.doesNotThrow(() => lineage.validate([alternative, next], returning, c.expected));
  assert.throws(() => lineage.validate([alternative, next], returning, c.expected, c.first), /交权链/);
  assert.throws(() => lineage.validate([c.second], c.grant, c.expected, c.first), /交权链/);
});

test('re-signing the same released payload does not match its durable signature anchor', () => {
  const c = chain(), replacement = sign(c.first);
  assert.notEqual(replacement.signature, c.first.signature);
  const next = sign(lineage.draft(fields('B', 'C', 2), [replacement]));
  const returning = lineage.draft(c.expected, [replacement, next]);
  assert.throws(() => lineage.validate([replacement, next], returning, c.expected, c.first), /交权链/);
});

test('ancestor payload and signature mutations cannot retain a valid chain', () => {
  const c = chain();
  for (const patch of [{ digest: 'c'.repeat(64) }, { account: 'other-owner' }, { target: 'D' },
    { sourceKey: encoded('D') }, { targetKey: encoded('D') }, { signature: Buffer.alloc(70).toString('base64') }]) {
    const ancestors = copy(c.ancestors); Object.assign(ancestors[0], patch);
    assert.throws(() => lineage.validate(ancestors, c.grant, c.expected, c.first), /交权链/);
  }
  assert.throws(() => sign(c.grant, 'D'), /交权链/);
});

test('signed links cannot skip a generation, change the previous hash or change the delegated source key', () => {
  const c = chain();
  for (const patch of [{ gen: 3 }, { previous: 'f'.repeat(64) }, { source: 'D', sourceKey: encoded('D') }]) {
    const changed = { ...c.second, ...patch };
    delete changed.signature;
    const replacement = sign(changed);
    const returning = { ...c.grant, previous: lineage.hash(replacement) };
    assert.throws(() => lineage.validate([c.first, replacement], returning, c.expected, c.first), /交权链/);
  }
});

test('canonical signing rejects unknown fields, noncanonical scope and malformed public keys', () => {
  const c = chain();
  for (const patch of [{ extra: 'unbound' }, { scope: '[ "https://hub.example", "owner" ]' },
    { sourceKey: c.grant.sourceKey + '\n' }, { gen: 1.5 }, { op: 'not-a-uuid' }, { previous: 'bad' }]) {
    assert.throws(() => lineage.text({ ...c.grant, ...patch }), /交权链/);
  }
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => lineage.publicKey(rsa.publicKey), /交权链/);
  assert.throws(() => lineage.publicKey(keys.A.privateKey), /交权链/);
});

test('chain count and serialized byte limits reject unbounded ancestry before traversal', () => {
  const c = chain();
  assert.throws(() => lineage.validate(Array(lineage.MAX_LINKS).fill(c.first), c.grant, c.expected), /交权链/);
  const oversized = { ...c.first, extra: 'x'.repeat(lineage.MAX_BYTES) };
  assert.throws(() => lineage.validate([oversized], c.grant, c.expected), /交权链/);
  assert.throws(() => lineage.draft(c.expected, null), /交权链/);
});
