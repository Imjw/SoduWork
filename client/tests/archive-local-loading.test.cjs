'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture(count, accountRows, beforeLocalPage) {
  let createdRows = 0, user = 'a', releaseRemote;
  class Element {
    constructor() {
      this.children = []; this.attributes = {}; this.replacements = 0; this.handlers = {};
      this.classList = { add() {}, remove() {}, contains: () => true, toggle() {} };
    }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    appendChild(item) { this.append(item); return item; }
    replaceChildren(...items) { this.replacements++; this.children = items; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    click() { return this.handlers.click?.({ stopPropagation() {} }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    set className(value) { this._className = value; if (value === 'archive-history-item') createdRows++; }
    get className() { return this._className; }
  }
  const elements = new Map(['archivePanel', 'archiveHistoryList', 'archiveProjectsList', 'archiveHistoryStatus', 'archiveHistoryCount']
    .map(id => [id, new Element()]));
  const document = { body: new Element(), getElementById: id => elements.get(id), createElement: () => new Element(), querySelectorAll: () => [] };
  const rows = Array.from({ length: count }, (_, index) => ({ id: 'archived-' + index, title: 'Saved ' + index, archived: true, at: count - index }));
  const calls = [], accountCalls = [], listeners = {}, values = new Map();
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; },
    SoduWorkAPI: { hubBase: () => 'https://archive-fixture.invalid', clientAuthSnapshot: () => ({ user: { id: user } }) },
    soduWorkAPI: { conversationSession: { localHistorySupported: true,
      async history(options) {
        if (options.source === 'account') {
          accountCalls.push(options);
          if (!accountRows) return new Promise(resolve => { releaseRemote = resolve; });
          const start = options.after?.at || 0, end = Math.min(start + options.limit, accountRows.length);
          return { ok: true, chats: accountRows.slice(start, end),
            next: end < accountRows.length ? { at: end, id: 'account-cursor' } : null };
        }
        calls.push(options);
        const revision = beforeLocalPage?.(options, rows) || 1;
        const start = options.after ? rows.findIndex(row => row.id === options.after.id) + 1 : 0;
        const end = Math.min(start + options.limit, rows.length);
        return { ok: true, chats: rows.slice(start, end), next: end < rows.length ? { at: end, id: rows[end - 1].id } : null,
          localCatalog: { workspace: 'fixture', revision,
            ...(options.catalogRevision === revision ? {} : { items: rows.map(row => ({ id: row.id, archived: true })) }) } };
      },
      archivedHistory: () => { throw Error('The account archive must not use the legacy merged history'); },
    } },
  };
  const context = vm.createContext({ window, document, localStorage: storage, URL, Intl });
  for (const file of ['workspace/workspace-sidebar-state.js', 'archive/archive-history-panel.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components', file), 'utf8'), context);
  return { window, document, storage, elements, calls, accountCalls, listeners, rows, created: () => createdRows,
    owner(value) { user = value; }, remote: value => releaseRemote(value) };
}

