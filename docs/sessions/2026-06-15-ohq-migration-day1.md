# 2026-06-15 — OHQ → Claw HQ migration, Day 1

Day 1 of the locked 5-phase OHQ migration: lock the door, then open it.

## Goals

1. Flip auth from `trusted-lan` → `shared-secret` so the relay isn't world-readable.
2. Enable Tailscale Funnel so Claw HQ is reachable off-tailnet from anywhere.
3. Repoint the Android APK at the HTTPS funnel URL so it works on cellular.

## Step 1 — auth flip (trusted-lan → shared-secret)

Pre-flip state: `auth.mode: "trusted-lan"`, anyone on `100.88.29.65:3838` was auto-`owner`. Push devices already registered under `user_id="owner"`, so shared-secret (which keeps that identity via `uid === "owner"`) was the right pick over real-auth (which would have assigned a UUID and silently broken push).

Two iterations on the SPA path:

- First pass shipped a backend bcrypt helper (`scripts/set-shared-secret.mjs`) Frank could run from the shell. He came back: "this has to work for every Claw HQ user — and remote-friendly." Right call.
- Second pass moved the flip into the in-app **Settings → Auth** tab. `/api/auth/login` + `/api/auth/signup` are now always-registered and branch on `config.auth.mode` at request time so a hot-flip via `POST /api/auth/mode` takes effect on the next request without a restart.

### New routes (`apps/cloud-relay/src/auth.ts`)

- `GET /api/auth/mode` — `{mode, hasPassphrase}`. Open.
- `POST /api/auth/mode` — owner-auth gated. Body `{passphrase}` (min 12 chars). bcrypts, calls `persistAuthChange()`, mutates in-memory config. While in trusted-lan, resolveOwner auto-passes so the first flip works without auth; post-flip the route requires the cookie, which makes rotation safe.
- `POST /api/auth/login` — branch at request time. Trusted-lan returns 400 ("not applicable"), shared-secret takes `{password}`, real-auth takes `{email, password}`.
- `POST /api/auth/signup` — real-auth only; other modes 400.

### SPA

- `apps/web/src/components/Login.tsx` rewritten as a mode-aware shell — passphrase-only when `shared-secret`, email+password when `real-auth`.
- `apps/web/src/App.tsx` calls `api.detectAuthMode()` on 401 (and on logout) so the login form matches the relay's mode.
- New `apps/web/src/components/settings/SettingsAuthTab.tsx` — current-mode display, passphrase + confirm form, SudoGate-protected, auto-reload 800 ms after first flip so the user lands cleanly on the new login screen.
- `apps/web/src/api.ts` — `detectAuthMode()`, `getAuthMode()`, `setSharedSecret()`, `loginSharedSecret()`.

### Bug surfaced + fixed in this session

`<SudoGate />` was only mounted inside the chat-screen tree (`ChatApp.tsx:487`). When `showSettings === true`, ChatApp early-returned just `<Settings />` — so the sudo modal singleton wasn't mounted, and `requireSudo()` dispatched an event nothing listened for. Symptom: clicking "Switch to shared-secret" did nothing.

This bug also masked the existing **Plugins-install** and **Pairing-revoke** gates (per the Phase C step 32 inventory) — none of them would have ever worked from inside Settings. Fix: wrap each early-return in a fragment that also renders `<SudoGate />`.

### Tests

- `apps/cloud-relay/scripts/phaseM1-auth-flip-test.mjs` — 17 assertions on the helper script (env-var + stdin paths, bcrypt round-trip, too-short rejected, rotation, existing config fields preserved). All green.
- `apps/cloud-relay/scripts/phaseM2-auth-mode-route-test.mjs` — 24 assertions on the in-UI route, in-process via `fastify.inject()`. Covers: trusted-lan → 200 flip, post-flip 401 carries mode, login wrong/right, cookie issuance, `/api/auth/me` with cookie, rotate-with-cookie, old-passphrase-rejected-after-rotation, short passphrase 400, disk reflects shared-secret. All green.

## Step 2 — Tailscale Funnel

`tailscale serve` was already configured (HEAD `a4b57be` from step 23). Just needed `tailscale funnel --bg 3838`. Status flipped from "(tailnet only)" to "Funnel on". Same URL — `https://jesse-legion-7-16irx9.tail9bb12b.ts.net` — works both on-tailnet (direct) and off-tailnet (through Tailscale's funnel edges).

Verified live over HTTPS: `/api/auth/me` 401s with `mode:"shared-secret"`, `/api/auth/mode` returns `{mode, hasPassphrase:true}`, `/install/apk` HEADs as 2.4 MB `application/vnd.android.package-archive`. Frank's off-tailnet browser test on cellular: ✓.

## Step 3 — APK URL repoint

APK 0.4.7 was already built at `/install/apk` (step 34). Reinstall flow: uninstall existing app (Android keeps SharedPreferences across reinstalls), download from `<funnel>/install`, install, enter HTTPS URL at first-launch setup screen. Frank reported "everything went perfectly" — probe succeeded, WebView loaded shared-secret login over HTTPS, push re-registered.

## Bookmarked for after migration cutover

Saved in `memory/project_claw_hq_post_migration_followups.md`:

1. **Rate-limit `/api/auth/login` + brute-force defense** — the funnel URL is now indexed by Let's Encrypt CT logs. bcrypt is slow but not a silver bullet. Token-bucket per IP, optional TOTP, optional IP allowlist.
2. **"Change relay URL" UI in the APK** — currently requires uninstall to repoint. Generic JS bridge + Settings button is the proper fix.

Neither blocks migration cutover; surface when Frank asks "what's next" or hits a related topic.

## Files

```
A  apps/cloud-relay/scripts/phaseM1-auth-flip-test.mjs
A  apps/cloud-relay/scripts/phaseM2-auth-mode-route-test.mjs
A  apps/cloud-relay/scripts/set-shared-secret.mjs
A  apps/web/src/components/settings/SettingsAuthTab.tsx
A  docs/sessions/2026-06-15-ohq-migration-day1.md
M  apps/cloud-relay/src/auth.ts
M  apps/cloud-relay/src/config.ts
M  apps/web/src/App.tsx
M  apps/web/src/api.ts
M  apps/web/src/components/ChatApp.tsx
M  apps/web/src/components/Login.tsx
M  apps/web/src/components/Settings.tsx
```

41 smoke assertions total across M1 + M2, all green. APK 0.4.7 unchanged (no Kotlin work this batch).

## Next on resume — Day 2

OHQ chat schema probe (read-only — never edit `/home/jesse/oswald-hq/`) → `claw-hq import-ohq` CLI command (generic source-dir override, not hardcoded to Frank's box) → dry-run → live import on Frank's go. See `memory/project_claw_hq_ohq_migration.md` for the locked plan.
