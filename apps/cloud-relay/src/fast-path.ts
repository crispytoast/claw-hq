/**
 * Fast-path chat sender (Phase 9.1).
 *
 * OHQ-style: spawn `claude -p` per turn, stream stdout, exit. No OpenClaw
 * gateway in the hot path — bypasses the buffer ceiling + 1006 disconnects
 * that wedge long chats in the gateway routing.
 *
 * Trades plugin tools for reliability. v1 is chat-only (--tools "").
 *
 * Contract with the SPA is identical to the gateway path: the relay emits
 * the same `chat` event envelopes (delta/final/error) addressed by
 * sessionKey, so ChatDetailView.tsx needs no fast-path-aware branching.
 */
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { TunnelEnvelope } from "@claw-hq/protocol-types";
import {
  loadChatForFastPath,
  setChatClaudeSessionIdRelay,
  appendAssistantFinalIfNew,
  type Chat,
} from "./chats-storage.js";
import {
  buildClaudeArgs,
  findClaudeBin,
  parseStreamLine,
  sessionIdFromInit,
  spawn,
  textDeltaFromEvent,
} from "./claude-cli.js";

export interface FastPathDeps {
  /** Connected SPA clients keyed by clientId — fast-path broadcasts to all. */
  clients: Map<string, WebSocket>;
}

export interface FastPathRequest {
  /** Full chat UUID (resolved by ws-routing before calling here). */
  chatId: string;
  /** Session key the SPA sent — used verbatim in emitted envelopes so the
   *  SPA's per-chat dispatcher finds them (`agent:main:clawhq-<prefix>`). */
  sessionKey: string;
  /** Opaque request id from the SPA's chat.send envelope. */
  reqId: string;
  /** The user's prompt text. Already extracted by ws-routing. */
  promptText: string;
  /** Optional model override. */
  model?: string;
}

/** Per-turn idle ceiling. If the child emits zero output for this long,
 *  we kill it and synthesize a chat:error. Separate from the global
 *  watchdog (which only watches gateway-routed sessions). */
const FAST_PATH_IDLE_MS = 5 * 60_000;

/** Cap concurrent claude subprocesses to keep host memory in check. */
const MAX_CONCURRENT = 4;
let inFlight = 0;

function broadcast(deps: FastPathDeps, envelope: TunnelEnvelope): void {
  const payload = JSON.stringify(envelope);
  for (const ws of deps.clients.values()) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function makeChatEvent(opts: {
  sessionKey: string;
  state: "delta" | "final" | "error";
  runId: string;
  text?: string;
  errorMessage?: string;
}): TunnelEnvelope {
  const message =
    opts.state === "delta" || opts.state === "final"
      ? { role: "assistant", content: opts.text ?? "" }
      : undefined;
  return {
    kind: "frame",
    clientId: "fast-path",
    direction: "agent-to-client",
    frame: {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: opts.sessionKey,
        state: opts.state,
        runId: opts.runId,
        ...(message ? { message } : {}),
        ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      },
    },
  };
}

function emitError(
  deps: FastPathDeps,
  sessionKey: string,
  runId: string,
  reason: string,
): void {
  broadcast(
    deps,
    makeChatEvent({ sessionKey, state: "error", runId, errorMessage: reason }),
  );
}

/**
 * Run one fast-path turn. Resolves when the child exits (success or
 * failure). The SPA sees streaming via the broadcaster.
 */