test('deleting one of 10020 archives does not refetch the inventory or reconstruct unaffected rows', async () => {
  const f = fixture(10020), deleted = [];
  f.window.soduWorkAPI.conversationSession.permanentDeleteHistory = async id => {
    deleted.push(id); return { ok: true, id, deleted: true };
  };
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  const list = f.elements.get('archiveHistoryList'), retained = list.children[20];
  const calls = f.calls.length, created = f.created();
  const pending = list.children[0].children[1].children[1].click();
  await f.document.body.children.at(-1).children[0].children[2].children[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, calls, 'the acknowledged deletion needs no complete history reread');
  assert.equal(f.created(), created, 'unaffected conversation rows retain their DOM');
  assert.equal(list.children.length, 10019);
  assert.equal(list.children[19], retained);
  await pending;
  assert.deepEqual(deleted, ['archived-0']);
  f.remote({ ok: true, chats: [{ id: 'archived-0', title: 'Stale deleted title', archived: true }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.children.length, 10019, 'an older account reply cannot resurrect the acknowledged deletion');
});

test('archive deletion confirmation cannot dispatch after the account changes', async () => {
  const f = fixture(2, []); let deletes = 0;
  f.window.soduWorkAPI.conversationSession.permanentDeleteHistory = async () => { deletes++; return { ok: true }; };
  f.window.openArchiveHistory(); await new Promise(resolve => setImmediate(resolve));
  const pending = f.elements.get('archiveHistoryList').children[0].children[1].children[1].click();
  f.owner('b');
  await f.document.body.children.at(-1).children[0].children[2].children[1].click();
  await pending;
  assert.equal(deletes, 0);
});

test('failed deletion keeps the archived row and does not start an unrelated inventory reload', async () => {
  const f = fixture(2, []);
  f.window.soduWorkAPI.conversationSession.permanentDeleteHistory = async () => ({ ok: false, reason: 'Fixture access denied' });
  f.window.openArchiveHistory(); await new Promise(resolve => setImmediate(resolve));
  const list = f.elements.get('archiveHistoryList'), original = list.children[0], reads = f.calls.length;
  const pending = original.children[1].children[1].click();
  await f.document.body.children.at(-1).children[0].children[2].children[1].click(); await pending;
  assert.equal(list.children[0], original); assert.equal(list.children.length, 2);
  assert.equal(f.calls.length, reads);
  assert.equal(f.elements.get('archiveHistoryStatus').textContent, 'Fixture access denied');
});

function archivedProject(f, ids) {
  const store = f.window.WorkspaceSidebarState.create(f.window.WorkspaceSidebarState.accountOptions({
    storage: f.storage, api: f.window.SoduWorkAPI,
  }));
  const id = store.saveProject({ name: 'Archived fixture project', folders: [] });
  for (const chatId of ids) store.move(f.rows.find(row => row.id === chatId), id);
  store.archiveProject(id);
  return id;
}

test('deleting an archived project removes only its acknowledged members without refetching all history', async () => {
  const f = fixture(20, []), deleted = [];
  archivedProject(f, ['archived-0', 'archived-1']);
  f.window.soduWorkAPI.conversationSession.permanentDeleteHistory = async id => {
    deleted.push(id); return { ok: true, id, deleted: true };
  };
  f.window.openArchiveHistory(); await new Promise(resolve => setImmediate(resolve));
  const list = f.elements.get('archiveHistoryList'), retained = list.children[10], reads = f.calls.length;
  const projectList = f.elements.get('archiveProjectsList');
  assert.equal(projectList.children.length, 1);
  const pending = projectList.children[0].children[1].children[1].click();
  await f.document.body.children.at(-1).children[0].children[2].children[1].click(); await pending;
  assert.deepEqual(deleted, ['archived-0', 'archived-1']);
  assert.equal(f.calls.length, reads);
  assert.equal(list.children.length, 18);
  assert.equal(list.children[8], retained);
  assert.equal(projectList.children.filter(row => row.className === 'archive-history-item').length, 0);
});

test('an account change during project deletion prevents subsequent member dispatch and ignores the old receipt', async () => {
  const f = fixture(3, []), deleted = []; let release;
  archivedProject(f, ['archived-0', 'archived-1']);
  f.window.soduWorkAPI.conversationSession.permanentDeleteHistory = id => {
    deleted.push(id); return new Promise(resolve => { release = () => resolve({ ok: true, id, deleted: true }); });
  };
  f.window.openArchiveHistory(); await new Promise(resolve => setImmediate(resolve));
  const pending = f.elements.get('archiveProjectsList').children[0].children[1].children[1].click();
  await f.document.body.children.at(-1).children[0].children[2].children[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deleted, ['archived-0']);
  f.owner('b'); f.listeners['soduwork-data-scope-changed']();
  await new Promise(resolve => setImmediate(resolve));
  const list = f.elements.get('archiveHistoryList'), currentRows = list.children.slice();
  release(); await pending;
  assert.deepEqual(deleted, ['archived-0']);
  assert.deepEqual(list.children, currentRows);
  assert.equal(list.children.length, 3, 'The late old-account receipt cannot mutate the new view');
});

test('large local archives remain searchable without waiting for cloud history or repainting every page', async () => {
  const f = fixture(10020);
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  const list = f.elements.get('archiveHistoryList');
  assert.equal(list.children.length, 10020);
  assert.equal(f.calls.length, 52, 'One paged inventory plus one unchanged native-refresh page');
  assert.ok(f.calls.every(call => call.source === 'local' && call.archived === true && call.limit === 200));
  assert.equal(f.accountCalls.length, 1);
  assert.equal(f.accountCalls[0].source, 'account');
  assert.ok(list.replacements <= 3, 'Repaint first, completed, and refreshed inventory only');
  assert.ok(f.created() <= 20500, 'DOM construction stays linear in the archive size');
  f.remote({ ok: false, reason: 'Fixture offline' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list.children.length, 10020, 'Cloud failure preserves the complete local inventory');
});

test('account archives drain bounded pages independently while retaining the full local inventory', async () => {
  const accountRows = Array.from({ length: 405 }, (_, index) => ({ id: 'account-' + index, title: 'Account ' + index, archived: true }));
  const f = fixture(3, accountRows);
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.elements.get('archiveHistoryList').children.length, 408);
  assert.equal(f.accountCalls.length, 3);
  assert.ok(f.accountCalls.every(call => call.source === 'account' && call.archived && call.limit === 200));
  assert.deepEqual(f.accountCalls.map(call => call.after?.at || 0), [0, 200, 400]);
});

test('an archive added before an in-flight cursor remains searchable after the inventory changes', async () => {
  let revision = 1;
  const f = fixture(405, [], (options, rows) => {
    if (options.after && revision === 1) {
      rows.unshift({ id: 'new-archive', title: 'New archive', archived: true, at: 999 });
      revision++;
    }
    return revision;
  });
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  const titles = f.elements.get('archiveHistoryList').children.map(item => item.children[0].children[0].textContent);
  assert.equal(titles.length, 406);
  assert.equal(new Set(titles).size, 406);
  assert.ok(titles.includes('New archive'));
  assert.equal(f.calls.filter(call => !call.after && !call.refresh).length, 2);
  assert.equal(f.calls.filter(call => call.refresh).length, 1);
});

test('continuous archive changes stop retrying and retain the last rendered records', async () => {
  let revision = 1;
  const f = fixture(405, [], options => options.after ? ++revision : revision);
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 6, 'Three first-page attempts bound repeated invalidation');
  assert.equal(f.elements.get('archiveHistoryList').children.length, 200);
  assert.equal(f.elements.get('archiveHistoryStatus').textContent, '读取归档历史失败');
});

test('an invalidated native refresh cannot mistake its restarted first page for a complete unchanged inventory', async () => {
  let revision = 1;
  const f = fixture(405, [], (options, rows) => {
    if (options.refresh && revision === 1) {
      rows.push({ id: 'discovered-archive', title: 'Discovered archive', archived: true, at: -1 });
      revision = 2;
    } else if (options.after && revision === 2) {
      rows.unshift({ id: 'concurrent-archive', title: 'Concurrent archive', archived: true, at: 999 });
      revision = 3;
    }
    return revision;
  });
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  const titles = f.elements.get('archiveHistoryList').children.map(item => item.children[0].children[0].textContent);
  assert.equal(new Set(titles).size, 407);
  assert.ok(titles.includes('Discovered archive'));
  assert.ok(titles.includes('Concurrent archive'));
});

test('late archive replies from a previous account cannot replace the current archive view', async () => {
  const f = fixture(3);
  f.window.openArchiveHistory();
  await new Promise(resolve => setImmediate(resolve));
  const oldRemote = f.remote;
  // Resolve the old account after changing identity but before starting another request.
  f.owner('b'); oldRemote({ ok: true, chats: [{ id: 'private-a', title: 'Private old account' }] });
  await new Promise(resolve => setImmediate(resolve));
  const titles = f.elements.get('archiveHistoryList').children.map(item => item.children[0].children[0].textContent);
  assert.deepEqual(titles, ['Saved 0', 'Saved 1', 'Saved 2']);
});
