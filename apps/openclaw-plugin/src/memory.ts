import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Allow letters, digits, underscores, dashes, and dots. Must end in .md.
// Cannot start with a dot (no hidden files) and cannot contain `/` or `\`.
const VALID_FILENAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;

const MAX_FILE_BYTES = 1_000_000; // 1MB — memory files are notes, not blobs.

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

/**
 * When projectSlug is empty/null, returns `<workspaceRoot>/memory/` for shared
 * workspace memory. When set, returns `<workspaceRoot>/projects/<slug>/memory/`.
 * Both paths are guarded against traversal escape.
 */
function resolveMemoryDir(
  workspaceRoot: string,
  projectSlug: string | null,
): string | null {
  const workspaceAbs = path.resolve(workspaceRoot);
  if (!projectSlug) {
    return path.resolve(path.join(workspaceAbs, "memory"));
  }
  if (!VALID_SLUG.test(projectSlug)) return null;
  const projectsDir = path.resolve(path.join(workspaceAbs, "projects"));
  const memoryDir = path.resolve(
    path.join(projectsDir, projectSlug, "memory"),
  );
  if (
    memoryDir !== projectsDir &&
    !memoryDir.startsWith(projectsDir + path.sep)
  ) {
    return null;
  }
  return memoryDir;
}

function resolveMemoryFile(
  workspaceRoot: string,
  projectSlug: string | null,
  name: string,
): string | null {
  if (!VALID_FILENAME.test(name)) return null;
  const dir = resolveMemoryDir(workspaceRoot, projectSlug);
  if (!dir) return null;
  const filePath = path.resolve(path.join(dir, name));
  if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return null;
  return filePath;
}

export interface MemoryFileSummary {
  name: string;
  size: number;
  updatedMs: number;
}

export interface MemoryFileContent extends MemoryFileSummary {
  content: string;
}

export async function listMemoryFiles(input: {
  workspaceRoot: string;
  projectSlug: string | null;
}): Promise<MemoryFileSummary[] | null> {
  const dir = resolveMemoryDir(input.workspaceRoot, input.projectSlug);
  if (!dir) return null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: MemoryFileSummary[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!VALID_FILENAME.test(e.name)) continue;
    let stat;
    try {
      stat = await fs.stat(path.join(dir, e.name));
    } catch {
      continue;
    }
    out.push({ name: e.name, size: stat.size, updatedMs: stat.mtimeMs });
  }
  out.sort((a, b) => b.updatedMs - a.updatedMs);
  return out;
}

export async function getMemoryFile(input: {
  workspaceRoot: string;
  projectSlug: string | null;
  name: string;
}): Promise<MemoryFileContent | null> {
  const filePath = resolveMemoryFile(
    input.workspaceRoot,
    input.projectSlug,
    input.name,
  );
  if (!filePath) return null;
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    return {
      name: input.name,
      content,
      size: stat.size,
      updatedMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export interface PutMemoryResult extends MemoryFileContent {
  created: boolean;
}

export async function putMemoryFile(input: {
  workspaceRoot: string;
  projectSlug: string | null;
  name: string;
  content: string;
}): Promise<PutMemoryResult | null | "TOO_LARGE"> {
  const dir = resolveMemoryDir(input.workspaceRoot, input.projectSlug);
  if (!dir) return null;
  const filePath = resolveMemoryFile(
    input.workspaceRoot,
    input.projectSlug,
    input.name,
  );
  if (!filePath) return null;
  if (Buffer.byteLength(input.content, "utf8") > MAX_FILE_BYTES) {
    return "TOO_LARGE";
  }
  return withFileLock(filePath, async () => {
    let created = false;
    try {
      await fs.access(filePath);
    } catch {
      created = true;
    }
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, input.content, "utf8");
    await fs.rename(tmp, filePath);
    const stat = await fs.stat(filePath);
    return {
      name: input.name,
      content: input.content,
      size: stat.size,
      updatedMs: stat.mtimeMs,
      created,
    };
  });
}

/**
 * Read the workspace's long-term memory file at `<workspaceRoot>/MEMORY.md`.
 * This lives at the workspace root (not under `memory/`) by long-standing
 * convention — OHQ surfaces it as the "long-term memory" reference distinct
 * from the daily rollups in `memory/YYYY-MM-DD.md`.
 *
 * Read-only: writes still go through the per-file `putMemoryFile` path; this
 * is a viewer-side helper only.
 */
export async function getLongTermMemory(input: {
  workspaceRoot: string;
}): Promise<{ content: string; size: number; updatedMs: number } | null> {
  const root = path.resolve(input.workspaceRoot);
  const filePath = path.resolve(path.join(root, "MEMORY.md"));
  // Defense-in-depth: refuse anything that escapes the workspace root.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    return { content, size: stat.size, updatedMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function deleteMemoryFile(input: {
  workspaceRoot: string;
  projectSlug: string | null;
  name: string;
}): Promise<{ deleted: true } | null> {
  const filePath = resolveMemoryFile(
    input.workspaceRoot,
    input.projectSlug,
    input.name,
  );
  if (!filePath) return null;
  return withFileLock(filePath, async () => {
    try {
      await fs.unlink(filePath);
      return { deleted: true } as const;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  });
}
