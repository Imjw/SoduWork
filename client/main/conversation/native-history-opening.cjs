'use strict';

// A proven missing archive may use independent local history. A permission,
// corruption, connection, or ownership failure never authorizes replacement.
async function resolve({ app, session, history, row }) {
  const recover = async (verifyRunner = false) => {
    try {
      const recovery = await history.prepareContinuation(row.id, { refresh: verifyRunner });
      if (verifyRunner && recovery.historyRecovery?.nativeArchiveMissing !== true)
        throw Object.assign(Error('执行底座尚未确认原始会话缺失，请重新打开历史'), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
      return { resume: { ...row, path: '', runtimeConversationId: '' }, recovery };
    }
    catch (error) { if (['NATIVE_HISTORY_MISSING', 'HISTORY_INCOMPLETE', 'HISTORY_UNRESOLVED_TOOLS'].includes(error.code)) return { readOnly: true, error };
      throw error; }
  };
  const record = require('./runtime-segments').read(app, row.id);
  if (row.deviceTransferId && record?.deviceTransferId !== row.deviceTransferId) return recover();
  const active = record?.active || { adapterId: row.adapterId || 'pi', sessionId: row.id };
  if (active.adapterId === 'pi') {
    const found = await session.historyEntry(app, active.sessionId, { strict: true });
    if (!found?.ok && !found?.notFound) throw Error(found?.reason || '原生会话暂时无法读取');
    if (found?.notFound) {
      return recover();
    }
    return { resume: record ? require('./runtime-segments').row(record) : { ...found.entry, adapterId: 'pi' } };
  }
  const resume = await session.archivedConversation(app, row.id, { nativeOnly: true, strict: true });
  if (resume) return { resume };
  const runtime = require('../agent-runtime/runtime-catalog').runtime(active.adapterId);
  if (runtime?.transport !== 'runner')
    throw Object.assign(Error('原始执行底座不可用，无法确认会话状态'), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  return recover(true);
}
module.exports = { resolve };
