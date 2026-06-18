/**
 * Phase 9.1 fast-path resume continuity smoke.
 *
 * Sends turn 1 ("My favorite color is purple"), then turn 2 ("What's my
 * favorite color?"). Asserts the second reply mentions purple, proving
 * the `--resume <session-id>` continuity works.
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { runFastPathTurn } from "../src/fast-path.js";

const DATA_DIR = resolve(homedir(), ".openclaw", "clawhq", "data", "chats");
mkdirSync(DATA_DIR, { recursive: true });

const chatId = randomUUID();
const chatPath = resolve(DATA_DIR, `${chatId}.json`);
const sessionKey = `agent:main:clawhq-${chatId.slice(0, 8)}`;

const now = Date.now();
const chat = {
  id: chatId,
  projectSlug: null,
  title: "FAST-PATH RESUME SMOKE",
  createdMs: now,
  updatedMs: now,
  messages: [] as unknown[],
  kind: "head" as const,
  mode: "fast" as const,
};
writeFileSync(chatPath, JSON.stringify(chat, null, 2), "utf8");

interface FakeWs {
  readyState: number;
  send(payload: string): void;
}
const captured: Array<Record<string, unknown>> = [];
const fakeWs: FakeWs = {
  readyState: 1,
  send(payload) { captured.push(JSON.parse(payload)); },
};
const clients = new Map<string, unknown>();
clients.set("smoke-client", fakeWs);

function getFinalText(): string {
  for (let i = captured.length - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = captured[i] as any;
    if (env?.frame?.payload?.state === "final") {
      return env.frame.payload.message?.content ?? "";
    }
  }
  return "";
}

console.log("=== Turn 1 ===");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await runFastPathTurn({ clients: clients as any }, {
  chatId,
  sessionKey,
  reqId: "smoke-1",
  promptText: "My favorite color is purple. Please remember that.",
});
const turn1 = getFinalText();
console.log(`  reply: ${turn1.slice(0, 100)}`);

const after1 = JSON.parse(readFileSync(chatPath, "utf8"));
console.log(`  claudeSessionId set: ${!!after1.claudeSessionId} (${after1.claudeSessionId ?? "n/a"})`);
console.log(`  messages: ${after1.messages.length}`);

captured.length = 0;

console.log("\n=== Turn 2 (should resume) ===");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await runFastPathTurn({ clients: clients as any }, {
  chatId,
  sessionKey,
  reqId: "smoke-2",
  promptText: "What's my favorite color? Just the color, one word.",
});
const turn2 = getFinalText();
console.log(`  reply: ${turn2.slice(0, 100)}`);

const after2 = JSON.parse(readFileSync(chatPath, "utf8"));
console.log(`  messages: ${after2.messages.length}`);

try { unlinkSync(chatPath); } catch { /* ignore */ }

const turn2Lower = turn2.toLowerCase();
const remembered = turn2Lower.includes("purple");
console.log(`\nremembered favorite color: ${remembered ? "YES ✓" : "NO ✗"}`);

// Fast-path persists assistant-final only (SPA owns user-message persist via
// clawhq.chats.append). So we expect 2 assistant messages after 2 turns, not 4.
const ok =
  !!after1.claudeSessionId &&
  after2.claudeSessionId === after1.claudeSessionId &&
  after2.messages.length === 2 &&
  after2.messages.every((m: { role?: string }) => m.role === "assistant") &&
  remembered;

console.log(`\nverdict: ${ok ? "PASS ✓" : "FAIL ✗"}`);
process.exit(ok ? 0 : 1);
