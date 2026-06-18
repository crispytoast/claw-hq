/**
 * Phase 9.3 memory-injection smoke.
 *
 * Seeds a fast-mode project chat scoped to "the-interface-claw-hq", asks
 * the agent who it is, and asserts the reply mentions "Claw HQ specialist"
 * (the persona from projects/the-interface-claw-hq/SOUL.md). If memory
 * injection works, the model SHOULD respond in-character.
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

const chat = {
  id: chatId,
  projectSlug: "the-interface-claw-hq",
  title: "MEMORY SMOKE",
  createdMs: Date.now(),
  updatedMs: Date.now(),
  messages: [] as unknown[],
  kind: "project" as const,
  mode: "fast" as const,
};
writeFileSync(chatPath, JSON.stringify(chat, null, 2), "utf8");

interface FakeWs { readyState: number; send(p: string): void; }
const captured: Array<Record<string, unknown>> = [];
const fakeWs: FakeWs = { readyState: 1, send(p) { captured.push(JSON.parse(p)); } };
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

console.log(`smoke chatId=${chatId.slice(0, 8)} projectSlug=${chat.projectSlug}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
await runFastPathTurn({ clients: clients as any }, {
  chatId,
  sessionKey,
  reqId: "smoke-mem",
  promptText: "In one sentence, who are you and what do you own?",
});
const reply = getFinalText();

console.log(`\nreply: ${reply}`);

try { unlinkSync(chatPath); } catch { /* ignore */ }

const lower = reply.toLowerCase();
// Persona is "Claw HQ specialist" per SOUL.md. Match any of the strong signals.
const signals = [
  "claw hq specialist",
  "claw hq",
  "relay",
  "tunnel",
  "apk",
];
const hits = signals.filter((s) => lower.includes(s));

console.log(`\npersona signals matched: ${hits.length}/${signals.length} (${hits.join(", ") || "none"})`);

// We're not testing exact wording — just that the model is clearly grounded
// in the loaded persona. Two of the five signals is plenty.
const ok = hits.length >= 2;
console.log(`\nverdict: ${ok ? "PASS ✓" : "FAIL ✗"}`);
process.exit(ok ? 0 : 1);
