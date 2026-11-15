const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = name => readFileSync(new URL('../extension/' + name, `file://${__filename}`), 'utf8');
const app = source('app.js');
const entry = (url, title = 'Example') => ({ id: 'local-id', url, title, faviconUrl: 'https://example.com/icon.png' });
const config = shortcuts => ({ format: 'tab-out-shortcuts', version: 1, shortcuts });
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

// Separate mock Drive server shared by independent simulated browser instances.
// The production HTTP client still constructs and executes every REST request.
function driveServer(initial) {
  const server = {
    config: initial, id: initial === undefined ? null : 'drive-file', requests: [], writes: 0,
    offline: false, status: 0, expiredOnce: false, corruptRead: false,
    async fetch(url, options) {
      const target = new URL(url);
      this.requests.push({ url, method: options.method || 'GET', cache: options.cache });
      assert.equal(options.redirect, 'error');
      assert.equal(target.origin, 'https://www.googleapis.com');
      if (this.offline) throw Error('offline');
      if (this.expiredOnce) { this.expiredOnce = false; return jsonResponse({}, 401); }
      if (this.status) return jsonResponse({}, this.status);
      assert.match(options.headers.Authorization, /^Bearer test-token/);
      if (target.pathname === '/drive/v3/files') {
        assert.equal(target.searchParams.get('spaces'), 'appDataFolder');
        return jsonResponse({ files: this.id ? [{ id: this.id, modifiedTime: '2026-11-15T10:00:00Z' }] : [] });
      }
      if (options.method === 'POST') {
        assert.match(options.headers['Content-Type'], /^multipart\/related; boundary=/);
        const body = options.body.split('\r\n\r\n');
        assert.deepEqual(JSON.parse(body[1].split('\r\n--')[0]).parents, ['appDataFolder']);
        this.config = JSON.parse(body[2].split('\r\n--')[0]);
        this.id = 'drive-file'; this.writes++;
        return jsonResponse({ id: this.id, modifiedTime: '2026-11-15T10:01:00Z' });
      }
      if (options.method === 'PATCH') {
        assert.match(target.pathname, /^\/upload\/drive\/v3\/files\/drive-file$/);
        this.config = JSON.parse(options.body); this.writes++;
        return jsonResponse({ id: this.id, modifiedTime: '2026-11-15T10:01:00Z' });
      }
      assert.equal(target.searchParams.get('alt'), 'media');
      return this.corruptRead ? new Response('{broken') : jsonResponse(this.config);
    },
  };
  return server;
}

