import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  appendMessage,
  createChat,
  deleteChat,
  getChatHistory,
  listChats,
  renameChat,
  searchChats,
  setChatArchived,
  type ChatRole,
} from "./chats.js";
import { listAllTasks, toggleTask } from "./tasks.js";
import {
  deleteMemoryFile,
  getLongTermMemory,
  getMemoryFile,
  listMemoryFiles,
  putMemoryFile,
} from "./memory.js";
import {
  pluginsInstall,
  pluginsList,
  pluginsSearch,
  pluginsUninstall,
} from "./plugins.js";
import { getDoc, listDocs, searchDocs } from "./docs.js";
import { buildSpecialistContext } from "./specialist-context.js";

const PLUGIN_ID = "clawhq";
const PLUGIN_VERSION = "0.0.18";

type ClawHqConfig = {
  workspaceRoot?: string;
};

type SubprojectStatus = "active" | "back-burner" | "done";

const SKIP_DIRS = new Set([
  "secrets",
  "node_modules",
  ".git",
  ".openclaw",
  ".oswald-hq",
]);

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function resolveWorkspaceRoot(api: {
  pluginConfig?: Record<string, unknown>;
  config: unknown;
}): string | null {
  const cfg = (api.pluginConfig ?? {}) as ClawHqConfig;
  if (typeof cfg.workspaceRoot === "string" && cfg.workspaceRoot.trim()) {
    return cfg.workspaceRoot;
  }
  if (process.env.CLAWHQ_WORKSPACE_ROOT) {
    return process.env.CLAWHQ_WORKSPACE_ROOT;
  }
  const ocConfig = api.config as
    | { agents?: { defaults?: { workspace?: string } } }
    | undefined;
  const inherited = ocConfig?.agents?.defaults?.workspace;
  if (typeof inherited === "string" && inherited.trim()) return inherited;
  return null;
}

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

function calculateProgress(md: string): number {
  const checked = (md.match(/- \[x\]/gi) || []).length;
  const unchecked = (md.match(/- \[ \]/g) || []).length;
  const total = checked + unchecked;
  return total === 0 ? 0 : Math.round((checked / total) * 100);
}

function extractStatus(content: string): string {
  const m = content.match(/\*\*?status\*\*?:?\s*([^\n]+)/i);
  if (!m) return "Planning";
  const val = m[1]!.trim().toLowerCase();
  if (val.includes("live") || val.includes("publish")) return "Live";
  if (
    val.includes("build") ||
    val.includes("in progress") ||
    val.includes("active")
  )
    return "Build";
  if (
    val.includes("plan") ||
    val.includes("draft") ||
    val.includes("todo")
  )
    return "Planning";
  return m[1]!.trim().split(/\s+/)[0]!;
}

function parseFrontmatter(content: string): {
  data: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) return { data: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: content };
  const block = content.slice(3, end).replace(/^\n/, "");
  const body = content.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) data[m[1]!.trim()] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { data, body };
}

function parseSubprojectStatus(raw: string | undefined): SubprojectStatus {
  const v = (raw ?? "").toLowerCase().replace(/[_\s]+/g, "-");
  if (v === "back-burner" || v === "backburner" || v === "paused")
    return "back-burner";
  if (v === "done" || v === "complete" || v === "completed") return "done";
  return "active";
}

