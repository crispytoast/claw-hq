import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const CHATS_DIR = path.join(os.homedir(), ".openclaw", "clawhq", "data", "chats");

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const VALID_CHAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatRole = "user" | "assistant" | "system";

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
  if (!["user", "assistant", "system"].includes(input.role)) return null;
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

export async function deleteChat(id: string): Promise<boolean> {
  if (!VALID_CHAT_ID.test(id)) return false;
  return withChatLock(id, async () => {
    try {
      await fs.unlink(chatPath(id));
      return true;
    } catch {
      return false;
    }
  });
}