export async function runFastPathTurn(
  deps: FastPathDeps,
  req: FastPathRequest,
): Promise<void> {
  const runId = randomUUID();

  if (inFlight >= MAX_CONCURRENT) {
    emitError(deps, req.sessionKey, runId, "Fast-path is busy — too many turns in flight. Try again in a moment.");
    return;
  }

  const bin = await findClaudeBin();
  if (!bin) {
    emitError(deps, req.sessionKey, runId, "Fast-path unavailable — `claude` CLI not on $PATH. Set CLAW_HQ_CLAUDE_BIN or install the Claude Code CLI.");
    return;
  }

  let chat: Chat | null;
  try {
    chat = await loadChatForFastPath(req.chatId);
  } catch (e) {
    emitError(deps, req.sessionKey, runId, `Could not load chat: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!chat) {
    emitError(deps, req.sessionKey, runId, `Chat not found: ${req.chatId}`);
    return;
  }
  if (chat.mode !== "fast") {
    // Defensive — caller should have already routed by mode. If we end up
    // here, surface the mismatch instead of silently doing the wrong thing.
    emitError(deps, req.sessionKey, runId, `Fast-path called on a non-fast chat (mode=${chat.mode ?? "gateway"}).`);
    return;
  }

  // NOTE: user-message persistence is owned by the SPA's existing
  // `clawhq.chats.append` RPC (which still runs through the gateway —
  // it's small, fast, and not the failure-prone path). Fast-path only
  // owns the assistant streaming + final-persist.

  inFlight += 1;

  const args = buildClaudeArgs({
    prompt: req.promptText,
    ...(req.model ? { model: req.model } : {}),
    ...(chat.claudeSessionId ? { resumeSessionId: chat.claudeSessionId } : {}),
  });

  console.log(`[fast-path] spawn chatId=${req.chatId.slice(0, 8)} resume=${chat.claudeSessionId ? "yes" : "no"} model=${req.model ?? "(default)"}`);

  const child = spawn(bin, args, {
    cwd: process.env.HOME ?? "/",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Promise the caller can await — resolves on child close OR on any
  // terminal broadcast. Lets the smoke test (and any future awaiter)
  // know the turn is done.
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((r) => { resolveDone = r; });

  let assembled = "";       // accumulated assistant text deltas
  let stderrTail = "";      // last few KB of stderr for error reports
  let stdoutBuf = "";       // line-buffering accumulator
  let capturedSessionId: string | null = null;
  let lastActivityMs = Date.now();
  let killedForIdle = false;

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivityMs >= FAST_PATH_IDLE_MS) {
      killedForIdle = true;
      console.warn(`[fast-path] idle ${FAST_PATH_IDLE_MS}ms — killing child for chatId=${req.chatId.slice(0, 8)}`);
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }
  }, 30_000);

  child.stdout?.on("data", (chunk: Buffer) => {
    lastActivityMs = Date.now();
    stdoutBuf += chunk.toString("utf8");
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const ev = parseStreamLine(line);
      if (ev) {
        // Capture session id on first turn (or any turn — they don't
        // change once set, but harmless to re-capture).
        if (!capturedSessionId) {
          const sid = sessionIdFromInit(ev);
          if (sid) {
            capturedSessionId = sid;
            void setChatClaudeSessionIdRelay({ chatId: req.chatId, claudeSessionId: sid })
              .catch((e) => console.warn(`[fast-path] persist sessionId failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
        // Stream text deltas to the SPA as chat:delta events.
        const delta = textDeltaFromEvent(ev);
        if (delta) {
          assembled += delta;
          broadcast(
            deps,
            makeChatEvent({
              sessionKey: req.sessionKey,
              state: "delta",
              runId,
              text: assembled,
            }),
          );
        }
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
  });

  child.on("error", (err) => {
    clearInterval(idleTimer);
    inFlight = Math.max(0, inFlight - 1);
    console.error(`[fast-path] spawn error chatId=${req.chatId.slice(0, 8)}: ${err.message}`);
    broadcast(
      deps,
      makeChatEvent({
        sessionKey: req.sessionKey,
        state: "error",
        runId,
        errorMessage: `Failed to spawn claude: ${err.message}`,
      }),
    );
    resolveDone();
  });

  child.on("close", async (code, signal) => {
    clearInterval(idleTimer);
    inFlight = Math.max(0, inFlight - 1);

    if (killedForIdle) {
      broadcast(
        deps,
        makeChatEvent({
          sessionKey: req.sessionKey,
          state: "error",
          runId,
          errorMessage: `Fast-path turn idle for ${FAST_PATH_IDLE_MS / 60_000} minutes with no output — killed. The Claude CLI may be stuck. Try again, or restart the relay if it keeps happening.`,
        }),
      );
      resolveDone();
      return;
    }

    const ok = code === 0 && !signal;
    if (!ok) {
      const tailHint = stderrTail.trim().split("\n").slice(-5).join(" | ").slice(0, 500);
      broadcast(
        deps,
        makeChatEvent({
          sessionKey: req.sessionKey,
          state: "error",
          runId,
          errorMessage: `claude exited code=${code} signal=${signal ?? "none"}${tailHint ? `: ${tailHint}` : ""}`,
        }),
      );
      resolveDone();
      return;
    }

    // Persist the final assistant text — dedup against any prior write.
    if (assembled) {
      try {
        await appendAssistantFinalIfNew({ chatId: req.chatId, content: assembled });
      } catch (e) {
        console.warn(`[fast-path] persist final failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Emit chat:final so SPA flips spinner off + dot to green.
    broadcast(
      deps,
      makeChatEvent({
        sessionKey: req.sessionKey,
        state: "final",
        runId,
        text: assembled,
      }),
    );

    console.log(`[fast-path] done chatId=${req.chatId.slice(0, 8)} chars=${assembled.length}`);
    resolveDone();
  });

  await donePromise;
}
