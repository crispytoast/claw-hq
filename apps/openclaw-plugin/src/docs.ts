/**
 * Workspace-wide `.md` doc browser. Read-only by design — the docs page in the
 * SPA only renders; the per-file editor remains on the existing
 * `clawhq.memory.*` surface, which is the only legal write path.
 *
 * Mirrors OHQ's /docs feature: tree view + full-text search across every
 * markdown file under the workspace root, with a hard skip-list for the dirs
 * we never want indexed (secrets, .git, node_modules, etc).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

const SKIP_DIRS = new Set([
  "secrets",
  "node_modules",
  ".git",
  ".openclaw",
  ".oswald-hq",
  ".oswald-cli-images",
  ".openclaw-cli-images",
  "dist",
  "build",
  ".next",
]);

const MAX_FILE_BYTES = 1_000_000; // 1MB cap when serving a single file
const SEARCH_RESULT_CAP = 200;
const SEARCH_SNIPPET_WINDOW = 80;
const MAX_SNIPPETS_PER_DOC = 2;

export interface DocSummary {
  relativePath: string;
  name: string;
  dir: string;
  size: number;
  updatedMs: number;
}

export interface DocContent extends DocSummary {
  content: string;
}

export interface DocSnippet {
  /** 0-based line number inside the file where the match starts. */
  line: number;
  snippet: string;
}

export interface DocSearchHit {
  doc: DocSummary;
  /** Total occurrences inside this doc (title + body). */
  matchCount: number;
  snippets: DocSnippet[];
  titleMatched: boolean;
}

export interface DocSearchResult {
  hits: DocSearchHit[];
  totalDocsScanned: number;
  query: string;
}

function inSkippedDir(relativePath: string): boolean {
  // Reject as soon as any path segment matches a skip dir. Cheaper than
  // re-checking inside walkDir, and protects callers that hit getDoc directly.
  for (const seg of relativePath.split(path.sep)) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

async function walkDir(
  workspaceRoot: string,
  dir: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkDir(workspaceRoot, full, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

export async function listDocs(input: {
  workspaceRoot: string;
}): Promise<DocSummary[]> {
  const root = path.resolve(input.workspaceRoot);
  const files: string[] = [];
  await walkDir(root, root, files);
  const out: DocSummary[] = [];
  for (const f of files) {
    let stat;
    try {
      stat = await fs.stat(f);
    } catch {
      continue;
    }
    const relativePath = path.relative(root, f);
    if (inSkippedDir(relativePath)) continue;
    out.push({
      relativePath,
      name: path.basename(f),
      dir: path.dirname(relativePath),
      size: stat.size,
      updatedMs: stat.mtimeMs,
    });
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

function resolveDocPath(workspaceRoot: string, relativePath: string): string | null {
  if (!relativePath || relativePath.startsWith("/")) return null;
  if (relativePath.includes("\0")) return null;
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(path.join(root, relativePath));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, abs);
  if (inSkippedDir(rel)) return null;
  if (!abs.endsWith(".md")) return null;
  return abs;
}

export async function getDoc(input: {
  workspaceRoot: string;
  relativePath: string;
}): Promise<DocContent | null> {
  const abs = resolveDocPath(input.workspaceRoot, input.relativePath);
  if (!abs) return null;
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) {
      // Soft-cap: return enough to render the head and a notice. Caller still
      // gets the real size so the SPA can show "truncated".
      const fh = await fs.open(abs, "r");
      try {
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_FILE_BYTES, 0);
        const content = buf.slice(0, bytesRead).toString("utf8") +
          `\n\n[doc truncated at ${MAX_FILE_BYTES} bytes; full size ${stat.size}]`;
        return {
          relativePath: path.relative(path.resolve(input.workspaceRoot), abs),
          name: path.basename(abs),
          dir: path.dirname(path.relative(path.resolve(input.workspaceRoot), abs)),
          size: stat.size,
          updatedMs: stat.mtimeMs,
          content,
        };
      } finally {
        await fh.close();
      }
    }
    const content = await fs.readFile(abs, "utf8");
    return {
      relativePath: path.relative(path.resolve(input.workspaceRoot), abs),
      name: path.basename(abs),
      dir: path.dirname(path.relative(path.resolve(input.workspaceRoot), abs)),
      size: stat.size,
      updatedMs: stat.mtimeMs,
      content,
    };
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(content: string, idx: number, len: number): { line: number; snippet: string } {
  const start = Math.max(0, idx - SEARCH_SNIPPET_WINDOW);
  const end = Math.min(content.length, idx + len + SEARCH_SNIPPET_WINDOW);
  const slice = content.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "[..]" : "";
  const suffix = end < content.length ? "[..]" : "";
  // Calculate line number by counting newlines before the match.
  const line = content.slice(0, idx).split("\n").length - 1;
  return { line, snippet: `${prefix}${slice}${suffix}` };
}

export async function searchDocs(input: {
  workspaceRoot: string;
  query: string;
}): Promise<DocSearchResult> {
  const query = (input.query ?? "").trim();
  if (!query) return { hits: [], totalDocsScanned: 0, query };
  const docs = await listDocs({ workspaceRoot: input.workspaceRoot });
  const needle = query.toLowerCase();
  const needleLen = query.length;
  const root = path.resolve(input.workspaceRoot);
  const hits: DocSearchHit[] = [];

  for (const doc of docs) {
    let content: string;
    try {
      content = await fs.readFile(path.join(root, doc.relativePath), "utf8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const titleLower = doc.relativePath.toLowerCase();
    const titleMatched = titleLower.includes(needle);
    let matchCount = titleMatched ? 1 : 0;
    const snippets: DocSnippet[] = [];

    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      matchCount++;
      if (snippets.length < MAX_SNIPPETS_PER_DOC) {
        snippets.push(snippetAround(content, idx, needleLen));
      }
      idx = lower.indexOf(needle, idx + needleLen);
    }
    if (matchCount === 0) continue;
    hits.push({ doc, matchCount, snippets, titleMatched });
  }
  hits.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return a.doc.relativePath.localeCompare(b.doc.relativePath);
  });
  return {
    hits: hits.slice(0, SEARCH_RESULT_CAP),
    totalDocsScanned: docs.length,
    query,
  };
}
