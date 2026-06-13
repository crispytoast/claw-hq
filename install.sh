#!/usr/bin/env sh
# Claw HQ install script. Installs Node.js if missing, then npm-installs
# the Claw HQ CLI globally.
#
# Usage:
#   curl -fsSL https://claw-hq.example/install.sh | sh
#
# Honors:
#   CLAW_HQ_VERSION=0.0.1  (default: latest)
#   CLAW_HQ_NODE_VERSION=22 (default: 22)

set -e

NODE_MIN_MAJOR=22
CLAW_HQ_VERSION="${CLAW_HQ_VERSION:-latest}"

log() { printf "\033[36m[claw-hq]\033[0m %s\n" "$1"; }
err() { printf "\033[31m[claw-hq]\033[0m %s\n" "$1" >&2; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing command: $1"; return 1
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

install_node() {
  log "Node $NODE_MIN_MAJOR+ not found. Installing via NodeSource..."
  if [ "$(id -u)" -ne 0 ]; then
    err "Node install requires root. Re-run with: curl -fsSL ... | sudo sh"
    err "Or install Node $NODE_MIN_MAJOR+ manually and re-run this script."
    exit 1
  fi
  case "$(uname -s)" in
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
        apt-get install -y nodejs
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y "nodejs${NODE_MIN_MAJOR}"
      else
        err "Unsupported Linux distribution. Install Node $NODE_MIN_MAJOR+ manually."
        exit 1
      fi
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install "node@${NODE_MIN_MAJOR}"
      else
        err "Install Homebrew or Node $NODE_MIN_MAJOR+ manually, then re-run."
        exit 1
      fi
      ;;
    *)
      err "Unsupported OS: $(uname -s). Install Node $NODE_MIN_MAJOR+ manually."
      exit 1
      ;;
  esac
}

main() {
  need_cmd curl || exit 1

  if ! node_ok; then
    install_node
    node_ok || { err "Node install failed."; exit 1; }
  fi
  log "Using Node $(node -v)"

  log "Installing @claw-hq/cli@${CLAW_HQ_VERSION}..."
  npm install -g "@claw-hq/cli@${CLAW_HQ_VERSION}"
  log "Installed: $(claw-hq help | head -1)"

  log "Next: run 'claw-hq init' to configure Claw HQ for your machine."
}

main "$@"
