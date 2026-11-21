'use strict';

const accountFields = ['cloud', 'remoteProjection', 'accountProjection', 'accountConversation',
  'acceptanceReview', 'requirementContext', 'taskId', 'taskRef', 'activeTaskId', 'historyProtection'];
const sourceFields = ['deviceTransferId', 'importedHistory', 'importDigest', 'source', 'sourceSessionId',
  'sourceClientId', 'sourceLocalId', 'cached'];
function protectedEvidence(row) {
  return accountFields.some(key => Boolean(row?.[key])) ||
    ['taskIds', 'taskBindings'].some(key => row?.[key] && (!Array.isArray(row[key]) || row[key].length));
}
function invalid() {
  return Object.assign(Error('原生会话归属证据无效，请重新读取'), { code: 'HISTORY_EVIDENCE_INVALID', historyAccessFailure: true });
}
function mergeNativeEvidence(indexedRow, nativeRow) {
  const indexed = indexedRow || {}, fresh = nativeRow || {}, merged = { ...indexed };
  // New evidence can only add protection. It cannot replace immutable creator
  // attribution, remove a task restriction, or turn an import into a local chat.
  if (protectedEvidence(indexed) || protectedEvidence(fresh)) merged.historyProtection = 'account';
  for (const key of sourceFields) if (!merged[key] && fresh[key]) merged[key] = fresh[key];
  if (fresh.adapterId === 'account-sync') merged.adapterId = fresh.adapterId;
  for (const key of ['location', 'locationMode'])
    if ((!merged[key] || merged[key] === 'local') && fresh[key] && fresh[key] !== 'local') merged[key] = fresh[key];
  const owners = new Set();
  for (const row of [indexed, fresh]) {
    if (row.historyNativeOwners !== undefined && !Array.isArray(row.historyNativeOwners)) throw invalid();
    for (const owner of row.historyNativeOwners || []) owners.add(owner);
    if (row.workOwner !== undefined && row.workOwner !== '') owners.add(row.workOwner);
  }
  if (owners.size > 1001) throw invalid();
  if (owners.size) merged.historyNativeOwners = [...owners];
  if (indexed.historyAliasIds !== undefined && !Array.isArray(indexed.historyAliasIds)) throw invalid();
  const ids = new Set(indexed.historyAliasIds || []);
  if (fresh.historyAliasIds !== undefined && !Array.isArray(fresh.historyAliasIds)) throw invalid();
  for (const id of [...(fresh.historyAliasIds || []), fresh.id, fresh.sessionId]) {
    if (id === undefined || id === '') continue;
    if (typeof id !== 'string' || id.length > 512 || /[\x00-\x1f]/.test(id)) throw invalid();
    if (id !== (indexed.id || indexed.sessionId)) ids.add(id);
  }
  if (ids.size > 1000) throw invalid();
  if (ids.size || indexed.historyAliasIds) merged.historyAliasIds = [...ids];
  return merged;
}
module.exports = { mergeNativeEvidence };
