'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFile } = require('node:child_process');
const continuation = require('../main/conversation/device-local-continuation.cjs');
const memory = require('../main/conversation/session-memory');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const { scope } = require('../main/platform-connections/runtime.cjs');

test('shared desktop continuation accepts local navigation but rejects new private and remote bindings', () => {
  assert.doesNotThrow(() => continuation.assertSelections({ sidebarProjectId: 'local-group', sidebarProjectName: 'Local group', projectId: '' }));
  for (const options of [{ projectId: 'business-project' }, { repoId: 'private-repository' },
    { taskId: 'private-task' }, { taskRef: 'task' }, { memoryIds: ['private'] },
    { pluginIds: ['private-plugin'] }, { skills: ['private-skill'] }, { nativeRelay: true }, { nativeRelayGuard() {} }])
    assert.throws(() => continuation.assertSelections(options), /私有资料/);
  assert.throws(() => continuation.assert({}, {}, identity(), 'ordinary'), /授权已失效/);
});

test('actual private memory use is durably protected without changing owner and cannot be downgraded', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-memory-protection-')), app = { getPath: () => root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = identity(); memory.bind(app, 'ordinary', a, [], true);
  const file = path.join(root, 'session-memory-bindings', require('node:crypto').createHash('sha256').update('ordinary').digest('hex') + '.json');
  const before = JSON.parse(fs.readFileSync(file));
  memory.protectHistory(app, 'ordinary', a, { prompt: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), before);
  memory.protectHistory(app, 'ordinary', a, { prompt: 'Synthetic organization memory', ids: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...before, historyProtection: 'account' });
  memory.bind(app, 'ordinary', a, [], true);
  assert.equal(JSON.parse(fs.readFileSync(file)).historyProtection, 'account');
  assert.throws(() => memory.protectHistory(app, 'ordinary', identity('two'), { prompt: 'Other private memory' }), /另一个账号/);
  assert.equal(JSON.parse(fs.readFileSync(file)).owner, scope(a));
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (String(args[1]).includes('session-memory-bindings')) throw Object.assign(Error('synthetic storage failure'), { code: 'ENOSPC' });
    return original(...args);
  });
  assert.throws(() => memory.protectHistory(app, 'new-private', a, { prompt: 'Must not become shared' }), /storage failure/);
});

test('desktop continuation grants revoke on new protected bindings, changed execution owner and account changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-continuation-grant-')), app = { getPath: () => root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = identity(), b = identity('two'); let current = b;
  t.mock.method(require('../main/conversation/requirement-context'), 'cachedIdentity', () => current);
  const row = { id: 'ordinary', localReplica: true, adapterId: 'pi', creator: { account: 'one', hub: a.hub } };
  const grant = continuation.grant(app, row, b), handle = { sessionId: row.id };
  assert.equal(continuation.assert(grant, app, b, row.id).original, scope(a), 'Verified immutable creator provenance is sufficient');
  const segments = require('../main/conversation/runtime-segments');
  const record = { version: 1, id: row.id, owner: scope(a), deviceShared: true, executionOwner: scope(b),
    segments: [], active: { sessionId: 'native-b', adapterId: 'pi' } };
  await segments.save(app, record); continuation.bind(handle, grant);
  assert.equal(continuation.guard(handle, b), true);
  memory.bind(app, row.id, a, [], true);
  memory.protectHistory(app, row.id, a, { prompt: 'Private information admitted later' });
  assert.throws(() => continuation.guard(handle, b), /账号|私有资料/);
  fs.rmSync(path.join(root, 'session-memory-bindings'), { recursive: true });
  await segments.save(app, { ...record, executionOwner: scope(a) });
  assert.throws(() => continuation.guard(handle, b), /执行账号已变化/);
  await segments.save(app, record); current = a;
  assert.throws(() => continuation.guard(handle, b), /切换|变化/);
});

