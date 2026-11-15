const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const app = readFileSync(new URL('../extension/app.js', `file://${__filename}`), 'utf8');

async function harness(shortcuts) {
  const store = { shortcutsMigrated: true, ...(shortcuts === undefined ? {} : { shortcuts }) };
  const elements = Object.fromEntries(['shortcutsImportFile', 'shortcutsImportBtn', 'shortcutsExportBtn', 'shortcutsImportMode', 'shortcutsTransferStatus'].map(id => [id, {
    value: id === 'shortcutsImportMode' ? 'merge' : '', dataset: {}, handlers: {},
    addEventListener(event, handler) { this.handlers[event] = handler; },
  }]));
  let failSave = false;
  let downloaded;
  const storage = {
    QUOTA_BYTES_PER_ITEM: 8192,
    get: async key => ({ [key]: store[key] }),
    set: async data => { if (failSave) throw Error('quota'); Object.assign(store, data); },
    remove: async key => { delete store[key]; },
  };
  const callbacks = {};
  const context = vm.createContext({
    URL: class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:test'; }
      static revokeObjectURL() {}
    },
    crypto: webcrypto, TextEncoder, Blob, console,
    setTimeout: () => 0, clearTimeout() {},
    document: {
      getElementById: id => elements[id] || null,
      addEventListener() {}, body: { appendChild() {} },
      createElement: () => ({ click() {}, remove() {} }),
    },
    chrome: {
      runtime: { id: 'test' }, storage: { local: storage, sync: storage },
      tabs: { query: async () => [], ...Object.fromEntries(['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached'].map(name => [name, { addListener: fn => { callbacks[name] = fn; } }])) },
    },
    LOCALE: 'zh-CN', t: key => key,
  });
  vm.runInContext(app, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    context, store, elements, failSave() { failSave = true; },
    async import(text, mode = 'merge', size = text.length) {
      elements.shortcutsImportMode.value = mode;
      elements.shortcutsImportFile.files = [{ size, text: async () => text }];
      elements.shortcutsImportFile.value = 'selected.json';
      await elements.shortcutsImportFile.handlers.change({ target: elements.shortcutsImportFile });
      assert.equal(elements.shortcutsImportFile.value, '');
      assert.equal(elements.shortcutsImportBtn.disabled, false);
      return elements.shortcutsTransferStatus.textContent;
    },
    async export() { await elements.shortcutsExportBtn.handlers.click(); return downloaded.text(); },
  };
}
const entry = (url, title = 'Example') => ({ id: 'local-id', url, title, faviconUrl: 'https://example.com/icon.png' });
const config = shortcuts => JSON.stringify({ format: 'tab-out-shortcuts', version: 1, shortcuts });

test('export/import preserves names, URLs, icons and order, creates fresh local IDs', async () => {
  const original = [entry('https://example.com/b', '<b>中文 & "quotes"</b>'), entry('https://example.com/a')];
  const source = await harness(original);
  const exported = await source.export();
  assert.equal(JSON.parse(exported).shortcuts[0].id, undefined);
  const target = await harness([]);
  await target.import(exported, 'replace');
  assert.deepEqual(Array.from(target.store.shortcuts, ({ id, ...rest }) => ({ ...rest })), original.map(({ id, ...rest }) => rest));
  assert.notEqual(target.store.shortcuts[0].id, 'local-id');
  assert.notEqual(target.store.shortcuts[0].id, target.store.shortcuts[1].id);
  assert.equal(vm.runInContext('escapeShortcutHtml(\'<b>&"\')', target.context), '&lt;b&gt;&amp;&quot;');
});

test('merge keeps existing values and order, skips normalized duplicate URLs', async () => {
  const existing = [entry('https://example.com', 'Original')];
  const h = await harness(existing);
  const message = await h.import(config([entry('https://example.com/', 'Changed'), entry('https://new.example/a'), entry('https://new.example/a')]));
  assert.equal(h.store.shortcuts.length, 2);
  assert.equal(h.store.shortcuts[0], existing[0]);
  assert.match(message, /新增 1 个，跳过 2/);
});

test('invalid JSON, schema, versions and unsafe URLs leave storage intact', async () => {
  const existing = [entry('https://keep.example')];
  const h = await harness(existing);
  for (const text of ['{', 'null', '{"shortcuts":[]}', config([null]), config([entry('javascript:alert(1)')]), config([{ ...entry('https://ok.example'), faviconUrl: 'data:text/html,unsafe' }]), config([entry('https://ok.example')]).replace('"version":1', '"version":2')]) {
    await h.import(text, 'replace');
    assert.equal(h.store.shortcuts, existing);
    assert.equal(h.elements.shortcutsTransferStatus.dataset.error, 'true');
  }
});

test('empty replacement persists instead of restoring default shortcuts', async () => {
  const h = await harness([entry('https://keep.example')]);
  await h.import(config([]), 'replace');
  assert.equal(h.store.shortcuts.length, 0);
  assert.equal((await vm.runInContext('getShortcuts()', h.context)).length, 0);
});

test('file size and UTF-8 sync quota failures leave configuration intact', async () => {
  const existing = [entry('https://keep.example')];
  const h = await harness(existing);
  assert.match(await h.import(config([]), 'replace', 1024 * 1024 + 1), /文件过大/);
  assert.match(await h.import(config([entry('https://ok.example', '中'.repeat(3000))]), 'replace'), /超出同步存储容量/);
  assert.equal(h.store.shortcuts, existing);
});

test('storage failure reports an error without replacing the old configuration', async () => {
  const existing = [entry('https://keep.example')];
  const h = await harness(existing);
  h.failSave();
  assert.match(await h.import(config([entry('https://new.example')]), 'replace'), /保存失败/);
  assert.equal(h.store.shortcuts, existing);
});

test('BOM-prefixed config is accepted and missing configuration still gets defaults', async () => {
  const h = await harness();
  assert.equal((await vm.runInContext('getShortcuts()', h.context)).length, 3);
  await h.import('\uFEFF' + config([entry('https://new.example')]), 'replace');
  assert.equal(h.store.shortcuts[0].url, 'https://new.example');
});
