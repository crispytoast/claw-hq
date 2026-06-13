/**
 * `claw-hq doctor` — sanity check the local setup.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readConfig, pathExists, configPath } from "@claw-hq/cloud-relay/config";
import { discoverOpenClaw } from "@claw-hq/tunnel-agent/openclaw-config";

export async function doctor(): Promise<void> {
  const path = configPath();
  console.log(`Config: ${path}`);
  if (!pathExists(path)) {
    console.log("  ✗ Not found. Run `claw-hq init`.");
    process.exit(1);
  }
  console.log("  ✓ Found");

  const cfg = readConfig();
  console.log(`Auth mode: ${cfg.auth.mode}`);
  console.log(`Bind:      ${cfg.host}:${cfg.port}`);
  console.log(`Public:    ${cfg.publicUrl}`);
  console.log(`Run:       relay=${cfg.run.relay} tunnel=${cfg.run.tunnel}`);

  if (cfg.run.tunnel) {
    const ocPath = cfg.tunnel?.openclawConfigPath ?? resolve(homedir(), ".openclaw", "openclaw.json");
    console.log(`\nOpenClaw config: ${ocPath}`);
    if (!pathExists(ocPath)) {
      console.log("  ✗ Not found.");
    } else {
      try {
        const d = discoverOpenClaw(ocPath);
        console.log(`  ✓ Gateway: ${d.gatewayUrl}`);
        console.log(`  ✓ Token: ${d.gatewayToken.slice(0, 6)}…`);

        // Probe the Gateway WS to make sure it's actually reachable.
        const { WebSocket } = await import("ws");
        await new Promise<void>((resolveP, reject) => {
          const ws = new WebSocket(d.gatewayUrl);
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error(`timeout connecting to ${d.gatewayUrl}`));
          }, 3000);
          ws.on("open", () => {
            clearTimeout(timer);
            ws.close();
            resolveP();
          });
          ws.on("error", (err: Error) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        console.log(`  ✓ Gateway WS reachable`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ ${msg}`);
      }
    }
  }
}