async function harness(shortcuts, options = {}) {
  const store = shortcuts === undefined ? {} : { shortcuts };
  const legacy = options.legacy || {};
  const server = options.server || driveServer();
  const elements = Object.fromEntries(['shortcutsImportFile', 'shortcutsImportBtn', 'shortcutsExportBtn', 'shortcutsImportMode', 'shortcutsTransferStatus', 'shortcutsCloudUploadBtn', 'shortcutsCloudDownloadBtn', 'shortcutsCloudMergeBtn', 'shortcutsCloudAccount', 'shortcutsCloudSummary', 'shortcutsCloudStatus', 'shortcutsDriveConnectBtn', 'shortcutsSyncRecheckBtn', 'shortcutsDriveSetup', 'shortcutsDriveClientId', 'shortcutsDriveExtensionId', 'shortcutsDriveSetupStatus', 'shortcutsDriveSaveConfigBtn', 'shortcutsDriveDownloadConfigBtn'].map(id => [id, {
    value: id === 'shortcutsImportMode' ? 'merge' : '', dataset: {}, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  }]));
  const localWrites = [], authCalls = [], invalidated = [], callbacks = {};
  let account = options.account === undefined ? { id: 'account-1', email: 'test@example.com' } : options.account;
  let failSave = false, failAuth = false, downloaded;
  const context = vm.createContext({
    URL: class extends URL {
      static createObjectURL(blob) { downloaded = blob; return 'blob:test'; }
      static revokeObjectURL() {}
    }, URLSearchParams, AbortSignal, crypto: webcrypto, TextEncoder, Blob, console,
    fetch: (url, args) => server.fetch(url, args),
    window: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {},
    document: {
      getElementById: id => elements[id] || null,
      addEventListener() {}, body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }),
    },
    chrome: {
      runtime: { id: 'test', getManifest: () => ({ name: 'Tab Out', manifest_version: 3, permissions: ['tabs', 'storage', 'identity'], ...(options.unconfigured ? {} : { oauth2: { client_id: 'test-client.apps.googleusercontent.com' } }) }) },
      storage: {
        local: {
          get: async key => ({ [key]: store[key] }),
          set: async data => { if (failSave) throw Error('quota'); localWrites.push(data); Object.assign(store, data); },
        },
        sync: { get: async key => ({ [key]: legacy[key] }), set: async () => { throw Error('Chrome Sync must not be written'); } },
        onChanged: { addListener: fn => { callbacks.storage = fn; } },
      },
      identity: {
        getProfileUserInfo: async ({ accountStatus }) => { assert.equal(accountStatus, 'ANY'); return account || { id: '' }; },
        getAuthToken: async options => { authCalls.push(options); if (failAuth) throw Error('denied'); return { token: 'test-token-' + authCalls.length, grantedScopes: ['https://www.googleapis.com/auth/drive.appdata'] }; },
        removeCachedAuthToken: async ({ token }) => { invalidated.push(token); },
      },
      tabs: { query: async () => [], ...Object.fromEntries(['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached'].map(name => [name, { addListener() {} }])) },
    }, LOCALE: 'zh-CN', t: key => key,
  });
  vm.runInContext(source('drive-sync.js'), context);
  vm.runInContext(app, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    context, store, legacy, server, elements, localWrites, authCalls, invalidated, callbacks,
    failSave() { failSave = true; }, failAuth() { failAuth = true; }, setAccount(value) { account = value; },
    cloud(mode) { return vm.runInContext(`syncShortcutsCloud('${mode}')`, context); },
    async import(text, mode = 'merge', size = text.length) {
      elements.shortcutsImportMode.value = mode;
      elements.shortcutsImportFile.files = [{ size, text: async () => text }];
      elements.shortcutsImportFile.value = 'file.json';
      await elements.shortcutsImportFile.handlers.change({ target: elements.shortcutsImportFile });
      assert.equal(elements.shortcutsImportFile.value, '');
      assert.equal(elements.shortcutsImportBtn.disabled, false);
      return elements.shortcutsTransferStatus.textContent;
    },
    async export() { await elements.shortcutsExportBtn.handlers.click(); return downloaded.text(); },
    downloadedText() { return downloaded.text(); },
  };
}

test('portable JSON round-trip preserves contents and order, with fresh local IDs', async () => {
  const entries = [entry('https://example.com/b', '<b>中文 & "quotes"</b>'), entry('https://example.com/a')];
  const a = await harness(entries), b = await harness([]);
  await b.import(await a.export(), 'replace');
  assert.deepEqual(Array.from(b.store.shortcuts, ({ id, ...rest }) => rest), entries.map(({ id, ...rest }) => rest));
  assert.notEqual(b.store.shortcuts[0].id, 'local-id');
  assert.notEqual(b.store.shortcuts[0].id, b.store.shortcuts[1].id);
  assert.equal(vm.runInContext('escapeShortcutHtml(\'<b>&"\')', b.context), '&lt;b&gt;&amp;&quot;');
});

test('file merge retains local names and order and skips equivalent URLs', async () => {
  const local = [entry('https://example.com', 'Local')];
  const h = await harness(local);
  await h.import(JSON.stringify(config([entry('https://example.com/'), entry('https://new.example'), entry('https://new.example/')] )));
  assert.equal(h.store.shortcuts.length, 2);
  assert.equal(h.store.shortcuts[0], local[0]);
});

test('invalid configuration and oversized files leave local data unchanged', async () => {
  const local = [entry('https://keep.example')], h = await harness(local);
  for (const text of ['{', 'null', '{"shortcuts":[]}', JSON.stringify(config([null])), JSON.stringify(config([entry('javascript:alert(1)')])), JSON.stringify(config([{ ...entry('https://ok.example'), faviconUrl: 'data:unsafe' }]))]) {
    await h.import(text, 'replace');
    assert.equal(h.store.shortcuts, local);
    assert.equal(h.elements.shortcutsTransferStatus.dataset.error, 'true');
  }
  assert.match(await h.import('{}', 'replace', 1024 * 1024 + 1), /文件过大/);
  assert.equal(h.store.shortcuts, local);
});

