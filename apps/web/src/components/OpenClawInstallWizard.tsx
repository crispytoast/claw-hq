import { useCallback, useEffect, useMemo, useState } from "react";
import { systemApi, type OpenClawStatus } from "../system-api.js";
import { Check, X } from "./icons.js";

interface Props {
  onSkip(): void;
  onReady(): void;
}

type Step = "install" | "start" | "ready";
type PlatformHint = "macos" | "linux" | "windows" | "docker" | "unknown";

function detectPlatform(): PlatformHint {
  if (typeof navigator === "undefined") return "unknown";
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux") || ua.includes("x11") || ua.includes("ubuntu")) return "linux";
  if (ua.includes("win")) return "windows";
  return "unknown";
}

function statusToStep(status: OpenClawStatus | null): Step {
  if (!status) return "install";
  if (!status.installed) return "install";
  if (!status.reachable) return "start";
  return "ready";
}

const INSTALL_COMMANDS: Record<PlatformHint, Array<{ label: string; command: string; note?: string }>> = {
  macos: [
    {
      label: "Homebrew",
      command: "brew install openclaw",
      note: "Recommended on macOS. Adds `openclaw` to your PATH.",
    },
    {
      label: "npm (Node 22+)",
      command: "npm install -g openclaw",
      note: "Cross-platform if you already have Node.",
    },
    {
      label: "Docker",
      command: "docker run --rm -it openclaw/openclaw init",
      note: "Sandboxed; runs the daemon inside the container.",
    },
  ],
  linux: [
    {
      label: "Install script",
      command: "curl -fsSL https://openclaw.ai/install.sh | sh",
      note: "Installs Node 22 if missing, then the openclaw CLI.",
    },
    {
      label: "npm (Node 22+)",
      command: "sudo npm install -g openclaw",
      note: "If you already have Node 22.",
    },
    {
      label: "Docker",
      command: "docker run --rm -it openclaw/openclaw init",
    },
  ],
  windows: [
    {
      label: "npm (Node 22+)",
      command: "npm install -g openclaw",
      note: "Install Node 22 from nodejs.org first if you don't have it.",
    },
    {
      label: "Docker Desktop",
      command: "docker run --rm -it openclaw/openclaw init",
      note: "Works under Docker Desktop with WSL2.",
    },
  ],
  docker: [
    {
      label: "Docker",
      command: "docker run --rm -it openclaw/openclaw init",
    },
  ],
  unknown: [
    {
      label: "npm (Node 22+)",
      command: "npm install -g openclaw",
    },
    {
      label: "Install script (Linux/macOS)",
      command: "curl -fsSL https://openclaw.ai/install.sh | sh",
    },
  ],
};

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="install-cmd">
      <pre className="install-cmd-pre">{command}</pre>
      <button
        type="button"
        className="btn-ghost install-cmd-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            window.prompt("Copy:", command);
          }
        }}
      >{copied ? <>Copied <Check size={12} style={{ verticalAlign: "-2px" }} /></> : "Copy"}</button>
    </div>
  );
}

