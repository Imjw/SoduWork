'use strict';

const crypto = require('node:crypto');

// Catalog refreshes change its cursor even for a read-only view. Compare the
// actual transcript, lifecycle intent and user-editable metadata on return.
function historyStamp(row, saved, transferId) {
  const metadata = [row.title, row.adapterId, row.modelName, row.taskId, row.taskTitle,
    row.taskIds, row.taskBindings, row.activeTaskId, row.creator, row.workOwner, row.cwd,
    row.archived, row.deleted, row.deviceTransferId, row.deviceTransferDigest];
  return { transferId, lifecycleRevision: row.replicaRevision ?? 0, digest: saved.digest,
    metadata: crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
}
function matchesHistory(expected, row, saved) {
  if (!expected || !row || row.deleted || !saved) return false;
  const actual = historyStamp(row, saved, expected.transferId);
  return expected.lifecycleRevision === actual.lifecycleRevision && expected.digest === actual.digest &&
    expected.metadata === actual.metadata;
}

module.exports = { historyStamp, matchesHistory };
