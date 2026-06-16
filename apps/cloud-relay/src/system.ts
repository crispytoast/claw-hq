/**
 * /api/system/* endpoints — version info, update check, OpenClaw status,
 * Firebase / push notification config storage.
 *
 * These power the Settings tab. Most endpoints are read-only or store user-
 * uploaded config; nothing fetches anything external automatically except the
 * version-check endpoint, which the user explicitly triggers.
 */
import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync, existsSync, promises as fsp, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { WebSocket } from "ws";
import { resolveOwner } from "./auth.js";
import type { ResolvedConfig } from "./config.js";
import { discoverOpenClaw } from "./openclaw-discovery.js";
import { CLAW_HQ_VERSION, DEFAULT_RELEASES_URL } from "./version.js";

const execP = promisify(exec);

// Re-export so existing imports keep working.
export { CLAW_HQ_VERSION } from "./version.js";

interface SystemDeps {
  db: Database.Database;
  config: ResolvedConfig;
}

interface PushConfig {
  /** Firebase project id (e.g. "my-claw-hq"). */
  projectId: string;
  /** android google-services.json contents (relay returns to APK on /api/push/config). */
  googleServicesJson?: Record<string, unknown>;
  /** Service-account JSON for server-side FCM sending (kept private to the relay). */
  serviceAccountJson?: Record<string, unknown>;
  /** When the user uploaded this. */
  updatedAt: number;
}

function pushConfigPath(config: ResolvedConfig): string {
  return resolve(config.dataDir, "push-config.json");
}

function readPushConfig(config: ResolvedConfig): PushConfig | null {
  const path = pushConfigPath(config);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PushConfig;
  } catch {
    return null;
  }
}

function writePushConfig(config: ResolvedConfig, pc: PushConfig): void {
  writeFileSync(pushConfigPath(config), JSON.stringify(pc, null, 2) + "\n", { mode: 0o600 });
}

/** Strip the service-account JSON before returning to the UI — never expose private keys. */
function publicPushConfig(pc: PushConfig | null): { configured: boolean; projectId?: string; updatedAt?: number } {
  if (!pc) return { configured: false };
  return { configured: true, projectId: pc.projectId, updatedAt: pc.updatedAt };
}

// ---------------- /api/system/health helpers (Linux /proc + nvidia-smi) ----------------
// Ported from oswald-hq/src/app/api/system/health/route.ts. Strictly read-only —
// no secrets surface here; the values are CPU/RAM/Disk/GPU utilization stats.

type CpuSample = { total: number; idle: number };
let prevCpuSample: CpuSample | null = null;

function parseCpuLine(line: string): CpuSample {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // /proc/stat: user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

async function readCpuLine(): Promise<CpuSample | null> {
  try {
    const data = await fsp.readFile("/proc/stat", "utf8");
    const line = data.split("\n").find((l) => l.startsWith("cpu "));
    return line ? parseCpuLine(line) : null;
  } catch {
    return null;
  }
}

async function cpuUsage(): Promise<number | null> {
  const cur = await readCpuLine();
  if (!cur) return null;
  if (!prevCpuSample) {
    prevCpuSample = cur;
    await new Promise((r) => setTimeout(r, 120));
    const cur2 = await readCpuLine();
    if (!cur2) return null;
    const dt = cur2.total - cur.total;
    const di = cur2.idle - cur.idle;
    prevCpuSample = cur2;
    return dt > 0 ? Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100))) : 0;
  }
  const dt = cur.total - prevCpuSample.total;
  const di = cur.idle - prevCpuSample.idle;
  prevCpuSample = cur;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
}

async function cpuTemp(): Promise<number | null> {
  try {
    const dirs = await fsp.readdir("/sys/class/hwmon");
    for (const d of dirs) {
      try {
        const name = (await fsp.readFile(`/sys/class/hwmon/${d}/name`, "utf8")).trim();
        if (name !== "coretemp" && name !== "k10temp" && name !== "zenpower") continue;
        const raw = (await fsp.readFile(`/sys/class/hwmon/${d}/temp1_input`, "utf8")).trim();
        const c = Number(raw) / 1000;
        return Number.isFinite(c) ? Math.round(c) : null;
      } catch { /* try next */ }
    }
  } catch { /* hwmon unavailable */ }
  return null;
}

async function memInfo(): Promise<{ used: number; total: number } | null> {
  try {
    const data = await fsp.readFile("/proc/meminfo", "utf8");
    const grab = (k: string) => {
      const m = data.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = grab("MemTotal");
    const avail = grab("MemAvailable");
    if (total === null || avail === null) return null;
    return { used: total - avail, total };
  } catch {
    return null;
  }
}

interface GpuInfo { load: number; temp: number; vramUsed: number; vramTotal: number; }
async function gpuInfo(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execP(
      "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 1500 },
    );
    const first = stdout.split("\n").find((l) => l.trim().length > 0);
    if (!first) return null;
    const parts = first.split(",").map((s) => Number(s.trim()));
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [load, temp, used, total] = parts as [number, number, number, number];
    return { load, temp, vramUsed: used * 1024 * 1024, vramTotal: total * 1024 * 1024 };
  } catch {
    return null;
  }
}

