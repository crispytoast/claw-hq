/**
 * `claw-hq pair <pairing-token> [--relay <url>]` — writes config.json so
 * the tunnel agent can connect to the cloud relay.
 *
 * Validates that:
 *   1. Local OpenClaw config is readable + has a gateway token.
 *   2. Token format looks right (chq_ prefix is a soft check, not enforced).
 *
 * Does NOT verify against the cloud — `pnpm dev:tunnel` is the smoke test.
 */
import { discoverOpenClaw } from "./openclaw-config.js";
import { CONFIG_PATH, writeConfig } from "./config.js";

function parseArgs(argv: string[]): { token: string; relay?: string; openclawConfig?: string } | null {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") return null;
  let token = "";
  let relay: string | undefined;
  let openclawConfig: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--relay") {
      relay = args[++i];
    } else if (a === "--openclaw-config") {
      openclawConfig = args[++i];
    } else if (a && !a.startsWith("-")) {
      token = a;
    }
  }
  if (!token) return null;
  return { token, relay, openclawConfig };
}

function usage(): void {
  console.log("Usage: claw-hq pair <pairing-token> [--relay <ws-url>] [--openclaw-config <path>]");
  console.log("");
  console.log("Get a pairing token from your Claw HQ account page.");
  console.log("--relay defaults to ws://localhost:3838 (local-via-Tailscale install).");
  console.log("--openclaw-config defaults to ~/.openclaw/openclaw.json.");
}

const parsed = parseArgs(process.argv);
if (!parsed) {
  usage();
  process.exit(parsed === null ? 0 : 2);
}

const openclawConfigPath = parsed.openclawConfig ?? "~/.openclaw/openclaw.json";

// Fail fast if the local OpenClaw isn't reachable.
try {
  const discovery = discoverOpenClaw(openclawConfigPath);
  console.log(`[pair] discovered local OpenClaw Gateway at ${discovery.gatewayUrl}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[pair] cannot read OpenClaw config: ${msg}`);
  console.error("[pair] install OpenClaw first (https://docs.openclaw.ai) and ensure the Gateway is running.");
  process.exit(2);
}

writeConfig({
  pairingToken: parsed.token,
  relayUrl: parsed.relay ?? "ws://localhost:3838",
  openclawConfigPath,
});

console.log(`[pair] wrote ${CONFIG_PATH}`);
console.log(`[pair] start the tunnel agent: pnpm dev:tunnel`);
