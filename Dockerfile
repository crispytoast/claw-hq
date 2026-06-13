# Claw HQ — single-image distribution.
#
# Usage:
#   docker build -t claw-hq .
#   docker run -d --name claw-hq \
#     -p 3838:3838 \
#     -v ~/.claw-hq:/data \
#     -v ~/.openclaw:/openclaw:ro \
#     claw-hq
#
# OpenClaw must run on the host (or another container) — this image talks to
# its Gateway over the network or via the mounted config. For single-host
# deployments, expose OpenClaw's Gateway port and set:
#   -e OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789
#
# The image runs the CLI's `start` command. Override CMD to use `init` or
# `pair` interactively:
#   docker run -it --rm -v ~/.claw-hq:/data claw-hq claw-hq init

FROM node:22-bookworm-slim AS base

# better-sqlite3 ships prebuilt binaries for linux/x64; arm64 may need build deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.6.0

WORKDIR /app

# Copy manifests first for better Docker layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/
COPY apps/cloud-relay/package.json ./apps/cloud-relay/
COPY apps/tunnel-agent/package.json ./apps/tunnel-agent/
COPY apps/web/package.json ./apps/web/
COPY packages/protocol-types/package.json ./packages/protocol-types/

RUN pnpm install --frozen-lockfile

# Copy sources + build the SPA.
COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @claw-hq/web build

# ---- Runtime image ----
FROM base AS runtime

ENV CLAW_HQ_DATA_DIR=/data \
    CLAW_HQ_WEB_DIST=/app/apps/web/dist \
    CLAW_HQ_PORT=3838

VOLUME ["/data"]
EXPOSE 3838

# Default config baked in: trusted-lan, 0.0.0.0 bind, in-process relay+tunnel,
# OpenClaw config expected at /openclaw/openclaw.json (mount as -v).
COPY <<'JSON' /etc/claw-hq/default-config.json
{
  "port": 3838,
  "host": "0.0.0.0",
  "publicUrl": "http://localhost:3838",
  "run": { "relay": true, "tunnel": true },
  "auth": { "mode": "trusted-lan" },
  "tunnel": {
    "relayUrl": "in-process",
    "openclawConfigPath": "/openclaw/openclaw.json"
  },
  "dataDir": "/data",
  "webDistPath": "/app/apps/web/dist"
}
JSON

# Seed config on first run if /data is empty.
COPY <<'SH' /usr/local/bin/claw-hq-entrypoint.sh
#!/usr/bin/env sh
set -e
if [ ! -f /data/config.json ]; then
  mkdir -p /data
  cp /etc/claw-hq/default-config.json /data/config.json
  echo "[claw-hq] seeded default config at /data/config.json"
fi
export CLAW_HQ_CONFIG=/data/config.json
exec "$@"
SH
RUN chmod +x /usr/local/bin/claw-hq-entrypoint.sh

# A friendly `claw-hq` command in PATH.
RUN ln -s /app/apps/cli/bin/claw-hq.mjs /usr/local/bin/claw-hq && \
    chmod +x /app/apps/cli/bin/claw-hq.mjs

# The CLI binary uses dist/, so make sure it's compiled.
RUN pnpm --filter @claw-hq/cli build || true

ENTRYPOINT ["/usr/local/bin/claw-hq-entrypoint.sh"]
CMD ["pnpm", "--filter", "@claw-hq/cli", "start"]
