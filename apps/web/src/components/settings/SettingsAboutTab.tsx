import { useEffect, useState } from "react";
import type { User } from "../../api.js";
import { systemApi, type VersionInfo } from "../../system-api.js";

export function SettingsAboutTab({ user }: { user: User }) {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    void (async () => {
      try { setInfo(await systemApi.version()); } catch { /* noop */ }
    })();
  }, []);

  return (
    <div className="settings-pane">
      <h2>About</h2>
      <div className="settings-card">
        <dl className="settings-kv">
          <dt>Claw HQ version</dt><dd><code>{info?.current ?? "…"}</code></dd>
          <dt>Install method</dt><dd>{info?.installMethod ?? "…"}</dd>
          <dt>Signed in as</dt><dd>{user.displayName} <span style={{ opacity: 0.6 }}>({user.id})</span></dd>
        </dl>
      </div>
      <p className="settings-help" style={{ marginTop: "1rem" }}>
        Claw HQ is the self-hosted GUI for OpenClaw. Source: <em>not yet public</em>.
        Built to replace the OpenClaw terminal for ordinary use — every command in{" "}
        <code>openclaw --help</code> gets a UI counterpart over time.
      </p>
    </div>
  );
}
