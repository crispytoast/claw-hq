# Claw HQ

**Self-hosted cross-device interface for OpenClaw.**

Download OpenClaw, then download Claw HQ. Run the setup wizard, pick how you want to deploy it (local-only, LAN, Tailnet, custom VPN, VPS-relay, behind your reverse proxy — your call), and you have a polished web/PWA on top of your own OpenClaw. No central server, no telemetry, no accounts on someone else's machine.

## Install

**Via npm (recommended — Node 22+):**
```sh
npm install -g @claw-hq/cli
claw-hq init
claw-hq start
```

**Via Docker:**
```sh
docker run -d --name claw-hq \
  -p 3838:3838 \
  -v ~/.claw-hq:/data \
  -v ~/.openclaw:/openclaw:ro \
  claw-hq/claw-hq
```

**Via install script (installs Node + Claw HQ):**
```sh
curl -fsSL https://claw-hq.example/install.sh | sh
```

Then open `http://localhost:3838/` (or wherever you bound it) in any browser. On mobile, Chrome will prompt "Install"; iOS Safari → Share → "Add to Home Screen". You get a home-screen icon and full-screen mode — same UX as a native app.

## Setup wizard (`claw-hq init`)

Walks you through:

1. **Where does OpenClaw run?** Auto-detects `~/.openclaw/openclaw.json`.
2. **Where do you want to access Claw HQ from?**
   - Just this machine (localhost only)
   - My LAN (shared-secret recommended)
   - My Tailnet / VPN (shared-secret recommended)
   - Public internet (real-auth required + put TLS in front)
3. **Auth mode** (suggested based on reach):
   - `trusted-lan` — no password, anyone reachable is trusted
   - `shared-secret` — one passphrase for everyone
   - `real-auth` — email + password accounts
4. **Passphrase** (if shared-secret).
5. **Port + public URL**.
6. Writes `~/.claw-hq/config.json`.

Then `claw-hq start` runs the relay + tunnel together (single process by default).

## Other CLI commands

- `claw-hq start` — start the configured services
- `claw-hq pair <token>` — split-host deployments: pair this machine's tunnel with a remote relay
- `claw-hq doctor` — sanity check (config, OpenClaw reachability)
- `claw-hq help`

## Deployment shapes

| Shape | OpenClaw runs | Claw HQ runs | Reach | Setup |
|---|---|---|---|---|
| Single-host (default) | local | same machine | localhost / LAN | `init` → pick "local" or "lan" |
| Tailnet | local | same machine | every device on user's Tailnet | `init` → "tailnet" + shared-secret |
| Tailscale Serve (HTTPS) | local | same machine | Tailnet with TLS via Tailscale cert | as above + `tailscale serve` |
| Custom VPN | local | same machine | VPN subnet | as Tailnet |
| VPS-relay | home machine | tiny VPS | public URL, tunnel from home | `init` on VPS + `pair` at home |
| Cloudflare Tunnel | local | same machine | public URL via Cloudflare | as single-host + `cloudflared` |
| Behind reverse proxy | local | same machine | as your nginx/Caddy | as single-host + proxy_pass |

## Architecture

```
[ Browser / PWA / Native wrapper ]
   │  cookie-authed ws (or shared-secret token, or no auth in trusted-lan)
   ▼
[ Claw HQ Server ]          ← single-host single process, OR split for VPS-relay
   │  loopback ws (or outbound WS for VPS-relay shape)
   ▼
[ Tunnel module ]           ← does OpenClaw handshake transparently
   │  ws://127.0.0.1:18789
   ▼
[ User's OpenClaw Gateway ]
```

The browser never sees OpenClaw's shared-secret token. The tunnel module does the `connect` handshake (using `client.id: "gateway-client"` + `client.mode: "backend"`, the trusted-loopback path) on each browser client's behalf and emits a synthetic `claw.session_ready` event when the Gateway session is live. From there it's pure passthrough.

## Repo layout

- `apps/cli` — `@claw-hq/cli` package, user-facing entrypoint (`claw-hq init/start/pair/doctor`)
- `apps/cloud-relay` — Fastify HTTP+WS server with three pluggable auth modes
- `apps/tunnel-agent` — outbound WSS to relay, per-client OpenClaw Gateway sessions
- `apps/web` — Vite + React + TS SPA, PWA-installable
- `packages/protocol-types` — shared TS types over OpenClaw Gateway Protocol v4

## Status

- v0.1 — local-via-Tailscale multi-tenant SaaS prototype (superseded)
- **v0.2 — IN PROGRESS** — single-tenant self-hosted product with CLI + three auth modes + Dockerfile + install.sh + PWA. Pivot rationale in `BRIEF.md`. Native wrappers (TWA, Tauri) queued for v0.3.

Built and run on jesse-Legion-7-16IRX9 as a systemd user service (`claw-hq.service`); end-to-end verified at `http://100.88.29.65:3838/` from the Tailnet.

## License

UNLICENSED for now. License decision queued.
