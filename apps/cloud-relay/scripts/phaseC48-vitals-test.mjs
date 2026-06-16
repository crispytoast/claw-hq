#!/usr/bin/env node
/**
 * Phase C step 48 — PC vitals strip + chat-subheader removal.
 *
 * Frank's directive: "At the top of the chat page there is the name of the
 * chat right next to the title of the project in the bubble. You can get rid
 * of the bubble and the text it's not necessary anymore. I also want to make
 * the header the same as OHQ throughout the whole app. With the PC vitals
 * monitor as well."
 *
 * Backend: /api/system/health reading /proc/stat + /proc/meminfo + hwmon +
 * statfs + nvidia-smi, owner-gated. Frontend: SystemHealth.tsx polls 2s,
 * renders CPU%/CPU°/GPU%/GPU°/RAM%/Disk% with inline SVG icons. Mounted in
 * page-toolbar so it shows on every page. Chat-subheader (title + project
 * chip) removed.
 *
 * Source-aware smoke + live 401 probe of the new route.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const systemTs = readFileSync(
  resolve(REPO, "apps/cloud-relay/src/system.ts"),
  "utf-8",
);
const sysHealthTsx = readFileSync(
  resolve(REPO, "apps/web/src/components/SystemHealth.tsx"),
  "utf-8",
);
const chatApp = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatApp.tsx"),
  "utf-8",
);
const chatTsx = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatDetailView.tsx"),
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

console.log("Phase C step 48 — vitals + chat-subheader removal");

// Backend route.
ok(
  systemTs.includes('fastify.get("/api/system/health"'),
  "/api/system/health route registered",
);
ok(
  systemTs.includes("/proc/stat"),
  "CPU sampling reads /proc/stat",
);
ok(
  systemTs.includes("/proc/meminfo"),
  "RAM reads /proc/meminfo",
);
ok(
  systemTs.includes("/sys/class/hwmon"),
  "CPU temp reads /sys/class/hwmon",
);
ok(
  systemTs.includes("nvidia-smi --query-gpu="),
  "GPU info uses nvidia-smi CSV query",
);
ok(
  systemTs.includes("statfsSync("),
  "Disk info uses statfsSync (Node 18.15+ sync API)",
);
ok(
  /async function gpuInfo\(\)[\s\S]{0,300}timeout:\s*1500/.test(systemTs),
  "nvidia-smi exec has 1500ms timeout so missing-GPU machines don't hang",
);
ok(
  /resolveOwner\(req, config, db\);\s*if \(!owner\)/.test(
    systemTs.split('fastify.get("/api/system/health"')[1]?.slice(0, 500) ?? "",
  ),
  "health endpoint is owner-gated",
);

// Frontend component.
ok(
  /export function SystemHealth\(\)/.test(sysHealthTsx),
  "SystemHealth React component exported",
);
ok(
  /setInterval\(\(\) => \{ if \(!document\.hidden\) void tick\(\); \}, 2000\)/.test(sysHealthTsx),
  "polls every 2s and pauses when tab is hidden",
);
ok(
  /credentials: "include"/.test(sysHealthTsx),
  "fetch sends auth cookie",
);
ok(
  /const CpuIcon = /.test(sysHealthTsx),
  "inline CpuIcon SVG defined",
);
ok(
  /const GpuIcon = /.test(sysHealthTsx),
  "inline GpuIcon SVG defined",
);
ok(
  /const ThermIcon = /.test(sysHealthTsx),
  "inline ThermIcon SVG defined",
);
ok(
  /const RamIcon = /.test(sysHealthTsx),
  "inline RamIcon SVG defined",
);
ok(
  /const DiskIcon = /.test(sysHealthTsx),
  "inline DiskIcon SVG defined",
);
ok(
  /function colorFor/.test(sysHealthTsx) && /v >= 90/.test(sysHealthTsx),
  "color thresholds defined (red >= 90, accent >= 75)",
);

// Mount.
ok(
  /import \{ SystemHealth \} from "\.\/SystemHealth\.js"/.test(chatApp),
  "ChatApp imports SystemHealth",
);
ok(
  /<SystemHealth \/>/.test(chatApp),
  "ChatApp renders <SystemHealth /> in the toolbar",
);

// Chat-subheader removal.
ok(
  !/className="chat-subheader"/.test(chatTsx),
  "chat-subheader div removed from ChatDetailView",
);
ok(
  !/className="chat-subheader-chip"/.test(chatTsx),
  "chat-subheader-chip span removed from ChatDetailView",
);

// CSS.
ok(
  /\.sys-health \{/.test(css),
  ".sys-health CSS rule defined",
);
ok(
  /\.sys-health[\s\S]{0,200}tabular-nums/.test(css),
  ".sys-health uses tabular-nums so widths don't dance",
);
ok(
  /\.page-toolbar-title \{[\s\S]*?color:\s*var\(--muted-foreground\)/.test(css),
  ".page-toolbar-title color dimmed to --muted-foreground",
);
ok(
  /@media \(max-width:\s*480px\)[\s\S]*?\.sys-health-metric:nth-of-type\(2\)/.test(css),
  "narrow-screen rule hides temp metrics so 4 chips fit on phone",
);

// Live probe — endpoint mounted (401 without cookie, NOT 404).
import { execSync } from "node:child_process";
try {
  const code = execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:3838/api/system/health', { encoding: "utf-8" }).trim();
  ok(
    code === "401",
    `live: GET /api/system/health returns 401 (got ${code}) — route mounted, owner gate working`,
  );
} catch (e) {
  ok(false, `live probe failed: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\nphaseC48: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
