/**
 * Read OpenClaw's local config to discover the Gateway URL + shared-secret
 * token. Mirrors the tunnel-agent's discoverer so the relay can probe
 * OpenClaw without requiring the tunnel package as a hard dep.
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
    auth?: { token?: string };
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
  if (!token) throw new Error(`gateway.auth.token missing in ${expanded}`);
  return { gatewayUrl: `ws://127.0.0.1:${port}`, gatewayToken: token };
}
