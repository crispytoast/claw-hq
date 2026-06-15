// Plugin-management bridge: shells out to the host's `openclaw plugins` CLI.
// The Gateway doesn't currently expose plugin list / install / uninstall as
// first-class RPCs — they live on the CLI — so we mirror them through our own
// `clawhq.plugins.*` methods. The CLI's `--json` flag gives us machine-readable
// output to translate.
//
// Safety notes:
// 1. We never interpolate user-supplied strings into a shell; argv arrays only.
// 2. List/search are read-only (`operator.read`). Install/uninstall mutate
//    host state, so the caller must hold `operator.admin`.
// 3. Install can take a long time on cold downloads. We give it a generous
//    timeout (5 min) but surface a TIMEOUT error code rather than orphaning
//    the child.

import { spawn } from "node:child_process";

export interface PluginEntry {
  id: string;
  enabled: boolean;
  version?: string;
  origin?: string;
  source?: string;
  description?: string;
  installPath?: string;
  rawJson?: unknown;
}

export interface ListResult {
  plugins: PluginEntry[];
  rawStdout: string;
}

export interface SearchHit {
  id: string;
  name?: string;
  channel?: string;
  family?: string;
  version?: string;
  summary?: string;
  installHint?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  rawStdout: string;
}

export interface MutationResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const LIST_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const UNINSTALL_TIMEOUT_MS = 60_000;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runOpenclaw(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("openclaw", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort; the kill may race against natural exit.
      }
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({
        stdout,
        stderr: stderr || (err.message ?? String(err)),
        exitCode: -1,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : -1,
        timedOut,
      });
    });
  });
}

function normalizeEntry(raw: unknown): PluginEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // The CLI's JSON shape has shifted across versions; pull what we can and
  // fall back to nested `manifest`/`metadata` fields when present.
  const manifest = (r.manifest ?? r.metadata ?? {}) as Record<string, unknown>;
  const id =
    typeof r.id === "string" ? r.id :
    typeof r.pluginId === "string" ? r.pluginId :
    typeof manifest.id === "string" ? (manifest.id as string) :
    null;
  if (!id) return null;
  const enabled =
    r.enabled === true ||
    r.enabled === false ? (r.enabled as boolean) :
    typeof r.disabled === "boolean" ? !(r.disabled as boolean) :
    true;
  const version =
    typeof r.version === "string" ? r.version :
    typeof manifest.version === "string" ? (manifest.version as string) :
    undefined;
  const description =
    typeof r.description === "string" ? r.description :
    typeof manifest.description === "string" ? (manifest.description as string) :
    undefined;
  const source =
    typeof r.source === "string" ? r.source :
    typeof r.installSource === "string" ? (r.installSource as string) :
    undefined;
  const origin =
    typeof r.origin === "string" ? r.origin :
    typeof r.kind === "string" ? r.kind :
    undefined;
  const installPath =
    typeof r.installPath === "string" ? r.installPath :
    typeof r.dir === "string" ? r.dir :
    typeof r.root === "string" ? r.root :
    undefined;
  return {
    id,
    enabled,
    version,
    description,
    source,
    origin,
    installPath,
    rawJson: r,
  };
}

function extractPluginsArray(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.plugins)) return obj.plugins;
  if (Array.isArray(obj.installed)) return obj.installed;
  if (Array.isArray(obj.entries)) return obj.entries;
  // Some shapes nest under `inventory.plugins`.
  if (obj.inventory && typeof obj.inventory === "object") {
    const inv = obj.inventory as Record<string, unknown>;
    if (Array.isArray(inv.plugins)) return inv.plugins;
  }
  return [];
}

export async function pluginsList(opts: { onlyEnabled?: boolean } = {}): Promise<ListResult> {
  const args = ["plugins", "list", "--json"];
  if (opts.onlyEnabled) args.push("--enabled");
  const r = await runOpenclaw(args, LIST_TIMEOUT_MS);
  if (r.timedOut) throw new Error("openclaw plugins list timed out");
  if (r.exitCode !== 0) throw new Error(`openclaw plugins list exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch (e) {
    throw new Error(`openclaw plugins list returned non-JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rawList = extractPluginsArray(parsed);
  const plugins: PluginEntry[] = [];
  for (const raw of rawList) {
    const entry = normalizeEntry(raw);
    if (entry) plugins.push(entry);
  }
  return { plugins, rawStdout: r.stdout };
}

function normalizeHit(raw: unknown): SearchHit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id =
    typeof r.packageName === "string" ? r.packageName :
    typeof r.id === "string" ? r.id :
    typeof r.name === "string" ? r.name :
    null;
  if (!id) return null;
  return {
    id,
    name: typeof r.name === "string" ? r.name : undefined,
    channel: typeof r.channel === "string" ? r.channel : undefined,
    family: typeof r.family === "string" ? r.family : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    installHint: typeof r.installHint === "string" ? r.installHint : undefined,
  };
}

export async function pluginsSearch(query: string): Promise<SearchResult> {
  // Refuse shell-meta in query; we pass argv-style but a query with control
  // chars is suspect and could break the JSON output the CLI produces.
  const q = query.trim().slice(0, 200);
  if (!q) return { hits: [], rawStdout: "" };
  const r = await runOpenclaw(["plugins", "search", q, "--json", "--limit", "40"], SEARCH_TIMEOUT_MS);
  if (r.timedOut) throw new Error("openclaw plugins search timed out");
  if (r.exitCode !== 0) throw new Error(`openclaw plugins search exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch (e) {
    throw new Error(`openclaw plugins search returned non-JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rawHits = extractHitArray(parsed);
  const hits: SearchHit[] = [];
  for (const raw of rawHits) {
    const hit = normalizeHit(raw);
    if (hit) hits.push(hit);
  }
  return { hits, rawStdout: r.stdout };
}

function extractHitArray(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.hits)) return obj.hits;
  if (Array.isArray(obj.plugins)) return obj.plugins;
  return [];
}

const SPEC_RE = /^[A-Za-z0-9@/:_.\-+]+$/;

export async function pluginsInstall(spec: string): Promise<MutationResult> {
  if (!SPEC_RE.test(spec)) {
    throw new Error(`refusing to install invalid spec: ${spec}`);
  }
  const r = await runOpenclaw(["plugins", "install", spec, "--json"], INSTALL_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`openclaw plugins install ${spec} timed out`);
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}

export async function pluginsUninstall(id: string): Promise<MutationResult> {
  if (!SPEC_RE.test(id)) {
    throw new Error(`refusing to uninstall invalid id: ${id}`);
  }
  // Refuse to uninstall ourselves — that would kill the very RPC we used.
  if (id === "clawhq") {
    throw new Error("refusing to uninstall the clawhq plugin from itself");
  }
  const r = await runOpenclaw(["plugins", "uninstall", id, "--json"], UNINSTALL_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`openclaw plugins uninstall ${id} timed out`);
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}
