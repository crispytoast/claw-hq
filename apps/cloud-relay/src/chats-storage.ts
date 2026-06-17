/**
 * Mirror of the chat-storage file format used by `@claw-hq/openclaw-plugin`
 * (apps/openclaw-plugin/src/chats.ts). The relay reads + writes these files
 * directly so it can persist a chat-complete assistant turn even when the SPA
 * is disconnected (screen off, phone backgrounded). Format must stay in sync
 * with the plugin — verified by the chat-roundtrip smoke.
 *
 * Both processes run on the same host so the file lock semantics interleave
 * cleanly: in-process Promise-chained per-chat lock for the relay, atomic
 * temp-rename for the file write. A reader can never observe a partial JSON.
 */
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const CHATS_DIR = resolve(homedir(), ".openclaw", "clawhq", "data", "chats");
const VALID_CHAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function chatPath(id: string): string {
  return resolve(CHATS_DIR, `${id}.json`);
}

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

async function readChat(id: string): Promise<Chat | null> {
  if (!VALID_CHAT_ID.test(id)) return null;
  try {
    const raw = await fs.readFile(chatPath(id), "utf8");
    return JSON.parse(raw) as Chat;
  } catch {
    return null;
  }
}

async function writeChatAtomic(chat: Chat): Promise<void> {
  if (!existsSync(CHATS_DIR)) await fs.mkdir(CHATS_DIR, { recursive: true });
  chat.updatedMs = Date.now();
  const tmp = `${chatPath(chat.id)}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(chat, null, 2), "utf8");
  await fs.rename(tmp, chatPath(chat.id));
}

/**
 * The SPA encodes only the first 8 characters of the chat UUID into the
 * OpenClaw session key (`agent:main:clawhq-<8chars>`). The relay sees that
 * prefix in chat-final frames; this resolver scans the chats dir for the
 * unique file whose name starts with the prefix.
 *
 * Returns null when no match or multiple matches (rare collision case).
 */
export async function resolveClawhqChatIdFromPrefix(prefix: string): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{1,36}$/.test(prefix)) return null;
  if (!existsSync(CHATS_DIR)) return null;
  try {
    const entries = await fs.readdir(CHATS_DIR);
    const matches = entries.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    if (matches.length !== 1) return null;
    const hit = matches[0]!;
    return hit.slice(0, -".json".length);
  } catch {
    return null;
  }
}

export async function chatExists(id: string): Promise<boolean> {
  if (!VALID_CHAT_ID.test(id)) return false;
  return existsSync(chatPath(id));
}

/**
 * Append an assistant message to a chat ONLY if the latest assistant message's
 * content differs from what we're about to write. Lets the relay safely
 * re-persist on disconnect/reconnect races without producing duplicates when
 * the SPA also appended.
 */
export async function appendAssistantFinalIfNew(input: {
  chatId: string;
  content: string;
}): Promise<{ appended: boolean; reason?: string }> {
  if (!VALID_CHAT_ID.test(input.chatId)) return { appended: false, reason: "invalid-id" };
  const content = (input.content ?? "").toString();
  if (!content) return { appended: false, reason: "empty" };
  return withChatLock(input.chatId, async () => {
    const chat = await readChat(input.chatId);
    if (!chat) return { appended: false, reason: "no-chat" };
    // Dedupe: if the most recent assistant message has the same text we just
    // saw, the SPA already persisted it — skip.
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (!m) continue;
      if (m.role === "assistant") {
        if (m.content === content) return { appended: false, reason: "duplicate" };
        break;
      }
      if (m.role === "user") break;
    }
    const message: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content,
      createdMs: Date.now(),
    };
    chat.messages.push(message);
    await writeChatAtomic(chat);
    return { appended: true };
  });
}
