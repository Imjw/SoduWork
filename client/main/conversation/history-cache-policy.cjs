'use strict';

const crypto = require('node:crypto');

const capturedCopyId = (hub, account, id) => 'copy-' + crypto.createHash('sha256')
  .update(JSON.stringify([hub, account, id])).digest('hex');

function automaticAccountCache(row) {
  const source = row?.source;
  if (!row?.cached || row.importDigest || row.importedHistory || !source?.id ||
      row.cloud || row.locationMode === 'remote' || row.location === 'cloud') return false;
  // Only the deterministic automatic cache is retired. Explicit imports and
  // recovered local outboxes keep their independent identities and contents.
  return row.id === capturedCopyId(source.hub, source.account, source.id) &&
    (row.adapterId === 'account-sync' || row.locationMode === 'account' || row.location === 'account' ||
      String(source.id).startsWith('acct-'));
}

module.exports = { capturedCopyId, automaticAccountCache };
