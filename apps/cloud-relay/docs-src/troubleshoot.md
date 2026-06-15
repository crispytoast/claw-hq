---
title: Troubleshooting
description: Common gotchas and how to fix them.
---

# Troubleshooting

## "Tunnel offline" in the chat header

The relay can't reach OpenClaw's Gateway. Check:

```bash
openclaw doctor
openclaw gateway status
systemctl --user status openclaw-gateway   # Linux user service
```

If the Gateway is up but Claw HQ still says offline, restart the relay:

```bash
systemctl --user restart claw-hq.service
```

## Push notifications don't arrive

Test in order:

1. **Settings → Notifications → Send test push** — surfaces FCM stderr if the auth path is broken.
2. **Settings → Doctor** — shows the latest `push-sender` log.
3. Confirm the APK registered: in **Settings → Notifications**, the *Devices* list should include your phone with a recent timestamp.
4. Confirm `google-services.json`'s package name is `com.clawhq.app` (matches the APK).

## APK won't install

- Make sure "Install unknown apps" is enabled for your browser / Files app.
- Sometimes Chrome on Android blocks `.apk` over HTTP — visit the HTTPS Tailnet URL instead. The `/install` page shows it when Tailscale Serve is configured.
- The APK is debug-signed by default. Production-signed builds require Play Store registration ($25 one-time) — out of scope for v0.4.

## "Plugin v0.0.13 not loaded yet"

The plugin's gateway methods are registered at startup. After updating the plugin (or installing v0.0.13 for Plugins-tab support), restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

Or kill the `openclaw gateway run` child explicitly. The relay reconnects automatically.

## Chat session doesn't continue across devices

Both devices must use the same session key. Claw HQ's chats derive the session key from the chat id (`agent:main:clawhq-<first8>`) — that's deterministic. The catch: if the agent session ages out of OpenClaw's warm-session cache, the next turn boots a fresh session that won't see prior context. Re-attach project memory by re-asking — the plugin injects `BRIEF.md` + `memory/INDEX.md` as a preamble on the first user message per session.

## `clawhq.health` returns scopes without `operator.admin`

Re-pair the tunnel: `claw-hq pair`. Silent local pairing grants `operator.admin` on first loopback connect, but if your device-identity file moved (e.g. after a fresh install), the gateway issues a new pairing record with read+write only.

## Where to file issues

GitHub: <https://github.com/your-org/claw-hq/issues>. Include `claw-hq doctor` output.
