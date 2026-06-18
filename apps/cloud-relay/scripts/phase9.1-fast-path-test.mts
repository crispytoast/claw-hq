/**
 * Phase 9.1 fast-path smoke test.
 *
 * Validates the fast-path orchestrator end-to-end WITHOUT needing the
 * WebSocket layer. Creates a fast-mode chat record on disk, imports
 * runFastPathTurn directly, captures broadcast envelopes via a fake
 * clients map, and asserts:
 *   - a delta arrived (proves claude streamed)
 *   - a final arrived with non-empty text
 *   - the chat record was updated with the assistant final
 *   - claudeSessionId was persisted
 *
 * Run via tsx:
 *   pnpm --filter @claw-hq/cloud-relay exec tsx scripts/phase9.1-fast-path-test.mts
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
  title: "FAST-PATH SMOKE",
  createdMs: now,
  updatedMs: now,
  messages: [
    { id: randomUUID(), role: "user", content: "Say hi in five words.", createdMs: now },
  ],
  kind: "head" as const,
  mode: "fast" as const,
};
writeFileSync(chatPath, JSON.stringify(chat, null, 2), "utf8");

console.log(`smoke chatId=${chatId}`);
console.log(`smoke sessionKey=${sessionKey}`);

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

let timedOut = false;
const overallTimer = setTimeout(() => {
  timedOut = true;
  console.error("smoke TIMEOUT after 120s — aborting");
  process.exit(2);
}, 120_000);

// runFastPathTurn expects Map<string, WebSocket>; the fake satisfies the
// duck-type (readyState + send). Cast for the smoke.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await runFastPathTurn({ clients: clients as any }, {
  chatId,
  sessionKey,
  reqId: "smoke-req-1",
  promptText: "Say hi in five words.",
});
clearTimeout(overallTimer);

await new Promise((r) => setTimeout(r, 300));

let deltas = 0;
let finalEvent: Record<string, unknown> | null = null;
let errorEvent: Record<string, unknown> | null = null;
for (const env of captured) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (env as any)?.frame?.payload;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((env as any)?.frame?.event !== "chat" || !payload) continue;
  if (payload.state === "delta") deltas += 1;
  else if (payload.state === "final") finalEvent = payload;
  else if (payload.state === "error") errorEvent = payload;
}

console.log(`\nresults:`);
console.log(`  total envelopes broadcast: ${captured.length}`);
console.log(`  delta count:               ${deltas}`);
console.log(`  final present:             ${!!finalEvent}`);
console.log(`  error present:             ${!!errorEvent}`);
if (errorEvent) console.log(`  error message:             ${errorEvent.errorMessage}`);
if (finalEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (finalEvent.message as any)?.content ?? "";
  console.log(`  final text length:         ${text.length}`);
  console.log(`  final text preview:        ${String(text).slice(0, 200)}`);
}

const after = JSON.parse(readFileSync(chatPath, "utf8"));
const lastMsg = after.messages[after.messages.length - 1];
console.log(`\npersistence:`);
console.log(`  message count:             ${after.messages.length}`);
console.log(`  last role:                 ${lastMsg?.role}`);
console.log(`  last content length:       ${(lastMsg?.content ?? "").length}`);
console.log(`  claudeSessionId set:       ${!!after.claudeSessionId} (${after.claudeSessionId ?? "n/a"})`);

try { unlinkSync(chatPath); } catch { /* ignore */ }

const finalText = finalEvent && (finalEvent.message as { content?: string } | undefined)?.content;
const ok =
  !timedOut &&
  !errorEvent &&
  deltas > 0 &&
  !!finalEvent &&
  !!(finalText && finalText.length > 0) &&
  after.messages.length === 2 &&
  after.messages[1]?.role === "assistant" &&
  !!after.claudeSessionId;

console.log(`\nverdict: ${ok ? "PASS ✓" : "FAIL ✗"}`);
process.exit(ok ? 0 : 1);
