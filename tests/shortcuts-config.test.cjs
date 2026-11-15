const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const app = readFileSync(new URL('../extension/app.js', `file://${__filename}`), 'utf8');

async function harness(shortcuts, options = {}) {
  const store = shortcuts === undefined ? {} : { shortcuts };
  const cloudStore = options.cloud || {};
  const localWrites = [];
  const cloudWrites = [];
  let account = options.account === undefined ? { id: 'account-1', email: 'test@example.com' } : options.account;
  let failCloudSave = false;
  let failCloudRead = false;
  const elements = Object.fromEntries(['shortcutsImportFile', 'shortcutsImportBtn', 'shortcutsExportBtn', 'shortcutsImportMode', 'shortcutsTransferStatus', 'shortcutsCloudUploadBtn', 'shortcutsCloudDownloadBtn', 'shortcutsCloudMergeBtn', 'shortcutsCloudAccount', 'shortcutsCloudSummary', 'shortcutsCloudStatus', 'shortcutsSyncSettingsBtn', 'shortcutsSyncRecheckBtn', 'shortcutsSyncHelp'].map(id => [id, {
    value: id === 'shortcutsImportMode' ? 'merge' : '', hidden: true, dataset: {}, handlers: {},
    addEventListener(event, handler) { this.handlers[event] = handler; },
  }]));
  let failSave = false;
  let downloaded;
  const storage = {
    get: async key => ({ [key]: store[key] }),
    set: async data => { if (failSave) throw Error('quota'); localWrites.push(data); Object.assign(store, data); },
    remove: async key => { delete store[key]; },
  };
  const cloudStorage = {
    QUOTA_BYTES_PER_ITEM: 8192,
    get: async key => { if (failCloudRead) throw Error('sync read failed'); return { [key]: cloudStore[key] }; },
    set: async data => { if (failCloudSave) throw Error('sync write failed'); cloudWrites.push(data); Object.assign(cloudStore, data); },
  };
  const callbacks = {};
  const context = vm.createContext({
    URL: class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:test'; }
      static revokeObjectURL() {}
    },
    crypto: webcrypto, TextEncoder, Blob, console, window: { addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {},
    document: {
      getElementById: id => elements[id] || null,
      addEventListener() {}, body: { appendChild() {} },
      createElement: () => ({ click() {}, remove() {} }),
    },
    chrome: {
      runtime: { id: 'test' }, storage: { local: storage, sync: cloudStorage, onChanged: { addListener: fn => { callbacks.storage = fn; } } },
      identity: { getProfileUserInfo: async details => { assert.equal(details.accountStatus, 'ANY'); return account || { id: '', email: '' }; } },
      tabs: { query: async () => [], ...Object.fromEntries(['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached'].map(name => [name, { addListener: fn => { callbacks[name] = fn; } }])) },
    },
    LOCALE: 'zh-CN', t: key => key,
  });
  vm.runInContext(app, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    context, store, cloudStore, elements, localWrites, cloudWrites, callbacks,
    failSave() { failSave = true; },
    failCloudSave() { failCloudSave = true; },
    failCloudRead() { failCloudRead = true; },
    setAccount(value) { account = value; },
    cloud(mode) { return vm.runInContext(`syncShortcutsCloud('${mode}')`, context); },
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

test('oversized files are rejected, but local file imports are independent of sync quota', async () => {
  const existing = [entry('https://keep.example')];
  const h = await harness(existing);
  assert.match(await h.import(config([]), 'replace', 1024 * 1024 + 1), /文件过大/);
  assert.equal(h.store.shortcuts, existing);
  await h.import(config([entry('https://ok.example', '中'.repeat(3000))]), 'replace');
  assert.equal(h.store.shortcuts[0].title.length, 3000);
  assert.equal(h.cloudWrites.length, 0);
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

const snapshot = shortcuts => ({ accountId: 'account-1', updatedAt: '2026-11-15T00:00:00Z', config: JSON.parse(config(shortcuts)) });

test('local edits and file imports never update the cloud copy', async () => {
  const cloud = { shortcutsCloud: snapshot([entry('https://cloud.example')]) };
  const before = JSON.stringify(cloud);
  const h = await harness([], { cloud });
  await vm.runInContext("addShortcut('https://local.example', 'Local', '')", h.context);
  await h.import(config([entry('https://file.example')]), 'merge');
  assert.equal(h.store.shortcuts.length, 2);
  assert.equal(JSON.stringify(cloud), before);
  assert.equal(h.cloudWrites.length, 0);
});

test('migration prefers local config, preserves empty lists, and never writes to sync', async () => {
  for (const local of [[], [entry('https://local.example')]]) {
    const h = await harness(local, { cloud: { shortcuts: [entry('https://old.example')] } });
    assert.equal(await vm.runInContext('getShortcuts()', h.context), local);
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.cloudWrites.length, 0);
  }
  for (const legacy of [[], [entry('https://old.example')]]) {
    const cloud = { shortcuts: legacy };
    const h = await harness(undefined, { cloud });
    await Promise.all([vm.runInContext('getShortcuts()', h.context), vm.runInContext('getShortcuts()', h.context)]);
    assert.equal(h.store.shortcuts, legacy);
    assert.equal(h.localWrites.length, 1);
    assert.equal(cloud.shortcuts, legacy);
    assert.equal(h.cloudWrites.length, 0);
  }
});

test('upload writes a portable cloud snapshot and leaves the local config intact', async () => {
  const local = [entry('https://local.example', 'Local')];
  const h = await harness(local, { cloud: { shortcutsCloud: snapshot([entry('https://old.example')]) } });
  await h.cloud('upload');
  assert.equal(h.store.shortcuts, local);
  assert.equal(h.cloudStore.shortcutsCloud.config.shortcuts[0].title, 'Local');
  assert.equal(h.cloudStore.shortcutsCloud.config.shortcuts[0].id, undefined);
  assert.equal(h.cloudStore.shortcutsCloud.accountId, 'account-1');
  assert.equal(h.localWrites.length, 0);
  assert.equal(h.cloudWrites.length, 1);
  assert.match(h.elements.shortcutsCloudStatus.textContent, /已提交/);
});

test('download replaces local order and values without changing cloud', async () => {
  const cloud = { shortcutsCloud: snapshot([entry('https://b.example', 'B'), entry('https://a.example', 'A')]) };
  const before = JSON.stringify(cloud);
  const h = await harness([entry('https://local.example')], { cloud });
  await h.cloud('download');
  assert.deepEqual(Array.from(h.store.shortcuts, item => item.title), ['B', 'A']);
  assert.equal(JSON.stringify(cloud), before);
  assert.equal(h.cloudWrites.length, 0);
});

test('cloud merge is the union, deduplicating both sides with local values winning', async () => {
  const local = [entry('https://same.example', 'Local name'), entry('https://local.example', 'Local only'), entry('https://same.example/', 'Local duplicate')];
  const cloud = { shortcutsCloud: snapshot([entry('https://same.example/', 'Cloud name'), entry('https://cloud.example', 'Cloud only'), entry('https://cloud.example/', 'Cloud duplicate')]) };
  const before = JSON.stringify(cloud);
  const h = await harness(local, { cloud });
  await h.cloud('merge');
  assert.deepEqual(Array.from(h.store.shortcuts, item => item.title), ['Local name', 'Local only', 'Cloud only']);
  assert.equal(h.store.shortcuts[0], local[0]);
  assert.equal(JSON.stringify(cloud), before);
  const after = JSON.stringify(h.store.shortcuts);
  await h.cloud('merge');
  assert.equal(JSON.stringify(h.store.shortcuts), after);
});

test('missing cloud never clears local, but an explicit empty cloud snapshot does', async () => {
  const local = [entry('https://keep.example')];
  const h = await harness(local);
  await h.cloud('download');
  assert.equal(h.store.shortcuts, local);
  assert.match(h.elements.shortcutsCloudStatus.textContent, /尚无云端/);
  h.cloudStore.shortcutsCloud = snapshot([]);
  await h.cloud('merge');
  assert.equal(h.store.shortcuts.length, 1);
  await h.cloud('download');
  assert.equal(h.store.shortcuts.length, 0);
});

test('unsigned-in accounts cannot upload, download or merge', async () => {
  const local = [entry('https://keep.example')];
  const cloud = { shortcutsCloud: snapshot([]) };
  const before = JSON.stringify(cloud);
  const h = await harness(local, { account: null, cloud });
  for (const mode of ['upload', 'download', 'merge']) {
    await h.cloud(mode);
    assert.equal(h.store.shortcuts, local);
    assert.equal(JSON.stringify(cloud), before);
    assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  }
  assert.equal(h.elements.shortcutsCloudUploadBtn.disabled, false);
});

test('quota and storage failures preserve the destination configuration', async () => {
  const cloud = { shortcutsCloud: snapshot([entry('https://keep.example')]) };
  const before = JSON.stringify(cloud);
  const h = await harness([entry('https://local.example', '中'.repeat(3000))], { cloud });
  await h.cloud('upload');
  assert.match(h.elements.shortcutsCloudStatus.textContent, /超出 Chrome 同步容量/);
  assert.equal(JSON.stringify(cloud), before);
  h.store.shortcuts = [entry('https://new.example')];
  h.failCloudSave();
  await h.cloud('upload');
  assert.equal(JSON.stringify(cloud), before);
  h.failSave();
  const local = h.store.shortcuts;
  await h.cloud('download');
  assert.equal(h.store.shortcuts, local);
  assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
});

test('malformed cloud, account mismatch and sync read failures preserve local', async () => {
  for (const bad of [null, { ...snapshot([]), accountId: 'other-account' }, { ...snapshot([]), config: { format: 'unknown' } }, snapshot([entry('javascript:alert(1)')])]) {
    const local = [entry('https://keep.example')];
    const h = await harness(local, { cloud: { shortcutsCloud: bad } });
    await h.cloud('download');
    assert.equal(h.store.shortcuts, local);
    assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  }
  const h = await harness([entry('https://keep.example')]);
  const local = h.store.shortcuts;
  h.failCloudRead();
  await h.cloud('merge');
  assert.equal(h.store.shortcuts, local);
});

test('legacy sync data can still be downloaded, and cloud updates never auto-replace local', async () => {
  const cloud = { shortcuts: [entry('https://legacy.example')] };
  const h = await harness([entry('https://local.example')], { cloud });
  const local = h.store.shortcuts;
  await h.callbacks.storage({ shortcuts: { newValue: cloud.shortcuts } }, 'sync');
  assert.equal(h.store.shortcuts, local);
  await h.cloud('download');
  assert.equal(h.store.shortcuts[0].url, 'https://legacy.example');
  assert.equal(h.cloudWrites.length, 0);
});

test('account switches during a transfer abort before writing either destination', async () => {
  for (const mode of ['upload', 'download', 'merge']) {
    const local = [entry('https://keep.example')];
    const cloud = { shortcutsCloud: snapshot([entry('https://cloud.example')]) };
    const before = JSON.stringify(cloud);
    const h = await harness(local, { cloud });
    let calls = 0;
    h.context.chrome.identity.getProfileUserInfo = async () => ({ id: ++calls === 1 ? 'account-1' : 'account-2' });
    await h.cloud(mode);
    assert.equal(h.store.shortcuts, local);
    assert.equal(JSON.stringify(cloud), before);
    assert.match(h.elements.shortcutsCloudStatus.textContent, /账户已切换/);
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.cloudWrites.length, 0);
  }
});

test('two simultaneous cloud actions execute only the first operation', async () => {
  const h = await harness([entry('https://local.example')]);
  await Promise.all([h.cloud('upload'), h.cloud('download')]);
  assert.equal(h.cloudWrites.length, 1);
  assert.equal(h.localWrites.length, 0);
});

test('sync settings button opens an active tab, focuses its window and explains next steps', async () => {
  const h = await harness([]);
  let opened;
  let focused;
  h.context.chrome.tabs.create = async options => { opened = options; return { id: 9, windowId: 3 }; };
  h.context.chrome.windows = { update: async (id, options) => { focused = { id, options }; } };
  await h.elements.shortcutsSyncSettingsBtn.handlers.click();
  assert.equal(opened.url, 'chrome://settings/syncSetup');
  assert.equal(opened.active, true);
  assert.equal(focused.id, 3);
  assert.equal(focused.options.focused, true);
  assert.equal(h.elements.shortcutsSyncHelp.hidden, false);
  assert.equal(h.elements.shortcutsSyncSettingsBtn.disabled, false);
  assert.match(h.elements.shortcutsCloudStatus.textContent, /已打开.*重新检查账户/);
});

test('settings navigation failure displays manual instructions and allows retry', async () => {
  const h = await harness([]);
  h.context.console = { warn() {} };
  h.context.chrome.tabs.create = async () => { throw Error('navigation blocked'); };
  await h.elements.shortcutsSyncSettingsBtn.handlers.click();
  assert.equal(h.elements.shortcutsSyncHelp.hidden, false);
  assert.equal(h.elements.shortcutsSyncSettingsBtn.disabled, false);
  assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  assert.match(h.elements.shortcutsCloudStatus.textContent, /未能自动打开.*地址栏/);
  h.context.chrome.tabs.create = async () => ({ windowId: 1 });
  await h.elements.shortcutsSyncSettingsBtn.handlers.click();
  assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'false');
});

test('rechecking account shows the cause and detects signing into Chrome', async () => {
  const h = await harness([], { account: null });
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.equal(h.elements.shortcutsCloudUploadBtn.disabled, false);
  h.setAccount({ id: 'account-1', email: 'signed-in@example.com' });
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.equal(h.elements.shortcutsCloudUploadBtn.disabled, false);
  assert.match(h.elements.shortcutsCloudAccount.textContent, /signed-in@example.com/);
});

test('Chrome sign-in without legacy full Sync consent still allows an explicit upload', async () => {
  const h = await harness([entry('https://local.example')]);
  const requestedStatuses = [];
  h.context.chrome.identity.getProfileUserInfo = async ({ accountStatus }) => {
    requestedStatuses.push(accountStatus);
    return accountStatus === 'ANY' ? { id: 'account-1', email: 'signed-in@example.com' } : { id: '', email: '' };
  };
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.match(h.elements.shortcutsCloudAccount.textContent, /signed-in@example.com/);
  assert.equal(h.elements.shortcutsCloudUploadBtn.disabled, false);
  await h.elements.shortcutsCloudUploadBtn.handlers.click();
  assert.equal(h.cloudWrites.length, 1);
  assert.ok(requestedStatuses.every(status => status === 'ANY'));
});

test('missing account permission is explained instead of silently disabling actions', async () => {
  const h = await harness([entry('https://keep.example')]);
  h.context.chrome.permissions = { contains: async () => false };
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.match(h.elements.shortcutsCloudStatus.textContent, /权限尚未生效.*重新加载/);
  assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  assert.equal(h.elements.shortcutsCloudUploadBtn.disabled, false);
  await h.elements.shortcutsCloudUploadBtn.handlers.click();
  assert.match(h.elements.shortcutsCloudStatus.textContent, /权限尚未生效/);
  assert.equal(h.cloudWrites.length, 0);
  assert.equal(h.localWrites.length, 0);
});

test('an absent cloud snapshot leaves download clickable and explains why it cannot run', async () => {
  const local = [entry('https://keep.example')];
  const h = await harness(local);
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.equal(h.elements.shortcutsCloudDownloadBtn.disabled, false);
  await h.elements.shortcutsCloudDownloadBtn.handlers.click();
  assert.match(h.elements.shortcutsCloudStatus.textContent, /尚无云端副本/);
  assert.equal(h.store.shortcuts, local);
  assert.equal(h.localWrites.length, 0);
});

test('image failures use CSP-compatible listeners and reveal shortcut letters', async () => {
  const h = await harness([]);
  const letter = { style: { display: 'none' }, classList: { contains: name => name === 'shortcut-letter' } };
  const image = { tagName: 'IMG', dataset: { imageFallback: 'letter' }, style: {}, nextElementSibling: letter };
  h.context.handleImageError({ target: image });
  assert.equal(image.style.display, 'none');
  assert.equal(letter.style.display, 'flex');
  const ordinary = { tagName: 'IMG', dataset: { imageFallback: 'hide' }, style: {} };
  h.context.handleImageError({ target: ordinary });
  assert.equal(ordinary.style.display, 'none');
  h.context.handleImageError({ target: { tagName: 'SCRIPT' } });
  const html = readFileSync(new URL('../extension/index.html', `file://${__filename}`), 'utf8');
  assert.doesNotMatch(app + html, /\son(?:error|load|click)\s*=/i);
});

test('favicon caching reads the Chrome endpoint instead of fetching website icons across origins', async () => {
  const h = await harness([]);
  let requestedUrl;
  h.context.chrome.permissions = { contains: async ({ permissions }) => permissions.includes('favicon') };
  h.context.chrome.runtime.getURL = path => 'chrome-extension://test' + path;
  h.context.fetch = async url => { requestedUrl = new URL(url); return { ok: true, blob: async () => new Blob(['icon']) }; };
  h.context.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,aWNvbg=='; this.onload(); }
  };
  const result = await h.context.fetchFaviconAsDataUri('https://shop.example/page');
  assert.equal(requestedUrl.protocol, 'chrome-extension:');
  assert.equal(requestedUrl.pathname, '/_favicon/');
  assert.equal(requestedUrl.searchParams.get('pageUrl'), 'https://shop.example/page');
  assert.equal(result, 'data:image/png;base64,aWNvbg==');
});

test('favicon permission or cache misses degrade quietly without a remote fetch', async () => {
  const h = await harness([]);
  let requests = 0;
  h.context.fetch = async () => { requests++; return { ok: false }; };
  h.context.chrome.permissions = { contains: async () => false };
  assert.equal(await h.context.fetchFaviconAsDataUri('https://example.com'), null);
  assert.equal(requests, 0);
  h.context.chrome.permissions.contains = async () => true;
  h.context.chrome.runtime.getURL = path => 'chrome-extension://test' + path;
  assert.equal(await h.context.fetchFaviconAsDataUri('https://example.com'), null);
  assert.equal(requests, 1);
  assert.equal(await h.context.fetchFaviconAsDataUri('javascript:alert(1)'), null);
  assert.equal(requests, 1);
});
