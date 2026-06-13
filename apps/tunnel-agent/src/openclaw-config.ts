/**
 * Read OpenClaw's local config to discover the Gateway URL + shared-secret
 * token. The tunnel agent uses these to dial the local Gateway.
 *
 * The user never has to copy/paste the token — we read it from the same file
 * the OpenClaw CLI uses.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface OpenClawDiscovery {
  gatewayUrl: string;
  gatewayToken: string;
}

interface OpenClawConfigFile {
  gateway?: {
    port?: number;
    bind?: string;
    auth?: {
      mode?: "none" | "token" | "password" | "trusted-proxy";
      token?: string;
      password?: string;
    };
  };
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

export function discoverOpenClaw(configPath: string): OpenClawDiscovery {
  const expanded = expandHome(configPath);
  const raw = readFileSync(expanded, "utf-8");
  const parsed = JSON.parse(raw) as OpenClawConfigFile;
  const port = parsed.gateway?.port ?? 18789;
  const token = parsed.gateway?.auth?.token;
  if (!token || typeof token !== "string") {
    throw new Error(`openclaw config at ${expanded} has no gateway.auth.token`);
  }
  return {
    gatewayUrl: `ws://127.0.0.1:${port}`,
    gatewayToken: token,
  };
}
