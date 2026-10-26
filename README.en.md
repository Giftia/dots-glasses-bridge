# Dots Glasses Bridge

The first npm test downloads one hash-pinned public Hysteria release as a read-only verification fixture. It is not executed, contains no proxy credentials, and is cached in the ignored .test-assets directory. Prepare that cache before offline tests. Normal service startup does not download it.

[简体中文](README.md)

Connect Qwen N1 Pro glasses to your existing Dot. Speak, share a real photo, and continue a conversation with the same assistant. The bridge accepts requests quickly, delivers native MCP Events to the original Dot, and stores its replies. The glasses speak a short summary; a phone can open a signed page for full text and attachments.

**Experimental.** The owner has confirmed physical glasses-to-Dot conversations. WeChat text, photo, and report round trips passed earlier phone acceptance, but the latest WeChat outbound attempt returned `ret=-2` and remains paused as rejected. This is **not** a current full-chain acceptance claim. See [acceptance scope](docs/ACCEPTANCE.md). This project is not affiliated with Qwen, OpenAI, or WeChat.

| Capability | Scope |
| --- | --- |
| Existing Dot | Native MCP Events, original assistant tools and permissions; no replacement API assistant or Hermes CLI |
| Conversation | Turn-by-turn questions, corrections, choices, bounded context, explicit conversation reset |
| Photos | Official camera capture, follow-up on the previous photo, additional photos in the same conversation |
| Replies | Short spoken summary; signed external HTTPS result page when valid attachments exist; links expire within 15 minutes |
| Notifications | Optional WeChat output; no proactive glasses speech, real-time interruption, or always-on listening |
| Mirroring | Only replies submitted or explicitly published through bridge tools; no automatic lossless mirror of every Dot output |

No resident local browser page is required. The bridge service and optional WeChat worker must keep running under your process manager. Native Events and subscription access depend on the actual platform and account; availability is not universal. [Qwen platform](https://device.qianwen.com/) · [Dot integration](docs/DOT.md)

## Quick start

1. Prepare Node.js, a domain, HTTPS reverse proxy, and an original Dot account with the required native Events capability. The runtime minimum is in [package.json](package.json); development tests use Node.js 24.
2. Install dependencies and run the checks from the source directory:

   ```sh
   npm ci
   npm test
   npm run check
   ```

3. Initialize a fresh private installation, then configure HTTPS using [DEPLOY](docs/DEPLOY.md). Replace the example absolute installation path with one you control:

   ```sh
   node deploy/init.mjs --install-dir /srv/dots-bridge --public-base-url https://dots.example.com/dots --port 17326
   DOT_EVENTS_CONFIG=/srv/dots-bridge/.dot-events/private/config.json node server.mjs
   ```

4. Configure the [Qwen skill](docs/QIANWEN.md), connect and subscribe the [original Dot](docs/DOT.md), and run the [acceptance checklist](docs/ACCEPTANCE.md). [WeChat](docs/WEIXIN.md) is optional.

The public release provides a generic initializer, not a Windows-specific installer or migration utility for existing private installations. PowerShell syntax is documented in [DEPLOY](docs/DEPLOY.md); optional WeChat login and worker startup are in [WEIXIN](docs/WEIXIN.md). Detailed integration documents are currently in Chinese.

## Security

Keep private configuration, pairing codes, OAuth state, WeChat login state, messages, photos, and signed URLs out of source control. The server binds to `127.0.0.1`, using port `17326` by default; expose it through your HTTPS proxy. Keep glasses, WeChat outbound, and WeChat inbound credentials separate. The original Dot uses OAuth authorization. [Authentication reference](https://developers.openai.com/plugins/build/auth)

Treat signed links as temporary bearer access. Use only one WeChat account consumer. An upstream `accepted` receipt does not prove phone delivery. Rejected or unknown sends are not silently retried; `ret=-2` does not establish a particular expiry window or a requirement to scan a QR code again. See [troubleshooting](docs/TROUBLESHOOTING.md).

[Architecture](docs/ARCHITECTURE.md) · [References](docs/REFERENCES.md) · [MIT License](LICENSE)
