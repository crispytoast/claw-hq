/**
 * Cloud Relay configuration.
 *
 * The CLI's `init` wizard writes a config file at $CLAW_HQ_CONFIG (default
 * ~/.claw-hq/config.json). The relay reads it at startup. Three auth modes
 * are supported; each maps to a different deployment shape.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

export type AuthMode = "trusted-lan" | "shared-secret" | "real-auth";

export interface ClawHqConfig {
  /** TCP port the relay HTTP+WS server binds to. */
  port: number;
  /** Bind interface. "127.0.0.1" for local-only; "0.0.0.0" for LAN/Tailnet. */
  host: string;
  /** Public URL shown to the user in install / pairing instructions. */
  publicUrl: string;
  /** What this process runs. Single-host runs both; split deployments run one. */
  run: { relay: boolean; tunnel: boolean };
  /** Auth strategy for the browser client. */
  auth: {
    mode: AuthMode;
    /** bcrypt hash of the shared passphrase (mode: shared-secret only). */
    sharedSecretHash?: string;
  };
  /** Tunnel config (only needed if run.tunnel is true). */
  tunnel?: {
    /** "in-process" means the CLI auto-wires it to the local relay over loopback. */
    relayUrl: string | "in-process";
    /** Pairing token (auto-generated in single-host; user-provided in split-host). */
    pairingToken?: string;
    /** Path to OpenClaw's config file (Gateway URL + token are auto-read from it). */
    openclawConfigPath: string;
  };
  /** Data directory (SQLite, cookie secret, etc). */
  dataDir: string;
  /** Where the built web SPA lives. */
  webDistPath: string;
}

export interface ResolvedConfig extends ClawHqConfig {
  dbPath: string;
  cookieSecret: string;
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".claw-hq", "config.json");

export function configPath(): string {
  return process.env.CLAW_HQ_CONFIG ?? DEFAULT_CONFIG_PATH;
}

/** Default config: single-host, trusted-LAN, both relay + tunnel in one process. */
export function defaultConfig(): ClawHqConfig {
  const port = Number(process.env.CLAW_HQ_PORT ?? 3838);
  const dataDir = resolve(process.env.CLAW_HQ_DATA_DIR ?? resolve(homedir(), ".claw-hq"));
  return {
    port,
    host: "127.0.0.1",
    publicUrl: `http://localhost:${port}`,
    run: { relay: true, tunnel: true },
    auth: { mode: "trusted-lan" },
    tunnel: {
      relayUrl: "in-process",
      openclawConfigPath: resolve(homedir(), ".openclaw", "openclaw.json"),
    },
    dataDir,
    webDistPath: resolve(process.env.CLAW_HQ_WEB_DIST ?? `${process.cwd()}/apps/web/dist`),
  };
}

export function readConfig(): ClawHqConfig {
  const path = configPath();
  if (!existsSync(path)) return defaultConfig();
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ClawHqConfig>;
  return { ...defaultConfig(), ...raw, auth: { ...defaultConfig().auth, ...(raw.auth ?? {}) }, run: { ...defaultConfig().run, ...(raw.run ?? {}) } };
}

export function writeConfig(c: ClawHqConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/** Resolve runtime details (data dir, cookie secret) that aren't in the user-edited config. */
export function resolveConfig(c: ClawHqConfig = readConfig()): ResolvedConfig {
  mkdirSync(c.dataDir, { recursive: true });
  const secretPath = resolve(c.dataDir, "cookie.secret");
  let cookieSecret: string;
  if (existsSync(secretPath)) {
    cookieSecret = readFileSync(secretPath, "utf-8").trim();
  } else {
    cookieSecret = randomBytes(32).toString("hex");
    writeFileSync(secretPath, cookieSecret + "\n", { mode: 0o600 });
  }
  return { ...c, dbPath: resolve(c.dataDir, "claw-hq.db"), cookieSecret };
}

/** Sanity check that a path exists; used by setup wizard to verify openclaw config. */
export function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
