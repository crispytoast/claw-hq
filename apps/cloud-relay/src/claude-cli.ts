/**
 * Thin wrapper around the Claude Code CLI for the fast-path chat sender.
 *
 * Goals:
 *   - Locate the `claude` binary on $PATH (or via CLAW_HQ_CLAUDE_BIN env).
 *   - Build a tight, predictable argv for non-interactive streaming mode.
 *   - Parse the line-delimited stream-json output into a structured event
 *     stream the fast-path can dispatch.
 *
 * Non-goals:
 *   - Spawning / process management — that's fast-path.ts's job.
 *   - Memory injection / system prompt construction — fast-path layers
 *     those on top.
 */
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

let cachedBin: string | null | undefined;

/**
 * Locate the `claude` CLI. Resolution order:
 *   1. CLAW_HQ_CLAUDE_BIN env var (absolute path).
 *   2. `which claude` on $PATH.
 * Returns null if not found — the relay will surface this to the SPA as
 * a fast-path-unavailable error so the user can fix their install.
 */
export async function findClaudeBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const envBin = process.env.CLAW_HQ_CLAUDE_BIN;
  if (envBin) {
    cachedBin = envBin;
    return envBin;
  }
  try {
    const { stdout } = await execFile("which", ["claude"], { timeout: 2000 });
    const bin = stdout.trim();
    cachedBin = bin || null;
    return cachedBin;
  } catch {
    cachedBin = null;
    return null;
  }
}

/** Reset the cached binary lookup. Tests only. */
export function _resetClaudeBinCache(): void {
  cachedBin = undefined;
}

export interface ClaudeRunArgs {
  /** The current user message (the only argv-passed prompt; history is
   *  inherited via --resume). */
  prompt: string;
  /** Pass-through model alias (e.g. "sonnet") or full id. Optional. */
  model?: string;
  /** Resume an existing Claude CLI session by id. Captured from the
   *  `system.init` event on the first turn. */
  resumeSessionId?: string;
  /** Optional system-prompt override. v1: not used. */
  systemPrompt?: string;
}

/**
 * Build the argv for a non-interactive turn. Mirrors OHQ's working
 * invocation (`stream-json --verbose --include-partial-messages
 * --dangerously-skip-permissions`) so the event shape matches what
 * the parser below expects.
 *
 * Notable flags:
 *   --tools ""        Disable all built-in tools. Fast-path v1 is chat
 *                     only — no Bash/Edit/Read etc. Locks down the
 *                     blast radius and removes a whole class of failures.
 *   --no-session-persistence   ALSO not used (--resume needs sessions
 *                     to be persisted somewhere). The CLI's session
 *                     storage lives under ~/.claude/projects.
 */
export function buildClaudeArgs(args: ClaudeRunArgs): string[] {
  // NOTE: order matters. `--tools` is variadic and would eat the positional
  // prompt arg if placed before it, so we don't use `--tools ""` here.
  // For fast-path v1 we leave tools available; in chat-style use the model
  // simply won't invoke them. If tool-restriction becomes important we'll
  // pivot to --disallowedTools with an explicit list.
  const out: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];
  if (args.model) out.push("--model", args.model);
  if (args.resumeSessionId) out.push("--resume", args.resumeSessionId);
  if (args.systemPrompt) out.push("--append-system-prompt", args.systemPrompt);
  // Prompt is the last positional arg.
  out.push(args.prompt);
  return out;
}

/**
 * Parsed stream-json event kinds the fast-path handler cares about.
 * Anything else is passed through verbatim for the SPA to ignore.
 */
export type ClaudeStreamEvent =
  | { type: "system"; subtype?: string; session_id?: string; [k: string]: unknown }
  | { type: "stream_event"; event?: { delta?: { type?: string; text?: string }; [k: string]: unknown }; [k: string]: unknown }
  | { type: "assistant"; message?: { content?: unknown; usage?: unknown }; [k: string]: unknown }
  | { type: "result"; result?: string; is_error?: boolean; usage?: unknown; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Extract any text delta from a stream-json line. Returns "" if not a text delta. */
export function textDeltaFromEvent(ev: ClaudeStreamEvent): string {
  if (ev.type !== "stream_event") return "";
  const e = (ev as { event?: { delta?: { type?: string; text?: string } } }).event;
  if (!e || !e.delta) return "";
  if (e.delta.type !== "text_delta") return "";
  return typeof e.delta.text === "string" ? e.delta.text : "";
}

/** Pull the session_id out of a `system.init` event. Returns null otherwise. */
export function sessionIdFromInit(ev: ClaudeStreamEvent): string | null {
  if (ev.type !== "system") return null;
  if ((ev as { subtype?: string }).subtype !== "init") return null;
  const id = (ev as { session_id?: string }).session_id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Parse a single stream-json line. Returns null on parse error.
 * Stream-json is one JSON object per line, no surrounding array.
 */
export function parseStreamLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

/** Re-export for fast-path's use. */
export { spawn };
