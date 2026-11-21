'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { accountId } = require('./device-auth-request');
const { diskJournal } = require('./automation-conversations');
const fingerprint = require('./conversation/personal-relay').fingerprint;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const METHODS = ['history.list', 'history.read', 'conversation.send', 'conversation.status',
  'migration.offer', 'migration.chunk', 'migration.prepare', 'migration.grant', 'migration.abort'];
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);

function create({ app, identityOf, conversation, session, peer, transfer,
  journal = diskJournal(path.join(app.getPath('userData'), 'device-direct-message-receipts')) }) {
  const scope = identity => [identity?.hub || '', identity?.clientId || '', accountId(identity)];
  let queue = Promise.resolve();
  async function metadata(item, guard) {
    if (!item || !conversation.deviceHistory) return item;
    const row = await conversation.deviceHistory.resolve(item.id);
    await guard();
    const native = row && !row.cached && !row.cloud && !row.remoteProjection && !row.accountProjection &&
      !row.importDigest && !row.importedHistory && !row.deleted && !row.archived &&
      !['missing', 'partial'].includes(row.historyContentState) &&
      row.adapterId !== 'account-sync' && !['remote', 'account'].includes(row.locationMode) && !transfer.blocked?.(row.id);
    return { ...item, canContinue: Boolean(native), continuationId: native ? row.id : '',
      continuationRevision: native ? row.revision || 0 : 0 };
  }
  async function authorization(remote, role) {
    await remote?.assertCurrent?.();
    const identity = await identityOf(app), key = JSON.stringify(scope(identity));
    if (!remote || typeof remote.assertCurrent !== 'function' || remote.role !== role || !remote.deviceId ||
        !accountId(identity) || remote.accountId !== accountId(identity) || remote.deviceId === identity.clientId)
      throw Error('设备身份或访问方向不允许此操作');
    const guard = async () => {
      await remote.assertCurrent();
      if (JSON.stringify(scope(await identityOf(app))) !== key) throw Error('账号或设备连接已变化');
    };
    await guard();
    return { identity, guard, key };
  }
  async function send(remote, params) {
    const { identity, guard, key } = await authorization(remote, 'mobile');
    if (!params || Object.keys(params).some(k => !['sessionId', 'messageId', 'text'].includes(k)) ||
        !textId(params.sessionId) || !/^[A-Za-z0-9_-]{8,100}$/.test(params.messageId || '') ||
        typeof params.text !== 'string' || !params.text.trim() || params.text.length > 50000)
      throw Error('续聊请求不正确');
    const receiptKey = digest([key, remote.deviceId, params.messageId]), hash = digest(params);
    const previous = journal.read(receiptKey);
    if (previous) {
      if (previous.digest !== hash) throw Error('消息标识已用于其他内容，不能重复使用');
      await guard();
      return previous.result || { ok: false, phase: 'uncertain', messageId: params.messageId,
        reason: '上次发送结果尚未确认，请核对来源电脑；不会重复发送' };
    }
    // Resolve through the owner's indexed reader before opening a native runtime.
    await conversation.history({ action: 'read', id: params.sessionId, limit: 1 }, guard, identityOf);
    await guard();
    let handle = conversation.find(params.sessionId);
    if (!handle) {
      const opened = await conversation.open({ chatId: params.sessionId, nativeRelay: true }, identity);
      if (!opened?.ok) throw Error(opened?.reason || '来源会话暂时无法打开');
      handle = conversation.find(params.sessionId);
    }
    const snapshot = handle?.snapshot?.();
    if (!handle || handle.sessionId !== params.sessionId || handle.localReplica || handle.passiveCloudView || snapshot?.cloudHandoff ||
        snapshot?.execution?.accountConversation)
      throw Error('仅允许继续这台电脑持有的本机会话');
    if (handle.inFlight?.() || ['streaming', 'running', 'responding', 'queued'].includes(snapshot?.status))
      throw Error('原会话正在执行，请等待完成后再发送');
    if (snapshot?.runtimeUnavailable) throw Error('请先在来源电脑恢复执行底座');
    // Task routing is derived only from the source runtime. The peer cannot
    // choose a task or manufacture execution permissions in its payload.
    const taskId = String(handle.activeTaskId || handle.taskRef || handle.taskId ||
      snapshot?.execution?.turnQueue?.activeTaskId || (handle.taskIds?.length === 1 ? handle.taskIds[0] : '')).trim();
    if (!taskId && handle.taskIds?.length) throw Error('请先在来源电脑选择要继续的需求');
    const before = fingerprint(handle);
    await guard();
    // Persist before dispatch. A crash or a lost reply never authorizes a second send.
    journal.write(receiptKey, { digest: hash, sessionId: params.sessionId });
    let result;
    try {
      const sent = await conversation.send(handle.ref, params.text, [], {
        submissionId: 'device-direct-' + params.messageId,
        ...(taskId ? { taskId, taskExecution: { reuseConversation: true, followUp: true } } : {}),
        skills: [...(handle.ui?.selectedSkills || [])],
        nativeRelayGuard: async () => {
          await guard();
          if (conversation.find(params.sessionId) !== handle || handle.inFlight?.() || fingerprint(handle) !== before)
            throw Error('来源会话已变化，本次消息未发送');
        },
      });
      result = { ok: sent?.ok === true && sent?.accepted === true, messageId: params.messageId,
        phase: sent?.ok && sent?.accepted ? 'accepted' : 'rejected',
        reason: sent?.ok && sent?.accepted ? '' : '来源会话未接收消息，请在来源电脑核对' };
    } catch (_) {
      result = { ok: false, phase: 'uncertain', messageId: params.messageId,
        reason: '发送结果尚未确认，请核对来源电脑；不会自动重发' };
    }
    journal.write(receiptKey, { digest: hash, sessionId: params.sessionId, result });
    await guard();
    return result;
  }
  async function receive(remote, method, params) {
    if (!METHODS.includes(method)) throw Error('不支持的设备操作');
    if (method.startsWith('migration.')) {
      await authorization(remote, 'desktop');
      return transfer.receive({ peer: remote, operation: method.slice(10), args: params || {} });
    }
    const { guard, key } = await authorization(remote, 'mobile');
    if (method === 'conversation.send') {
      const pending = queue.then(() => send(remote, params));
      queue = pending.catch(() => {});
      return pending;
    }
    if (method === 'conversation.status') {
      if (!params || Object.keys(params).some(k => !['sessionId', 'messageId'].includes(k)) || !textId(params.sessionId))
        throw Error('会话标识不正确');
      const page = await conversation.history({ action: 'read', id: params.sessionId, limit: 1 }, guard, identityOf);
      const handle = conversation.find(params.sessionId), snapshot = handle?.snapshot?.();
      const record = params.messageId && journal.read(digest([key, remote.deviceId, params.messageId]));
      const recovery = snapshot?.historyRecovery;
      await guard();
      return { conversation: await metadata(page.conversation, guard), status: snapshot?.status || 'idle',
        pendingApproval: Boolean(snapshot?.pendingApproval || snapshot?.pendingUi || snapshot?.pendingPermissions?.length),
        receipt: record?.sessionId === params.sessionId ? record.result || { phase: 'uncertain' } : null,
        historyRecovery: recovery ? Object.fromEntries(['mode', 'nativeArchiveMissing', 'bodyMissing']
          .filter(key => recovery[key] !== undefined).map(key => [key, recovery[key]])) : null };
    }
    const action = method === 'history.list' ? 'list' : 'read';
    const result = await conversation.history({ ...(params || {}), action }, guard, identityOf);
    if (action === 'list') result.items = await Promise.all((result.items || []).map(item => metadata(item, guard)));
    else result.conversation = await metadata(result.conversation, guard);
    await guard();
    return result;
  }
  return { receive, peer, transfer, session };
}

