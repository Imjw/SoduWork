'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFile } = require('node:child_process');
test('cold processes restore original intent and completed tool results in real Pi context without replaying tools', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-device-cold-')), requests = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const first = requests.length === 1;
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native-read-checkpoint', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: 'checkpoint.txt' }) } }] }
        : { role: 'assistant', content: 'Saved ALPHA-DEVICE-731.' };
      for (const [part, finish] of [[delta, null], [{}, first ? 'tool_calls' : 'stop']])
        response.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'fixture',
          choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  const run = phase => new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, 'helpers/device-history-native-peer.cjs'), root, endpoint, phase],
    { timeout: 25000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(Error(error.message + '\n' + stderr));
      const line = stdout.split('\n').find(value => value.startsWith('DEVICE_HISTORY_RESULT '));
      if (!line) return reject(Error('Missing isolated process receipt: ' + stderr));
      resolve(JSON.parse(line.slice('DEVICE_HISTORY_RESULT '.length)));
    }));
  const source = await run('source');
  fs.unlinkSync(source.nativePath);
  const restored = await run('restore');
  const reopened = await run('reopen');
  assert.equal(restored.id, source.id);
  assert.notEqual(restored.nativeId, source.nativeId);
  assert.match(restored.restoredText, /Remember the synthetic recovery phrase ALPHA-DEVICE-731/);
  assert.equal(restored.historyRecovery.nativeArchiveMissing, true);
  assert.equal(requests.length, 4);
  assert.equal(source.toolExecutions, 1); assert.equal(restored.toolExecutions, 0); assert.equal(reopened.toolExecutions, 0);
  assert.notEqual(restored.cwd, source.cwd);
  assert.equal(reopened.nativeId, restored.nativeId, 'The next cold open resumes the same current-generation native archive');
  assert.equal(fs.existsSync(path.join(restored.cwd, 'checkpoint.txt')), false, 'Old source files are not implicitly copied');
  assert.match(JSON.stringify(requests[1].messages), /TOOL-RECEIPT-BETA-482/, 'The original native tool actually completed');
  for (const request of requests.slice(2)) {
    const actual = JSON.stringify(request.messages);
    assert.match(actual, /Remember the synthetic recovery phrase ALPHA-DEVICE-731/);
    assert.match(actual, /Saved ALPHA-DEVICE-731/);
    assert.match(actual, /TOOL-RECEIPT-BETA-482/);
    assert.match(actual, /Do not repeat completed operations/);
    const text = request.messages.flatMap(({ content }) =>
      typeof content === 'string' ? [content] : (content || []).map(block => block.text || '')).join('\n');
    const workspace = /Conversation and task references; current workspace:\n([^\n]+)/.exec(text);
    assert.ok(workspace, 'The model must receive the recovery workspace record');
    assert.equal(fs.realpathSync.native(JSON.parse(workspace[1]).cwd), fs.realpathSync.native(restored.cwd));
    assert.doesNotMatch(actual, /user explicitly changed Agent|Continue in the SAME workspace/);
  }
});
