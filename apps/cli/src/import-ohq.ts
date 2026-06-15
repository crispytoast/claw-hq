/**
 * `claw-hq import-ohq <source-dir>` — one-way migration of legacy
 * Oswald-HQ chats into Claw HQ.
 *
 * Source layout (must look like):
 *   <source-dir>/.oswald-hq/chats/<uuid>.json
 *   <source-dir>/.oswald-hq/uploads/<chatId>/<filename>
 *
 * Target layout (generic — derived from Claw HQ config):
 *   ~/.openclaw/clawhq/data/chats/<uuid>.json    (the openclaw-plugin's chats dir)
 *   <config.dataDir>/uploads/<sha256>.<ext>      (the relay's content-addressed store)
 *   <config.dataDir>/uploads/<sha256>.meta.json
 *
 * Default behaviour is a dry-run that reports what would be imported. Pass
 * `--live` to actually write. Existing chat files are NOT overwritten unless
 * `--force` is also passed.
 *
 * Generic: works for any OHQ install — no hardcoded paths beyond the Claw HQ
 * config and OHQ's well-known directory layout. Source dir is a CLI arg.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readConfig } from "@claw-hq/cloud-relay/config";

// ── Source (OHQ) shape ──────────────────────────────────────────────────────

interface OhqAskQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

type OhqBlock =
  | { kind: "user"; text: string; images?: string[]; files?: { url: string; name: string }[] }
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; name: string; summary: string }
  | { kind: "tool-result"; ok: boolean; summary: string }
  | { kind: "ask-question"; questions: OhqAskQuestion[] }
  | { kind: "system"; text: string; ctxPct?: number }
  | { kind: "error"; text: string };

interface OhqChat {
  id: string;
  title: string;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  claudeSessionId: string | null;
  model?: string | null;
  messages: OhqBlock[];
}

// ── Target (Claw HQ) shape ──────────────────────────────────────────────────

type ClawHqRole = "user" | "assistant" | "system" | "tool";

interface ClawHqMessage {
  id: string;
  role: ClawHqRole;
  content: string;
  createdMs: number;
}

interface ClawHqChat {
  id: string;
  projectSlug: string | null;
  title: string;
  createdMs: number;
  updatedMs: number;
  messages: ClawHqMessage[];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface ImportOptions {
  sourceDir: string;
  live: boolean;
  force: boolean;
  filterChatId: string | null;
  filterProject: string | null; // "__null__" sentinel for project === null
  skipAttachments: boolean;
}

function parseArgs(argv: string[]): ImportOptions {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    process.exit(argv.length === 0 ? 2 : 0);
  }
  let sourceDir: string | null = null;
  const opts: Omit<ImportOptions, "sourceDir"> = {
    live: false,
    force: false,
    filterChatId: null,
    filterProject: null,
    skipAttachments: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--live") opts.live = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--skip-attachments") opts.skipAttachments = true;
    else if (a === "--chat") opts.filterChatId = argv[++i] ?? null;
    else if (a === "--project") {
      const v = argv[++i] ?? null;
      opts.filterProject = v === "none" ? "__null__" : v;
    } else if (!a.startsWith("--")) {
      if (sourceDir === null) sourceDir = a;
      else {
        console.error(`unexpected positional: ${a}`);
        process.exit(2);
      }
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!sourceDir) {
    console.error("missing <source-dir>");
    printUsage();
    process.exit(2);
  }
  return { sourceDir: path.resolve(sourceDir), ...opts };
}

function printUsage(): void {
  console.log(`Usage: claw-hq import-ohq <source-dir> [options]

Source dir is the OHQ workspace root containing .oswald-hq/chats/ and
.oswald-hq/uploads/.

Options:
  --live              Actually write. Default is dry-run.
  --force             Overwrite existing Claw HQ chats with same id.
  --chat <id>         Import only the chat with this UUID.
  --project <slug>    Import only chats tagged with this project slug.
                      Use "none" for chats with no project.
  --skip-attachments  Don't copy uploads; leave URLs broken.
  -h, --help          Show this message.
`);
}

// ── Conversion ──────────────────────────────────────────────────────────────

interface ChatPlan {
  source: string; // file path
  ohq: OhqChat;
  target: ClawHqChat;
  attachments: AttachmentPlan[];
  /** True when target id already exists in clawhq chats dir. */
  exists: boolean;
}

