// Pure line-diff helpers used by ChatDetailView's DiffView. Kept in a separate
// module so it can be unit-reasoned about and re-used if another surface (e.g.
// a future approvals card) wants to show file changes.

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffHunk {
  /** Human-readable header like "@@ -1,3 +1,4 @@" (synthesized; not authoritative). */
  header: string;
  lines: DiffLine[];
}

export interface DiffStats {
  added: number;
  deleted: number;
}

// LCS matrix gets quadratic in size; cap before falling back to a coarse
// delete-all / add-all split. ~500x500 lines is the limit before we bail.
const MAX_LCS_PRODUCT = 250_000;

// Context lines kept around each change run when collapsing to hunks.
const HUNK_CONTEXT = 3;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  // Treat an empty string as zero lines, not one empty line, so a new-file
  // Write doesn't render a phantom "−" against the placeholder.
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > MAX_LCS_PRODUCT) {
    const out: DiffLine[] = [];
    for (let i = 0; i < m; i++) out.push({ kind: "del", text: oldLines[i]!, oldNumber: i + 1 });
    for (let j = 0; j < n; j++) out.push({ kind: "add", text: newLines[j]!, newNumber: j + 1 });
    return out;
  }

  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: "ctx", text: oldLines[i]!, oldNumber: i + 1, newNumber: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: oldLines[i]!, oldNumber: i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: newLines[j]!, newNumber: j + 1 });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: "del", text: oldLines[i]!, oldNumber: i + 1 });
    i++;
  }
  while (j < n) {
    out.push({ kind: "add", text: newLines[j]!, newNumber: j + 1 });
    j++;
  }
  return out;
}

export function statsFor(lines: DiffLine[]): DiffStats {
  let added = 0;
  let deleted = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") deleted++;
  }
  return { added, deleted };
}

/**
 * Group a flat diff into hunks: runs of changes with up to HUNK_CONTEXT
 * surrounding `ctx` lines on either side. Long runs of pure context between
 * hunks are dropped so a 5,000-line file with one tweak doesn't paint 5,000
 * rows.
 */
export function toHunks(lines: DiffLine[]): DiffHunk[] {
  // Find indices of every change.
  const changeIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "ctx") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  // Merge adjacent change ranges into one hunk if their context windows touch.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - HUNK_CONTEXT);
    const end = Math.min(lines.length - 1, idx + HUNK_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map((r) => {
    const slice = lines.slice(r.start, r.end + 1);
    // Synthesize a unified-diff style header using the first numbered lines.
    const firstOld = slice.find((l) => l.oldNumber !== undefined)?.oldNumber ?? 0;
    const firstNew = slice.find((l) => l.newNumber !== undefined)?.newNumber ?? 0;
    const oldCount = slice.filter((l) => l.kind !== "add").length;
    const newCount = slice.filter((l) => l.kind !== "del").length;
    return {
      header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
      lines: slice,
    };
  });
}

/**
 * Detect what kind of file edit a tool call represents and extract the
 * before/after text. Returns null for tools we don't know how to render
 * as a diff.
 */
export interface ParsedFileEdit {
  filePath: string;
  before: string;
  after: string;
  /** "new-file" hides the empty pane; "edit" renders both. */
  mode: "edit" | "new-file";
}

export function parseFileEditArgs(name: string, args: unknown): ParsedFileEdit[] | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;

  if (name === "Write") {
    const filePath = typeof a.file_path === "string" ? a.file_path : null;
    const content = typeof a.content === "string" ? a.content : null;
    if (!filePath || content === null) return null;
    return [{ filePath, before: "", after: content, mode: "new-file" }];
  }

  if (name === "Edit") {
    const filePath = typeof a.file_path === "string" ? a.file_path : null;
    const oldString = typeof a.old_string === "string" ? a.old_string : null;
    const newString = typeof a.new_string === "string" ? a.new_string : null;
    if (!filePath || oldString === null || newString === null) return null;
    return [{ filePath, before: oldString, after: newString, mode: "edit" }];
  }

  if (name === "MultiEdit") {
    const filePath = typeof a.file_path === "string" ? a.file_path : null;
    const edits = Array.isArray(a.edits) ? a.edits : null;
    if (!filePath || !edits) return null;
    const out: ParsedFileEdit[] = [];
    for (const raw of edits) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const oldString = typeof e.old_string === "string" ? e.old_string : null;
      const newString = typeof e.new_string === "string" ? e.new_string : null;
      if (oldString === null || newString === null) continue;
      out.push({ filePath, before: oldString, after: newString, mode: "edit" });
    }
    return out.length > 0 ? out : null;
  }

  return null;
}
