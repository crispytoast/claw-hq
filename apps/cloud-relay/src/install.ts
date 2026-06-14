/**
 * Sideload routes for the Android APK.
 *
 * - GET /install        → HTML landing page with the download link + sideload steps.
 * - GET /install/apk    → serves the latest debug-signed APK from
 *                         `apps/android/app/build/outputs/apk/release/app-release.apk`
 *                         relative to the relay's working directory.
 *
 * Hard rule (memory: feedback-post-apk-link): every project's relay must expose
 * an `/install` URL so the agent can post the install link inline whenever a
 * new APK ships.
 */
import { existsSync, statSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ResolvedConfig } from "./config.js";

interface InstallDeps {
  config: ResolvedConfig;
}

// Anchored to this module's location so pnpm/--filter cwd shifts don't matter.
// dist/install.js → ../../../ (dist → cloud-relay → apps → repo-root).
// Override with CLAW_HQ_INSTALL_APK for non-standard layouts.
function apkPath(): string {
  if (process.env.CLAW_HQ_INSTALL_APK) return resolve(process.env.CLAW_HQ_INSTALL_APK);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..");
  return resolve(repoRoot, "apps/android/app/build/outputs/apk/release/app-release.apk");
}

export async function registerInstallRoutes(
  fastify: FastifyInstance,
  _deps: InstallDeps,
): Promise<void> {
  fastify.get("/install", async (_req, reply) => {
    const path = apkPath();
    let sizeLine = "(APK not built yet)";
    if (existsSync(path)) {
      const st = statSync(path);
      const mb = (st.size / (1024 * 1024)).toFixed(1);
      const built = new Date(st.mtimeMs).toLocaleString();
      sizeLine = `${mb} MB · built ${built}`;
    }
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Claw HQ</title>
<style>
  body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
         background:#1B1B1B; color:#eee; margin:0; padding:24px;
         display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { max-width: 420px; width: 100%; background:#262626; border:1px solid #333;
          border-radius:12px; padding:24px; }
  h1 { margin:0 0 4px; font-size:1.2rem; display:flex; align-items:center; gap:8px; }
  .brand-dot { width:10px; height:10px; border-radius:50%; background:#B83C5C; display:inline-block; }
  .sub { margin:0 0 16px; color:#999; font-size:0.85rem; }
  .meta { color:#888; font-size:0.78rem; margin-top:4px; }
  a.cta { display:block; padding:14px; background:#00d9d9; color:#1B1B1B; font-weight:700;
          text-align:center; border-radius:8px; text-decoration:none; margin:20px 0 12px; }
  ol { padding-left:20px; line-height:1.6; font-size:0.9rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#0e0e0e;
         padding:1px 6px; border-radius:4px; font-size:0.85em; }
</style>
</head>
<body>
<div class="card">
  <h1><span class="brand-dot"></span> Claw HQ</h1>
  <p class="sub">Android app — sideload from this relay.</p>
  <a class="cta" href="/install/apk">Download APK</a>
  <p class="meta">${sizeLine}</p>
  <ol>
    <li>Tap <strong>Download APK</strong> above.</li>
    <li>When the download finishes, tap the notification (or open Files → Downloads).</li>
    <li>Android may prompt you to allow installs from this browser — say yes.</li>
    <li>Open Claw HQ; on first run you'll be asked for the relay URL.</li>
  </ol>
</div>
</body>
</html>`;
    reply.type("text/html; charset=utf-8");
    return html;
  });

  fastify.get("/install/apk", async (_req, reply) => {
    const path = apkPath();
    if (!existsSync(path)) {
      reply.code(404);
      return { error: "APK not built", expected: path };
    }
    const st = statSync(path);
    reply.type("application/vnd.android.package-archive");
    reply.header("Content-Disposition", "attachment; filename=claw-hq.apk");
    reply.header("Content-Length", String(st.size));
    return reply.send(createReadStream(path));
  });
}