test('empty and BOM configurations work and large local imports do not use cloud quota', async () => {
  const h = await harness();
  assert.equal((await h.context.getShortcuts()).length, 3);
  await h.import('\uFEFF' + JSON.stringify(config([])), 'replace');
  assert.equal((await h.context.getShortcuts()).length, 0);
  await h.import(JSON.stringify(config([entry('https://ok.example', '中'.repeat(3000))])), 'replace');
  assert.equal(h.store.shortcuts[0].title.length, 3000);
  assert.equal(h.server.requests.length, 0);
});

test('migration preserves existing and legacy empty lists without cloud writes', async () => {
  for (const items of [[], [entry('https://legacy.example')]]) {
    const h = await harness(undefined, { legacy: { shortcuts: items } });
    await Promise.all([h.context.getShortcuts(), h.context.getShortcuts()]);
    assert.equal(h.store.shortcuts, items);
    assert.equal(h.localWrites.length, 1);
    assert.equal(h.legacy.shortcuts, items);
    assert.equal(h.server.requests.length, 0);
    const existing = await harness([], { legacy: { shortcuts: items } });
    assert.equal((await existing.context.getShortcuts()).length, 0);
  }
});

test('local editing and file imports never write to Drive', async () => {
  const h = await harness([]);
  await h.context.addShortcut('https://local.example', 'Local', '');
  await h.import(JSON.stringify(config([entry('https://file.example')])));
  assert.equal(h.store.shortcuts.length, 2);
  assert.equal(h.server.writes, 0);
});

test('two independent machines upload and download through the Drive server', async () => {
  const server = driveServer();
  const a = await harness([entry('https://machine-a.example', 'From A')], { server });
  const b = await harness([entry('https://machine-b.example', 'From B')], { server });
  await a.cloud('upload');
  assert.equal(server.writes, 1);
  assert.match(a.elements.shortcutsCloudStatus.textContent, /服务器回读校验成功/);
  assert.equal(server.requests[1].method, 'POST');
  await b.cloud('download');
  assert.equal(b.store.shortcuts[0].title, 'From A');
  assert.match(b.elements.shortcutsCloudStatus.textContent, /服务器下载并覆盖本地/);
  assert.ok(server.requests.every(request => request.cache === 'no-store'));
  assert.equal(a.authCalls[0].interactive, true);
  assert.deepEqual(Array.from(a.authCalls[0].scopes), ['https://www.googleapis.com/auth/drive.appdata']);
});

test('each download reads updated server contents rather than reusing a local snapshot', async () => {
  const server = driveServer(config([entry('https://first.example', 'First')]));
  const h = await harness([], { server });
  await h.cloud('download');
  server.config = config([entry('https://newest.example', 'Newest')]);
  await h.cloud('download');
  assert.equal(h.store.shortcuts[0].title, 'Newest');
  assert.equal(server.writes, 0);
});

test('cloud merge takes the union, preserves local names and deduplicates both sides', async () => {
  const server = driveServer(config([entry('https://same.example/', 'Remote'), entry('https://remote.example', 'Remote only'), entry('https://remote.example/', 'Duplicate')]));
  const local = [entry('https://same.example', 'Local'), entry('https://local.example', 'Local only'), entry('https://same.example/', 'Duplicate')];
  const h = await harness(local, { server });
  const before = JSON.stringify(server.config);
  await h.cloud('merge');
  assert.deepEqual(Array.from(h.store.shortcuts, item => item.title), ['Local', 'Local only', 'Remote only']);
  assert.equal(h.store.shortcuts[0], local[0]);
  const after = JSON.stringify(h.store.shortcuts);
  await h.cloud('merge');
  assert.equal(JSON.stringify(h.store.shortcuts), after);
  assert.equal(JSON.stringify(server.config), before);
  assert.equal(server.writes, 0);
});

