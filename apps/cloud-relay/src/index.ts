/**
 * Relay standalone entry point — used by `pnpm dev:relay` and by the legacy
 * systemd unit. The CLI (`@claw-hq/cli`) calls `startServer` directly.
 */
import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("[relay] fatal:", err);
  process.exit(1);
});

const shutdown = (signal: string) => {
  console.log(`[relay] ${signal} — exiting`);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
