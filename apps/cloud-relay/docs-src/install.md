---
title: Install
description: Install Claw HQ on your laptop, server, or container.
---

# Install Claw HQ

Pick the option that fits your setup. Each one ends with the same `claw-hq start` command and the same `~/.claw-hq/config.json`.

## Quick install (Linux / macOS)

```bash
curl -fsSL https://claw-hq.dev/install.sh | sh
```

Installs Node 22 if missing (via NodeSource on Linux or Homebrew on macOS), then `npm install -g @claw-hq/cli`. After it finishes:

```bash
claw-hq init    # one-time setup wizard
claw-hq start   # relay + tunnel in one process
```

## npm (Node 22+)

```bash
npm install -g @claw-hq/cli
claw-hq init
claw-hq start
```

## Docker

```bash
docker run -d \
  --name claw-hq \
  -p 3838:3838 \
  -v ~/.claw-hq:/data \
  -v ~/.openclaw:/openclaw:ro \
  claw-hq/claw-hq
```

The container's entrypoint seeds a default `config.json` on first run. Mount `~/.openclaw` read-only so the relay can discover the gateway URL from the host's OpenClaw config without needing its own.

## From source

```bash
git clone https://github.com/crispytoast/claw-hq.git
cd claw-hq
pnpm install
pnpm --filter @claw-hq/cli dev init
pnpm --filter @claw-hq/cli dev start
```

`pnpm dev:*` scripts at the repo root cover each app individually (`dev:relay`, `dev:tunnel`, `dev:web`, `dev:cli`).

## After install

- [Quickstart](/docs/quickstart) walks through the setup wizard.
- [Auth modes](/docs/auth) explains the three options (trusted-LAN, shared-secret, real-auth).
- [APK + push notifications](/docs/apk) gets you mobile push.

## Updating

```bash
claw-hq doctor   # check current version + reachability
npm update -g @claw-hq/cli   # or docker pull claw-hq/claw-hq:latest
```

The in-app **Settings → Updates** tab shows an install-method-aware upgrade command and a "Check for updates" button. There is no background telemetry — the version check only runs when you click it.
