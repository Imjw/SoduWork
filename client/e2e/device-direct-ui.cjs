'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs/promises'), assert = require('node:assert/strict');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'device-direct-ui');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
let win;
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) {
  for (let i = 0; i < 100; i++) {
    if (await js('Boolean(' + source + ')')) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const detail = await js('document.querySelector("[data-status]")?.textContent || "No status surface"');
  throw Error('Timed out: ' + source + ' (' + detail + ')');
}
const click = selector => js('document.querySelector(' + JSON.stringify(selector) + ').click();void 0');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 900, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }, offscreen: true });
  win.webContents.on('console-message', (_event, ...args) => {
    const message = typeof args[1] === 'string' ? args[1] : _event.message || '';
    if (message && !message.includes('Electron Security Warning')) console.log(message);
  });
  await win.loadFile(path.join(__dirname, 'fixtures/device-direct.html'));
  await click('#open'); await until('document.querySelectorAll("[data-target] option").length===2');
  assert.equal(await js('document.querySelector("[data-target] option[value=phone-c]")'), null);
  assert.equal(await js('document.querySelector("[data-preview]").disabled'), true);
  await click('[data-offer]'); await until('!document.querySelector("[data-offer-box]").hidden');
  assert.equal(await js('JSON.parse(document.querySelector("[data-offer-value]").value).deviceId'), 'desktop-a');
  await js('document.querySelector("[data-target]").value="desktop-b";document.querySelector("[data-target]").dispatchEvent(new Event("change"));void 0');
  await click('[data-preview]'); await until('document.querySelectorAll(".device-direct-files input").length===2');
  assert.equal(await js('document.querySelectorAll(".device-direct-files input:checked").length'), 0);
  assert.equal(await js('document.querySelector("[data-workspace-notice]").textContent'), 'Synthetic <workspace> notice; history can still transfer.');
  assert.equal(await js('document.querySelector("[data-workspace-notice]").children.length'), 0);
  assert.equal(await js('calls.filter(row=>row[0]==="start").length'), 0);
  await js('document.querySelector(".device-direct-files input").checked=true;void 0');
  await click('[data-start]'); await until('calls.some(row=>row[0]==="start")');
  const start = await js('calls.find(row=>row[0]==="start")[1]');
  assert.deepEqual(start.selectedPaths, ['chosen.txt']); assert.equal(start.operationId, 'op-synthetic');
  assert.equal(start.ref, 'ref-a'); assert.equal(start.targetDeviceId, 'desktop-b');
  await click('[data-close]'); await click('#open'); await until('document.querySelectorAll(".device-direct-receipt").length===1');
  assert.equal(await js('document.querySelector("[data-offer-value]").value'), '');
  // Switching accounts closes the surface and cannot expose old pairing data.
  await js('owner="owner-b";dispatchEvent(new Event("soduwork-data-scope-changed"));void 0');
  assert.equal(await js('document.querySelector(".device-direct-dialog")'), null);
  await click('#open'); await until('document.querySelector("[data-status]").textContent==="连接状态已更新"');
  assert.equal(await js('document.querySelectorAll(".device-direct-receipt").length'), 0);
  win.setSize(430, 800);
  assert.equal(await js('document.querySelector(".device-direct-dialog").scrollWidth<=document.querySelector(".device-direct-dialog").clientWidth+1'), true);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true,
    verification: 'Real Electron renderer with synthetic direct-service callbacks; no live devices or model calls',
    checks: ['desktop-only migration targets', 'files opt in', 'workspace notice as text', 'selected file submission', 'durable operation reference', 'scope fencing', 'narrow layout'] }, null, 2));
  console.log('device-direct-ui: 7 checks passed');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
