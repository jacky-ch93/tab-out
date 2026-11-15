#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const clientId = process.argv[2];
if (!clientId || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error('用法：node scripts/configure-drive.mjs <Chrome 扩展 OAuth 客户端 ID>');
  process.exit(1);
}
const path = new URL('../extension/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.permissions = [...new Set([...(manifest.permissions || []), 'identity', 'identity.email'])];
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'https://www.googleapis.com/*'])];
manifest.oauth2 = { client_id: clientId, scopes: ['https://www.googleapis.com/auth/drive.appdata'] };
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
console.log('已配置 Google Drive OAuth。请在 chrome://extensions 重新加载 Tab Out。');
console.log('注意：云端同步面板目前不在前端显示，需要先恢复 extension/index.html 中的 Google Drive 区块。');
