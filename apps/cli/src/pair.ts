/**
 * `claw-hq pair <pairing-token> [--relay <ws-url>]`
 *
 * Writes ~/.claw-hq/config.json for a SPLIT-process deployment, where this
 * machine runs just the tunnel and the relay lives elsewhere.
 *
 * (Single-host setups don't need this — `claw-hq init` handles them.)
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readConfig, writeConfig, pathExists } from "@claw-hq/cloud-relay/config";
import { discoverOpenClaw } from "@claw-hq/tunnel-agent/openclaw-config";

interface ParsedArgs {
  token: string;
  relayUrl?: string;
  openclawConfigPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return null;
  let token = "";
  let relayUrl: string | undefined;
  let openclawConfigPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--relay") {
      relayUrl = argv[++i];
    } else if (a === "--openclaw-config") {
      openclawConfigPath = argv[++i];
    } else if (a && !a.startsWith("-")) {
      token = a;
    }
  }
  if (!token) return null;
  return { token, relayUrl, openclawConfigPath };
}

export function pair(argv: string[]): void {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.log("Usage: claw-hq pair <pairing-token> [--relay <ws-url>] [--openclaw-config <path>]\n");
    console.log("Get a pairing token from your remote Claw HQ relay's web UI.");
    console.log("--relay defaults to ws://localhost:3838.");
    console.log("--openclaw-config defaults to ~/.openclaw/openclaw.json.");
    process.exit(parsed === null ? 0 : 2);
  }

  const openclawConfigPath = parsed.openclawConfigPath ?? resolve(homedir(), ".openclaw", "openclaw.json");
  if (!pathExists(openclawConfigPath)) {
    console.error(`✗ OpenClaw config not found at ${openclawConfigPath}`);
    console.error("  Install OpenClaw first (https://docs.openclaw.ai) and ensure the Gateway is running.");
    process.exit(2);
  }

  try {
    const discovery = discoverOpenClaw(openclawConfigPath);
    console.log(`✓ Discovered local OpenClaw Gateway at ${discovery.gatewayUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Cannot read OpenClaw config: ${msg}`);
    process.exit(2);
  }

  const existing = readConfig();
  existing.run = { relay: false, tunnel: true };
  existing.tunnel = {
    relayUrl: parsed.relayUrl ?? "ws://localhost:3838",
    pairingToken: parsed.token,
    openclawConfigPath,
  };
  writeConfig(existing);
  console.log("✓ Wrote tunnel config to ~/.claw-hq/config.json");
  console.log("\nStart the tunnel with: claw-hq start");
}
