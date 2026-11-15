'use strict';

// Direct Google Drive requests. No chrome.storage.sync or local cloud cache.
// OAuth access tokens stay in memory/Chrome's identity cache, never in storage.
globalThis.TabOutDrive = class TabOutDrive {
  static scope = 'https://www.googleapis.com/auth/drive.appdata';
  static fileName = 'tab-out-shortcuts.json';
  static maxBytes = 1024 * 1024;

  constructor({ authorize, invalidate, checkAccount, fetchImpl = globalThis.fetch }) {
    this.authorize = authorize;
    this.invalidate = invalidate;
    this.checkAccount = checkAccount;
    this.fetchImpl = fetchImpl;
    this.token = null;
  }

  async request(path, options = {}) {
    // Paths are built by this class, never taken from downloaded configuration.
    const url = new URL(path, 'https://www.googleapis.com');
    if (url.origin !== 'https://www.googleapis.com') throw new Error('无效的 Google Drive 请求地址。');
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.checkAccount();
      this.token ||= await this.authorize();
      await this.checkAccount();
      let response;
      try {
        response = await this.fetchImpl(url.href, {
          ...options,
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: { ...options.headers, Authorization: `Bearer ${this.token}` },
        });
      } catch {
        throw new Error('无法连接 Google Drive（断网或请求超时）。未确认云端写入，请恢复网络后重新检查。');
      }
      if (response.status === 401 && attempt === 0) {
        await this.invalidate(this.token);
        this.token = null;
        continue;
      }
      if (!response.ok) {
        const messages = {
          401: 'Google Drive 授权已失效，请重新连接。',
          403: 'Google Drive 拒绝访问，请检查 Drive API 是否启用、授权范围或云端存储空间。',
          404: '云端文件已不存在，请重新读取云端列表。',
          429: 'Google Drive 请求过于频繁，请稍后重试。',
        };
        throw new Error(messages[response.status] || `Google Drive 请求失败（HTTP ${response.status}）。`);
      }
      await this.checkAccount();
      return response;
    }
  }

  async findFile() {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${TabOutDrive.fileName}' and trashed = false`,
      orderBy: 'modifiedTime desc',
      fields: 'nextPageToken,files(id,name,modifiedTime,size)',
      pageSize: '100',
    });
    const visited = new Set();
    while (true) {
      const data = await (await this.request(`/drive/v3/files?${params}`)).json();
      if (!Array.isArray(data.files)) throw new Error('Google Drive 返回了无效的文件列表。');
      // Google allows duplicate names. Use the newest server modification time,
      // with ID as a deterministic tie-breaker, without deleting older copies.
      if (data.files.length) {
        return data.files.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime))
          || String(a.id).localeCompare(String(b.id)))[0];
      }
      if (!data.nextPageToken) return null;
      if (visited.has(data.nextPageToken)) throw new Error('Google Drive 文件分页异常，请重试。');
      visited.add(data.nextPageToken);
      params.set('pageToken', data.nextPageToken);
    }
  }

  async readFile(file) {
    if (!file.id || (file.size && Number(file.size) > TabOutDrive.maxBytes)) {
      throw new Error('云端配置文件无效或超过 1 MB，本地配置未更改。');
    }
    const response = await this.request(`/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    const text = await response.text();
    if (new TextEncoder().encode(text).length > TabOutDrive.maxBytes) throw new Error('云端配置超过 1 MB，本地配置未更改。');
    let config;
    try { config = JSON.parse(text); }
    catch { throw new Error('云端配置不是有效的 JSON，本地配置未更改。'); }
    return { config, updatedAt: file.modifiedTime, fileId: file.id };
  }

  async read() {
    const file = await this.findFile();
    return file ? this.readFile(file) : null;
  }

  async write(config) {
    const content = JSON.stringify(config);
    if (new TextEncoder().encode(content).length > TabOutDrive.maxBytes) throw new Error('配置超过 1 MB，请精简后再上传。');
    const file = await this.findFile();
    let response;
    if (file) {
      response = await this.request(`/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id,modifiedTime,size`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: content,
      });
    } else {
      const boundary = `tab_out_${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name: TabOutDrive.fileName, parents: ['appDataFolder'], mimeType: 'application/json' });
      response = await this.request('/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime,size', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`,
      });
    }
    const saved = await response.json();
    // A write acknowledgment alone isn't enough: read the server file back and
    // verify its contents before telling the user the upload is confirmed.
    const verified = await this.readFile(saved);
    if (JSON.stringify(verified.config) !== content) throw new Error('云端写入后的内容校验不一致，可能有其他设备同时上传。请重新读取后重试。');
    return verified;
  }
};