test('upload updates the existing Drive file and works beyond the Chrome Sync 8 KB limit', async () => {
  const server = driveServer(config([]));
  const h = await harness([entry('https://large.example', '中'.repeat(3000))], { server });
  await h.cloud('upload');
  assert.equal(server.writes, 1);
  assert.equal(server.config.shortcuts[0].title.length, 3000);
  assert.ok(server.requests.some(request => request.method === 'PATCH'));
  assert.equal(server.config.shortcuts[0].id, undefined);
});

test('offline downloads and merges never fall back to legacy Chrome Sync data', async () => {
  const local = [entry('https://keep.example')];
  const h = await harness(local, { legacy: { shortcutsCloud: { config: config([]) }, shortcuts: [] } });
  h.server.offline = true;
  for (const mode of ['download', 'merge', 'upload']) {
    await h.cloud(mode);
    assert.equal(h.store.shortcuts, local);
    assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
    assert.match(h.elements.shortcutsCloudStatus.textContent, /无法连接 Google Drive/);
  }
  assert.equal(h.server.writes, 0);
});

test('missing cloud preserves local, while a valid empty server file clears it', async () => {
  const local = [entry('https://keep.example')], h = await harness(local);
  await h.cloud('download');
  assert.equal(h.store.shortcuts, local);
  assert.match(h.elements.shortcutsCloudStatus.textContent, /尚无配置文件/);
  h.server.id = 'drive-file'; h.server.config = config([]);
  await h.cloud('download');
  assert.equal(h.store.shortcuts.length, 0);
});

test('malformed or unsafe server configurations never overwrite local data', async () => {
  for (const remote of [{ bad: true }, config([entry('javascript:alert(1)')]), config([null])]) {
    const local = [entry('https://keep.example')];
    const h = await harness(local, { server: driveServer(remote) });
    await h.cloud('download');
    assert.equal(h.store.shortcuts, local);
    assert.equal(h.localWrites.length, 0);
  }
});

test('expired tokens are invalidated and retried once without storing tokens', async () => {
  const h = await harness([], { server: driveServer(config([])) });
  h.server.expiredOnce = true;
  await h.cloud('download');
  assert.equal(h.invalidated.length, 1);
  assert.equal(h.authCalls[0].interactive, true);
  assert.equal(h.authCalls[1].interactive, false);
  assert.ok(!JSON.stringify(h.store).includes('test-token'));
});

test('OAuth cancellation, API failures and missing developer configuration preserve local data', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const local = [entry('https://keep.example')], h = await harness(local);
    h.server.status = status;
    await h.cloud('download');
    assert.equal(h.store.shortcuts, local);
    assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  }
  const h = await harness([], { unconfigured: true });
  await h.cloud('upload');
  assert.match(h.elements.shortcutsCloudStatus.textContent, /尚未配置 OAuth/);
  assert.equal(h.server.requests.length, 0);
  const denied = await harness([]); denied.failAuth();
  await denied.cloud('download');
  assert.match(denied.elements.shortcutsCloudStatus.textContent, /尚未获得 Google Drive 授权/);
  assert.equal(denied.localWrites.length, 0);
});

test('server write acknowledgment without successful readback never reports verified upload', async () => {
  const h = await harness([entry('https://local.example')]);
  h.server.corruptRead = true;
  await h.cloud('upload');
  assert.equal(h.server.writes, 1);
  assert.equal(h.elements.shortcutsCloudStatus.dataset.error, 'true');
  assert.doesNotMatch(h.elements.shortcutsCloudStatus.textContent, /校验成功/);
});

test('account changes abort before writes and simultaneous actions are serialized', async () => {
  const local = [entry('https://keep.example')], h = await harness(local);
  let calls = 0;
  h.context.chrome.identity.getProfileUserInfo = async () => ({ id: ++calls === 1 ? 'account-1' : 'account-2' });
  await h.cloud('upload');
  assert.equal(h.server.writes, 0);
  assert.equal(h.store.shortcuts, local);
  const busy = await harness(local);
  await Promise.all([busy.cloud('upload'), busy.cloud('download')]);
  assert.equal(busy.server.writes, 1);
  assert.equal(busy.localWrites.length, 0);
});

test('connecting explicitly authorizes, while background refresh never prompts for login', async () => {
  const h = await harness([]);
  await h.elements.shortcutsDriveConnectBtn.handlers.click();
  assert.equal(h.authCalls[0].interactive, true);
  assert.match(h.elements.shortcutsCloudStatus.textContent, /Google Drive 已连接/);
  await h.elements.shortcutsSyncRecheckBtn.handlers.click();
  assert.equal(h.authCalls.at(-1).interactive, false);
  assert.equal(h.server.writes, 0);
});

