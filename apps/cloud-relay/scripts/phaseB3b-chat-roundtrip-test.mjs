#!/usr/bin/env node
/**
 * Phase B step 3b smoke test — mirror the new ChatDetailView turn flow.
 *
 *   1. WS connect → wait for claw.session_ready.
 *   2. clawhq.chats.create({ projectSlug }) → grab chatId.
 *   3. clawhq.chats.append (role:"user", content:"...").
 *   4. clawhq.projects.get({ slug }) → build memory preamble.
 *   5. chat.send({ sessionKey, message: preamble + user text }).
 *   6. Wait for chat event with state:"final" → capture assistant text.
 *   7. clawhq.chats.append (role:"assistant", content:<final text>).
 *   8. clawhq.chats.history({ chatId }) → assert both messages persisted.
 *   9. clawhq.chats.delete({ chatId }) → clean up.
 *
 * Exits 0 on full success, non-zero otherwise.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const PROJECT_SLUG = process.env.CLAWHQ_TEST_PROJECT ?? "the-interface-claw-hq";

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

let nextId = 1;
const requestId = () => `c-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  const wsUrl = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(wsUrl);

  const pending = new Map(); // requestId -> {resolve, reject}
  let timedOut = false;
  let chatFinalText = null;
  let chatSendPromise = null;
  let chatSendResolve = null;

  const wallTimeout = setTimeout(() => {
    timedOut = true;
    log("FAIL", "wall-clock timeout 60s");
    try { ws.close(); } catch { /* noop */ }
  }, 60_000);

  const sendReq = (method, params) => {
    const id = requestId();
    log("SEND", `${id} ${method}`);
    ws.send(
      JSON.stringify({
        kind: "frame",
        clientId: "self",
        direction: "client-to-agent",
        frame: { type: "req", id, method, params },
      }),
    );
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  await new Promise((resolve, reject) => {
    ws.on("open", () => {
      log("OPEN", `ws ${wsUrl}`);
    });
    ws.on("error", (err) => {
      log("ERR", err.message);
      reject(err);
    });

    ws.on("message", (raw) => {
      let env;
      try { env = JSON.parse(raw.toString()); } catch { return; }
      if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
      const frame = env.frame;
      if (!frame || typeof frame !== "object") return;

      if (frame.type === "event") {
        if (frame.event === "claw.session_ready") {
          log("READY", `protocol=${frame.payload?.protocol} scopes=${(frame.payload?.scopes ?? []).join(",")}`);
          resolve();
          return;
        }
        if (frame.event === "relay.agent_offline") {
          log("FAIL", "tunnel offline");
          try { ws.close(); } catch { /* noop */ }
          return;
        }
        if (frame.event === "chat") {
          const payload = frame.payload ?? {};
          if (payload.state === "final" && payload.message?.content) {
            const parts = Array.isArray(payload.message.content) ? payload.message.content : [];
            const t = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
            if (t) {
              chatFinalText = t.text;
              log("CHAT", `final="${chatFinalText.slice(0, 80)}"`);
              if (chatSendResolve) chatSendResolve();
            }
          }
        }
        return;
      }
      if (frame.type === "res") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.payload);
        else entry.reject(new Error(`${frame.error?.code ?? "ERR"}: ${frame.error?.message ?? "(no message)"}`));
      }
    });
  });

  // 1) Create a chat scoped to the project.
  const created = await sendReq("clawhq.chats.create", {
    projectSlug: PROJECT_SLUG,
    title: "phaseB3b smoke",
  });
  const chatId = created.chat?.id;
  if (!chatId) throw new Error("clawhq.chats.create did not return chat.id");
  log("OK", `chatId=${chatId}`);

  // 2) Append user message.
  const userText = "Reply with just the single word: ok";
  await sendReq("clawhq.chats.append", {
    chatId,
    role: "user",
    content: userText,
  });
  log("OK", "appended user");

  // 3) Pull project memory for the preamble.
  let preamble = "";
  try {
    const project = await sendReq("clawhq.projects.get", { slug: PROJECT_SLUG });
    const name = project?.summary?.name ?? PROJECT_SLUG;
    const brief = (project?.docs?.brief ?? "").trim().slice(0, 4000);
    const mem = (project?.docs?.memoryIndex ?? "").trim().slice(0, 2000);
    if (brief || mem) {
      const parts = [`[Project context — ${name}]`];
      if (brief) parts.push("", "## BRIEF.md", brief);
      if (mem) parts.push("", "## memory/INDEX.md", mem);
      parts.push("", "---", "");
      preamble = parts.join("\n");
    }
  } catch (e) {
    log("WARN", `projects.get failed: ${e.message}`);
  }
  log("MEM", `preamble bytes=${preamble.length}`);

  // 4) chat.send with sessionKey + preamble + user text.
  const sessionKey = `agent:main:clawhq-${chatId.slice(0, 8)}`;
  chatSendPromise = new Promise((resolve) => { chatSendResolve = resolve; });
  const chatSendId = requestId();
  log("SEND", `${chatSendId} chat.send (sessionKey=${sessionKey})`);
  ws.send(
    JSON.stringify({
      kind: "frame",
      clientId: "self",
      direction: "client-to-agent",
      frame: {
        type: "req",
        id: chatSendId,
        method: "chat.send",
        params: {
          sessionKey,
          message: `${preamble}${userText}`,
          idempotencyKey: `phaseB3b-${Date.now()}`,
        },
      },
    }),
  );
  await chatSendPromise;
  if (!chatFinalText) throw new Error("chat.send did not stream a final reply");

  // 5) Persist assistant response.
  await sendReq("clawhq.chats.append", {
    chatId,
    role: "assistant",
    content: chatFinalText,
  });
  log("OK", "appended assistant");

  // 6) Verify history.
  const history = await sendReq("clawhq.chats.history", { chatId });
  const messages = history.chat?.messages ?? [];
  const userTurns = messages.filter((m) => m.role === "user");
  const asstTurns = messages.filter((m) => m.role === "assistant");
  if (userTurns.length !== 1) throw new Error(`expected 1 user msg, got ${userTurns.length}`);
  if (asstTurns.length !== 1) throw new Error(`expected 1 assistant msg, got ${asstTurns.length}`);
  if (userTurns[0].content !== userText) {
    throw new Error(`user content mismatch: ${JSON.stringify(userTurns[0].content)}`);
  }
  if (asstTurns[0].content !== chatFinalText) {
    throw new Error("assistant content mismatch on reload");
  }
  log("OK", `history verified — user=1 assistant=1`);

  // 7) Clean up.
  await sendReq("clawhq.chats.delete", { chatId });
  log("OK", "deleted chat");

  clearTimeout(wallTimeout);
  try { ws.close(1000, "phaseB3b complete"); } catch { /* noop */ }
  console.log(`\n  Result: "${chatFinalText}"\n`);
  process.exit(timedOut ? 1 : 0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