function install({ app, ipcMain, BrowserWindow, getRendererRoot, identityOf, conversation, session, peer, transfer, trustedWindow, journal }) {
  const service = peer && transfer ? create({ app, identityOf, conversation, session, peer, transfer, journal }) : null;
  const trusted = trustedWindow || require('./app-menu-info.cjs').createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  function requireWindow(event) {
    const win = trusted(event);
    if (!win) throw Error('设备连接只能由 SoduWork 主窗口操作');
    if (!peer || !transfer) throw Error('请更新桌面客户端以启用设备历史和直连迁移');
    return win;
  }
  const operations = {
    status: () => peer.status(), listen: input => peer.listen(input), stop: () => peer.stop(),
    offer: () => peer.createPairingOffer(), connect: input => peer.connect(input),
    peers: () => peer.peers(), disconnect: input => peer.disconnect(input),
  };
  for (const [name, operation] of Object.entries(operations)) {
    ipcMain.handle('device-direct-' + name, async (event, input = {}) => {
      const win = requireWindow(event), identity = await identityOf(app), owner = JSON.stringify([identity?.hub, identity?.clientId, accountId(identity)]);
      if (!accountId(identity)) throw Error('请先登录当前账号');
      const result = await operation(input);
      const current = await identityOf(app);
      if (trusted(event) !== win || JSON.stringify([current?.hub, current?.clientId, accountId(current)]) !== owner)
        throw Error('账号或页面已变化，请重新打开设备连接');
      return result;
    });
  }
  for (const name of ['preview', 'start', 'status', 'resume', 'cancel']) {
    ipcMain.handle('device-migration-' + name, async (event, input = {}) => {
      const win = requireWindow(event);
      const identity = await identityOf(app), owner = JSON.stringify([identity?.hub, identity?.clientId, accountId(identity)]);
      if (!accountId(identity)) throw Error('请先登录当前账号');
      if (!input || Object.keys(input).some(k => !['ref', 'sessionId', 'targetDeviceId', 'operationId', 'selectedPaths'].includes(k)))
        throw Error('迁移参数不正确');
      if (['preview', 'start'].includes(name)) {
        const handle = session.get(input.ref), snapshot = handle?.snapshot?.();
        if (!handle || !input.sessionId || handle.sessionId !== input.sessionId || handle.attachedWindow !== win ||
            handle.passiveCloudView || snapshot?.cloudHandoff || snapshot?.execution?.accountConversation)
          throw Error('请在当前电脑打开本人持有的本机会话后迁移');
      }
      const result = await transfer[name]({ sessionId: input.sessionId, targetDeviceId: input.targetDeviceId,
        operationId: input.operationId, ...(name === 'start' ? { selectedPaths: input.selectedPaths } : {}) });
      requireWindow(event);
      const latest = await identityOf(app);
      if (JSON.stringify([latest?.hub, latest?.clientId, accountId(latest)]) !== owner) throw Error('账号或设备已切换');
      return result;
    });
  }
  return service;
}

module.exports = { create, install, METHODS };