test('local storage failures preserve the previous list after a real server read', async () => {
  const local = [entry('https://keep.example')];
  const h = await harness(local, { server: driveServer(config([])) });
  h.failSave(); await h.cloud('download');
  assert.equal(h.store.shortcuts, local);
  assert.equal(h.server.writes, 0);
});

test('image fallbacks contain no inline event handlers', async () => {
  const h = await harness([]);
  const letter = { style: { display: 'none' }, classList: { contains: name => name === 'shortcut-letter' } };
  const image = { tagName: 'IMG', dataset: { imageFallback: 'letter' }, style: {}, nextElementSibling: letter };
  h.context.handleImageError({ target: image });
  assert.equal(image.style.display, 'none'); assert.equal(letter.style.display, 'flex');
  assert.doesNotMatch(app + source('index.html'), /\son(?:error|load|click)\s*=/i);
});

test('favicon caching stays on the Chrome extension origin', async () => {
  const h = await harness([]); let requested;
  h.context.chrome.permissions = { contains: async () => true };
  h.context.chrome.runtime.getURL = path => 'chrome-extension://test' + path;
  h.context.fetch = async url => { requested = new URL(url); return { ok: true, blob: async () => new Blob(['icon']) }; };
  h.context.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,aWNvbg=='; this.onload(); } };
  assert.equal(await h.context.fetchFaviconAsDataUri('https://example.com'), 'data:image/png;base64,aWNvbg==');
  assert.equal(requested.protocol, 'chrome-extension:');
  assert.equal(requested.searchParams.get('pageUrl'), 'https://example.com');
});

test('shortcut icons list several sources so a blocked one does not blank the icon', async () => {
  const h = await harness([]);
  const candidates = vm.runInContext(
    "getShortcutFaviconCandidates({ url: 'https://example.com/x', faviconUrl: 'https://example.com/icon.png' }, '')",
    h.context,
  );
  assert.deepEqual(Array.from(candidates), [
    'https://example.com/icon.png',
    'https://example.com/favicon.ico',
    'https://icons.duckduckgo.com/ip3/example.com.ico',
    'https://www.google.com/s2/favicons?domain=example.com&sz=64',
  ]);
  // The cached data URI comes first, duplicates collapse, and unsafe schemes
  // are dropped instead of ending up in an <img src>.
  const withCache = vm.runInContext(
    "getShortcutFaviconCandidates({ url: 'https://example.com', faviconUrl: 'javascript:alert(1)' }, 'data:image/png;base64,AAA')",
    h.context,
  );
  assert.deepEqual(Array.from(withCache), [
    'data:image/png;base64,AAA',
    'https://example.com/favicon.ico',
    'https://icons.duckduckgo.com/ip3/example.com.ico',
    'https://www.google.com/s2/favicons?domain=example.com&sz=64',
  ]);
  // Google's service answers unknown domains with a placeholder globe rather
  // than failing, so a stored Google URL must not shadow the real icon.
  const storedGoogle = vm.runInContext(
    "getShortcutFaviconCandidates({ url: 'https://example.com', faviconUrl: 'https://www.google.com/s2/favicons?domain=example.com&sz=64' }, '')",
    h.context,
  );
  assert.deepEqual(Array.from(storedGoogle), [
    'https://example.com/favicon.ico',
    'https://icons.duckduckgo.com/ip3/example.com.ico',
    'https://www.google.com/s2/favicons?domain=example.com&sz=64',
  ]);
});