interface AttachmentPlan {
  sourcePath: string;
  /** Original URL in the OHQ chat (`/api/chats/<id>/attachments/<file>`). */
  sourceUrl: string;
  /** Plain filename the user uploaded (best-effort — falls back to disk name). */
  filename: string;
  /** Inferred mime type from extension. */
  mimeType: string;
  /** sha256 of bytes (lazy: filled in during plan(), since it's read-only). */
  sha256: string;
  /** Extension including the dot, lowercase, e.g. ".jpg". */
  ext: string;
  /** New URL we'll splice into the imported chat body. */
  targetUrl: string;
  size: number;
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".ndjson": "application/x-ndjson",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".log": "text/plain",
};

function mimeFromExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

async function sha256OfFile(p: string): Promise<{ sha: string; size: number }> {
  const hasher = createHash("sha256");
  const buf = await fs.readFile(p);
  hasher.update(buf);
  return { sha: hasher.digest("hex"), size: buf.length };
}

/**
 * URL splice: rewrite OHQ's `/api/chats/<id>/attachments/<file>` to Claw HQ's
 * `/uploads/<sha>`. We map by URL because OHQ stores attachment refs on user
 * blocks by URL (`images`/`files`) and inside message text the URL is the only
 * stable handle we can match.
 */
function buildUrlRewriteMap(plans: AttachmentPlan[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of plans) m.set(a.sourceUrl, a.targetUrl);
  return m;
}

function rewriteUrlsInText(text: string, rewrite: Map<string, string>): string {
  let out = text;
  for (const [from, to] of rewrite) {
    if (out.includes(from)) {
      // Plain string replace — URLs include the chat UUID + a file UUID so
      // collisions with anything else in the body are vanishingly unlikely.
      out = out.split(from).join(to);
    }
  }
  return out;
}

