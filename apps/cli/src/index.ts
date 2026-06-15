/**
 * Claw HQ CLI entry. Routes the first argv to a sub-command.
 */
import { init } from "./init.js";
import { start } from "./start.js";
import { pair } from "./pair.js";
import { doctor } from "./doctor.js";
import { importOhq } from "./import-ohq.js";

const VERSION = "0.0.1";

function usage(): void {
  console.log(`Claw HQ ${VERSION} — self-hosted cross-device interface for OpenClaw

Usage: claw-hq <command> [args]

Commands:
  init          Interactive setup wizard. Writes ~/.claw-hq/config.json.
  start         Start the configured services (relay, tunnel, or both).
  pair <token>  Pair this machine's tunnel with a remote Claw HQ relay.
  doctor        Sanity-check the local setup (config + OpenClaw reachability).
  import-ohq <source-dir>
                Migrate legacy Oswald-HQ chats into Claw HQ. Dry-run by default.
  help          Show this message.

Read more: https://github.com/<TBD>/claw-hq
`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "init":
      await init();
      return;
    case "start":
      await start();
      return;
    case "pair":
      pair(rest);
      return;
    case "doctor":
      await doctor();
      return;
    case "import-ohq":
      await importOhq(rest);
      return;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      usage();
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
