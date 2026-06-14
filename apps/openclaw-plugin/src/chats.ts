import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const CHATS_DIR = path.join(os.homedir(), ".openclaw", "clawhq", "data", "chats");

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const VALID_CHAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "tool" entries persist a structured tool-call record. Their `content` is a
// JSON-stringified blob of { toolCallId, name, args, result, isError,
// startedMs, doneMs } so older readers see a self-describing payload and the
// SPA can reconstruct ToolBlock state on history load.
export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdMs: number;
}

export interface Chat {
  id: string;
  projectSlug: string | null;
  title: string;
  createdMs: number;
  updatedMs: number;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  projectSlug: string | null;
  title: string;
  createdMs: number;
  updatedMs: number;
  messageCount: number;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(CHATS_DIR, { recursive: true });
}

function chatPath(id: string): string {
  return path.join(CHATS_DIR, `${id}.json`);
}

// Per-chat write lock: serializes multiple appends so concurrent callers
// don't trample each other when rewriting the whole file. Mirrors OHQ's
// withChatLock pattern.
const chatLocks = new Map<string, Promise<unknown>>();

function withChatLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(id) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  chatLocks.set(id, tail);
  void tail.then(() => {
    if (chatLocks.get(id) === tail) chatLocks.delete(id);
  });
  return result;
}

async function writeChatAtomic(chat: Chat): Promise<void> {
  await ensureDir();
  chat.updatedMs = Date.now();
  const tmp = `${chatPath(chat.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(chat, null, 2), "utf8");
  await fs.rename(tmp, chatPath(chat.id));
}

async function readChat(id: string): Promise<Chat | null> {
  if (!VALID_CHAT_ID.test(id)) return null;
  try {
    const raw = await fs.readFile(chatPath(id), "utf8");
    return JSON.parse(raw) as Chat;
  } catch {
    return null;
  }
}

export async function listChats(projectSlug?: string): Promise<ChatSummary[]> {
  await ensureDir();
  if (projectSlug !== undefined && projectSlug !== null) {
    if (!VALID_SLUG.test(projectSlug)) return [];
  }
  const files = await fs.readdir(CHATS_DIR);
  const out: ChatSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(CHATS_DIR, file), "utf8");
      const chat = JSON.parse(raw) as Chat;
      if (projectSlug !== undefined && chat.projectSlug !== projectSlug)
        continue;
      out.push({
        id: chat.id,
        projectSlug: chat.projectSlug,
        title: chat.title,
        createdMs: chat.createdMs,
        updatedMs: chat.updatedMs,
        messageCount: chat.messages.length,
      });
    } catch {
      // skip corrupt file
    }
  }
  out.sort((a, b) => b.updatedMs - a.updatedMs);
  return out;
}

export async function createChat(input: {
  projectSlug?: string | null;
  title?: string;
}): Promise<Chat> {
  await ensureDir();
  const projectSlug =
    input.projectSlug && VALID_SLUG.test(input.projectSlug)
      ? input.projectSlug
      : null;
  const now = Date.now();
  const chat: Chat = {
    id: randomUUID(),
    projectSlug,
    title: input.title?.trim() || "New chat",
    createdMs: now,
    updatedMs: now,
    messages: [],
  };
  await withChatLock(chat.id, () => writeChatAtomic(chat));
  return chat;
}

export async function getChatHistory(id: string): Promise<Chat | null> {
  return readChat(id);
}

export interface AppendResult {
  message: ChatMessage;
  projectSlug: string | null;
  updatedMs: number;
  messageCount: number;
}

export async function appendMessage(input: {
  chatId: string;
  role: ChatRole;
  content: string;
}): Promise<AppendResult | null> {
  if (!VALID_CHAT_ID.test(input.chatId)) return null;
  if (!["user", "assistant", "system", "tool"].includes(input.role)) return null;
  const content = (input.content ?? "").toString();
  return withChatLock(input.chatId, async () => {
    const chat = await readChat(input.chatId);
    if (!chat) return null;
    const message: ChatMessage = {
      id: randomUUID(),
      role: input.role,
      content,
      createdMs: Date.now(),
    };
    chat.messages.push(message);
    await writeChatAtomic(chat);
    return {
      message,
      projectSlug: chat.projectSlug,
      updatedMs: chat.updatedMs,
      messageCount: chat.messages.length,
    };
  });
}

export async function renameChat(input: {
  chatId: string;
  title: string;
}): Promise<Chat | null> {
  if (!VALID_CHAT_ID.test(input.chatId)) return null;
  const title = (input.title ?? "").trim();
  if (!title) return null;
  return withChatLock(input.chatId, async () => {
    const chat = await readChat(input.chatId);
    if (!chat) return null;
    chat.title = title.slice(0, 200);
    await writeChatAtomic(chat);
    return chat;
  });
}

export interface DeleteResult {
  chatId: string;
  projectSlug: string | null;
}

export interface SnippetHit {
  messageId: string;
  role: ChatRole;
  createdMs: number;
  /** Context window around the first match, with [..] markers if truncated. */
  snippet: string;
}

export interface ChatSearchHit {
  id: string;
  projectSlug: string | null;
  title: string;
  updatedMs: number;
  matchCount: number;
  /** First few matched messages with surrounding text. */
  snippets: SnippetHit[];
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  totalChatsScanned: number;
  query: string;
}

const SNIPPET_WINDOW = 60;
const MAX_SNIPPETS_PER_CHAT = 3;

function buildSnippet(text: string, matchIdx: number, matchLen: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_WINDOW);
  const end = Math.min(text.length, matchIdx + matchLen + SNIPPET_WINDOW);
  const prefix = start > 0 ? "[..]" : "";
  const suffix = end < text.length ? "[..]" : "";
  // Collapse multi-line content to a single line so the snippet stays compact.
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${prefix}${slice}${suffix}`;
}

