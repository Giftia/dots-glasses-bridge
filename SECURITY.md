# Security and private data

For a vulnerability, use GitHub's private vulnerability reporting if available. Otherwise contact the maintainer through the profile linked from this repository before sending details. Do not put credentials, full callback URLs, signed result links, QR codes, photos, or private chat text in public issues.

Use one application process and one WeChat consumer per account directory. Keep `.dot-events`, WeChat state, connection files, owner codes and TLS keys outside the web root and out of Git. The initializer restricts its newly created private runtime; separately created WeChat directories need the same restrictive owner-only permissions (plus SYSTEM on Windows). Proxy authentication is also private. Never disable TLS verification to make callback delivery work.

The reverse proxy must expose only the application routes. Do not expose the Node listener directly. Signed result links are bearer capabilities and expire; anyone possessing a live link may open it. Original photos, returned artifacts and task records remain private on disk. A 24-hour read-expiry policy is not automatic disk deletion. Plan retention and capacity management separately; do not delete active cursors or uncertain send records.

`accepted` means a successful API response, not physical delivery or reading. Unknown or explicitly rejected sends pause outbound forwarding. New inbound messages can still arrive. Do not clear receipts, reset cursors, blindly restart or automatically resend an uncertain delivery. See [troubleshooting](docs/TROUBLESHOOTING.md) and the explicit one-attempt [recovery tool](docs/WEIXIN-RECOVERY.md).

The included release scanner is a safety net, not a guarantee that arbitrary files are safe. Its small allowlist contains exact SHA-256 hashes of manually reviewed synthetic credential-URL fixtures; a changed fixture is scanned again. Only publish reviewed source files from a fresh repository. Do not add live runtime directories or old workspace history.
