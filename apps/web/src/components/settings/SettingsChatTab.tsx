import { useState } from "react";
import { getFastModeDefault, setFastModeDefault } from "../../chat-prefs.js";

/**
 * Phase 9.1 — chat preferences.
 *
 * The big one here is the fast-mode default toggle. Fast mode bypasses the
 * OpenClaw gateway for the chat-send hot path: the relay shells out to
 * `claude -p` directly (OHQ-style). More reliable for long chats; loses
 * plugin tool access in exchange.
 */
export function SettingsChatTab() {
  const [fastDefault, setFastDefaultState] = useState<boolean>(() => getFastModeDefault());

  const flip = () => {
    const next = !fastDefault;
    setFastModeDefault(next);
    setFastDefaultState(next);
  };

  return (
    <div className="settings-pane">
      <h2>Chat</h2>
      <p className="settings-help">
        Per-device chat preferences. These only affect new chats you create from this device.
      </p>

      <div className="settings-card">
        <div className="settings-card-title">Fast mode (default for new chats)</div>
        <p>
          Fast mode bypasses the OpenClaw gateway and shells out to <code>claude</code> directly for each turn.
          More reliable for long chats — no gateway buffer ceiling, no 1006 disconnects.
        </p>
        <p>
          Trade-off: <strong>no plugin tools</strong> (no MCPs, skills, channels, exec approvals).
          Pure Claude chat. Existing chats keep their original mode.
        </p>
        <label className="settings-toggle">
          <input type="checkbox" checked={fastDefault} onChange={flip} />
          <span>{fastDefault ? "Fast mode is the default for new chats" : "Use OpenClaw gateway (default)"}</span>
        </label>
      </div>
    </div>
  );
}
