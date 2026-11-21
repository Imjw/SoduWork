'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const handover = require('../main/conversation/device-history-handover.cjs');

test('bounded device recovery retains original intent, current corrections, task references, and tool results', () => {
  const messages = [{ role: 'user', text: 'ORIGINAL-REQUIREMENT: preserve the initial acceptance criteria.' },
    ...Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '旧上下文🙂'.repeat(6000) })),
    { role: 'user', text: 'LATEST-CORRECTION: continue with the revised output format.' }];
  const tools = Array.from({ length: 100 }, (_, index) => ({ id: 'operation-' + index, name: 'write', state: 'done',
    args: { path: '/old-device/output-' + index }, result: 'RECEIPT-' + index + ': ' + '完成结果🙂'.repeat(4000) }));
  const result = handover.brief({ messages, tools }, { cwd: '/new-device/workspace', row: {
    id: 'logical-chat', taskId: 'requirement-one', taskTitle: 'Original task', taskBindings: [{ taskId: 'requirement-one', assignee: 'never-authorize' }] } });
  assert.ok(Buffer.byteLength(result) <= handover.MAX_BYTES);
  assert.match(result, /ORIGINAL-REQUIREMENT/); assert.match(result, /LATEST-CORRECTION/);
  assert.match(result, /requirement-one/); assert.match(result, /RECEIPT-0/); assert.match(result, /RECEIPT-99/);
  assert.match(result, /Do not repeat completed operations/); assert.match(result, /source environment/);
  assert.doesNotMatch(result, /never-authorize|user explicitly changed Agent|SAME workspace|�/);
});

test('a cancelled write remains a terminal cancellation in the continuation context', () => {
  const brief = handover.brief({ messages: [], tools: [{ id: 'write-id', name: 'WriteFile',
    state: 'cancelled', cancelReason: 'access-change', result: '' }] }, { cwd: '/current-workspace' });
  assert.match(brief, /"state":"cancelled","cancelReason":"access-change"/);
  assert.match(brief, /Do not automatically retry cancelled operations/);
});

test('device recovery exposes only verified existing files inside the current workspace', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-handover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'target'); fs.mkdirSync(cwd);
  const valid = path.join(cwd, 'selected.txt'), foreign = path.join(root, 'foreign.txt');
  fs.writeFileSync(valid, 'selected'); fs.writeFileSync(foreign, 'unselected'); fs.symlinkSync(foreign, path.join(cwd, 'link.txt'));
  const attachments = [{ name: 'selected', path: valid, availability: 'available' },
    { name: 'foreign', path: foreign, availability: 'available' },
    { name: 'link', path: path.join(cwd, 'link.txt'), availability: 'available' },
    { name: 'missing', path: path.join(cwd, 'missing.txt'), availability: 'available' }];
  const result = handover.brief({ messages: [], tools: [] }, { cwd, attachments });
  assert.ok(result.includes('Verified current file: ' + valid));
  assert.equal(result.includes(foreign), false); assert.equal(result.includes(path.join(cwd, 'link.txt')), false);
  assert.match(result, /Unavailable or unverified attachment: missing/);
});

test('same-generation native reopen uses device handover while ordinary runtime handovers retain their policy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-history-reopen-')), app = { getPath: () => root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const segments = require('../main/conversation/runtime-segments'), identity = require('./helpers/platform-session-fixture.cjs').identity();
  const record = { version: 1, id: 'logical', owner: segments.scope(identity), cwd: root, segments: [],
    active: { adapterId: 'pi', sessionId: 'current-native', path: '' },
    prefix: { messages: [{ role: 'user', text: 'ORIGINAL-INTENT' }], tools: [{ id: 'completed', name: 'read', state: 'done', result: 'RECORDED-RESULT' }] },
    deviceHistoryComplete: true, deviceHistoryContext: { id: 'logical', taskId: 'task-one', attachments: [] } };
  await segments.save(app, record);
  const resume = () => require('../main/agent-runtime/switchable-conversation').resumeOptions({ app, identity, runtimeConversationId: 'logical' });
  const device = resume().options.contextPrompts.join('\n');
  assert.match(device, /RECORDED-RESULT/); assert.match(device, /task-one/); assert.doesNotMatch(device, /user explicitly changed Agent/);
  await segments.save(app, { ...record, deviceHistoryComplete: false });
  assert.equal(resume().options.contextPrompts[0], segments.brief(record.prefix));
});
