# 可选：事件回调的独立出口

正常部署直接通过 HTTPS 向平台提供的事件回调发送签名请求，不需要个人电脑常驻网页或安装代理。如果回调挑战、投递遇到 403 或超时，先核对目标、DNS、有效授权和上游响应；并非所有 403 都由同一原因造成。

可选的 Linux 受管出口只改变回调挑战与事件发送的传输。OAuth、媒体下载、微信及其他程序不经过它，不设置系统全局代理，不关闭 TLS 验证。这不是默认部署步骤，也不附带可用节点或口令。

## 兼容范围

受管模式只接受官方 Hysteria 2.13.0 Linux amd64 文件，固定 SHA-256：

    907ba8c9693edb104b20582681fb7dc15639d5b64a9cbb616a7b539190a86691

来源为 [官方发布页](https://github.com/HyNetworks/hysteria/releases/tag/app/v2.13.0)，另外核对官方校验清单和独立许可证。仓库不分发二进制；其他架构、版本、操作系统不在该模式的验证范围。不要修改校验常量来容纳未知下载。

在源码目录下，由低权限服务账号准备：

| 相对位置 | 内容与权限 |
| --- | --- |
| .dot-events/proxy/hysteria | 已校验可执行文件；root 或服务账号持有，不允许组及其他用户写入 |
| .dot-events/private/hysteria-client.json | 从 [模板](../deploy/hysteria-client.example.json) 创建；服务账号持有，600 |
| .dot-events/private/webhook-proxy.txt | 与 JSON 一致的带认证本地 HTTP 代理网址；服务账号持有，600 |

父目录权限为 700。节点地址、认证和证书 SNI 必须自行提供和确认，tls.insecure 必须为 false。本地代理只监听 127.0.0.1:17327，不开放到局域网或公网。模板占位值不能作为可用配置。

可在项目根目录用以下本机脚本，从已填写的私有 JSON 生成代理文件，不把口令展开到命令行或日志。目标文件已存在时会拒绝：

    node --input-type=module -e 'import fs from "node:fs";const p=".dot-events/private/";const c=JSON.parse(fs.readFileSync(p+"hysteria-client.json","utf8"));const u=new URL("http://127.0.0.1:17327");u.username=c.http.username;u.password=c.http.password;fs.writeFileSync(p+"webhook-proxy.txt",u.href+"\n",{flag:"wx",mode:0o600});'

在已有应用配置中显式设置 managedWebhookProxy 为 true，按发布流程备份、更新并重启这一项应用，再分别验证本机健康、回调挑战及真实事件投递。不要为此重启主机、修改全局网络或迁移微信账号。应用管理自己的子进程，代理异常时关闭应用，不静默切回直连；恢复由既有服务管理策略决定。

应用端口不能与代理的 17327 冲突。没有可验证节点时，保留默认直连并把事件能力标记为待接通。
