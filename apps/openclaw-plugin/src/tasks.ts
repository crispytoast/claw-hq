import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

// GitHub-flavored checkbox: `- [ ] ...` or `- [x] ...` (also tolerates `- [X]`).
// Group 1: leading bullet+open-bracket. Group 2: state char. Group 3: rest.
const CHECKBOX_LINE_REGEX = /^(\s*[-*]\s*\[)([ xX])(\]\s.*)$/;

// Per-path serialization so two concurrent toggles can't race each other when
// they happen to land on the same file.
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(absPath) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  fileLocks.set(absPath, tail);
  void tail.then(() => {
    if (fileLocks.get(absPath) === tail) fileLocks.delete(absPath);
  });
  return result;
}

function resolveTasksPath(
  workspaceRoot: string,
  projectSlug: string,
  subprojectSlug?: string | null,
): string | null {
  if (!VALID_SLUG.test(projectSlug)) return null;
  if (subprojectSlug && !VALID_SLUG.test(subprojectSlug)) return null;
  const projectsDir = path.resolve(path.join(workspaceRoot, "projects"));
  const base = path.join(projectsDir, projectSlug);
  const tasksPath = subprojectSlug
    ? path.join(base, "subprojects", subprojectSlug, "TASKS.md")
    : path.join(base, "TASKS.md");
  const resolved = path.resolve(tasksPath);
  // Defense-in-depth: refuse any path that escapes projects/.
  if (resolved !== projectsDir && !resolved.startsWith(projectsDir + path.sep)) {
    return null;
  }
  return resolved;
}

export interface TasksSummary {
  projectSlug: string;
  subprojectSlug: string | null;
  content: string;
  totalCount: number;
  checkedCount: number;
}

function summarize(content: string, projectSlug: string, subprojectSlug: string | null): TasksSummary {
  let totalCount = 0;
  let checkedCount = 0;
  for (const line of content.split("\n")) {
    const m = CHECKBOX_LINE_REGEX.exec(line);
    if (m) {
      totalCount++;
      const state = m[2];
      if (state === "x" || state === "X") checkedCount++;
    }
  }
  return { projectSlug, subprojectSlug, content, totalCount, checkedCount };
}

export interface ToggleResult extends TasksSummary {
  lineIndex: number;
  checked: boolean;
}

// ── Aggregated rollup (Phase C step 40) ─────────────────────────────────────

export interface TaskLine {
  projectSlug: string;
  /** Human name from the project's BRIEF.md or fallback to slug. */
  projectName: string;
  subprojectSlug: string | null;
  /** Human name from the subproject's BRIEF.md or fallback to slug. */
  subprojectName: string | null;
  /** 0-indexed position of this checkbox within the source TASKS.md
   *  (matches the index toggleTask expects). */
  lineIndex: number;
  text: string;
  checked: boolean;
}

export interface RollupResult {
  tasks: TaskLine[];
  /** Number of projects scanned, regardless of whether they had tasks. */
  projectsScanned: number;
  /** Number of TASKS.md files actually read. */
  filesRead: number;
}

const SKIP_DIRS = new Set([
  "secrets",
  "node_modules",
  ".git",
  ".openclaw",
  ".oswald-hq",
]);

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function nameFromBrief(brief: string | null, fallback: string): string {
  if (!brief) return fallback;
  // Workspace convention (per OHQ's listSubprojects): frontmatter `name:`
  // wins over the H1 — subprojects use frontmatter as canonical metadata
  // and the H1 is often a generic header.
  let body = brief;
  let frontmatterName: string | null = null;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) {
      const block = body.slice(3, end);
      const fm = block.match(/(?:^|\n)name:\s*([^\n]+)/);
      if (fm) frontmatterName = fm[1]!.trim().replace(/^["']|["']$/g, "");
      body = body.slice(end + 4).replace(/^\n/, "");
    }
  }
  if (frontmatterName) return frontmatterName;
  const h1 = body.match(/^#\s+(.+)/m);
  if (h1) return h1[1]!.trim();
  return fallback;
}

function collectTaskLines(
  content: string,
  projectSlug: string,
  projectName: string,
  subprojectSlug: string | null,
  subprojectName: string | null,
): TaskLine[] {
  const out: TaskLine[] = [];
  let cbIdx = 0;
  for (const line of content.split("\n")) {
    const m = CHECKBOX_LINE_REGEX.exec(line);
    if (!m) continue;
    const state = m[2];
    const checked = state === "x" || state === "X";
    // m[3] is `]<space>...rest`. Strip the leading `] ` so text is just the task body.
    const post = m[3] ?? "";
    const text = post.replace(/^\]\s/, "").trim();
    if (text.length === 0) {
      cbIdx++;
      continue;
    }
    out.push({
      projectSlug,
      projectName,
      subprojectSlug,
      subprojectName,
      lineIndex: cbIdx,
      text,
      checked,
    });
    cbIdx++;
  }
  return out;
}