function convertMessages(
  ohq: OhqChat,
  attachments: AttachmentPlan[],
  createdMs: number,
  updatedMs: number,
): ClawHqMessage[] {
  const rewrite = buildUrlRewriteMap(attachments);
  const out: ClawHqMessage[] = [];
  // OHQ doesn't store per-message timestamps; we linearly interpolate so the
  // history scrolls back in roughly the right order. Range collapses to a
  // single point if createdMs === updatedMs (single-turn chats).
  const total = Math.max(1, ohq.messages.length);
  const step = total > 1 ? (updatedMs - createdMs) / (total - 1) : 0;

  for (let i = 0; i < ohq.messages.length; i++) {
    const block = ohq.messages[i];
    if (!block) continue;
    const ts = Math.round(createdMs + step * i);
    if (block.kind === "user") {
      const parts: string[] = [];
      if (block.text) parts.push(rewriteUrlsInText(block.text, rewrite));
      // Match the Phase C step 4 convention: persist attachments as inline
      // markdown links so reload renders them as clickable chips.
      for (const url of block.images ?? []) {
        const a = attachments.find((x) => x.sourceUrl === url);
        const target = a ? a.targetUrl : url;
        const name = a ? a.filename : url.split("/").pop() ?? "image";
        parts.push(`[📎 ${name}](${target})`);
      }
      for (const file of block.files ?? []) {
        const a = attachments.find((x) => x.sourceUrl === file.url);
        const target = a ? a.targetUrl : file.url;
        parts.push(`[📎 ${file.name}](${target})`);
      }
      out.push({ id: randomUUID(), role: "user", content: parts.join("\n"), createdMs: ts });
    } else if (block.kind === "assistant-text") {
      out.push({
        id: randomUUID(),
        role: "assistant",
        content: rewriteUrlsInText(block.text, rewrite),
        createdMs: ts,
      });
    } else if (block.kind === "system") {
      const ctx =
        typeof block.ctxPct === "number" ? ` · ctx ${block.ctxPct.toFixed(1)}%` : "";
      out.push({
        id: randomUUID(),
        role: "system",
        content: `${block.text}${ctx}`,
        createdMs: ts,
      });
    } else if (block.kind === "error") {
      out.push({
        id: randomUUID(),
        role: "system",
        content: `[error] ${block.text}`,
        createdMs: ts,
      });
    } else if (block.kind === "ask-question") {
      // Tap-cards are no longer actionable on imported history — flatten to a
      // system note that preserves the question and its option labels so the
      // log still makes sense.
      const qs = block.questions.map((q: OhqAskQuestion) => {
        const labels = q.options
          .map((o: { label: string; description?: string }) => `• ${o.label}`)
          .join("\n");
        return `${q.question}\n${labels}`;
      });
      out.push({
        id: randomUUID(),
        role: "system",
        content: `[question]\n${qs.join("\n\n")}`,
        createdMs: ts,
      });
    } else if (block.kind === "tool-use") {
      // Pair with the next tool-result if present so we emit one "tool" row
      // per call, matching the Phase C step 9 persisted shape that ChatApp
      // reconstructs into a DisplayTool item.
      const next = ohq.messages[i + 1];
      let result = "";
      let isError = false;
      if (next && next.kind === "tool-result") {
        result = next.summary ?? "";
        isError = !next.ok;
        i++; // consume paired result
      }
      const payload = {
        toolCallId: `ohq-${i}-${randomUUID()}`,
        name: block.name,
        args: { summary: block.summary ?? "" },
        result,
        isError,
        startedMs: ts,
        doneMs: ts,
      };
      out.push({
        id: randomUUID(),
        role: "tool",
        content: JSON.stringify(payload),
        createdMs: ts,
      });
    } else if (block.kind === "tool-result") {
      // Orphan tool-result (no preceding tool-use this iteration — usually means
      // the use was consumed already by an earlier index advance). Render as
      // system breadcrumb so we don't drop it on the floor.
      const status = block.ok ? "ok" : "error";
      out.push({
        id: randomUUID(),
        role: "system",
        content: `[tool-result · ${status}] ${block.summary ?? ""}`,
        createdMs: ts,
      });
    }
  }
  return out;
}

async function planAttachments(
  ohq: OhqChat,
  sourceUploadsDir: string,
  skipAttachments: boolean,
): Promise<AttachmentPlan[]> {
  if (skipAttachments) return [];
  const plans: AttachmentPlan[] = [];
  // Walk every block that can carry an attachment URL.
  const urls = new Map<string, { filename: string }>();
  for (const b of ohq.messages) {
    if (b.kind !== "user") continue;
    for (const url of b.images ?? []) {
      const name = url.split("/").pop() ?? "image";
      if (!urls.has(url)) urls.set(url, { filename: name });
    }
    for (const f of b.files ?? []) {
      if (!urls.has(f.url)) urls.set(f.url, { filename: f.name });
    }
  }
  for (const [url, info] of urls) {
    // OHQ URL pattern: /api/chats/<chatId>/attachments/<filename>
    const m = url.match(/^\/api\/chats\/([^/]+)\/attachments\/(.+)$/);
    if (!m) continue;
    const chatId = m[1];
    const filename = m[2];
    if (!chatId || !filename) continue;
    const onDisk = path.join(sourceUploadsDir, chatId, filename);
    try {
      const { sha, size } = await sha256OfFile(onDisk);
      const ext = path.extname(filename).toLowerCase();
      plans.push({
        sourcePath: onDisk,
        sourceUrl: url,
        filename: info.filename,
        mimeType: mimeFromExt(ext),
        sha256: sha,
        ext,
        targetUrl: `/uploads/${sha}`,
        size,
      });
    } catch {
      // Missing file — skip; URL stays as-is in body (will 404 on click, but the
      // history line still reads).
    }
  }
  return plans;
}

