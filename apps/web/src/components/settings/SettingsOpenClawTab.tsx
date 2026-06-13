import { useEffect, useState } from "react";
import { systemApi, type OpenClawStatus } from "../../system-api.js";

export function SettingsOpenClawTab() {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setBusy(true);
    setErr("");
    try {
      setStatus(await systemApi.openclaw());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  return (
    <div className="settings-pane">
      <h2>OpenClaw daemon</h2>
      <p className="settings-help">
        Claw HQ is a UI on top of OpenClaw — every chat, channel, skill, and tool flows through your local OpenClaw Gateway.
      </p>

      {busy && <div className="spinner" />}
      {err && <div className="settings-err">{err}</div>}

      {status && !status.installed && (
        <div className="settings-card warn">
          <div className="settings-card-title">OpenClaw not detected</div>
          <p>No OpenClaw config found at <code>{status.configPath}</code>.</p>
          <p>
            <a href="https://docs.openclaw.ai" target="_blank" rel="noopener noreferrer">
              Install OpenClaw →
            </a>
          </p>
        </div>
      )}

      {status && status.installed && (
        <div className="settings-card">
          <div className="settings-card-title">
            {status.reachable
              ? <><span className="dot dot-green" /> Connected</>
              : <><span className="dot dot-red" /> Not reachable</>}
          </div>
          <dl className="settings-kv">
            <dt>Gateway URL</dt><dd><code>{status.gatewayUrl ?? "—"}</code></dd>
            <dt>Config path</dt><dd><code>{status.configPath}</code></dd>
          </dl>
          {!status.reachable && status.error && <p className="settings-err">{status.error}</p>}
          {!status.reachable && (
            <p>
              OpenClaw doesn't seem to be running. Start it with{" "}
              <code>systemctl --user start openclaw-gateway</code> (Linux) or check{" "}
              <code>openclaw status</code>.
            </p>
          )}
        </div>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>More OpenClaw config (coming soon)</h2>
      <p className="settings-help">
        Future tabs will surface OpenClaw's full config surface — channels (Slack/Telegram/etc),
        MCP servers, skills, cron jobs, exec approval policy, model selection, memory, sessions,
        and node pairing — all without leaving Claw HQ.
      </p>

      <button className="btn-ghost" onClick={refresh} disabled={busy}>
        {busy ? <span className="spinner" /> : "Refresh"}
      </button>
    </div>
  );
}
