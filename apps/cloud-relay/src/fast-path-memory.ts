/**
 * Memory injection for fast-path chats (Phase 9.3).
 *
 * Fast-mode bypasses the OpenClaw gateway, which means it also bypasses
 * the gateway's session-loader (the thing that auto-injects SOUL.md /
 * AGENTS.md / project context per chat scope). This module replicates
 * that loader by reading files directly off disk and assembling a
 * preamble the fast-path can prepend to the first turn's prompt.
 *
 * Pattern: inject ONCE on the first turn (when chat.claudeSessionId is
 * still null). Subsequent turns rely on `claude --resume` to reload the
 * full conversation including the first turn's memory — same approach
 * the SPA uses for gateway-mode chats via `buildMemoryPreamble`.
 *
 * Workspace layout:
 *   <workspaceRoot>/
 *     SOUL.md, AGENTS.md, USER.md, IDENTITY.md   — global persona
 *     MEMORY.md                                  — head-chat only
 *     projects/<slug>/
 *       SOUL.md, AGENTS.md                       — specialist persona override
 *       BRIEF.md, ROADMAP.md                     — product vision + state
 *       memory/INDEX.md                          — curated long-term
 *       memory/YYYY-MM-DD.md                     — daily logs
 */
import { promises as fs } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";

const WORKSPACE_ROOT =
  process.env.CLAW_HQ_WORKSPACE_ROOT
  ?? process.env.OPENCLAW_WORKSPACE_ROOT
  ?? resolve(homedir(), ".openclaw", "workspace");

/** Per-section character budget. ~10-20K is plenty for SOUL/AGENTS. */
const SECTION_CAP = 12_000;
/** Hard ceiling for the assembled preamble. Stops us from blowing the
 *  Claude context window even when files are huge. */
const TOTAL_CAP = 60_000;

async function safeRead(path: string, cap = SECTION_CAP): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    if (raw.length <= cap) return raw;
    return raw.slice(0, cap) + `\n\n... [truncated at ${cap.toLocaleString()} chars]`;
  } catch {
    return null;
  }
}

/** Look up the most-recent daily memory note for a project. Returns null
 *  if the dir is missing or empty. Matches plain `YYYY-MM-DD.md` files
 *  (skips the `YYYY-MM-DD-HHMM.md` and `INDEX.md` style files). */
async function loadMostRecentDailyMemory(projectDir: string): Promise<{ path: string; content: string } | null> {
  const memDir = resolve(projectDir, "memory");
  let entries: string[];
  try {
    entries = await fs.readdir(memDir);
  } catch {
    return null;
  }
  const dated = entries.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const latest = dated.pop();
  if (!latest) return null;
  const path = resolve(memDir, latest);
  const content = await safeRead(path, SECTION_CAP);
  if (!content) return null;
  return { path, content };
}

export interface MemoryPreambleInput {
  /** Chat scope. Missing/undefined treated as "project". */
  chatKind: "project" | "head" | undefined;
  /** Project slug for project-scope chats. null for head chats. */
  projectSlug: string | null;
}

/**
 * Build the memory preamble for a fast-path chat's first turn. Returns
 * an empty string when there's nothing useful to inject — caller can
 * unconditionally prepend it without conditional logic.
 */
export async function buildFastPathMemoryPreamble(input: MemoryPreambleInput): Promise<string> {
  const sections: Array<{ heading: string; body: string; path: string }> = [];

  // Global persona — always loaded.
  for (const name of ["SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md", "TOOLS.md"]) {
    const path = resolve(WORKSPACE_ROOT, name);
    const body = await safeRead(path);
    if (body) sections.push({ heading: `# Workspace ${name}`, body, path });
  }

  if (input.chatKind === "head") {
    // Head Oswald gets the portfolio-level memory. Specialists do NOT.
    const memPath = resolve(WORKSPACE_ROOT, "MEMORY.md");
    const body = await safeRead(memPath);
    if (body) sections.push({ heading: "# Workspace MEMORY.md", body, path: memPath });
  } else if (input.projectSlug) {
    // Project specialist context.
    const projectDir = resolve(WORKSPACE_ROOT, "projects", input.projectSlug);
    for (const name of ["SOUL.md", "AGENTS.md", "BRIEF.md", "ROADMAP.md"]) {
      const path = resolve(projectDir, name);
      const body = await safeRead(path);
      if (body) sections.push({ heading: `# Project ${input.projectSlug}/${name}`, body, path });
    }
    const indexPath = resolve(projectDir, "memory", "INDEX.md");
    const indexBody = await safeRead(indexPath);
    if (indexBody) sections.push({ heading: `# Project ${input.projectSlug}/memory/INDEX.md`, body: indexBody, path: indexPath });
    const daily = await loadMostRecentDailyMemory(projectDir);
    if (daily) sections.push({ heading: `# Project ${input.projectSlug}/memory/${basename(daily.path)}`, body: daily.content, path: daily.path });
  }

  if (sections.length === 0) return "";

  const header =
    `[Fast-path memory preamble — loaded once per chat. Treat as authoritative
context. Read each section, then respond to the user's message that follows
the "---" separator.]`;

  let assembled = header + "\n\n";
  for (const s of sections) {
    const chunk = `${s.heading}\n\n${s.body}\n\n`;
    if (assembled.length + chunk.length > TOTAL_CAP) {
      assembled += `[Remaining context omitted — preamble hit the ${TOTAL_CAP.toLocaleString()}-char ceiling.]\n\n`;
      break;
    }
    assembled += chunk;
  }
  assembled += "---\n\n";
  return assembled;
}

/** Internal helper exposed for tests / introspection. */
export const _internal = { WORKSPACE_ROOT, SECTION_CAP, TOTAL_CAP };