async function planOneChat(
  filePath: string,
  sourceUploadsDir: string,
  targetChatsDir: string,
  skipAttachments: boolean,
): Promise<ChatPlan | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let ohq: OhqChat;
  try {
    ohq = JSON.parse(raw) as OhqChat;
  } catch {
    console.warn(`  skip (unparseable): ${path.basename(filePath)}`);
    return null;
  }
  if (!ohq.id || !Array.isArray(ohq.messages)) return null;

  const createdMs = Date.parse(ohq.createdAt) || Date.now();
  const updatedMs = Date.parse(ohq.updatedAt) || createdMs;
  const attachments = await planAttachments(ohq, sourceUploadsDir, skipAttachments);
  // Use the original UUID if it's valid; otherwise mint a new one so we keep
  // the schema's chat-id format constraint.
  const targetId = isValidUuid(ohq.id) ? ohq.id : randomUUID();
  const messages = convertMessages({ ...ohq, id: targetId }, attachments, createdMs, updatedMs);

  const target: ClawHqChat = {
    id: targetId,
    projectSlug: ohq.project ?? null,
    title: (ohq.title ?? "").trim().slice(0, 200) || "Imported chat",
    createdMs,
    updatedMs,
    messages,
  };

  let exists = false;
  try {
    await fs.stat(path.join(targetChatsDir, `${targetId}.json`));
    exists = true;
  } catch {
    /* ok */
  }

  return { source: filePath, ohq, target, attachments, exists };
}