test('a failed icon source moves on to the next one before the letter appears', async () => {
  const h = await harness([]);
  const letter = { classList: { contains: name => name === 'shortcut-letter' }, style: {} };
  const image = {
    tagName: 'IMG',
    src: 'https://a.example/icon.png',
    style: {},
    dataset: { imageFallback: 'letter', faviconSources: 'https://a.example/icon.png||https://b.example/icon.png||https://c.example/icon.png' },
    nextElementSibling: letter,
  };
  h.context.probeImage = image;

  vm.runInContext('handleImageError({ target: probeImage })', h.context);
  assert.equal(image.src, 'https://b.example/icon.png');
  assert.equal(image.dataset.faviconIndex, '1');
  assert.equal(image.style.display, undefined);
  assert.equal(letter.style.display, undefined);

  vm.runInContext('handleImageError({ target: probeImage })', h.context);
  assert.equal(image.src, 'https://c.example/icon.png');

  // Sources exhausted: the image is hidden and the letter takes over.
  vm.runInContext('handleImageError({ target: probeImage })', h.context);
  assert.equal(image.src, 'https://c.example/icon.png');
  assert.equal(image.style.display, 'none');
  assert.equal(letter.style.display, 'flex');
});

test('an icon service placeholder is recognised and does not win over the real icon', async () => {
  const h = await harness([]);
  const probes = [];
  h.context.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.src = ''; probes.push(this); }
  };

  vm.runInContext('loadFaviconPlaceholderSize(FAVICON_SERVICES[0])', h.context);
  assert.equal(probes.length, 1);
  assert.match(probes[0].src, /tab-out\.invalid/);
  probes[0].naturalWidth = 16;
  probes[0].naturalHeight = 16;
  probes[0].onload();

  h.context.probeImage = {
    getAttribute: () => 'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    naturalWidth: 16, naturalHeight: 16,
  };
  assert.equal(vm.runInContext('isFaviconPlaceholder(probeImage)', h.context), true);
  h.context.probeImage.naturalWidth = 32;
  assert.equal(vm.runInContext('isFaviconPlaceholder(probeImage)', h.context), false);

  // A placeholder that loads successfully still moves on to the next source.
  const letter = { classList: { contains: name => name === 'shortcut-letter' }, style: {} };
  h.context.loadImage = {
    tagName: 'IMG', style: {}, naturalWidth: 16, naturalHeight: 16,
    src: 'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    getAttribute() { return this.src; },
    dataset: { imageFallback: 'letter', faviconSources: 'https://www.google.com/s2/favicons?domain=example.com&sz=64||https://example.com/favicon.ico' },
    nextElementSibling: letter,
  };
  vm.runInContext('handleImageLoad({ target: loadImage })', h.context);
  assert.equal(h.context.loadImage.src, 'https://example.com/favicon.ico');
  assert.equal(h.context.loadImage.style.display, undefined);
});

test('Drive rejects oversized data and refuses to follow unexpected request origins', async () => {
  const h = await harness([]);
  const client = new h.context.TabOutDrive({ authorize: async () => 'test-token', invalidate: async () => {}, checkAccount: async () => {} });
  await assert.rejects(client.readFile({ id: 'remote', size: 1024 * 1024 + 1 }), /超过 1 MB/);
  await assert.rejects(client.request('https://untrusted.example/'), /无效的 Google Drive/);
  assert.equal(h.server.requests.length, 0);
});

test('Drive listing follows an empty page instead of treating it as no configuration', async () => {
  const h = await harness([]); let requests = 0;
  const client = new h.context.TabOutDrive({ authorize: async () => 'test-token', invalidate: async () => {}, checkAccount: async () => {},
    fetchImpl: async url => {
      const params = new URL(url).searchParams;
      requests++;
      return params.get('pageToken') ? jsonResponse({ files: [{ id: 'latest', modifiedTime: '2026-11-15T10:00:00Z' }] })
        : jsonResponse({ files: [], nextPageToken: 'next' });
    },
  });
  assert.equal((await client.findFile()).id, 'latest');
  assert.equal(requests, 2);
});

