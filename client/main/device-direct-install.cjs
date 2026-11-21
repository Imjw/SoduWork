'use strict';

const { accountId } = require('./device-auth-request');
function install({ app, ipcMain, BrowserWindow, dialog, safeStorage, deviceAuth, getRendererRoot, conversation, session }) {
  // Direct requests use cached local identity only. Pairing certificate issuance
  // belongs to sign-in; neither history nor transport may renew through the Hub.
  const identityOf = () => {
    const id = deviceAuth.identity(app);
    return id ? { ...id, session: deviceAuth.session(app, id.hub, id.clientId) } : null;
  };
  const scope = () => { const id = identityOf(); return JSON.stringify([id?.hub, id?.clientId, accountId(id)]); };
  const trusted = require('./app-menu-info.cjs').createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  async function confirm(message, detail) {
    const parent = BrowserWindow.getAllWindows().find(win => trusted({ sender: win.webContents, senderFrame: win.webContents?.mainFrame }));
    if (!parent || !accountId(identityOf())) return false;
    const owner = scope();
    const answer = await dialog.showMessageBox(parent, {
      type: 'question', title: 'SoduWork', message, detail, buttons: ['拒绝', '确认允许'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    return answer.response === 1 && owner === scope() &&
      trusted({ sender: parent.webContents, senderFrame: parent.webContents?.mainFrame }) === parent;
  }
  let controller;
  const contract = require('./device-history-controller.cjs');
  if (typeof conversation?.setDeviceTransfer !== 'function' ||
      typeof conversation.deviceHistory?.exportPortable !== 'function' ||
      typeof conversation.deviceHistory?.importPortable !== 'function') {
    return { controller: contract.install({ app, ipcMain, BrowserWindow, getRendererRoot, identityOf,
      conversation, session, trustedWindow: trusted }) };
  }
  const peer = require('./device-peer/index.cjs').install({ app, safeStorage, deviceAuth,
    confirmPair: remote => confirm('允许本人设备建立直连？',
      '设备：' + remote.deviceId + '\n类型：' + (remote.role === 'mobile' ? '移动端' : '电脑') +
      '\n密钥指纹：' + remote.keyFingerprint + '\n请核对另一台设备的身份。电脑之间只允许逐次确认的迁移；移动端可读取和继续本机会话。'),
    handlers: Object.fromEntries(contract.METHODS.map(method => [method, (params, remote) => controller.receive(remote, method, params)])),
  });
  const transfer = require('./conversation/device-transfer.cjs').create({ app, identityOf, session,
    history: conversation.deviceHistory, peer,
    confirmReceive: input => confirm('接收这次会话迁移？', '来源设备：' + input.sourceDeviceId +
      '\n会话：' + (input.title || input.sessionId) + '\n文件数：' + Number(input.fileCount || 0) +
      '\n总大小：' + Math.ceil(Number(input.totalBytes || 0) / 1024) + ' KB' +
      '\n接收后内容保存在本机，完成交接后本机取得执行权。此次同意仅适用于这条会话。'),
  });
  conversation.setDeviceTransfer(transfer);
  controller = contract.install({ app, ipcMain, BrowserWindow, getRendererRoot, identityOf,
    conversation, session, peer, transfer, trustedWindow: trusted });
  app.on('will-quit', () => { transfer.close(); void peer.dispose(); });
  return { peer, transfer, controller };
}
module.exports = { install };
