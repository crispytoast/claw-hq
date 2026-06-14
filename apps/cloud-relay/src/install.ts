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
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ResolvedConfig } from "./config.js";

interface InstallDeps {
  config: ResolvedConfig;
}

/**
 * Best-effort lookup of the Tailscale Serve HTTPS URL for this host. Returns
 * null if Tailscale isn't running, this device isn't on a tailnet, or Serve
 * isn't configured for our port. Override via CLAW_HQ_TLS_URL when run on a
 * host that doesn't have the tailscale binary in PATH.
 */
function detectTailscaleHttpsUrl(port: number): string | null {
  if (process.env.CLAW_HQ_TLS_URL) return process.env.CLAW_HQ_TLS_URL.replace(/\/$/, "");
  try {
    const raw = execSync("tailscale status --json", {
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const status = JSON.parse(raw);
    const dnsName = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : null;
    if (!dnsName) return null;
    // We don't probe `tailscale serve status` here — Serve config is sticky
    // and operator-only; we surface the would-be URL so the user can see what
    // it'll look like even before they enable it. The /install page wraps
    // this in a "if you've enabled Tailscale Serve" caveat.
    return `https://${dnsName}`;
  } catch {
    return null;
  }
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
  deps: InstallDeps,
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
    // Surface both URL flavors so users know the HTTPS option exists. Even if
    // Tailscale Serve isn't enabled yet, the magic-DNS name is the URL they'll
    // use once it is — so we render the line as guidance.
    const tlsUrl = detectTailscaleHttpsUrl(deps.config.port);
    const tlsBlock = tlsUrl
      ? `<div class="tls-block">
           <div class="tls-label">HTTPS via Tailscale Serve</div>
           <code class="tls-url">${tlsUrl}</code>
           <p class="tls-note">Use this URL inside the APK's relay-URL prompt if you've enabled <code>tailscale serve</code> on this host. Otherwise stick with the plain HTTP URL below.</p>
         </div>`
      : "";
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
  .tls-block { margin: 20px 0 12px; padding: 12px 14px; border-radius: 8px;
               background: rgba(0,217,217,0.06); border: 1px solid rgba(0,217,217,0.25); }
  .tls-label { font-size:0.68rem; text-transform:uppercase; letter-spacing:0.06em;
               color:#00d9d9; font-weight:600; margin-bottom:4px; }
  .tls-url { display:block; font-size:0.85rem; word-break:break-all;
             background:#0e0e0e; padding:8px 10px; border-radius:4px; margin:4px 0; }
  .tls-note { margin:8px 0 0; font-size:0.75rem; color:#888; }
</style>
</head>
<body>
<div class="card">
  <h1><span class="brand-dot"></span> Claw HQ</h1>
  <p class="sub">Android app — sideload from this relay.</p>
  <a class="cta" href="/install/apk">Download APK</a>
  <p class="meta">${sizeLine}</p>
  ${tlsBlock}
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