async function writeChat(targetChatsDir: string, chat: ClawHqChat): Promise<void> {
  await fs.mkdir(targetChatsDir, { recursive: true });
  const final = path.join(targetChatsDir, `${chat.id}.json`);
  const tmp = `${final}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(chat, null, 2), "utf-8");
  await fs.rename(tmp, final);
}

async function writeAttachment(
  uploadsDir: string,
  plan: AttachmentPlan,
): Promise<{ wrote: boolean }> {
  await fs.mkdir(uploadsDir, { recursive: true });
  const blob = path.join(uploadsDir, `${plan.sha256}${plan.ext}`);
  const meta = path.join(uploadsDir, `${plan.sha256}.meta.json`);
  let wrote = false;
  try {
    await fs.access(blob);
  } catch {
    await fs.copyFile(plan.sourcePath, blob);
    wrote = true;
  }
  // Always (re)write meta — cheap and keeps mimeType/filename in sync if the
  // same content was uploaded under a different name elsewhere.
  await fs.writeFile(
    meta,
    JSON.stringify({
      filename: plan.filename,
      mimeType: plan.mimeType,
      size: plan.size,
      createdMs: Date.now(),
    }),
  );
  return { wrote };
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function importOhq(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const sourceChatsDir = path.join(opts.sourceDir, ".oswald-hq", "chats");
  const sourceUploadsDir = path.join(opts.sourceDir, ".oswald-hq", "uploads");

  // Target dirs: chats dir is plugin-owned (always under ~/.openclaw/clawhq/...),
  // uploads dir comes from the relay config.dataDir.
  const targetChatsDir = path.join(os.homedir(), ".openclaw", "clawhq", "data", "chats");
  const cfg = readConfig();
  const targetUploadsDir = path.join(cfg.dataDir, "uploads");

  console.log(`Source: ${sourceChatsDir}`);
  console.log(`Target chats:    ${targetChatsDir}`);
  console.log(`Target uploads:  ${targetUploadsDir}`);
  console.log(`Mode: ${opts.live ? "LIVE" : "DRY-RUN"}${opts.force ? " (force)" : ""}`);
  if (opts.filterChatId) console.log(`Filter --chat:    ${opts.filterChatId}`);
  if (opts.filterProject)
    console.log(
      `Filter --project: ${opts.filterProject === "__null__" ? "(no project)" : opts.filterProject}`,
    );
  if (opts.skipAttachments) console.log("Attachments: SKIPPED");
  console.log("");

  let files: string[];
  try {
    files = (await fs.readdir(sourceChatsDir))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.bak"))
      .sort();
  } catch (err) {
    console.error(`Cannot read source chats dir: ${(err as Error).message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.log("No source chat files found.");
    return;
  }

  // Build all plans first so the dry-run summary is accurate before any write.
  const plans: ChatPlan[] = [];
  for (const f of files) {
    const plan = await planOneChat(
      path.join(sourceChatsDir, f),
      sourceUploadsDir,
      targetChatsDir,
      opts.skipAttachments,
    );
    if (!plan) continue;
    // Apply filters AFTER plan() so we can still report filtered-out counts.
    if (opts.filterChatId && plan.ohq.id !== opts.filterChatId) continue;
    if (opts.filterProject) {
      const want = opts.filterProject === "__null__" ? null : opts.filterProject;
      if ((plan.ohq.project ?? null) !== want) continue;
    }
    plans.push(plan);
  }

  if (plans.length === 0) {
    console.log("Nothing to import after filters.");
    return;
  }

  // Per-chat report
  let totalAttach = 0;
  let totalSkipBecauseExists = 0;
  for (const p of plans) {
    const lineSuffix = p.exists
      ? opts.force
        ? " (will overwrite)"
        : " (SKIP — exists; use --force)"
      : "";
    if (p.exists && !opts.force) totalSkipBecauseExists++;
    const proj = p.target.projectSlug ?? "(no project)";
    console.log(
      `  ${p.target.id}  ${p.target.title.slice(0, 50).padEnd(50)} ` +
        `proj=${proj.padEnd(28)} ${String(p.ohq.messages.length).padStart(5)} blocks → ` +
        `${String(p.target.messages.length).padStart(5)} msgs · attach ${p.attachments.length}${lineSuffix}`,
    );
    totalAttach += p.attachments.length;
  }

  console.log("");
  console.log(
    `Total: ${plans.length} chats, ${totalAttach} attachments` +
      (totalSkipBecauseExists ? ` · ${totalSkipBecauseExists} skipped (existing)` : ""),
  );

  if (!opts.live) {
    console.log("");
    console.log("Dry-run only. Re-run with --live to write.");
    return;
  }

  // Live: write chats + attachments
  let wroteChats = 0;
  let wroteBlobs = 0;
  let dupBlobs = 0;
  const attachmentsWritten = new Set<string>(); // dedupe by sha within this run

  for (const p of plans) {
    if (p.exists && !opts.force) continue;
    // Attachments first — chat references them.
    for (const a of p.attachments) {
      if (attachmentsWritten.has(a.sha256)) {
        dupBlobs++;
        continue;
      }
      try {
        const { wrote } = await writeAttachment(targetUploadsDir, a);
        if (wrote) wroteBlobs++;
        else dupBlobs++;
        attachmentsWritten.add(a.sha256);
      } catch (err) {
        console.warn(
          `  attachment failed (${a.filename}): ${(err as Error).message}`,
        );
      }
    }
    try {
      await writeChat(targetChatsDir, p.target);
      wroteChats++;
      console.log(`  ✓ ${p.target.id}  ${p.target.title.slice(0, 60)}`);
    } catch (err) {
      console.warn(`  ✗ ${p.target.id}: ${(err as Error).message}`);
    }
  }

  console.log("");
  console.log(
    `Done. Wrote ${wroteChats} chats; ${wroteBlobs} new attachment blobs (${dupBlobs} already on disk).`,
  );
  console.log("");
  console.log(
    "Reopen Claw HQ (or pull a sidebar refresh) to see the imported chats in the Sessions list.",
  );
}
