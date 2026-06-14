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
  type ChatRole,
} from "./chats.js";

const PLUGIN_ID = "clawhq";
const PLUGIN_VERSION = "0.0.5";

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
            "clawhq.chats.list",
            "clawhq.chats.create",
            "clawhq.chats.history",
            "clawhq.chats.append",
            "clawhq.chats.rename",
            "clawhq.chats.delete",
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
      "clawhq.chats.list",
      async ({ respond, params }) => {
        try {
          const p = (params ?? {}) as { projectSlug?: unknown };
          const projectSlug =
            typeof p.projectSlug === "string" ? p.projectSlug : undefined;
          const chats = await listChats(projectSlug);
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
      "clawhq.chats.create",
      async ({ respond, params, context }) => {
        try {
          const p = (params ?? {}) as {
            projectSlug?: unknown;
            title?: unknown;
          };
          const projectSlug =
            typeof p.projectSlug === "string" ? p.projectSlug : null;
          const title = typeof p.title === "string" ? p.title : undefined;
          const chat = await createChat({ projectSlug, title });
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
            !["user", "assistant", "system"].includes(p.role)
          ) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "role must be user|assistant|system",
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
  },
});
