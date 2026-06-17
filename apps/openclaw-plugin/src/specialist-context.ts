/**
 * Project-specialist context loader (Phase 8.2).
 *
 * When a session opens with a key like `agent:main:clawhq-<chatId>`, the
 * conversation belongs to that project's specialist (Claw HQ in this case,
 * PM HQ for `pmhq-`, head Oswald for `oswald-`). This module returns the
 * extra system-prompt context to prepend so the model boots into the
 * specialist's persona without the user having to point it at the files
 * manually.
 *
 * Mapping (`agent:main:<scope>-<chatIdFragment>`):
 *   clawhq → projects/the-interface-claw-hq/
 *   pmhq   → projects/pm-hq/
 *   oswald → workspace root (default OpenClaw prelude already covers head Oswald)
 *   *      → no extra context (passthrough)
 *
 * Read order per project:
 *   1. SOUL.md   — persona
 *   2. AGENTS.md — operating rules
 *   3. BRIEF.md  — product vision (small if present)
 *   4. memory/YYYY-MM-DD*.md — most-recent daily note for where work left off
 *
 * Hard cap on combined content keeps the prepended system text cacheable
 * and bounded; truncation marker is appended when it kicks in.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

const SCOPED_SESSION_RE = /^agent:main:([a-z]+)-([A-Za-z0-9-]+)$/;

/** Hard cap on total injected context length (chars). Bounded so the
 * prepended block stays cacheable and we don't blow the model window. */
const CONTEXT_CHAR_BUDGET = 32_000;

/** Map scope prefix → project directory (relative to workspaceRoot/projects/). */
const SCOPE_TO_PROJECT_DIR: Record<string, string | null> = {
  clawhq: "the-interface-claw-hq",
  pmhq: "pm-hq",
  // oswald uses the workspace root prelude OpenClaw already loads — nothing
  // extra to inject here. Mapped explicitly so unknown prefixes log noise.
  oswald: null,
};

export interface SpecialistContextResult {
  /** Combined Markdown text ready for prependSystemContext. Empty string
   *  when the session has no specialist mapping or all files are missing. */
  content: string;
  /** Scope prefix that was matched (`clawhq`, `pmhq`, `oswald`, or "" when no match). */
  scope: string;
  /** Project directory used (relative under projects/) or null. */
  projectDir: string | null;
  /** Files that contributed to `content`. Useful for debugging / logging. */
  filesRead: string[];
}

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

/** Returns the path to the most recent daily note (`YYYY-MM-DD*.md`) in
 *  the project's memory dir, or null if the dir is missing / empty. The
 *  filename pattern matches both `2026-06-16.md` and `2026-06-16-2112.md`
 *  (timestamp-suffixed handoff notes). */
async function mostRecentMemoryNote(memoryDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return null;
  }
  const dated = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}(?:-[0-9A-Za-z]+)?\.md$/i.test(f))
    .sort();
  if (dated.length === 0) return null;
  return path.join(memoryDir, dated[dated.length - 1]!);
}

function clip(content: string, sectionTitle: string, budget: number): string {
  if (content.length <= budget) return content;
  return `${content.slice(0, budget)}\n\n…[${sectionTitle} truncated at ${budget} chars]\n`;
}

/**
 * Build the injection text for a session key. Returns an empty content
 * string when the session doesn't map to a known specialist (head Oswald
 * sessions and unknown prefixes both fall here — head Oswald gets workspace
 * defaults via OpenClaw's native prelude).
 */
export async function buildSpecialistContext(args: {
  sessionKey: string;
  workspaceRoot: string;
}): Promise<SpecialistContextResult> {
  const empty: SpecialistContextResult = { content: "", scope: "", projectDir: null, filesRead: [] };
  const match = args.sessionKey.match(SCOPED_SESSION_RE);
  if (!match) return empty;
  const scope = match[1] ?? "";
  if (!(scope in SCOPE_TO_PROJECT_DIR)) return empty;
  const projectDir = SCOPE_TO_PROJECT_DIR[scope];
  if (!projectDir) return { ...empty, scope };

  const projectRoot = path.resolve(args.workspaceRoot, "projects", projectDir);
  const memoryDir = path.join(projectRoot, "memory");
  const dailyNotePath = await mostRecentMemoryNote(memoryDir);

  const files: Array<{ label: string; absPath: string }> = [
    { label: "SOUL.md", absPath: path.join(projectRoot, "SOUL.md") },
    { label: "AGENTS.md", absPath: path.join(projectRoot, "AGENTS.md") },
    { label: "BRIEF.md", absPath: path.join(projectRoot, "BRIEF.md") },
  ];
  if (dailyNotePath) {
    files.push({ label: `memory/${path.basename(dailyNotePath)}`, absPath: dailyNotePath });
  }

  const sections: string[] = [];
  const filesRead: string[] = [];
  let used = 0;
  // Header carries enough framing that a Claude reader knows what this is
  // even without the surrounding system prompt. Kept terse.
  const header = [
    `<!-- claw-hq specialist boot context -->`,
    `# Project-scoped boot — \`${projectDir}\``,
    ``,
    `You're booting as the specialist for project **${projectDir}**.`,
    `Treat the following files as authoritative for this turn.`,
    ``,
  ].join("\n");
  sections.push(header);
  used += header.length;

  for (const f of files) {
    if (used >= CONTEXT_CHAR_BUDGET) break;
    const text = await readFileSafe(f.absPath);
    if (!text) continue;
    const remaining = CONTEXT_CHAR_BUDGET - used;
    const sectionBudget = Math.max(2_000, Math.floor(remaining / Math.max(1, files.length)));
    const clipped = clip(text, f.label, sectionBudget);
    const block = `\n\n## ${f.label}\n\n${clipped}`;
    sections.push(block);
    used += block.length;
    filesRead.push(f.absPath);
  }

  if (filesRead.length === 0) {
    // No specialist files on disk — let OpenClaw's default prelude run.
    return { ...empty, scope, projectDir };
  }

  return {
    content: sections.join(""),
    scope,
    projectDir,
    filesRead,
  };
}
