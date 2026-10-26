# 来源与参考

本项目的行为边界以当前源码与 [验收记录范围](ACCEPTANCE.md) 为准。下面区分协议背景、平台入口和设计参考；引用不代表平台官方认可本项目，也不证明每个账号都有原生 Events 权限。

| 来源 | 用途与限制 |
| --- | --- |
| [千问 AI 硬件开放平台](https://device.qianwen.com/) | 眼镜 MCP、Skill 与官方拍照能力的配置入口；具体权限和发布流程由实际账号界面确认 |
| [OpenAI 认证文档](https://developers.openai.com/plugins/build/auth) | OAuth 与 MCP 认证背景；不是本项目自定义 Events 可用性的承诺 |
| [ChatGPT 公开 OAuth 客户端元数据](https://chatgpt.com/oauth/client.json) | 本项目固定客户端身份与回调约束的参考，实际实现见 [oauth.mjs](../lib/oauth.mjs) |
| [MCP 2025-03-26 传输规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) | JSON-RPC 与 HTTP 传输、安全边界背景；本项目支持范围须结合源码核对 |
| [千问社区参考文章](https://device.qianwen.com/community/post/3715539521260998) | 最初讨论的异步眼镜桥参考入口；整理文档时无法取得正文，未据此引用具体平台限制或实现细节 |

实现还参考了 [hightouch666/hermes-glasses-bridge](https://github.com/hightouch666/hermes-glasses-bridge) 的异步设计思路：眼镜快速收下、后台慢处理、用户按需查询与手机结果出口。该参考项目的本地审阅版本描述了“队列服务 → Hermes 所在主机接入端 → `hermes -z`”流程；本项目采用原 Dot 原生 MCP Events 与读写工具，执行端并不是 Hermes CLI。未从参考材料复制大段说明。

参考项目列出的上游是 [hange3514/xiaolongxia-glasses-bridge](https://github.com/hange3514/xiaolongxia-glasses-bridge)。此链接用于了解设计背景，不表示本项目是该代码的完整移植或兼容实现。许可与必要署名以仓库实际包含的 [LICENSE](../LICENSE) 及交付文件为准。

微信通道使用的行为以当前 [weixin.mjs](../lib/weixin.mjs)、[weixin-duplex.mjs](../lib/weixin-duplex.mjs) 和 [weixin-media.mjs](../lib/weixin-media.mjs) 为依据。仓库不把未能核实的微信错误码解释、凭据期限或扫码规则当成平台官方保证。
