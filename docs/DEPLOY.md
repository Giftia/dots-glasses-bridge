# 自行部署

需要可选微信双向通道时，另见 [微信部署步骤](WEIXIN.md)。

此文档与 `deploy/` 文件用于新的独立安装，示例域名、服务账号和绝对目录需由部署者替换。初始化只生成本机配置，不安装系统服务、不修改反向代理、不启用 HTTPS、不重启任何已有服务。仓库的自动测试不等于已在你的公网域名、眼镜或 ChatGPT 账号上完成验收。

## 1. 准备独立目录

需要 Node.js 16.14.2 以上，以及自己控制、已配置 TLS 的 HTTPS 域名。新安装推荐 Node.js 24；Node 16 是现有兼容基线。将项目放在已有、专用、真实的绝对目录，不能使用文件系统根目录、符号链接或链接祖先。**安装目录必须在 nginx 等 Web 服务的所有 `root`、`alias` 和静态托管目录之外**；`.dot-events` 包含口令、平台凭据、消息、照片和 OAuth 状态，不可通过 HTTP 下载，不可提交到 Git 或放入公开备份。

以下命令在项目目录执行，路径只是示例。Linux 示例安装目录为 `/opt/dots-glasses-bridge`，Windows 示例安装目录为 `C:\apps\dots-glasses-bridge`。先把文件复制到你实际选择的目录，然后执行：

```sh
npm ci --omit=dev
node deploy/init.mjs --install-dir /opt/dots-glasses-bridge --public-base-url https://owner.example/dots
```

Windows PowerShell 对应命令：

```powershell
npm ci --omit=dev
node deploy/init.mjs --install-dir 'C:\apps\dots-glasses-bridge' --public-base-url 'https://owner.example/dots'
```

`--install-dir` 与 `--public-base-url` 必填；URL 必须是 HTTPS 且准确以 `/dots` 结束，不接受账号密码、查询参数、片段或结尾斜杠。默认端口 `17326`，可加 `--port 17327` 指定 1–65535 的整数；反向代理端口也须同步。服务始终只监听 `127.0.0.1`。

初始化创建 `.dot-events/private/config.json`、`owner-code.txt`、`installation.json` 与独立的 `.dot-events/data/`，仅输出安装元数据和文件位置，不输出凭据。连接口令为随机 43 字符；配置只保留其哈希，平台凭据为另一个独立随机值。Linux 目录权限为 `700`、配置文件为 `600`；Windows 新运行目录移除继承授权，仅授予当前用户 SID 与 SYSTEM，子目录和文件继承该限制。无法设置权限则停止，不写入凭据。

初始化不会覆盖已有 `.dot-events`，包括未完成的安装。遇到拒绝先检查已有目录，保留故障证据和需要恢复的数据，再另选新目录；不要将重新初始化当作重启操作。使用系统服务时，应由最终服务账号运行初始化，否则它可能没有读取配置的权限。

## 2. 前台启动

Linux/macOS：

```sh
DOT_EVENTS_CONFIG=/opt/dots-glasses-bridge/.dot-events/private/config.json node server.mjs
```

Windows PowerShell：

```powershell
$env:DOT_EVENTS_CONFIG = 'C:\apps\dots-glasses-bridge\.dot-events\private\config.json'
node server.mjs
```

前台启动成功表示进程已经监听本机端口。它不代表公网 HTTPS 已接通，也不代表消息已经送达或眼镜已播报。按 Ctrl+C 停止前台进程；再次执行相同启动命令会复用原数据，**不要重新运行初始化器**。

## 3. 接入反向代理与系统服务

`deploy/nginx.example.conf` 是现有 HTTPS `server` 块内的路由片段，`deploy/dots-glasses-bridge.service.example` 是 systemd 服务示例。先审查和替换账号、路径、Node.js 位置、端口及已有站点配置，再按自己的运维流程安装。示例文件不会自动执行。systemd 示例仅允许写入 `.dot-events/data`，应使用初始化时的账号；它只管理当前桥接进程。

反向代理需保留原请求路径，转发以下接口：

| 用途 | 公网地址 |
| --- | --- |
| 眼镜平台工具入口，使用独立 `platformToken` | `https://owner.example/dots/glasses/mcp` |
| ChatGPT/Dot 工具入口，使用 OAuth | `https://owner.example/dots/mcp` |
| OAuth 授权服务器发现 | `https://owner.example/.well-known/oauth-authorization-server/dots` |
| OAuth 受保护资源发现 | `https://owner.example/.well-known/oauth-protected-resource/dots/mcp` |
| OAuth 授权、令牌、撤销 | `/dots/authorize`、`/dots/token`、`/dots/revoke` |

不要交换两个 MCP 入口或把 `platformToken` 当作 OAuth 连接口令。`owner-code.txt` 仅用于本人在授权页面输入；从受保护的本机文件读取并安全保存，勿粘贴到日志、工单或公开截图。项目当前固定支持的 OAuth 客户端及回调以 `lib/oauth.mjs` 为准。

初次部署包含新目录、凭据、HTTPS、代理及服务配置；重启只是让已部署的进程重新读取同一配置。修改代码或代理后的发布与重启由部署者单独执行，示例不替代已有备份、回滚和服务管理流程。

## 4. 检查实际接通情况

先在本机确认进程启动，再验证自己域名的两个发现接口返回对应的 issuer 和 `/dots/mcp` resource，且 `.dot-events/private/config.json` 等私有地址不可下载。接着分别完成眼镜平台工具配置、ChatGPT OAuth 授权，发送一条无敏感信息的文字并查看真实回复，再单独测试照片。记录本机检查、公网检查、OAuth、眼镜实际读写各自结果；保存摘要不代表眼镜已主动播报。停止服务前先确认正在处理的请求，保留整个私有运行目录作为需要保护的数据。
