#!/usr/bin/env node
/**
 * Phase C step 52 — sidebar split + per-chat status dots + chat-complete push.
 *
 * Frank's directive after step 51:
 *  1. New sidebar tab for the raw OpenClaw sessions (background subagent
 *     processes). I named it "Agents".
 *  2. Sessions group's Recent section now shows real user chats (from
 *     clawhq.chats.list), sorted by updatedMs desc.
 *  3. Orange status dot next to a chat name when the agent is running my
 *     prompt; flips to green when state==="final" arrives.
 *  4. Push notification on chat completion. ws-routing.ts already had the
 *     agent.end hook — scoped it to clawhq-pattern sessions and rewrote the
 *     deepLink to /chat-detail/<chatIdPrefix> so the tap lands on
 *     ChatDetailView (the chat record) instead of ChatPane (raw session).
 *  5. SPA deep-link consumer resolves /chat-detail/<prefix> against
 *     recentChats once they land.
 *
 * Source-aware smoke.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const chatApp = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatApp.tsx"),
  "utf-8",
);
const sidebar = readFileSync(
  resolve(REPO, "apps/web/src/components/Sidebar.tsx"),
  "utf-8",
);
const chatDetail = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatDetailView.tsx"),
  "utf-8",
);
const wsRouting = readFileSync(
  resolve(REPO, "apps/cloud-relay/src/ws-routing.ts"),
  "utf-8",
);
const css = readFileSync(
  resolve(REPO, "apps/web/src/styles.css"),
  "utf-8",
);

let assertions = 0;
let failures = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

console.log("Phase C step 52 — sidebar split + status dots + push");

// ChatApp state + handlers.
ok(
  /export interface ChatRecentSummary/.test(chatApp),
  "ChatRecentSummary exported from ChatApp",
);
ok(
  /export type ChatStatus = "running" \| "done"/.test(chatApp),
  "ChatStatus type exported",
);
ok(
  /CLAWHQ_SESSION_PREFIX_RE = \/\^agent:main:clawhq-/.test(chatApp),
  "CLAWHQ_SESSION_PREFIX_RE constant defined",
);
ok(
  /useState<ChatRecentSummary\[\]>\(\[\]\)/.test(chatApp),
  "recentChats state declared",
);
ok(
  /useState<Map<string, ChatStatus>>\(new Map\(\)\)/.test(chatApp),
  "chatStatuses state declared",
);
ok(
  /useState<string \| null>\(null\)/.test(chatApp) && /pendingChatPrefix/.test(chatApp),
  "pendingChatPrefix state declared (deep-link drain)",
);
ok(
  /handleChatStatus = useCallback/.test(chatApp),
  "handleChatStatus callback declared",
);
ok(
  /c\.call<\{ chats\?: ChatRecentSummary\[\] \}>\(\s*"clawhq\.chats\.list",\s*\{\},\s*\)/.test(chatApp),
  "clawhq.chats.list polled with empty args (all chats)",
);
ok(
  /setInterval\(\(\) => void tick\(\), 30_000\)/.test(chatApp),
  "chats list refreshed every 30s",
);
ok(
  /CLAWHQ_SESSION_PREFIX_RE/.test(chatApp) && /handleChatStatus\(chat\.id, "done"\)/.test(chatApp),
  "global chat listener sets done on state==final via prefix match",
);
ok(
  /detail = path\.match\(\/\^\\\/chat-detail\\\/\(\.\+\)\$\/\)/.test(chatApp),
  "deep-link consumer handles /chat-detail/<prefix>",
);
ok(
  /setPendingChatPrefix\(decodeURIComponent\(detail\[1\]\)\)/.test(chatApp),
  "deep-link consumer stashes pending prefix",
);
ok(
  /if \(!pendingChatPrefix \|\| recentChats\.length === 0\) return;/.test(chatApp),
  "pending prefix drained once chats land",
);
ok(
  /onChatStatus=\{handleChatStatus\}/.test(chatApp),
  "ChatDetailView wired with onChatStatus",
);

// Sidebar consumes the new props.
ok(
  /import type \{ SessionSummary, ChatRecentSummary, ChatStatus \} from "\.\/ChatApp\.js"/.test(sidebar),
  "Sidebar imports ChatRecentSummary + ChatStatus types",
);
ok(
  /recentChats: ChatRecentSummary\[\]/.test(sidebar),
  "Sidebar props declare recentChats",
);
ok(
  /chatStatuses: Map<string, ChatStatus>/.test(sidebar),
  "Sidebar props declare chatStatuses",
);
ok(
  /agentSessions = useMemo\(\s*\(\) => sessions\.filter\(\(s\) => !s\.sessionKey\.startsWith\(CLAWHQ_SESSION_PREFIX\)\)/.test(sidebar),
  "agentSessions = sessions minus clawhq-backed keys",
);
ok(
  /Recent = clawhq\.chats\.list/.test(sidebar),
  "Recent section comment explains the new source",
);
ok(
  /recentChats\.map\(\(chat\)/.test(sidebar),
  "Recent section iterates recentChats",
);
ok(
  /chatStatuses\.get\(chat\.id\)/.test(sidebar),
  "Recent row reads per-chat status",
);
ok(
  /cl-chat-status-\$\{statusKind\}/.test(sidebar),
  "Recent row renders status dot when status is set",
);
ok(
  /const \[agentsOpen, setAgentsOpen\] = useState\(false\)/.test(sidebar),
  "Agents group has its own open/close state",
);
ok(
  /<span>Agents<\/span>/.test(sidebar),
  "Agents group header rendered",
);
ok(
  /agentSessions\.map\(\(s\)/.test(sidebar),
  "Agents group iterates agentSessions",
);

// ChatDetailView signals running on send.
ok(
  /onChatStatus\?\(chatId: string, status: "running" \| "done"\): void/.test(chatDetail),
  "ChatDetailView props declare onChatStatus",
);
ok(
  /onChatStatus\?\.\(chatId, "running"\);/.test(chatDetail),
  "sendMessage calls onChatStatus running",
);
ok(
  /onChatStatus\]\);/.test(chatDetail),
  "onChatStatus added to sendMessage useCallback deps",
);

// Backend push deep-link rewrite.
ok(
  /agent:main:clawhq-\(\[A-Za-z0-9-\]\+\)/.test(wsRouting),
  "ws-routing.ts detects clawhq-pattern sessionId",
);
ok(
  /title: "Response ready"/.test(wsRouting),
  "clawhq chat completion uses 'Response ready' push title",
);
ok(
  /deepLink: `\/chat-detail\/\$\{clawhq\[1\]\}`/.test(wsRouting),
  "deepLink rewritten to /chat-detail/<chatIdPrefix>",
);
ok(
  /kind: "chat\.complete"/.test(wsRouting),
  "clawhq notification kind is chat.complete",
);
ok(
  /chatIdPrefix: clawhq\[1\]/.test(wsRouting),
  "push data carries chatIdPrefix for client-side lookup",
);

// CSS.
ok(
  /\.cl-chat-status \{/.test(css),
  ".cl-chat-status base CSS rule defined",
);
ok(
  /\.cl-chat-status-running \{[\s\S]*?#f0a230/.test(css),
  ".cl-chat-status-running uses amber",
);
ok(
  /\.cl-chat-status-done \{[\s\S]*?#4aa064/.test(css),
  ".cl-chat-status-done uses green",
);
ok(
  /@keyframes cl-chat-status-pulse/.test(css),
  "running dot has a pulse keyframes animation",
);
ok(
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cl-chat-status-running \{ animation: none/.test(css),
  "reduced-motion disables the pulse",
);

console.log(`\nphaseC52: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