test('configuration helper writes only the real client identifier and minimum scope', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawnSync } = require('node:child_process');
  const folder = mkdtempSync(join(tmpdir(), 'tab-out-oauth-test-'));
  try {
    mkdirSync(join(folder, 'scripts')); mkdirSync(join(folder, 'extension'));
    copyFileSync(new URL('../scripts/configure-drive.mjs', `file://${__filename}`), join(folder, 'scripts/configure-drive.mjs'));
    const manifestPath = join(folder, 'extension/manifest.json');
    const before = JSON.stringify({ name: 'Test', permissions: ['identity'], version: '1.0.0' });
    writeFileSync(manifestPath, before);
    const script = join(folder, 'scripts/configure-drive.mjs');
    assert.equal(spawnSync(process.execPath, [script, 'invalid']).status, 1);
    assert.equal(readFileSync(manifestPath, 'utf8'), before);
    assert.equal(spawnSync(process.execPath, [script, 'real-client.apps.googleusercontent.com']).status, 0);
    const updated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updated.oauth2.client_id, 'real-client.apps.googleusercontent.com');
    assert.deepEqual(updated.oauth2.scopes, ['https://www.googleapis.com/auth/drive.appdata']);
    assert.equal(updated.key, undefined);
    assert.equal(updated.version, '1.0.0');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('missing OAuth reveals an on-page setup guide and current extension ID', async () => {
  const h = await harness([], { unconfigured: true });
  await h.elements.shortcutsDriveConnectBtn.handlers.click();
  assert.equal(h.elements.shortcutsDriveSetup.hidden, false);
  assert.equal(h.elements.shortcutsDriveExtensionId.value, 'test');
  assert.match(h.elements.shortcutsCloudStatus.textContent, /上方「首次连接 Google Drive」/);
  assert.doesNotMatch(h.elements.shortcutsCloudStatus.textContent, /README/);
});

test('page setup validates the client and selected manifest before changing a file', async () => {
  const h = await harness([], { unconfigured: true });
  let pickerOpened = false, writes = 0;
  h.context.window.showOpenFilePicker = async () => {
    pickerOpened = true;
    return [{ name: 'manifest.json', getFile: async () => ({ text: async () => JSON.stringify({ name: 'Other app', manifest_version: 3 }) }), createWritable: async () => { writes++; } }];
  };
  h.elements.shortcutsDriveClientId.value = 'invalid';
  await h.elements.shortcutsDriveSaveConfigBtn.handlers.click();
  assert.equal(pickerOpened, false);
  h.elements.shortcutsDriveClientId.value = 'public-client.apps.googleusercontent.com';
  await h.elements.shortcutsDriveSaveConfigBtn.handlers.click();
  assert.equal(pickerOpened, true);
  assert.equal(writes, 0);
  assert.match(h.elements.shortcutsDriveSetupStatus.textContent, /所选文件不是 Tab Out/);
});

test('page setup writes and verifies the selected manifest without touching shortcuts', async () => {
  const local = [entry('https://keep.example')], h = await harness(local, { unconfigured: true });
  let contents = JSON.stringify({ name: 'Tab Out', manifest_version: 3, version: '1.0.3', key: 'keep-id' });
  h.elements.shortcutsDriveClientId.value = 'public-client.apps.googleusercontent.com';
  h.context.window.showOpenFilePicker = async () => [{
    name: 'manifest.json', getFile: async () => ({ text: async () => contents }),
    createWritable: async () => ({ write: async text => { contents = text; }, close: async () => {} }),
  }];
  await h.elements.shortcutsDriveSaveConfigBtn.handlers.click();
  const saved = JSON.parse(contents);
  assert.equal(saved.oauth2.client_id, 'public-client.apps.googleusercontent.com');
  assert.equal(saved.key, 'keep-id');
  assert.deepEqual(saved.oauth2.scopes, ['https://www.googleapis.com/auth/drive.appdata']);
  assert.equal(h.store.shortcuts, local);
  assert.equal(h.server.requests.length, 0);
  assert.match(h.elements.shortcutsDriveSetupStatus.textContent, /已保存.*重新加载/);
});

test('page setup supports downloading manifest.json when direct editing is unavailable', async () => {
  const h = await harness([], { unconfigured: true });
  h.elements.shortcutsDriveClientId.value = 'public-client.apps.googleusercontent.com';
  await h.elements.shortcutsDriveSaveConfigBtn.handlers.click();
  assert.match(h.elements.shortcutsDriveSetupStatus.textContent, /不支持直接更新文件/);
  await h.elements.shortcutsDriveDownloadConfigBtn.handlers.click();
  const manifest = JSON.parse(await h.downloadedText());
  assert.equal(manifest.name, 'Tab Out');
  assert.equal(manifest.oauth2.client_id, 'public-client.apps.googleusercontent.com');
  assert.match(h.elements.shortcutsDriveSetupStatus.textContent, /替换.*manifest.json/);
});
