# Google Drive 直连接入

> **状态：暂不上线。** 该功能目前不稳定，前端已屏蔽：`extension/index.html` 中没有「Google Drive 云端同步」面板，`extension/manifest.json` 也没有 `identity` / `identity.email` 权限和 `https://www.googleapis.com/*` 主机权限。代码保留在 `extension/app.js` 和 `extension/drive-sync.js` 中供后续恢复，本文是恢复时的开发参考，不面向使用者。

该实现直接向 Google Drive 请求配置，不依赖 Chrome 跨设备同步缓存。**必须先配置真实的 OAuth 客户端，才能完成真实账户的端到端验证。** 未配置时插件会明确显示未连接，不会报告上传成功。

## 开发者配置一次

插件页面已内置这些步骤：展开「Google Drive 云端同步」即可看到 Google Cloud 入口、本机扩展 ID 和客户端 ID 输入框。填写客户端 ID 后，可点击「选择并更新扩展配置」选择 `extension/manifest.json` 保存；浏览器不支持直接编辑时，可下载配置文件并替换原文件。无需查找 README 或使用终端。下面的命令方式仅作为开发者备用入口。

1. 打开 [Google Cloud 控制台](https://console.cloud.google.com/)，选择或创建一个项目，启用 **Google Drive API**。
2. 配置 Google Auth Platform 的应用名称、受众和 OAuth 授权屏幕。测试状态下，把需要使用的谷歌账户加入测试用户。
3. 数据访问范围仅添加 `https://www.googleapis.com/auth/drive.appdata`。这是本应用的私有配置目录，不是整个网盘访问权限。
4. 在 `chrome://extensions` 开启开发者模式，复制 Tab Out 的扩展 ID。在 Google Auth Platform 的「客户端」中创建 **Chrome Extension** 类型的 OAuth 客户端，在 Item ID 中填写该扩展 ID。
5. 复制得到的客户端 ID（以 `.apps.googleusercontent.com` 结尾），在仓库根目录执行：

   ```bash
   node scripts/configure-drive.mjs YOUR_CLIENT_ID.apps.googleusercontent.com
   ```

   脚本将真实客户端 ID 和最小权限范围写入 `extension/manifest.json`。客户端 ID 是应用标识，不是密码；**不需要 client secret，也不要把任何 access token 写入仓库**。脚本不修改现有扩展 ID 或删除原配置。
6. 在 `chrome://extensions` 重新加载扩展，再刷新 Tab Out 页面。

OAuth 客户端必须与本机安装的扩展 ID 相匹配。各设备应使用同一 Google Cloud 应用项目；如果未打包安装产生不同 ID，在同一项目下为对应 ID 创建 Chrome Extension 客户端，并在对应设备配置该客户端。不要为每台机器创建不同的 Google Cloud 项目，否则会变成不同应用的私有目录。发布应用可使用 [固定扩展 ID](https://developer.chrome.com/docs/extensions/reference/manifest/key) 和同一个客户端。更换现有扩展 ID 前先导出本地配置，以免读不到旧 ID 下的数据。

## 两台机器的真实验收

1. 两台机器在 Chrome 中登录同一个谷歌账户，展开「管理 / 同步」→「Google Drive 云端同步」，点击「连接 Google Drive」完成授权。
2. 在机器 A 添加一个可辨认的快捷方式，点击「上传云端」。只有 Drive 保存响应和服务器回读校验成功后，才会显示保存成功。
3. 在机器 B 点击「下载覆盖本地」。插件会直接请求 Google Drive，A 上传的快捷方式应出现在 B。此操作会覆盖 B 的本地列表，可先文件导出备份。
4. 在 B 新增一个快捷方式并上传，再在 A 下载，验证反向传输。
5. 测试合并时，两端同网址只保留一份，本地标题与顺序优先，另一端独有项追加；Drive 文件不会被修改。
6. 断网后尝试下载，应显示连接失败，并保持原本地配置不变。

Drive 的 `appDataFolder` 是隐藏的应用数据目录，不显示在普通网盘文件列表中。只需通过插件的实际服务器请求和另一台机器的下载结果验证，无需寻找公开分享文件。

## 错误处理

- **尚未配置 OAuth 客户端**：完成上面的开发者配置，并重新加载扩展。
- **授权失败**：确认客户端类型和扩展 ID 匹配，测试账户已加入授权屏幕测试用户，Drive API 已启用。
- **403**：检查 API、授权范围和 Drive 存储空间；插件不会扩大到整个网盘权限。
- **断网、超时、401/429/5xx**：提示错误，不会拿本地同步缓存冒充云端数据。
- **上传响应丢失或回读失败**：不能确认上传结果，会提示未完成；恢复网络后「刷新云端状态」检查服务器，不会伪报成功。

参考：[Chrome OAuth 官方流程](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)、[Google Drive 应用配置目录](https://developers.google.com/workspace/drive/api/guides/appdata)。
