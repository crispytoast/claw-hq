# Claw HQ

**The comprehensive self-hosted GUI for [OpenClaw](https://openclaw.ai).** Replaces the OpenClaw terminal for ordinary use — every command has a UI counterpart. Runs on your machine, talks to your local OpenClaw daemon, never phones home.

- **Phone, laptop, desktop** — one relay, every device, cross-device live feed with no polling lag
- **No API keys in Claw HQ** — OpenClaw owns provider auth (Anthropic, OpenAI, Gemini, Ollama, OpenRouter, …)
- **Native APK** with FCM push when an agent finishes a long run + tappable approval cards
- **PWA-installable** web client with offline shell
- **Voice input** via Android's `SpeechRecognizer` (same engine as Gboard mic)
- **Inline diff rendering** for `Edit` / `Write` / `MultiEdit` tool calls
- **Three auth modes** that match real deployments — trusted LAN, shared secret, real accounts
- **Every OpenClaw RPC** has a UI page — Channels, MCPs, Skills, Models, Approvals, Cron, Nodes, Plugins, Memory, Sessions, Doctor, RPC console

## Install

**Via npm** (Node 22+):
```bash
npm install -g @claw-hq/cli
claw-hq init    # setup wizard
claw-hq start
```

**Via Docker:**
```bash
docker run -d --name claw-hq \
  -p 3838:3838 \
  -v ~/.claw-hq:/data \
  -v ~/.openclaw:/openclaw:ro \
  claw-hq/claw-hq
```

**Via install script** (Linux / macOS — installs Node 22 if missing):
```bash
curl -fsSL https://claw-hq.dev/install.sh | sh
```

Then open `http://localhost:3838/`. On Android, the **APK** at `/install` adds push notifications and self-update via `PackageInstaller`.

Full install guide: [docs/install](https://github.com/crispytoast/claw-hq/blob/main/apps/cloud-relay/docs-src/install.md) (also served at `/docs/install` from your running relay).

## What it covers

| Page | OpenClaw RPC | Status |
|---|---|---|
| Chat | `chat.send` + `session.tool` / `session.message` events | ✅ |
| Sessions | `sessions.list` + Open/Compact/Delete | ✅ |
| Project home | `clawhq.projects.{list,get}` + interactive task checkboxes | ✅ |
| Subprojects | `clawhq.subprojects.{list,get}` | ✅ |
| Channels | `channels.status` | ✅ |
| MCPs | `tools.catalog` grouped by source server | ✅ |
| Skills | `skills.search` + `skills.install` | ✅ |
| Models | `models.list` grouped by provider | ✅ |
| Approvals | `exec.approval.list` + `exec.approval.resolve` (inline cards + page) | ✅ |
| Cron | `cron.{list,run,remove,add,update,runs}` | ✅ |
| Nodes | `node.{list,pair.*,rename,remove}` | ✅ |
| Plugins | `clawhq.plugins.{list,search,install,uninstall}` | ✅ |
| Memory | `clawhq.memory.{list,get,put,delete}` (workspace + project-scoped) | ✅ |
| Doctor | `health` | ✅ |
| RPC Console | any Gateway method | ✅ |
| Settings | OpenClaw status / Pairing / Plugins / Notifications / Updates / About | ✅ |

## Setup wizard (`claw-hq init`)

Walks you through:

1. **Where does OpenClaw run?** Auto-detects `~/.openclaw/openclaw.json`.
2. **Where do you want to access Claw HQ from?** Localhost, LAN, Tailnet, public internet.
3. **Auth mode** suggested based on reach: `trusted-lan` / `shared-secret` / `real-auth`.
4. **Passphrase** (shared-secret) or **first user** (real-auth).
5. **Port + public URL**.
6. Writes `~/.claw-hq/config.json`.

Then `claw-hq start` runs the relay + tunnel in one process. The CLI auto-generates an in-process pairing token so single-host deployments need zero pairing UI.

## CLI

- `claw-hq init` — setup wizard
- `claw-hq start` — start the configured services
- `claw-hq pair <token>` — pair a tunnel with a remote relay (split-host)
- `claw-hq tls-setup` — bind Tailscale Serve to port 443 → localhost
- `claw-hq doctor` — config + OpenClaw reachability check
- `claw-hq help`

## Deployment shapes

| Shape | OpenClaw runs | Claw HQ runs | Reach |
|---|---|---|---|
| Single-host (default) | local | same machine | localhost / LAN |
| Tailnet | local | same machine | every Tailnet device |
| Tailscale Serve (HTTPS) | local | same machine | Tailnet + automatic TLS |
| Custom VPN | local | same machine | VPN subnet |
| VPS-relay | home machine | tiny VPS | public URL, outbound tunnel from home |
| Cloudflare Tunnel | local | same machine | public URL via Cloudflare |
| Reverse proxy | local | same machine | as your nginx/Caddy/Traefik |

## Architecture

```
[ Browser / PWA / APK ]
   │  cookie-authed ws (or shared-secret token, or open in trusted-lan)
   ▼
[ Claw HQ Server ] ← single-host single process, or split for VPS-relay
   │  loopback ws (or outbound WS for VPS-relay shape)
   ▼
[ Tunnel module ] ← does OpenClaw handshake transparently
   │  ws://127.0.0.1:18789
   ▼
[ User's OpenClaw Gateway ]
   │
   ▼
[ @claw-hq/openclaw-plugin ] ← registers clawhq.* RPCs for project chats,
                               memory, task toggles, plugin management
```

Browser never sees OpenClaw's shared-secret token. The tunnel does the `connect` handshake via the trusted-loopback path (`client.mode: "backend"` + `client.id: "gateway-client"`) and emits a synthetic `claw.session_ready` event when the Gateway session is live.

## Repo layout

- `apps/cli` — `@claw-hq/cli`, user-facing entrypoint
- `apps/cloud-relay` — Fastify HTTP+WS server with three pluggable auth modes, push delivery, docs site
- `apps/tunnel-agent` — outbound WS to relay, per-client OpenClaw Gateway sessions
- `apps/web` — Vite + React + TS SPA, PWA-installable
- `apps/android` — native Kotlin WebView + FCM APK
- `apps/openclaw-plugin` — `@claw-hq/openclaw-plugin`, registers `clawhq.*` RPCs
- `packages/protocol-types` — shared TS types over Gateway Protocol v4

## Status

- **v0.2.1** — RELEASED. Self-hostable engine + native APK + comprehensive nav coverage + docs site at `/docs`. See [CHANGELOG](#changelog) below.

## Changelog

### v0.2.1 (2026-06-14)

- Inline diff rendering for `Edit` / `Write` / `MultiEdit` tool calls
- Settings → Plugins tab — `clawhq.plugins.{list,search,install,uninstall}` shelling to `openclaw plugins ...`
- Nodes nav page — pair phones as camera/mic/canvas nodes
- First-run OpenClaw install assistant with platform-aware install commands + auto-poll
- Docs site at `/docs/*` (8 pages, dep-free renderer) + `/docs/latest-version.json` manifest
- TLS via Tailscale Serve (code + docs)
- APK 0.4.6 — self-update via `PackageInstaller`, push deep links, voice STT
- Cron add/edit from UI
- AskUserQuestion tap-cards in chat
- Inline approval cards + Approvals nav badge
- Skills per-row install
- Workspace + project-scoped memory editor
- Cross-device chat live feed, file uploads, image thumbnails, full-text search

### v0.2.0 (2026-06-13)

- Self-hostable engine pivot — single-tenant, three auth modes
- CLI (`init`/`start`/`pair`/`doctor`)
- Dockerfile + install.sh
- PWA-installable web client
- Native APK with FCM push notifications
- Phase 5 v0.5.0 — Sessions, Channels, MCPs, Skills, Models, Approvals, Doctor, RPC Console pages
- Phase A OHQ-parity — sidebar + chat aesthetic

## License

UNLICENSED for now. License decision queued before broader public release.

## Contributing

Issues: <https://github.com/crispytoast/claw-hq/issues>. Include `claw-hq doctor` output.
