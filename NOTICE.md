# Sources and third-party components

Dots Bridge is an independent, unofficial Node.js implementation for connecting an existing Dot to Qwen AI glasses and an optional WeChat channel. It does not redistribute a Dot model, a Qwen app, OpenClaw, or a proxy executable.

- Design reference: [the Qwen community article](https://device.qianwen.com/community/post/3715539521260998) and [hightouch666/hermes-glasses-bridge](https://github.com/hightouch666/hermes-glasses-bridge), MIT. The fast-accept/asynchronous-work pattern is acknowledged; this repository uses native MCP events for the existing Dot rather than executing a Hermes CLI. No upstream Python implementation is bundled.
- WeChat protocol reference: [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin), MIT, protocol/source baseline `874637a0dbc24050f72d1385add4fc6170a2d726`. The channel and media client are independently implemented from the published protocol. Consult Tencent's [license](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/LICENSE) and [protocol](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol_zh_CN.md).
- npm dependency: `https-proxy-agent` 7.0.6 and its transitive `agent-base`, `debug`, and `ms` dependencies retain their respective MIT licenses in their installed packages. They are pinned by `package-lock.json`, not vendored here.
- Optional managed webhook transport can launch a separately supplied Hysteria binary. This repository does not include that binary or node credentials. Its independent license and release provenance must be reviewed by the operator before use. Ordinary direct HTTPS deployment does not require it.

Dots, ChatGPT, Qwen, WeChat and the respective product names belong to their owners. This project is not an official integration or an affiliation claim. Account entitlements and platform terms still determine which interfaces a deployment can use.
