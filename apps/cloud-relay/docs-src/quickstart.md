---
title: Quickstart
description: First-run walkthrough.
---

# Quickstart

You should be 5 minutes away from a working chat. If not, hop into [troubleshooting](/docs/troubleshoot).

## 0. Have OpenClaw running

Claw HQ is a UI for OpenClaw. If you don't have OpenClaw installed, the web app's first-run wizard will walk you through that step — but for the impatient:

```bash
npm install -g openclaw       # or brew install openclaw, or via Docker
openclaw init                 # create ~/.openclaw/openclaw.json
openclaw gateway run --background
```

## 1. Install Claw HQ

See [install](/docs/install). Quickest path on Linux/macOS:

```bash
curl -fsSL https://claw-hq.dev/install.sh | sh
```

## 2. Run the setup wizard

```bash
claw-hq init
```

The wizard asks you four things:

1. **OpenClaw config path** — defaults to `~/.openclaw/openclaw.json`.
2. **Auth mode** — `trusted-lan` (no password) / `shared-secret` (one passphrase) / `real-auth` (email + password). See [auth modes](/docs/auth).
3. **Port** — defaults to `3838`.
4. **Public URL** — the URL you'll point your phone APK at. Defaults to your Tailnet hostname if Tailscale is running, otherwise `http://<host-ip>:<port>`.

The wizard writes `~/.claw-hq/config.json` and seeds default app secrets.

## 3. Start the relay

```bash
claw-hq start
```

The CLI launches the relay and tunnel in one process. On Linux you can install a systemd user service:

```bash
claw-hq install-service        # adds ~/.config/systemd/user/claw-hq.service
systemctl --user enable --now claw-hq.service
loginctl enable-linger $USER   # so the service survives logout / reboot
```

## 4. Open the web app

Browse to the relay's URL (default `http://localhost:3838/`). If your auth mode is `trusted-lan` you'll be straight in.

## 5. (Optional) Install the APK

See [APK + push notifications](/docs/apk).

## 6. Browse the docs from inside

Every relay serves these docs at `/docs`. You don't need to come back here to refer to anything.
