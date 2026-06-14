#!/usr/bin/env bash
# Enable HTTPS-over-Tailnet for Claw HQ via Tailscale Serve.
#
# Run once on the host that runs claw-hq.service. Idempotent — running
# twice doesn't break the existing config (Tailscale dedupes).
#
# After this script, the relay is reachable at:
#   https://<this-host>.<your-tailnet>.ts.net/
# in addition to the existing http://<tailnet-ip>:3838/ endpoint. The
# bare-HTTP one keeps working — Tailscale Serve doesn't replace it.

set -euo pipefail

PORT="${CLAW_HQ_PORT:-3838}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found in PATH." >&2
  echo "Install from https://tailscale.com/download then re-run." >&2
  exit 1
fi

if ! tailscale status >/dev/null 2>&1; then
  echo "tailscale isn't logged in. Run \`sudo tailscale up\` first." >&2
  exit 1
fi

# Tailscale Serve needs either root or the operator flag pointed at $USER.
# This is the only sudo step.
if ! tailscale serve status >/dev/null 2>&1; then
  echo "Granting tailscale Serve permission to $USER (one-time, requires sudo)..."
  sudo tailscale set --operator="$USER"
fi

echo "Enabling tailscale serve for http://localhost:${PORT} ..."
tailscale serve --bg "http://localhost:${PORT}"

echo
echo "Done. New HTTPS URL:"
tailscale status --json | python3 -c '
import json, sys
s = json.load(sys.stdin)
name = (s.get("Self") or {}).get("DNSName", "").rstrip(".")
print(f"  https://{name}/" if name else "  (could not resolve tailnet DNS name)")
'
