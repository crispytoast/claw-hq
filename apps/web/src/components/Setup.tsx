import { useEffect, useState } from "react";
import { api, type User } from "../api.js";

interface Props {
  user: User;
  onDone(): void;
}

export function Setup({ user, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [issued, setIssued] = useState<{ pairCommand: string; pairingToken: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await api.issuePairingToken(detectDeviceLabel());
      setIssued({ pairCommand: res.pairCommand, pairingToken: res.pairingToken });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Poll for an existing token in case the user paired in another tab.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const tokens = await api.listPairingTokens();
        if (tokens.some((t) => t.lastUsedAt !== null)) onDone();
      } catch { /* noop */ }
    }, 4_000);
    return () => clearInterval(id);
  }, [onDone]);

  return (
    <div className="setup-shell">
      <div className="setup-card">
        <h1>
          <span className="brand-dot" /> Pair this account with your OpenClaw
        </h1>
        <p>
          Welcome, {user.displayName}. Claw HQ talks to your local OpenClaw via a tiny tunnel agent
          you run alongside OpenClaw. One command to pair, no port-forwarding required.
        </p>

        <h2>1. Install the tunnel agent</h2>
        <p>From a checkout of the Claw HQ repo on your OpenClaw machine:</p>
        <span className="code-block">
{`cd claw-hq && pnpm install`}
        </span>

        <h2>2. Generate a pairing command</h2>
        {!issued && (
          <button className="btn-primary" onClick={issue} disabled={busy}>
            {busy ? <span className="spinner" /> : "Generate pairing command"}
          </button>
        )}
        {err && <div className="err">{err}</div>}

        {issued && (
          <>
            <p>Copy this and run it on your OpenClaw machine:</p>
            <div className="copy-row">
              <code className="code-block">{issued.pairCommand}</code>
              <button
                className={`btn-copy ${copied ? "copied" : ""}`}
                onClick={async () => {
                  await navigator.clipboard?.writeText(issued.pairCommand);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <h2>3. Start the tunnel</h2>
            <span className="code-block">{`pnpm dev:tunnel`}</span>
            <p style={{ marginTop: "1rem" }}>
              <span className="spinner" /> Waiting for the tunnel agent to connect…
            </p>
            <p style={{ fontSize: "0.8rem" }}>
              This page will refresh automatically once pairing completes.
              Or <button className="btn-ghost" style={{ padding: 0 }} onClick={onDone}>continue anyway</button>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function detectDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unnamed device";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS device";
  if (/Android/i.test(ua)) return "Android device";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux device";
  if (/Windows/i.test(ua)) return "Windows device";
  return "Browser";
}