function firstNonHeadingLine(body: string): string {
  const m = body.match(/^(?!#)[^\n]+\n/m);
  if (m) return m[0].trim();
  return body
    .replace(/^#.*$/gm, "")
    .trim()
    .slice(0, 150)
    .trim();
}

async function readProjectSummary(projectsDir: string, slug: string) {
  if (!VALID_SLUG.test(slug)) return null;
  const projectDir = path.join(projectsDir, slug);
  let stat;
  try {
    stat = await fs.stat(projectDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const briefPath = path.join(projectDir, "BRIEF.md");
  const brief = await readFileSafe(briefPath);
  const nameMatch = brief.match(/^#\s+(.+)/m);
  const name = nameMatch ? nameMatch[1]!.trim() : slug;
  const blurb = firstNonHeadingLine(brief);
  const status = extractStatus(brief);
  const roadmap = await readFileSafe(path.join(projectDir, "ROADMAP.md"));
  const progress = calculateProgress(roadmap);

  return {
    id: slug,
    name,
    status,
    blurb,
    progress,
    lastUpdatedMs: stat.mtimeMs,
  };
}

async function projectsList(workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return {
      projects: [],
      workspaceRoot: null,
      hint: "workspaceRoot not configured; set plugins.entries.clawhq.config.workspaceRoot, $CLAWHQ_WORKSPACE_ROOT, or agents.defaults.workspace in openclaw.json",
    };
  }
  const projectsDir = path.join(workspaceRoot, "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return {
      projects: [],
      workspaceRoot,
      hint: `no projects/ directory under ${workspaceRoot}`,
    };
  }
  const projects: NonNullable<
    Awaited<ReturnType<typeof readProjectSummary>>
  >[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const summary = await readProjectSummary(projectsDir, e.name);
    if (summary) projects.push(summary);
  }
  projects.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs);
  return { projects, workspaceRoot };
}

async function listSubprojects(workspaceRoot: string, parent: string) {
  if (!VALID_SLUG.test(parent)) return [];
  const subsDir = path.join(workspaceRoot, "projects", parent, "subprojects");
  let entries;
  try {
    entries = await fs.readdir(subsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{
    parent: string;
    id: string;
    name: string;
    blurb: string;
    status: SubprojectStatus;
    progress: number;
    lastUpdatedMs: number;
  }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    if (!VALID_SLUG.test(e.name)) continue;
    const subDir = path.join(subsDir, e.name);
    const brief = await readFileSafe(path.join(subDir, "BRIEF.md"));
    const { data: fm, body } = parseFrontmatter(brief);
    const nameMatch = body.match(/^#\s+(.+)/m);
    const name = fm.name || (nameMatch ? nameMatch[1]!.trim() : e.name);
    const blurb = fm.blurb || firstNonHeadingLine(body);
    const status = parseSubprojectStatus(fm.status);
    const tasks = await readFileSafe(path.join(subDir, "TASKS.md"));
    const progress = calculateProgress(tasks || brief);
    let stat;
    try {
      stat = await fs.stat(subDir);
    } catch {
      continue;
    }
    out.push({
      parent,
      id: e.name,
      name,
      blurb,
      status,
      progress,
      lastUpdatedMs: stat.mtimeMs,
    });
  }
  out.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs);
  return out;
}

async function listAllSubprojects(workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return {
      subprojects: [],
      workspaceRoot: null,
      hint: "workspaceRoot not configured",
    };
  }
  const projectsDir = path.join(workspaceRoot, "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return {
      subprojects: [],
      workspaceRoot,
      hint: `no projects/ directory under ${workspaceRoot}`,
    };
  }
  const out: Array<{
    parent: string;
    id: string;
    name: string;
    blurb: string;
    status: SubprojectStatus;
    progress: number;
    lastUpdatedMs: number;
  }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    if (!VALID_SLUG.test(e.name)) continue;
    const subs = await listSubprojects(workspaceRoot, e.name);
    for (const s of subs) out.push(s);
  }
  out.sort((a, b) => b.lastUpdatedMs - a.lastUpdatedMs);
  return { subprojects: out, workspaceRoot };
}

async function subprojectGet(
  workspaceRoot: string | null,
  projectSlug: string,
  subSlug: string,
) {
  if (!workspaceRoot) return null;
  if (!VALID_SLUG.test(projectSlug)) return null;
  if (!VALID_SLUG.test(subSlug)) return null;
  const projectsDir = path.resolve(path.join(workspaceRoot, "projects"));
  const subDir = path.resolve(
    path.join(projectsDir, projectSlug, "subprojects", subSlug),
  );
  // Defense-in-depth: refuse anything that escapes projects/.
  if (!subDir.startsWith(projectsDir + path.sep)) return null;
  let stat;
  try {
    stat = await fs.stat(subDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const [brief, roadmap, tasks] = await Promise.all([
    readFileSafe(path.join(subDir, "BRIEF.md")),
    readFileSafe(path.join(subDir, "ROADMAP.md")),
    readFileSafe(path.join(subDir, "TASKS.md")),
  ]);
  const { data: fm, body } = parseFrontmatter(brief);
  const nameMatch = body.match(/^#\s+(.+)/m);
  const name = fm.name || (nameMatch ? nameMatch[1]!.trim() : subSlug);
  const blurb = fm.blurb || firstNonHeadingLine(body);
  const status = parseSubprojectStatus(fm.status);
  const progress = calculateProgress(tasks || brief);
  return {
    summary: {
      parent: projectSlug,
      id: subSlug,
      name,
      blurb,
      status,
      progress,
      lastUpdatedMs: stat.mtimeMs,
    },
    docs: { brief, roadmap, tasks },
  };
}

async function projectsGet(workspaceRoot: string | null, slug: string) {
  if (!workspaceRoot) return null;
  if (!slug || !VALID_SLUG.test(slug)) return null;
  const projectsDir = path.join(workspaceRoot, "projects");
  const summary = await readProjectSummary(projectsDir, slug);
  if (!summary) return null;
  const projectDir = path.join(projectsDir, slug);
  const [brief, roadmap, tasks, memoryIndex] = await Promise.all([
    readFileSafe(path.join(projectDir, "BRIEF.md")),
    readFileSafe(path.join(projectDir, "ROADMAP.md")),
    readFileSafe(path.join(projectDir, "TASKS.md")),
    readFileSafe(path.join(projectDir, "memory", "INDEX.md")),
  ]);
  const subprojects = await listSubprojects(workspaceRoot, slug);
  return {
    summary,
    docs: { brief, roadmap, tasks, memoryIndex },
    subprojects,
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Claw HQ",
  description:
    "Project-scoped chats, sub-project task toggles, file uploads, cross-device live feed.",
  register(api) {
    const workspaceRoot = resolveWorkspaceRoot(api);
    api.logger.info(
      `clawhq plugin loaded (v${PLUGIN_VERSION}, workspaceRoot=${
        workspaceRoot ?? "<unset>"
      })`,
    );

    // Phase 8.2 — Session-loader wiring.
    // When a turn begins on a project-scoped session (`agent:main:clawhq-*`
    // or `pmhq-*`), prepend that project's SOUL.md + AGENTS.md + BRIEF.md +
    // latest daily memory note so the specialist persona boots automatically.
    // Goes into `prependSystemContext` (cacheable, not per-turn token cost).
    // head Oswald (`oswald-*`) needs no extra context — OpenClaw's default
    // workspace prelude already loads workspace-root SOUL/USER/AGENTS.
    if (typeof api.on === "function" && workspaceRoot) {
      try {
        api.on(
          "before_prompt_build",
          async (_event, ctx) => {
            const sessionKey =
              typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
            if (!sessionKey) return;
            try {
              const result = await buildSpecialistContext({
                sessionKey,
                workspaceRoot,
              });
              if (!result.content) return;
              return { prependSystemContext: result.content };
            } catch (err) {
              api.logger.warn(
                `before_prompt_build specialist-context failed for ${sessionKey}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return;
            }
          },
          { priority: 50 },
        );
        api.logger.info("clawhq plugin: before_prompt_build specialist-context hook registered");
      } catch (err) {
        api.logger.warn(
          `clawhq plugin: before_prompt_build hook registration failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    api.registerGatewayMethod(
      "clawhq.health",
      ({ respond, client }) => {
        const c = client as
          | {
              connect?: { scopes?: unknown; role?: unknown };
              connId?: unknown;
            }
          | null
          | undefined;
        const callerScopes = Array.isArray(c?.connect?.scopes)
          ? (c.connect.scopes as unknown[]).filter(
              (s): s is string => typeof s === "string",
            )
          : [];
        respond(true, {
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          workspaceRoot,
          caller: {
            scopes: callerScopes,
            role: typeof c?.connect?.role === "string" ? c.connect.role : null,
            connId: typeof c?.connId === "string" ? c.connId : null,
          },
          methods: [
            "clawhq.health",
            "clawhq.projects.list",
            "clawhq.projects.get",
            "clawhq.subprojects.list",
            "clawhq.subprojects.get",
            "clawhq.chats.list",
            "clawhq.chats.create",
            "clawhq.chats.history",
            "clawhq.chats.append",
            "clawhq.chats.rename",
            "clawhq.chats.delete",
            "clawhq.chats.search",
            "clawhq.chats.archive",
            "clawhq.tasks.toggle",
            "clawhq.tasks.listAll",
            "clawhq.memory.list",
            "clawhq.memory.get",
            "clawhq.memory.put",
            "clawhq.memory.delete",
            "clawhq.memory.longTerm",
            "clawhq.plugins.list",
            "clawhq.plugins.search",
            "clawhq.plugins.install",
            "clawhq.plugins.uninstall",
            "clawhq.docs.list",
            "clawhq.docs.get",
            "clawhq.docs.search",
          ],
        });
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.projects.list",
      async ({ respond }) => {
        try {
          const result = await projectsList(workspaceRoot);
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.projects.get",
      async ({ respond, params }) => {
        try {
          const slug =
            typeof (params as { slug?: unknown })?.slug === "string"
              ? ((params as { slug: string }).slug as string)
              : "";
          if (!slug) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: slug",
            });
            return;
          }
          const result = await projectsGet(workspaceRoot, slug);
          if (!result) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no project: ${slug}`,
            });
            return;
          }
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.subprojects.list",
      async ({ respond }) => {
        try {
          const result = await listAllSubprojects(workspaceRoot);
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.subprojects.get",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as { projectSlug?: unknown; subSlug?: unknown };
          if (typeof p.projectSlug !== "string" || !p.projectSlug) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: projectSlug",
            });
            return;
          }
          if (typeof p.subSlug !== "string" || !p.subSlug) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: subSlug",
            });
            return;
          }
          const result = await subprojectGet(workspaceRoot, p.projectSlug, p.subSlug);
          if (!result) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no subproject: ${p.projectSlug}/${p.subSlug}`,
            });
            return;
          }
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.list",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            includeArchived?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" ? p.projectSlug : undefined;
          // Defaults to "active" so every legacy caller keeps the
          // pre-archive behavior. SPA passes "only" to fetch the per-project
          // archive tab and "all" for search/admin views.
          const includeArchived =
            p.includeArchived === "only" || p.includeArchived === "all"
              ? p.includeArchived
              : "active";
          const chats = await listChats(projectSlug, includeArchived);
          respond(true, { chats });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.search",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as {
            query?: unknown;
            projectSlug?: unknown;
            limit?: unknown;
          };
          if (typeof p.query !== "string") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: query",
            });
            return;
          }
          const result = await searchChats({
            query: p.query,
            projectSlug:
              typeof p.projectSlug === "string" ? p.projectSlug : undefined,
            limit: typeof p.limit === "number" ? p.limit : undefined,
          });
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.create",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            title?: unknown;
            kind?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" ? p.projectSlug : null;
          const title = typeof p.title === "string" ? p.title : undefined;
          const kind = p.kind === "head" ? "head" : undefined;
          const chat = await createChat({ projectSlug, title, kind });
          respond(true, { chat });
          try {
            context.broadcast("plugin.clawhq.chat.created", {
              chat: {
                id: chat.id,
                projectSlug: chat.projectSlug,
                title: chat.title,
                createdMs: chat.createdMs,
                updatedMs: chat.updatedMs,
                messageCount: chat.messages.length,
                ...(chat.kind ? { kind: chat.kind } : {}),
              },
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.chat.created broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.rename",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as { chatId?: unknown; title?: unknown };
          if (typeof p.chatId !== "string" || !p.chatId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: chatId",
            });
            return;
          }
          if (typeof p.title !== "string" || !p.title.trim()) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "title must be a non-empty string",
            });
            return;
          }
          const chat = await renameChat({ chatId: p.chatId, title: p.title });
          if (!chat) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no chat: ${p.chatId}`,
            });
            return;
          }
          respond(true, {
            chat: {
              id: chat.id,
              projectSlug: chat.projectSlug,
              title: chat.title,
              createdMs: chat.createdMs,
              updatedMs: chat.updatedMs,
              messageCount: chat.messages.length,
            },
          });
          try {
            context.broadcast("plugin.clawhq.chat.renamed", {
              chatId: chat.id,
              projectSlug: chat.projectSlug,
              title: chat.title,
              updatedMs: chat.updatedMs,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.chat.renamed broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.archive",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as { chatId?: unknown; archived?: unknown };
          if (typeof p.chatId !== "string" || !p.chatId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: chatId",
            });
            return;
          }
          // Default is archive=true so the common "Archive now" tap works
          // without callers needing to pass the flag. Pass archived=false
          // to restore a chat from the archive.
          const archived = p.archived === false ? false : true;
          const chat = await setChatArchived({ chatId: p.chatId, archived });
          if (!chat) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no chat: ${p.chatId}`,
            });
            return;
          }
          respond(true, {
            chat: {
              id: chat.id,
              projectSlug: chat.projectSlug,
              title: chat.title,
              createdMs: chat.createdMs,
              updatedMs: chat.updatedMs,
              messageCount: chat.messages.length,
              ...(chat.archived ? { archived: true } : {}),
              ...(typeof chat.archivedAt === "number" ? { archivedAt: chat.archivedAt } : {}),
            },
          });
          try {
            context.broadcast("plugin.clawhq.chat.archived", {
              chatId: chat.id,
              projectSlug: chat.projectSlug,
              archived: chat.archived === true,
              archivedAt: chat.archivedAt ?? null,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.chat.archived broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.history",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as { chatId?: unknown };
          if (typeof p.chatId !== "string" || !p.chatId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: chatId",
            });
            return;
          }
          const chat = await getChatHistory(p.chatId);
          if (!chat) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no chat: ${p.chatId}`,
            });
            return;
          }
          respond(true, { chat });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.append",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as {
            chatId?: unknown;
            role?: unknown;
            content?: unknown;
          };
          if (typeof p.chatId !== "string" || !p.chatId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: chatId",
            });
            return;
          }
          if (
            typeof p.role !== "string" ||
            !["user", "assistant", "system", "tool"].includes(p.role)
          ) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "role must be user|assistant|system|tool",
            });
            return;
          }
          if (typeof p.content !== "string") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "content must be a string",
            });
            return;
          }
          const result = await appendMessage({
            chatId: p.chatId,
            role: p.role as ChatRole,
            content: p.content,
          });
          if (!result) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no chat: ${p.chatId}`,
            });
            return;
          }
          respond(true, { message: result.message });
          // Fan out to every connected operator client so other devices viewing
          // the same chat (or the same project's chat list) update live. The
          // `plugin.*` prefix is required: the gateway broadcaster drops events
          // outside its scope-guard table unless they're plugin-namespaced.
          try {
            context.broadcast("plugin.clawhq.chat.message", {
              chatId: p.chatId,
              projectSlug: result.projectSlug,
              message: result.message,
              updatedMs: result.updatedMs,
              messageCount: result.messageCount,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.chat.message broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.tasks.listAll",
      async ({ respond }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const result = await listAllTasks({ workspaceRoot });
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.tasks.toggle",
      async ({ respond, params, context }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            subprojectSlug?: unknown;
            lineIndex?: unknown;
            checked?: unknown;
          };
          if (typeof p.projectSlug !== "string" || !p.projectSlug) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: projectSlug",
            });
            return;
          }
          if (typeof p.lineIndex !== "number") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "lineIndex must be a number",
            });
            return;
          }
          if (typeof p.checked !== "boolean") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "checked must be a boolean",
            });
            return;
          }
          const subprojectSlug =
            typeof p.subprojectSlug === "string" && p.subprojectSlug
              ? p.subprojectSlug
              : null;
          const result = await toggleTask({
            workspaceRoot,
            projectSlug: p.projectSlug,
            subprojectSlug,
            lineIndex: p.lineIndex,
            checked: p.checked,
          });
          if (!result) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no TASKS.md or line ${p.lineIndex} not a checkbox`,
            });
            return;
          }
          respond(true, {
            projectSlug: result.projectSlug,
            subprojectSlug: result.subprojectSlug,
            lineIndex: result.lineIndex,
            checked: result.checked,
            content: result.content,
            totalCount: result.totalCount,
            checkedCount: result.checkedCount,
          });
          try {
            context.broadcast("plugin.clawhq.task.toggled", {
              projectSlug: result.projectSlug,
              subprojectSlug: result.subprojectSlug,
              lineIndex: result.lineIndex,
              checked: result.checked,
              content: result.content,
              totalCount: result.totalCount,
              checkedCount: result.checkedCount,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.task.toggled broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.chats.delete",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as { chatId?: unknown };
          if (typeof p.chatId !== "string" || !p.chatId) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: chatId",
            });
            return;
          }
          const deleted = await deleteChat(p.chatId);
          if (!deleted) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no chat: ${p.chatId}`,
            });
            return;
          }
          respond(true, { deleted: true });
          try {
            context.broadcast("plugin.clawhq.chat.deleted", {
              chatId: deleted.chatId,
              projectSlug: deleted.projectSlug,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.chat.deleted broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.memory.list",
      async ({ respond, params }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as { projectSlug?: unknown };
          const projectSlug =
            typeof p.projectSlug === "string" && p.projectSlug ? p.projectSlug : null;
          const files = await listMemoryFiles({ workspaceRoot, projectSlug });
          if (!files) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: `invalid projectSlug: ${String(p.projectSlug)}`,
            });
            return;
          }
          respond(true, { projectSlug, files });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.memory.get",
      async ({ respond, params }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            name?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" && p.projectSlug ? p.projectSlug : null;
          if (typeof p.name !== "string" || !p.name) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: name",
            });
            return;
          }
          const file = await getMemoryFile({
            workspaceRoot,
            projectSlug,
            name: p.name,
          });
          if (!file) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no memory file: ${projectSlug ?? "<workspace>"}/${p.name}`,
            });
            return;
          }
          respond(true, { projectSlug, file });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.memory.put",
      async ({ respond, params, context }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            name?: unknown;
            content?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" && p.projectSlug ? p.projectSlug : null;
          if (typeof p.name !== "string" || !p.name) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: name",
            });
            return;
          }
          if (typeof p.content !== "string") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "content must be a string",
            });
            return;
          }
          const result = await putMemoryFile({
            workspaceRoot,
            projectSlug,
            name: p.name,
            content: p.content,
          });
          if (result === "TOO_LARGE") {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "content exceeds 1MB limit",
            });
            return;
          }
          if (!result) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: `invalid projectSlug or filename: ${projectSlug ?? "<workspace>"}/${p.name}`,
            });
            return;
          }
          respond(true, { projectSlug, file: result });
          try {
            context.broadcast("plugin.clawhq.memory.updated", {
              projectSlug,
              name: result.name,
              size: result.size,
              updatedMs: result.updatedMs,
              created: result.created,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.memory.updated broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.memory.delete",
      async ({ respond, params, context }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            name?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" && p.projectSlug ? p.projectSlug : null;
          if (typeof p.name !== "string" || !p.name) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: name",
            });
            return;
          }
          const result = await deleteMemoryFile({
            workspaceRoot,
            projectSlug,
            name: p.name,
          });
          if (!result) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no memory file: ${projectSlug ?? "<workspace>"}/${p.name}`,
            });
            return;
          }
          respond(true, { deleted: true });
          try {
            context.broadcast("plugin.clawhq.memory.deleted", {
              projectSlug,
              name: p.name,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.memory.deleted broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "clawhq.memory.longTerm",
      async ({ respond }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const file = await getLongTermMemory({ workspaceRoot });
          if (!file) {
            respond(true, { exists: false });
            return;
          }
          respond(true, { exists: true, file });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    // --- docs: workspace-wide markdown browser + search ---

    api.registerGatewayMethod(
      "clawhq.docs.list",
      async ({ respond }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const docs = await listDocs({ workspaceRoot });
          respond(true, { docs, workspaceRoot });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.docs.get",
      async ({ respond, params }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as { relativePath?: unknown };
          if (typeof p.relativePath !== "string" || !p.relativePath) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: relativePath",
            });
            return;
          }
          const doc = await getDoc({
            workspaceRoot,
            relativePath: p.relativePath,
          });
          if (!doc) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `no doc: ${p.relativePath}`,
            });
            return;
          }
          respond(true, { doc });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.docs.search",
      async ({ respond, params }) => {
        try {
          if (!workspaceRoot) {
            respond(false, undefined, {
              code: "PRECONDITION",
              message: "workspaceRoot not configured",
            });
            return;
          }
          const p = (params ?? {}) as { query?: unknown };
          const query = typeof p.query === "string" ? p.query : "";
          const result = await searchDocs({ workspaceRoot, query });
          respond(true, result);
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    // --- plugin management bridge: shells out to `openclaw plugins ...` ---

    api.registerGatewayMethod(
      "clawhq.plugins.list",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as { onlyEnabled?: unknown };
          const result = await pluginsList({
            onlyEnabled: p.onlyEnabled === true,
          });
          respond(true, { plugins: result.plugins });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.plugins.search",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as { query?: unknown };
          const query = typeof p.query === "string" ? p.query : "";
          const result = await pluginsSearch(query);
          respond(true, { hits: result.hits });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "clawhq.plugins.install",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as { spec?: unknown };
          const spec = typeof p.spec === "string" ? p.spec.trim() : "";
          if (!spec) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: spec",
            });
            return;
          }
          const result = await pluginsInstall(spec);
          if (!result.ok) {
            respond(false, undefined, {
              code: "INSTALL_FAILED",
              message: `openclaw plugins install ${spec} exited ${result.exitCode}: ${
                result.stderr.trim() || result.stdout.trim()
              }`,
            });
            return;
          }
          respond(true, { spec, exitCode: result.exitCode });
          try {
            context.broadcast("plugin.clawhq.plugins.changed", {
              kind: "installed",
              spec,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.plugins.changed broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      "clawhq.plugins.uninstall",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as { id?: unknown };
          const id = typeof p.id === "string" ? p.id.trim() : "";
          if (!id) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "missing required param: id",
            });
            return;
          }
          const result = await pluginsUninstall(id);
          if (!result.ok) {
            respond(false, undefined, {
              code: "UNINSTALL_FAILED",
              message: `openclaw plugins uninstall ${id} exited ${result.exitCode}: ${
                result.stderr.trim() || result.stdout.trim()
              }`,
            });
            return;
          }
          respond(true, { id, exitCode: result.exitCode });
          try {
            context.broadcast("plugin.clawhq.plugins.changed", {
              kind: "uninstalled",
              id,
            });
          } catch (e) {
            api.logger.warn(
              `plugin.clawhq.plugins.changed broadcast failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },
      { scope: "operator.admin" },
    );
  },
});
