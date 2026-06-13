# Claw HQ — Android shell

Minimal WebView + FCM Android app. The same APK works for every user — on first
launch, you enter the URL of your own Claw HQ relay (e.g. `http://100.88.29.65:3838`).
The app fetches your Firebase project init params from `GET /api/push/init`,
initializes the Firebase SDK programmatically, and registers its FCM token with
`POST /api/push/devices` so the relay can push to it.

Push notifications fire whenever the OpenClaw Gateway emits an `agent` lifecycle
end event or `exec.approval.requested`. See `apps/cloud-relay/src/ws-routing.ts`.

## Building

JDK 17 + Android SDK required. From this directory:

```sh
./build.sh
```

The APK lands at `app/build/outputs/apk/release/app-release.apk`. It's signed
with the debug key for v0.4 sideload distribution; proper release signing
comes when we hit Play Store.

## Sideload install

```sh
adb install -r app/build/outputs/apk/release/app-release.apk
```

Or upload to GitHub Releases and download/install from the phone.

## First launch

1. Enter your relay URL (e.g. `http://100.88.29.65:3838`)
2. Tap Continue — app probes `/api/system/version` to verify reachability
3. WebView opens the relay's SPA
4. Push notifications start working as soon as `/api/push/init` returns a
   Firebase config

## Why not a TWA?

TWAs require HTTPS + a public domain + digital-asset-links. Most Claw HQ users
self-host on a Tailnet or LAN where neither is available. A WebView shell with
the same FCM integration works the same on http://, https://, Tailnet,
Cloudflare Tunnel, anywhere.