test('changing the execution account refreshes an older complete cache and never bypasses native access failures', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-continuation-fresh-')), app = { getPath: () => root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = identity('two'), row = { id: 'ordinary', adapterId: 'pi', localReplica: true,
    creator: { account: 'one', hub: b.hub } };
  t.mock.method(require('../main/conversation/requirement-context'), 'cachedIdentity', () => b);
  const token = continuation.grant(app, row, b);
  let messages = ['cached message'], fail = null, calls = 0, missing = false;
  const history = {
    backfill: async () => { calls++; if (fail) throw fail; messages = ['cached message', 'last native message before crash']; },
    prepareContinuation: async () => ({ row, prefix: { messages: messages.slice(), tools: [] } }),
  };
  const session = { historyEntry: async () => missing ? { notFound: true } : { ok: true, entry: row } };
  const result = await continuation.prepare(token, history, b, session);
  assert.deepEqual(result.prefix.messages, ['cached message', 'last native message before crash']);
  assert.equal(calls, 1); assert.equal(result.historyRecovery.nativeArchiveMissing, false);
  fail = Object.assign(Error('synthetic permission denied'), { code: 'EACCES' });
  await assert.rejects(continuation.prepare(token, history, b, session), /permission denied/);
  missing = true;
  assert.equal((await continuation.prepare(token, history, b, session)).historyRecovery.nativeArchiveMissing, true);
  assert.equal(calls, 2, 'A proven missing native archive uses the complete independent copy');
});

test('real Pi cold A to B to B to A continuation retains history and uses each current account provider', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-account-native-')), requests = [];
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const first = requests.length === 1;
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-original', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: 'checkpoint.txt' }) } }] }
        : { role: 'assistant', content: (requests.length === 3 ? 'B-ACCOUNT-ANSWER-592. ' : '') + 'Saved ALPHA-DEVICE-731.' };
      for (const [value, finish] of [[delta, null], [{}, first ? 'tool_calls' : 'stop']])
        response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
          choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n');
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
      const receipt = stdout.split('\n').find(line => line.startsWith('DEVICE_HISTORY_RESULT '));
      if (!receipt) return reject(Error('Missing native receipt: ' + stderr));
      resolve(JSON.parse(receipt.slice('DEVICE_HISTORY_RESULT '.length)));
    }));
  const a = await run('source'), b = await run('account-b'), bAgain = await run('account-b-reopen'), aAgain = await run('account-a');
  assert.equal(fs.existsSync(a.nativePath), true, 'The original archive is retained');
  assert.notEqual(b.nativeId, a.nativeId); assert.equal(bAgain.nativeId, b.nativeId);
  assert.notEqual(aAgain.nativeId, b.nativeId, 'Returning A never resumes B provider credentials');
  for (const value of [b, bAgain, aAgain]) {
    assert.equal(value.id, a.id); assert.equal(value.owner, scope(identity()));
    assert.equal(value.creator.account, 'one'); assert.equal(value.bindings, 1, 'No new account adopts the original or its native aliases');
    assert.equal(value.toolExecutions, 0); assert.match(value.restoredText, /ALPHA-DEVICE-731/);
  }
  assert.equal(b.executionOwner, scope(identity('two'))); assert.equal(aAgain.executionOwner, scope(identity()));
  assert.match(bAgain.restoredText, /B-ACCOUNT-ANSWER-592/);
  assert.match(aAgain.restoredText, /B-ACCOUNT-ANSWER-592/);
  assert.match(aAgain.restoredText, /Account follow-up account-b/);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.map(row => row.authorization), ['Bearer synthetic-provider-one', 'Bearer synthetic-provider-one',
    'Bearer synthetic-provider-two', 'Bearer synthetic-provider-two', 'Bearer synthetic-provider-one']);
  for (const request of requests.slice(2)) {
    assert.match(JSON.stringify(request.body.messages), /ALPHA-DEVICE-731/);
    assert.match(JSON.stringify(request.body.messages), /TOOL-RECEIPT-BETA-482/);
  }
  assert.match(JSON.stringify(requests.at(-1).body.messages), /B-ACCOUNT-ANSWER-592/);
});
