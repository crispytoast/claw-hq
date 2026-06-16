#!/usr/bin/env node
/**
 * Phase C step 51 — infinite Android back button.
 *
 * Frank: "Make the native android back button actually send us back a page.
 * Right now if I click the android back button it just closes the app. I
 * want infinite back button. Every time I use the android back button it
 * should keep going to the previous page until there is no more previous
 * pages."
 *
 * Strategy: SPA-only. Every nav-state change (page / activeKey / activeChatId
 * / activeProject / activeMemoryProject / showSettings / showInbox) gets
 * pushed onto window.history via pushState. Android's existing
 * MainActivity.onBackPressed → wv.canGoBack/goBack already routes the
 * hardware back button through this; popstate restores the prior snapshot.
 * super.onBackPressed() only fires when SPA history is exhausted, closing
 * the app.
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
const mainActivity = readFileSync(
  resolve(REPO, "apps/android/app/src/main/kotlin/app/clawhq/MainActivity.kt"),
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

console.log("Phase C step 51 — infinite back stack");

// Snapshot effect.
ok(
  /skipNextPushRef = useRef\(true\)/.test(chatApp),
  "skipNextPushRef declared (initial replaceState rather than push)",
);
ok(
  /suppressPushRef = useRef\(false\)/.test(chatApp),
  "suppressPushRef declared (popstate-driven changes don't re-push)",
);
ok(
  /window\.history\.replaceState\(snap, ""\)/.test(chatApp),
  "initial mount uses replaceState",
);
ok(
  /window\.history\.pushState\(snap, ""\)/.test(chatApp),
  "subsequent nav changes pushState",
);

// All nav fields watched.
const watched = chatApp.match(/\}, \[\s*([\s\S]*?)\s*\]\);/g) ?? [];
const navDepBlock = watched.find((b) => b.includes("activeWorkspaceMemory")) ?? "";
for (const dep of [
  "page", "activeKey", "activeChatId", "activeChatProject",
  "activeProjectSlug", "activeProjectSub",
  "activeMemoryProject", "activeWorkspaceMemory",
  "showSettings", "showInbox",
]) {
  ok(navDepBlock.includes(dep), `nav effect deps include ${dep}`);
}
ok(
  !navDepBlock.includes("mobileOpen"),
  "mobileOpen (drawer) excluded from nav deps — opening drawer ≠ navigation",
);
ok(
  !navDepBlock.includes("activeChatTitle"),
  "activeChatTitle excluded — title changes mid-stream, not a nav event",
);
ok(
  !navDepBlock.includes("chatSearchQuery"),
  "chatSearchQuery excluded — search input ≠ navigation",
);

// popstate listener.
ok(
  /window\.addEventListener\("popstate", handler\)/.test(chatApp),
  "popstate listener registered",
);
ok(
  /suppressPushRef\.current = true;\s*setPage\(s\.page\)/.test(chatApp),
  "popstate handler sets suppressPushRef before restoring state",
);
// popstate handler should close the mobile drawer so it doesn't linger over
// the restored screen. Spot-check by finding the popstate block (delimited
// by the addEventListener call and its matching return cleanup).
const popstateBlock = (() => {
  const start = chatApp.indexOf('window.addEventListener("popstate"');
  if (start < 0) return "";
  const end = chatApp.indexOf("removeEventListener", start);
  if (end < 0) return chatApp.slice(start);
  return chatApp.slice(Math.max(0, start - 3000), end);
})();
ok(
  /setMobileOpen\(false\)/.test(popstateBlock),
  "popstate handler closes the mobile drawer so it doesn't linger over restored screen",
);

// Modal close paths use history.back() so closing doesn't add a new entry.
ok(
  /onClose=\{\(\) => window\.history\.back\(\)\}/.test(chatApp),
  "Settings onClose calls window.history.back()",
);
ok(
  /onClose=\{\(\) => \{\s*window\.history\.back\(\)/.test(chatApp),
  "Inbox onClose calls window.history.back()",
);
ok(
  !/setShowSettings\(false\)/.test(chatApp),
  "no direct setShowSettings(false) — all closes go through history.back()",
);
ok(
  !/setShowInbox\(false\)/.test(chatApp),
  "no direct setShowInbox(false) — all closes go through history.back()",
);

// Android side still routes back through canGoBack/goBack so SPA pushState
// entries are walked before super.onBackPressed() closes the app.
ok(
  /override fun onBackPressed\(\)/.test(mainActivity),
  "MainActivity.onBackPressed override present",
);
ok(
  /wv\.canGoBack\(\)/.test(mainActivity) && /wv\.goBack\(\)/.test(mainActivity),
  "MainActivity uses WebView.canGoBack/goBack — picks up SPA pushState entries",
);
ok(
  /super\.onBackPressed\(\)/.test(mainActivity),
  "super.onBackPressed() still fires when SPA stack is exhausted (closes app)",
);

console.log(`\nphaseC51: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
