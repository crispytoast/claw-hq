#!/usr/bin/env node
/**
 * Phase C step 32 smoke test — In-app sudo prompt for admin ops (Phase B 4c).
 *
 * Source-only: verifies the SudoGate module exists, the API surface is
 * `requireSudo` + `clearSudoGrants` + `<SudoGate />`, and the four destructive
 * call sites (Plugins install/uninstall, Nodes remove, Config save, Pairing
 * revoke) actually invoke it. There's no relay-side change so no live check
 * is meaningful.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../web/src");

let failures = 0;
const fail = (m) => { console.error(`FAIL: ${m}`); failures++; };

const gatePath = path.resolve(webRoot, "components/SudoGate.tsx");
if (!existsSync(gatePath)) fail("SudoGate.tsx missing");
const gateSrc = readFileSync(gatePath, "utf8");
for (const sym of ["requireSudo", "clearSudoGrants", "export function SudoGate"]) {
  if (!gateSrc.includes(sym)) fail(`SudoGate.tsx missing export: ${sym}`);
}
if (!gateSrc.includes("sessionStorage")) fail("SudoGate.tsx missing sessionStorage grant cache");

const chatAppSrc = readFileSync(path.resolve(webRoot, "components/ChatApp.tsx"), "utf8");
if (!chatAppSrc.includes("<SudoGate />")) fail("ChatApp does not mount <SudoGate />");

const appSrc = readFileSync(path.resolve(webRoot, "App.tsx"), "utf8");
if (!appSrc.includes("clearSudoGrants")) fail("App.tsx does not clear sudo grants on logout");

// Required call sites
const callSites = [
  { file: "components/settings/SettingsPluginsTab.tsx", marker: "Install plugin" },
  { file: "components/settings/SettingsPluginsTab.tsx", marker: "Uninstall plugin" },
  { file: "components/pages/NodesPage.tsx", marker: "Remove paired node" },
  { file: "components/pages/ConfigEditorPage.tsx", marker: "Edit OpenClaw config" },
  { file: "components/settings/SettingsPairingTab.tsx", marker: "Revoke pairing token" },
];

for (const { file, marker } of callSites) {
  const src = readFileSync(path.resolve(webRoot, file), "utf8");
  if (!src.includes("requireSudo")) fail(`${file} does not import/call requireSudo`);
  if (!src.includes(marker)) fail(`${file} does not have sudo prompt with title "${marker}"`);
}

// Old window.confirm fallbacks should be gone from call sites we've gated.
const replacedSites = [
  "components/settings/SettingsPluginsTab.tsx",
  "components/pages/NodesPage.tsx",
  "components/settings/SettingsPairingTab.tsx",
];
for (const file of replacedSites) {
  const src = readFileSync(path.resolve(webRoot, file), "utf8");
  // Allow window.confirm in unrelated paths, but not in the same callbacks we
  // gated. A simple proxy: if every requireSudo block has been added, the
  // matching window.confirm for the same verb should be gone. Check that the
  // file has at least one requireSudo and does not retain the literal
  // `window.confirm(\`Uninstall plugin` / similar.
  if (file === "components/settings/SettingsPluginsTab.tsx" && /window\.confirm\([\s\S]{0,40}Uninstall plugin/.test(src))
    fail(`${file} still uses window.confirm for uninstall`);
  if (file === "components/pages/NodesPage.tsx" && /window\.confirm\([\s\S]{0,40}Remove paired node/.test(src))
    fail(`${file} still uses window.confirm for remove`);
  if (file === "components/settings/SettingsPairingTab.tsx" && /window\.confirm\([\s\S]{0,40}Revoke pairing/.test(src))
    fail(`${file} still uses window.confirm for revoke`);
}

// CSS for the modal
const css = readFileSync(path.resolve(webRoot, "styles.css"), "utf8");
if (!css.includes(".sudo-modal")) fail("styles.css missing .sudo-modal block");
if (!css.includes(".sudo-backdrop")) fail("styles.css missing .sudo-backdrop block");

if (failures > 0) {
  console.error(`\n  ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n  Result: SudoGate wired into 5 destructive call sites + logout clears grants + CSS present\n`);
process.exit(0);
