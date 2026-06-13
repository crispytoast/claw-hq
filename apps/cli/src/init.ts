/**
 * `claw-hq init` — interactive setup wizard.
 */
import bcrypt from "bcryptjs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  defaultConfig,
  pathExists,
  writeConfig,
  type AuthMode,
  type ClawHqConfig,
} from "@claw-hq/cloud-relay/config";
import { openPrompts, header, note } from "./prompts.js";

interface ReachChoice {
  value: "local" | "lan" | "tailnet" | "public";
  label: string;
  defaultAuth: AuthMode;
  bindHost: string;
}

const REACH_CHOICES: ReachChoice[] = [
  {
    value: "local",
    label: "Just this machine (localhost only)",
    defaultAuth: "trusted-lan",
    bindHost: "127.0.0.1",
  },
  {
    value: "lan",
    label: "My LAN (same Wi-Fi / Ethernet) — shared-secret recommended",
    defaultAuth: "shared-secret",
    bindHost: "0.0.0.0",
  },
  {
    value: "tailnet",
    label: "My Tailnet / VPN — shared-secret recommended",
    defaultAuth: "shared-secret",
    bindHost: "0.0.0.0",
  },
  {
    value: "public",
    label: "Public internet (advanced — put a reverse proxy + TLS in front)",
    defaultAuth: "real-auth",
    bindHost: "127.0.0.1",
  },
];

export async function init(): Promise<void> {
  header("Claw HQ setup");
  note("This will configure Claw HQ and write ~/.claw-hq/config.json.\n");

  const cfg: ClawHqConfig = defaultConfig();
  const p = openPrompts();

  try {
    // -------- 1. OpenClaw location --------
    const defaultOpenclawPath = resolve(homedir(), ".openclaw", "openclaw.json");
    if (pathExists(defaultOpenclawPath)) {
      note(`✓ Found OpenClaw at ${defaultOpenclawPath}`);
      cfg.tunnel = { ...(cfg.tunnel ?? defaultConfig().tunnel!), openclawConfigPath: defaultOpenclawPath };
    } else {
      note(`⚠ OpenClaw not found at ${defaultOpenclawPath}`);
      const path = await p.ask("Path to your OpenClaw config (or blank to configure later):", "");
      if (path && pathExists(path)) {
        cfg.tunnel = { ...(cfg.tunnel ?? defaultConfig().tunnel!), openclawConfigPath: path };
      } else {
        note("  Skipping. Edit ~/.claw-hq/config.json or install OpenClaw first.");
      }
    }

    // -------- 2. Reach --------
    const reach = await p.askChoice<ReachChoice["value"]>(
      "Where do you want to access Claw HQ from?",
      REACH_CHOICES.map((c) => ({ value: c.value, label: c.label })),
      0,
    );
    const reachChoice = REACH_CHOICES.find((c) => c.value === reach)!;
    cfg.host = reachChoice.bindHost;

    // -------- 3. Auth mode --------
    const authMode = await p.askChoice<AuthMode>(
      `Auth mode (recommended: ${reachChoice.defaultAuth})`,
      [
        { value: "trusted-lan", label: "trusted-lan — no password (everyone reachable is trusted)" },
        { value: "shared-secret", label: "shared-secret — one passphrase for everyone" },
        { value: "real-auth", label: "real-auth — email + password accounts" },
      ],
      ["trusted-lan", "shared-secret", "real-auth"].indexOf(reachChoice.defaultAuth),
    );
    cfg.auth = { mode: authMode };

    if (authMode === "shared-secret") {
      let pw = "";
      while (pw.length < 6) {
        pw = await p.askPassword("Set a passphrase (≥6 chars):");
        if (pw.length < 6) note("  Too short, try again.");
      }
      const confirm = await p.askPassword("Confirm passphrase:");
      if (pw !== confirm) {
        note("Passphrases didn't match. Aborting.");
        process.exit(1);
      }
      cfg.auth.sharedSecretHash = await bcrypt.hash(pw, 10);
    }

    // -------- 4. Port --------
    const portStr = await p.ask("Port to listen on:", String(cfg.port));
    const port = Number(portStr);
    if (Number.isInteger(port) && port > 0 && port < 65536) cfg.port = port;

    // -------- 5. publicUrl --------
    const defaultPublic = reachChoice.value === "local" ? `http://localhost:${cfg.port}` : `http://<your-host>:${cfg.port}`;
    cfg.publicUrl = await p.ask("Public URL (shown in pairing instructions):", defaultPublic);

    writeConfig(cfg);
    header("All set");
    note(`✓ Wrote config to ${process.env.CLAW_HQ_CONFIG ?? resolve(homedir(), ".claw-hq", "config.json")}`);
    note("\nNext:");
    note("  claw-hq start          # run relay + tunnel in this terminal");
    if (authMode === "trusted-lan") {
      note(`  open ${cfg.publicUrl}/  # then visit Claw HQ`);
    } else if (authMode === "shared-secret") {
      note(`  open ${cfg.publicUrl}/  # sign in with your passphrase`);
    } else {
      note(`  open ${cfg.publicUrl}/  # sign up for the first account`);
    }
    if (reach !== "local") {
      note("\nReminder: you picked a non-localhost reach. The relay binds 0.0.0.0;");
      note("make sure your firewall / Tailnet ACLs are configured before you start.");
    }
  } finally {
    p.close();
  }
}