export async function searchChats(input: {
  query: string;
  projectSlug?: string | null;
  limit?: number;
}): Promise<ChatSearchResult> {
  const query = (input.query ?? "").trim();
  if (!query) return { hits: [], totalChatsScanned: 0, query };
  const needle = query.toLowerCase();
  const needleLen = query.length;
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const filterSlug =
    input.projectSlug && VALID_SLUG.test(input.projectSlug) ? input.projectSlug : null;
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(CHATS_DIR);
  } catch {
    return { hits: [], totalChatsScanned: 0, query };
  }
  const hits: ChatSearchHit[] = [];
  let scanned = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    scanned++;
    let chat: Chat;
    try {
      const raw = await fs.readFile(path.join(CHATS_DIR, file), "utf8");
      chat = JSON.parse(raw) as Chat;
    } catch {
      continue;
    }
    if (filterSlug && chat.projectSlug !== filterSlug) continue;

    let matchCount = 0;
    const snippets: SnippetHit[] = [];
    // Title is also searchable so users can find "Phase B planning" by name.
    const titleLower = chat.title.toLowerCase();
    if (titleLower.includes(needle)) matchCount++;
    for (const m of chat.messages) {
      const content = m.content ?? "";
      const lower = content.toLowerCase();
      let idx = lower.indexOf(needle);
      if (idx === -1) continue;
      let perMessageMatches = 0;
      while (idx !== -1) {
        perMessageMatches++;
        idx = lower.indexOf(needle, idx + needleLen);
      }
      matchCount += perMessageMatches;
      if (snippets.length < MAX_SNIPPETS_PER_CHAT) {
        snippets.push({
          messageId: m.id,
          role: m.role,
          createdMs: m.createdMs,
          snippet: buildSnippet(content, lower.indexOf(needle), needleLen),
        });
      }
    }
    if (matchCount === 0) continue;
    hits.push({
      id: chat.id,
      projectSlug: chat.projectSlug,
      title: chat.title,
      updatedMs: chat.updatedMs,
      matchCount,
      snippets,
    });
  }
  // Sort by match count desc, tiebreak by recency desc.
  hits.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return b.updatedMs - a.updatedMs;
  });
  return { hits: hits.slice(0, limit), totalChatsScanned: scanned, query };
}

export async function deleteChat(id: string): Promise<DeleteResult | null> {
  if (!VALID_CHAT_ID.test(id)) return null;
  return withChatLock(id, async () => {
    const chat = await readChat(id);
    if (!chat) return null;
    try {
      await fs.unlink(chatPath(id));
      return { chatId: chat.id, projectSlug: chat.projectSlug };
    } catch {
      return null;
    }
  });
}