export function OpenClawInstallWizard({ onSkip, onReady }: Props) {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const platform = useMemo(detectPlatform, []);
  const step = statusToStep(status);

  const refresh = useCallback(async (showSpinner = true) => {
    if (showSpinner) setPolling(true);
    setErr(null);
    try {
      const s = await systemApi.openclaw();
      setStatus(s);
      if (s.installed && s.reachable) onReady();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (showSpinner) setPolling(false);
    }
  }, [onReady]);

  // Initial fetch.
  useEffect(() => { void refresh(true); }, [refresh]);

  // Background poll — refresh every 4s while we're not yet ready. Stops once
  // the user is done so we don't burn cycles on the relay.
  useEffect(() => {
    if (step === "ready") return;
    const id = setInterval(() => { void refresh(false); }, 4000);
    return () => clearInterval(id);
  }, [step, refresh]);

  const commands = INSTALL_COMMANDS[platform] ?? INSTALL_COMMANDS.unknown;

  return (
    <div className="auth-shell install-wizard-shell">
      <div className="install-wizard">
        <div className="install-wizard-brand">Claw HQ</div>
        <div className="install-wizard-stepper">
          <span className={`install-step ${step === "install" ? "active" : step === "start" || step === "ready" ? "done" : ""}`}>
            <span className="install-step-num">1</span> Install OpenClaw
          </span>
          <span className="install-step-sep">›</span>
          <span className={`install-step ${step === "start" ? "active" : step === "ready" ? "done" : ""}`}>
            <span className="install-step-num">2</span> Start the gateway
          </span>
          <span className="install-step-sep">›</span>
          <span className={`install-step ${step === "ready" ? "active" : ""}`}>
            <span className="install-step-num">3</span> Ready
          </span>
        </div>

        {step === "install" && (
          <>
            <h1>Install OpenClaw first</h1>
            <p className="install-help">
              Claw HQ is a UI on top of <strong>OpenClaw</strong> — the local daemon that talks
              to your AI model. Everything runs on your machine; nothing is sent to a third
              party. Pick the option that fits your setup:
            </p>
            <div className="install-options">
              {commands.map((c) => (
                <div key={c.label} className="install-option">
                  <div className="install-option-label">{c.label}</div>
                  <CopyableCommand command={c.command} />
                  {c.note && <div className="install-option-note">{c.note}</div>}
                </div>
              ))}
            </div>
            <details className="install-other-platforms">
              <summary>Other platforms / advanced installs</summary>
              <p style={{ marginTop: 8 }}>
                Full docs: <a href="https://docs.openclaw.ai" target="_blank" rel="noopener noreferrer">docs.openclaw.ai</a>.
                After the binary is on your PATH, run <code>openclaw init</code> to create
                the config — this page will refresh automatically once it detects
                <code> ~/.openclaw/openclaw.json</code>.
              </p>
            </details>
          </>
        )}

        {step === "start" && (
          <>
            <h1>Start the OpenClaw gateway</h1>
            <p className="install-help">
              OpenClaw is installed at <code>{status?.configPath}</code>, but the gateway daemon
              isn't reachable. Start it:
            </p>
            <div className="install-options">
              <div className="install-option">
                <div className="install-option-label">Linux (systemd user service)</div>
                <CopyableCommand command="systemctl --user start openclaw-gateway" />
              </div>
              <div className="install-option">
                <div className="install-option-label">macOS / generic</div>
                <CopyableCommand command="openclaw gateway run --background" />
                <div className="install-option-note">
                  Or run <code>openclaw gateway run</code> in a terminal and leave it open.
                </div>
              </div>
            </div>
            <p className="install-help" style={{ marginTop: 12 }}>
              Diagnostics: <code>openclaw doctor</code> or <code>openclaw gateway status</code>.
            </p>
            {status?.error && (
              <div className="alert error" style={{ marginTop: 12 }}>{status.error}</div>
            )}
          </>
        )}

        {step === "ready" && (
          <>
            <h1>All set</h1>
            <p className="install-help">
              OpenClaw is installed and reachable at <code>{status?.gatewayUrl}</code>. Loading
              your dashboard…
            </p>
          </>
        )}

        <div className="install-wizard-status">
          {polling ? (
            <span><span className="spinner" /> Checking…</span>
          ) : status ? (
            <span>
              {status.installed
                ? <><Check size={12} style={{ verticalAlign: "-2px" }} /> installed</>
                : <><X size={12} style={{ verticalAlign: "-2px" }} /> not installed</>}
              {status.installed && (status.reachable
                ? <>  ·  <Check size={12} style={{ verticalAlign: "-2px" }} /> gateway reachable</>
                : "  ·  gateway not reachable")}
            </span>
          ) : err ? (
            <span className="install-err">{err}</span>
          ) : null}
          <button className="btn-ghost" onClick={() => void refresh(true)} disabled={polling}>
            Recheck now
          </button>
        </div>

        <div className="install-wizard-actions">
          <button className="btn-ghost" onClick={onSkip}>
            Skip — I'll set it up later
          </button>
          {step === "ready" && (
            <button className="btn-primary" onClick={onReady}>Open Claw HQ →</button>
          )}
        </div>
      </div>
    </div>
  );
}