function diskInfo(): { used: number; total: number } | null {
  try {
    const s = statfsSync("/");
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { used: total - free, total };
  } catch {
    return null;
  }
}

export async function registerSystemRoutes(fastify: FastifyInstance, deps: SystemDeps): Promise<void> {
  const { db, config } = deps;

  // ---------------- /api/system/health — PC vitals strip ----------------
  // Owner-gated since the Funnel URL is public. CPU/RAM/Disk/GPU stats aren't
  // secrets but leaking them off-tailnet to anyone with the URL adds nothing.
  fastify.get("/api/system/health", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const [cpu, cpuT, ram, gpu] = await Promise.all([
      cpuUsage(), cpuTemp(), memInfo(), gpuInfo(),
    ]);
    const disk = diskInfo();
    return { cpu: { usage: cpu, temp: cpuT }, ram, gpu, disk, ts: Date.now() };
  });

  // ---------------- version + update check ----------------
  fastify.get("/api/system/version", async (_req) => {
    return {
      current: CLAW_HQ_VERSION,
      // Latest is discovered by the in-app "Check for updates" button which
      // calls /api/system/version/check. We don't auto-poll on startup.
      latest: null,
      installMethod: detectInstallMethod(),
    };
  });

  fastify.post("/api/system/version/check", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    // When the project is published, this will hit GitHub releases:
    //   https://api.github.com/repos/<owner>/claw-hq/releases/latest
    // Until then, just confirm we're current.
    try {
      const releasesUrl = process.env.CLAW_HQ_RELEASES_URL ?? DEFAULT_RELEASES_URL;
      if (!releasesUrl) {
        return {
          current: CLAW_HQ_VERSION,
          latest: CLAW_HQ_VERSION,
          updateAvailable: false,
          note: "Update check disabled — set CLAW_HQ_RELEASES_URL to enable.",
        };
      }
      const res = await fetch(releasesUrl, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: string; html_url?: string };
      const latest = (body.tag_name ?? "").replace(/^v/, "");
      return {
        current: CLAW_HQ_VERSION,
        latest,
        updateAvailable: latest !== CLAW_HQ_VERSION && latest.length > 0,
        releaseUrl: body.html_url ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(502);
      return { error: `update check failed: ${msg}` };
    }
  });

  // ---------------- OpenClaw daemon status (read-only) ----------------
  fastify.get("/api/system/openclaw", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const ocPath = config.tunnel?.openclawConfigPath ?? `${process.env.HOME}/.openclaw/openclaw.json`;
    if (!existsSync(ocPath)) {
      return { installed: false, configPath: ocPath };
    }
    let gatewayUrl = "";
    try {
      gatewayUrl = discoverOpenClaw(ocPath).gatewayUrl;
    } catch {
      return { installed: true, configPath: ocPath, reachable: false, error: "config unreadable" };
    }
    // Probe the Gateway WS.
    const reachable = await probeGateway(gatewayUrl);
    return { installed: true, configPath: ocPath, gatewayUrl, reachable };
  });

  // ---------------- push notification config ----------------
  fastify.get("/api/system/push/config", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    return publicPushConfig(readPushConfig(config));
  });

  // Used by the APK to fetch its Firebase init params (no service account exposed).
  fastify.get("/api/push/init", async (_req, reply) => {
    const pc = readPushConfig(config);
    if (!pc || !pc.googleServicesJson) {
      reply.code(404);
      return { error: "push not configured" };
    }
    return { projectId: pc.projectId, googleServicesJson: pc.googleServicesJson };
  });

  fastify.post<{
    Body: {
      projectId?: string;
      googleServicesJson?: Record<string, unknown>;
      serviceAccountJson?: Record<string, unknown>;
    };
  }>("/api/system/push/config", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    if (!projectId) {
      reply.code(400);
      return { error: "projectId required" };
    }
    const existing = readPushConfig(config);
    const updated: PushConfig = {
      projectId,
      googleServicesJson: req.body?.googleServicesJson ?? existing?.googleServicesJson,
      serviceAccountJson: req.body?.serviceAccountJson ?? existing?.serviceAccountJson,
      updatedAt: Date.now(),
    };
    writePushConfig(config, updated);
    return publicPushConfig(updated);
  });

  fastify.delete("/api/system/push/config", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const path = pushConfigPath(config);
    if (existsSync(path)) {
      writeFileSync(path, JSON.stringify({}, null, 2) + "\n", { mode: 0o600 });
    }
    return { ok: true };
  });
}

function detectInstallMethod(): "npm" | "docker" | "source" | "unknown" {
  if (process.env.CLAW_HQ_INSTALL_METHOD === "docker") return "docker";
  if (process.env.CLAW_HQ_INSTALL_METHOD === "npm") return "npm";
  if (existsSync("/.dockerenv")) return "docker";
  // Default to source/dev — once published to npm, the install script sets the env var.
  return "source";
}

async function probeGateway(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(false);
    }, 2000);
    ws.on("open", () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(true);
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
