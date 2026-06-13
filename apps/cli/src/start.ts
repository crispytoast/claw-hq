/**
 * `claw-hq start` — start the configured Claw HQ services.
 *
 * Reads ~/.claw-hq/config.json (or CLAW_HQ_CONFIG). Starts the relay, the
 * tunnel, or both as the config dictates. In single-host mode (run.relay and
 * run.tunnel both true), the relay accepts an in-process auto-generated token
 * for /ws/agent — the user never sees it.
 */
import { randomBytes } from "node:crypto";
import { readConfig } from "@claw-hq/cloud-relay/config";
import { startServer } from "@claw-hq/cloud-relay/server";
import { startTunnel } from "@claw-hq/tunnel-agent/tunnel";

export async function start(): Promise<void> {
  const config = readConfig();

  if (!config.run.relay && !config.run.tunnel) {
    console.error("Nothing to run — both run.relay and run.tunnel are false in config.");
    process.exit(2);
  }

  const stoppers: Array<() => Promise<void>> = [];

  let inProcessToken: string | undefined;
  if (config.run.relay && config.run.tunnel && config.tunnel?.relayUrl === "in-process") {
    inProcessToken = `local-${randomBytes(16).toString("hex")}`;
  }

  if (config.run.relay) {
    const server = await startServer({ config, inProcessAgentToken: inProcessToken });
    stoppers.push(() => server.stop());
  }

  if (config.run.tunnel) {
    if (!config.tunnel) {
      console.error("run.tunnel is true but config.tunnel is missing.");
      process.exit(2);
    }
    const relayUrl = config.tunnel.relayUrl === "in-process"
      ? `ws://127.0.0.1:${config.port}`
      : config.tunnel.relayUrl;
    const token = inProcessToken ?? config.tunnel.pairingToken;
    if (!token) {
      console.error("tunnel.pairingToken is required when tunnel.relayUrl is remote.");
      console.error("Run `claw-hq pair <token>` to get one from the remote relay.");
      process.exit(2);
    }
    // Tiny delay so the relay's WS endpoint is ready before tunnel dials in-process.
    await new Promise((r) => setTimeout(r, 100));
    const tunnel = startTunnel({
      relayUrl,
      pairingToken: token,
      openclawConfigPath: config.tunnel.openclawConfigPath,
      exitOnAuthFailure: !inProcessToken,
    });
    stoppers.push(() => tunnel.stop());
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[cli] ${signal} — shutting down`);
    for (const stop of stoppers) {
      try { await stop(); } catch { /* noop */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
