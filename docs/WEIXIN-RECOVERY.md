# 恢复一条明确被拒收的微信回复

`rejected` 与 `unknown` 不同：前者是接口明确拒绝，后者无法确认发送结果。本工具只允许操作者对**一条指定、已明确拒绝、正文完全一致**的消息重新申请发送一次，不处理 `unknown`，不自动循环重试，不把旧记录改成成功，不跳过未送达消息。`ret=-2` 的业务含义尚未确认，不能仅凭它断定固定时间窗失效或要求重新扫码。

## 先检查

保持原单实例 `watch-chat` 运行；不要启动第二个收信 worker。在微信本人私聊发一条新文字，让原 worker 更新会话上下文。工具要求该上下文晚于拒绝时间，且在操作前十分钟以内。这是恢复工具的保守新鲜度要求，不是微信协议的固定 TTL。

从私有 `outbound-plan.json` 读取 `sourceId`、`nextPart`；在账号状态中对应记录键为 `sourceId + '-p' + (nextPart + 1)`，取它的 `updatedAt`。只分享这些安全字段，不要公开整个文件。

先运行只读检查（将占位值替换为本次实际值）：

```sh
node tools/recover-weixin.mjs --relay-dir /srv/dots-relay-private --channel-dir /srv/dots-weixin-private --source-id dots_REPLACE_WITH_ACTUAL_ID --updated-at REPLACE_WITH_MILLISECONDS
```

实际 ID 必须为 `dots-` 加 64 位十六进制；示例故意使用无效占位值，未替换不能操作。若恢复工具不在 worker 源码目录，另传 `--runtime-root /absolute/path/to/reviewed-worker`，从该运行目录加载实际微信模块；只可指向你信任且已审查的代码。默认不发送、不写入。

## 明确允许一次重试

确认只读结果为 `ready-for-one-explicit-retry`，并核对它就是尚未收到的那一条，再在原命令末尾追加：

```text
--apply --allow-retry-rejected
```

此时会在现有私有 relay 目录创建独立备份和事务，保留原完整发送计划与该条失败回执，写入不含凭据的 `BACKUP-MANIFEST.md`。备份包含私密正文，仍须按私有资料保护，不可提交 Git。仅以一个新而稳定的 `-recover1` 通知标识调用微信一次；账号的原拒收记录始终保留。API 接受后，只更新当前分段进度并解除这一条暂停；游标由原 worker 在所有分段接受后推进，不重启任务或改动绑定。

工具会等待账号锁最多约 45 秒；只有“忙且尚未发起发送”会等待，不会强抢锁、强杀进程或删除旧锁。新的请求若再次拒绝或结果不明，原出站暂停继续保留。相同恢复事务不再自动发起第二次网络请求。

## 验收和中断

接口 `accepted` 仍不等于手机实收。分别核对私有 `receipt.json` 的新鲜时间及 `outboundBlocked`、正常 cursor 前进，以及手机实际收到；再发一条文字确认双向聊天。工具测试使用合成通道，不替代本人手机验收。

如果工具在备份、发送或提交之间被中断，保留恢复目录和原生回执，不要删目录重跑，不要恢复旧 cursor。尤其 `sendReserved=true` 时，需要核对 `-recover1` 原生回执才能决定下一步；本工具不自动处理该事务，也不据此宣称消息没有发出。任何还原都要先停止单一消费者并审查当前计划、cursor 和收信情况，不能直接覆盖全账号文件。
