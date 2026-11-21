'use strict';

const crypto = require('node:crypto');
const DOMAIN = 'soduwork-device-grant/v1\0';
const ZERO = '0'.repeat(64);
const MAX_LINKS = 256;
const MAX_BYTES = 256 * 1024;
const FIELDS = ['scope','account','sid','gen','op','source','target','sourceKey','targetKey','digest','previous'];
const fail = () => Error('设备交权链无法校验，原会话已保留');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\x00-\x1f]/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function publicKey(value) {
  try {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPublicKey({
      key: Buffer.from(value, 'base64'), format: 'der', type: 'spki',
    });
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw fail();
    const encoded = key.export({format:'der',type:'spki'}).toString('base64');
    if (!(value instanceof crypto.KeyObject) && value !== encoded) throw fail();
    return encoded;
  } catch (_) { throw fail(); }
}

function text(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link) ||
      Object.keys(link).some(name => !FIELDS.includes(name) && name !== 'signature') ||
      !id(link.account) || !id(link.sid) || !id(link.source) || !id(link.target) || link.source === link.target ||
      !Number.isSafeInteger(link.gen) || link.gen < 1 ||
      typeof link.op !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(link.op) ||
      !hex(link.digest) || !hex(link.previous) || typeof link.scope !== 'string' || link.scope.length > 2048) throw fail();
  let scope;
  try { scope = JSON.parse(link.scope); } catch (_) { throw fail(); }
  if (!Array.isArray(scope) || scope.length !== 2 || scope[1] !== link.account ||
      typeof scope[0] !== 'string' || JSON.stringify(scope) !== link.scope) throw fail();
  try { if (new URL(scope[0]).origin !== scope[0]) throw fail(); } catch (_) { throw fail(); }
  publicKey(link.sourceKey); publicKey(link.targetKey);
  return JSON.stringify(['soduwork.device-transfer-lineage/v1',...FIELDS.map(name => link[name])]);
}

function signatureValid(link) {
  try {
    if (typeof link.signature !== 'string' || link.signature.length > 128 ||
        Buffer.from(link.signature,'base64').toString('base64') !== link.signature) return false;
    return crypto.verify('sha256',Buffer.from(DOMAIN + text(link)),
      crypto.createPublicKey({key:Buffer.from(link.sourceKey,'base64'),type:'spki',format:'der'}),
      Buffer.from(link.signature,'base64'));
  } catch (_) { return false; }
}

function hash(link) {
  if (!signatureValid(link)) throw fail();
  return crypto.createHash('sha256').update(text(link)).update('\n').update(link.signature).digest('hex');
}

function signed(grant, signature) {
  const link = {...grant,signature};
  if (!signatureValid(link)) throw fail();
  return link;
}

// Prior certificates may have expired. Each durable grant delegates the exact
// next key; the current key must additionally match the live authenticated peer.
function validate(ancestors, grant, expected, anchor) {
  if (!Array.isArray(ancestors) || ancestors.length >= MAX_LINKS ||
      Buffer.byteLength(JSON.stringify(ancestors)) > MAX_BYTES) throw fail();
  if (grant && Object.hasOwn(grant,'signature')) throw fail();
  text(grant);
  for (const field of ['scope','account','sid','gen','op','source','target','sourceKey','targetKey','digest']) {
    if (grant[field] !== expected[field]) throw fail();
  }
  let last = null, previous = ZERO, anchored = !anchor;
  const anchorHash = anchor && hash(anchor);
  for (const link of ancestors) {
    if (link.scope !== grant.scope || link.account !== grant.account || link.sid !== grant.sid ||
        link.gen !== (last ? last.gen + 1 : 1) || link.previous !== previous ||
        (last && (link.source !== last.target || link.sourceKey !== last.targetKey))) throw fail();
    previous = hash(link);
    if (previous === anchorHash) anchored = true;
    last = link;
  }
  if (!anchored || grant.previous !== previous || grant.gen !== (last ? last.gen + 1 : 1) ||
      (last && (grant.source !== last.target || grant.sourceKey !== last.targetKey))) throw fail();
  return {head:previous,generation:grant.gen};
}

function draft(fields, ancestors) {
  if (!Array.isArray(ancestors)) throw fail();
  const result = {...fields,previous:ancestors.length ? hash(ancestors.at(-1)) : ZERO};
  validate(ancestors,result,fields);
  return result;
}

module.exports = { publicKey, text, hash, signed, validate, draft, MAX_LINKS, MAX_BYTES };
