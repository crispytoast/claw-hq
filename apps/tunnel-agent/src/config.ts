/**
 * Tunnel agent config: pairing token + relay URL. Optional openclaw config
 * path override (defaults to ~/.openclaw/openclaw.json).
 *
 * Persisted to ./config.json by the `pair` CLI; never committed (see .gitignore).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = resolve(HERE, "..", "config.json");

export interface TunnelConfig {
  pairingToken: string;
  /** ws://host:port (no path) — agent appends /ws/agent?token=... */
  relayUrl: string;
  /** Path to OpenClaw's config file; ~ is expanded. */
  openclawConfigPath: string;
}

const DEFAULTS = {
  relayUrl: "ws://localhost:3838",
  openclawConfigPath: "~/.openclaw/openclaw.json",
};

export function loadConfigOrExit(): TunnelConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[tunnel] config not found at ${CONFIG_PATH}`);
    console.error("[tunnel] run: claw-hq pair <pairing-token>");
    process.exit(2);
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<TunnelConfig>;
    if (typeof raw.pairingToken !== "string" || raw.pairingToken.length === 0) {
      throw new Error("pairingToken missing");
    }
    return {
      pairingToken: raw.pairingToken,
      relayUrl: typeof raw.relayUrl === "string" && raw.relayUrl.length > 0 ? raw.relayUrl : DEFAULTS.relayUrl,
      openclawConfigPath:
        typeof raw.openclawConfigPath === "string" && raw.openclawConfigPath.length > 0
          ? raw.openclawConfigPath
          : DEFAULTS.openclawConfigPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tunnel] config invalid at ${CONFIG_PATH}: ${msg}`);
    process.exit(2);
  }
}

export function writeConfig(c: TunnelConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
