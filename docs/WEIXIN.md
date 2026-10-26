# 可选：微信双向通道

此功能把本人微信消息送到桥接服务，并由独立 worker 回传完整回复及支持的附件。它需要自己部署的 HTTPS 服务、本人扫码登录和本人发送的会话消息。下面是部署者自行执行的步骤；仓库未提供 Windows 服务安装器，也不表示当前环境已完成公网、微信账号或手机实际验收。

## 1. 离线生成桥接凭据

先停止桥接进程与旧微信 consumer，由原桥接服务账号执行。初始化会修改配置，不会启动、停止或重启任何进程。安装路径按实际替换：

```sh
node deploy/init-weixin.mjs --config /opt/dots-glasses-bridge/.dot-events/private/config.json
```

Windows PowerShell：

```powershell
node deploy/init-weixin.mjs --config 'C:\apps\dots-glasses-bridge\.dot-events\private\config.json'
```

初始化保留原配置字段，生成两个独立凭据：`weixinRelayToken` 用于通知 feed；`weixinIngressToken` 用于收信及 `full-v1` 图文 feed，均不能与眼镜 `platformToken` 共用。新增 `private/weixin-setup/connection.json`、`inbound-connection.json`、原始字节备份 `config.before.json` 与含 SHA-256 的 `BACKUP-MANIFEST.md`，先完成备份再原子替换配置。连接游标从当前 `dataDir/event-core/state.json` 的 `notificationSequence` 开始，尚无状态或状态为空时按 0，非空旧状态缺失序号或序号非法时拒绝初始化。

已有微信字段、已有或未完成的 `weixin-setup` 均拒绝覆盖。失败后保留私有准备目录供人工检查，不自动回滚；确认原配置、备份哈希和失败阶段之后再决定恢复方式。备份本身含原有凭据，不能公开。成功后按原部署方式重启桥接进程，使其读取新增配置；重启不需要再次初始化。

## 2. 准备 worker 私有目录

在运行 worker 的主机准备两个彼此独立的绝对目录。`RELAYABS` 存放上述两个连接文件、游标与回执；`CHANNELABS` 保存微信登录状态和本人会话上下文。它们均须在静态网站目录之外，不使用链接或共享的历史桥接目录。

Linux 示例：

```sh
install -d -m 700 /var/lib/dots-weixin-relay /var/lib/dots-weixin-channel
```

同机情况下，将 `weixin-setup` 中的 **`connection.json`、`inbound-connection.json` 两个文件**复制到 `/var/lib/dots-weixin-relay/`，并设为 `600`。如 worker 在另一台主机，使用已核实目标的安全传输方式仅传这两个文件；不要复制整个桥接配置、备份、眼镜口令或消息数据。所有操作由最终 worker 账号执行，不在命令行中展开凭据。

```sh
install -m 600 /opt/dots-glasses-bridge/.dot-events/private/weixin-setup/connection.json /var/lib/dots-weixin-relay/connection.json
install -m 600 /opt/dots-glasses-bridge/.dot-events/private/weixin-setup/inbound-connection.json /var/lib/dots-weixin-relay/inbound-connection.json
```

Windows PowerShell 示例，创建全新目录并明确限制权限：

```powershell
$relayDir = 'C:\apps\dots-weixin-relay'
$channelDir = 'C:\apps\dots-weixin-channel'
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($privateDir in @($relayDir, $channelDir)) {
    New-Item -ItemType Directory -Path $privateDir -ErrorAction Stop | Out-Null
    & icacls.exe $privateDir /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
    if ($LASTEXITCODE -ne 0) { throw '无法设置私有目录权限，停止操作' }
}
```

只在权限设置成功后复制两个连接文件；检查复制文件仍只有当前 SID 与 SYSTEM 的访问授权。不要对已有目录套用这些创建命令，也不要向宽松权限目录复制微信登录状态。

## 3. 本人扫码并建立会话

以下命令从项目根目录执行，替换为实际绝对目录。登录二维码属于短期私有资料，不上传二维码网站、不放入公开工单或截图。先生成登录资料并仅保存在私有目录：

```sh
umask 077
node weixin-cli.mjs login-start --state-dir /var/lib/dots-weixin-channel > /var/lib/dots-weixin-channel/login-display.json
```

结果应为 `waiting_for_scan`，其中 `qrContent` 是应当编码成二维码的内容；不要把 `qrCode` 编号当作二维码图片。项目不内置二维码绘制器，可用可信的本机二维码工具离线绘制。下面给出可复现的可选 Python 工具方案，工具安装阶段需要下载依赖，绘制阶段不上传登录资料：

```sh
python3 -m venv /var/lib/dots-weixin-channel/qr-tools
/var/lib/dots-weixin-channel/qr-tools/bin/python -m pip install qrcode==8.2 pypng==0.20220715.0
/var/lib/dots-weixin-channel/qr-tools/bin/python -c 'import json,qrcode,sys; qrcode.make(json.load(open(sys.argv[1],encoding="utf-8"))["qrContent"]).save(sys.argv[2])' /var/lib/dots-weixin-channel/login-display.json /var/lib/dots-weixin-channel/login-qr.png
```

在本机打开私有 `login-qr.png`，由本人微信扫码确认，然后检查：

```sh
node weixin-cli.mjs login-check --state-dir /var/lib/dots-weixin-channel
```

若仍为 `waiting_for_scan`，完成扫码后再次检查；过期返回 `login_expired`，再运行 `login-start` 生成新的二维码。`user_intervention_required` 按微信界面的实际要求处理，不用重试代替确认。登录成功后，**由同一个扫码账号向该机器人发送一条私聊文字**，再执行：

```sh
node weixin-cli.mjs context-check --state-dir /var/lib/dots-weixin-channel
node weixin-cli.mjs status --state-dir /var/lib/dots-weixin-channel
```

确认 `ownerBound: true`、`contextReady: true`、`state: ready` 后，再进入常驻转发。`waiting_for_owner_context` 表示尚未建立本人私聊上下文。Windows 的 `weixin-cli.mjs` 命令相同，替换绝对目录即可；若重定向登录 JSON，使用显式 UTF-8 输出。二维码绘制方案需自行安装相应的本机工具，并非 Windows 自动安装流程。

## 4. 启动唯一 consumer 并验收

一个微信账号只运行一个收信 consumer。开始前停止旧的 `watch`、`watch-chat` 或其他读取同账号消息的程序；并发读取可能竞争微信更新，不要靠多开来重试。新的双向 worker 使用两个位置参数，不是 `--state-dir`：

```sh
node weixin-relay.mjs watch-chat /var/lib/dots-weixin-relay /var/lib/dots-weixin-channel
```

Windows 示例：

```powershell
node weixin-relay.mjs watch-chat 'C:\apps\dots-weixin-relay' 'C:\apps\dots-weixin-channel'
```

`watch-chat` 读取 `connection.json` 和 `inbound-connection.json`，保留本地游标、发送计划与回执。保持相同目录重启，不重新登录、不改游标来重放消息。出现 `unknown`、`rejected` 或需要人工检查的发送状态，先核对回执与手机实际状态；不要直接重复发送。前台用 Ctrl+C 停止，常驻运行的服务管理由部署者按所在系统另行配置。

发送一条无敏感信息的本人微信文字，检查桥接服务出现该消息并由原 Dot 处理，再确认手机收到真实完整回复；之后单独测试照片及附件。自动测试通过、worker 保存回执、远端接受请求和手机实际送达是不同验收阶段。微信通道接通不代表眼镜主动播报已经实现。
