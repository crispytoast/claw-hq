---
title: APK + push notifications
description: Install the Android APK and wire up FCM push.
---

# APK + push notifications

The native APK lives at `/install` on every Claw HQ relay. Open it on the phone you want to pair.

## Install the APK

From your phone's browser, visit `<your-relay-url>/install`. The page detects whether you've enabled Tailscale Serve and surfaces the HTTPS URL when available. Tap the download link, then sideload — Chrome / Files app will ask for "Install unknown apps" permission the first time.

## What the APK does

- Renders the same SPA inside a WebView pointed at your relay
- Registers an FCM device token with the relay via `POST /api/push/devices`
- Receives push notifications when:
  - An `agent` run reaches `phase: end` in any session
  - `exec.approval.requested` fires for a command that needs human go-ahead
- Self-updates via `PackageInstaller` — when you ship a new APK, the existing one downloads + installs the upgrade in place

## Set up Firebase

Push is per-user — each Claw HQ install binds **its own** Firebase project. There's no shared push backend.

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com).
2. Add an Android app to that project with package name `com.clawhq.app`.
3. Download `google-services.json`.
4. In Firebase, create a service account JSON key under **Project settings → Service accounts → Generate new private key**.
5. In Claw HQ, open **Settings → Notifications** and upload both files. The relay stores them under `~/.claw-hq/push-config.json` with mode 0600. The service-account JSON is never returned to the UI after upload.

The APK pulls `google-services.json` from `/api/push/init` at launch, so one APK works for every Claw HQ user — no per-user APK build.

## Test the path

Open **Settings → Notifications → Send test push**. The relay JWT-signs a request via the stored service account, calls FCM HTTP v1, and you should see a notification land within a couple seconds. If not, check `Settings → Doctor` for stderr from the last attempt.

## Pair a phone as a camera/mic node

Different feature, same APK. See [Nodes](/docs/nodes).
