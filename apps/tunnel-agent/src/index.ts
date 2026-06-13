/**
 * Standalone tunnel entry — used by `pnpm dev:tunnel` and the legacy systemd
 * unit. The CLI (`@claw-hq/cli`) calls `startTunnel` directly.
 */
import { loadConfigOrExit } from "./config.js";
import { startTunnel } from "./tunnel.js";

const config = loadConfigOrExit();

const handle = startTunnel({
  relayUrl: config.relayUrl,
  pairingToken: config.pairingToken,
  openclawConfigPath: config.openclawConfigPath,
  exitOnAuthFailure: true,
});

const shutdown = async (signal: string) => {
  console.log(`[tunnel] ${signal} — shutting down`);
  await handle.stop(`agent ${signal}`);
  setTimeout(() => process.exit(0), 250);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
