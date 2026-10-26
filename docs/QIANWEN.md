# 千问 N1 Pro 配置

本项目接入的是 [千问 AI 硬件开放平台](https://device.qianwen.com/)。平台界面、工具标识和账号开放权限会变化；以下给出本项目的实际接口与验收要求，不保证所有账号都能创建或发布相同能力。

1. 完成 [服务部署](DEPLOY.md)，在平台添加 MCP 服务，地址填 `https://dots.example.com/dots/glasses/mcp`，配置本次安装生成的 `platformToken` 作为 Bearer 凭据。不要填写原 Dot 的 `/dots/mcp` 或重复追加 `/mcp`。
2. 刷新工具，确认存在 `send_to_assistant`、`query_assistant_result`、`query_assistant_notifications`、`assistant_bridge_status`；调试状态工具，记录实际返回值，不把工具可见当作链路验收。
3. 导入 [qianwen-skill/SKILL.md](../qianwen-skill/SKILL.md)，将 `{{MCP_ID}}` 替换为该服务的实际工具前缀，将 `{{CAMERA_ID}}` 替换为平台官方拍照工具前缀。按平台当前流程发布，并在真眼镜测试。
4. 按 [验收清单](ACCEPTANCE.md) 完成文字、追问、拍照和结果查询；平台调试成功不能替代眼镜实机结果。

## 实际交互

用户选定与助手交流后，后续“为什么”“第二个”“继续说”应作为新一轮原话送给 Dot。只有明确要求新话题、重新开始时，才使用 `new_conversation=true`。眼镜称呼可按安装者习惯修改；Skill 中的 Codex 表示你连接的原 Dot，不表示另起一个模型进程。

拍照必须使用本次官方 `capture_photo` 返回的有效 `model.url`；只有实际收下图片才可说已发送照片。追问上一张照片用 `use_previous_image=true`，无需重复拍摄。拍照失败、附件过期或指代不清时须明确说明，不用 OCR 或想象代替原图。

用户问“回复了吗”时，每轮都调用 `query_assistant_result`。只有本轮 `state=replied` 且 `reply` 非空才能转述；优先读 `replySummary`，不读任务号、文件名或整段链接。`queued`、`notified`、`processing` 只反映处理阶段。

用户明确要求完整图文链接时，先查询现有结果，原样输出有效 `resultUrl`；不把这个请求重新交办给 Dot。当前没有独立的手机卡片工具，不能声称手机已经自动显示；完整网址也可能进入语音播报。图文入口依赖实际附件，最多有效 15 分钟。

## 能力限制

本项目提供逐轮异步交流，不提供实时打断、持续免唤醒拾音或眼镜原生主动通知。`proactivePlaybackConfigured=false` 是明确的能力状态。微信通知独立配置，既不启用眼镜播报，也不能只凭桥接保存成功宣称手机已收到。

原生事件订阅是否可用须在 [原 Dot](DOT.md) 中核验；眼镜状态工具的 `subscriptionConfigured=true` 只能说明存在有效订阅，不能证明本轮事件已经读到或回复。