export async function listAllTasks(input: {
  workspaceRoot: string;
}): Promise<RollupResult> {
  const projectsDir = path.resolve(path.join(input.workspaceRoot, "projects"));
  let projectEntries;
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { tasks: [], projectsScanned: 0, filesRead: 0 };
  }
  const out: TaskLine[] = [];
  let projectsScanned = 0;
  let filesRead = 0;
  for (const e of projectEntries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    if (!VALID_SLUG.test(e.name)) continue;
    projectsScanned++;
    const projectSlug = e.name;
    const projectDir = path.join(projectsDir, projectSlug);
    const projectBrief = await readFileSafe(path.join(projectDir, "BRIEF.md"));
    const projectName = nameFromBrief(projectBrief, projectSlug);

    // Project-level TASKS.md (some projects have it, some don't).
    const projectTasksPath = path.join(projectDir, "TASKS.md");
    const projectTasks = await readFileSafe(projectTasksPath);
    if (projectTasks) {
      filesRead++;
      out.push(...collectTaskLines(projectTasks, projectSlug, projectName, null, null));
    }

    // Sub-project TASKS.md files.
    const subsDir = path.join(projectDir, "subprojects");
    let subEntries;
    try {
      subEntries = await fs.readdir(subsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of subEntries) {
      if (!se.isDirectory() || SKIP_DIRS.has(se.name)) continue;
      if (!VALID_SLUG.test(se.name)) continue;
      const subSlug = se.name;
      const subDir = path.join(subsDir, subSlug);
      const subBrief = await readFileSafe(path.join(subDir, "BRIEF.md"));
      const subName = nameFromBrief(subBrief, subSlug);
      const subTasks = await readFileSafe(path.join(subDir, "TASKS.md"));
      if (!subTasks) continue;
      filesRead++;
      out.push(...collectTaskLines(subTasks, projectSlug, projectName, subSlug, subName));
    }
  }
  return { tasks: out, projectsScanned, filesRead };
}

export async function toggleTask(input: {
  workspaceRoot: string;
  projectSlug: string;
  subprojectSlug?: string | null;
  lineIndex: number;
  checked: boolean;
}): Promise<ToggleResult | null> {
  const tasksPath = resolveTasksPath(
    input.workspaceRoot,
    input.projectSlug,
    input.subprojectSlug ?? null,
  );
  if (!tasksPath) return null;
  if (!Number.isInteger(input.lineIndex) || input.lineIndex < 0) return null;
  return withFileLock(tasksPath, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(tasksPath, "utf8");
    } catch {
      return null;
    }
    const lines = raw.split("\n");
    let seenCheckboxes = 0;
    let targetIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (CHECKBOX_LINE_REGEX.test(lines[i]!)) {
        if (seenCheckboxes === input.lineIndex) {
          targetIdx = i;
          break;
        }
        seenCheckboxes++;
      }
    }
    if (targetIdx === -1) return null;
    const replacement = lines[targetIdx]!.replace(
      CHECKBOX_LINE_REGEX,
      (_match, pre: string, _state: string, post: string) =>
        `${pre}${input.checked ? "x" : " "}${post}`,
    );
    lines[targetIdx] = replacement;
    const newContent = lines.join("\n");
    const tmp = `${tasksPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, newContent, "utf8");
    await fs.rename(tmp, tasksPath);
    const summary = summarize(
      newContent,
      input.projectSlug,
      input.subprojectSlug ?? null,
    );
    return { ...summary, lineIndex: input.lineIndex, checked: input.checked };
  });
}
