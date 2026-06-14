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
