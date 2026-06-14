import { useState } from "react";
import type { User } from "../api.js";
import { SettingsOpenClawTab } from "./settings/SettingsOpenClawTab.js";
import { SettingsUpdatesTab } from "./settings/SettingsUpdatesTab.js";
import { SettingsNotificationsTab } from "./settings/SettingsNotificationsTab.js";
import { SettingsAboutTab } from "./settings/SettingsAboutTab.js";
import { SettingsPairingTab } from "./settings/SettingsPairingTab.js";

export type SettingsTab = "openclaw" | "pairing" | "notifications" | "updates" | "about";

interface Props {
  user: User;
  onClose(): void;
  initialTab?: SettingsTab;
}

const TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: "openclaw", label: "OpenClaw" },
  { key: "pairing", label: "Pairing" },
  { key: "notifications", label: "Notifications" },
  { key: "updates", label: "Updates" },
  { key: "about", label: "About" },
];

export function Settings({ user, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "openclaw");

  return (
    <div className="settings-shell">
      <div className="settings-header">
        <button className="back-btn" onClick={onClose}>‹ Back</button>
        <div className="title">Settings</div>
        <div style={{ width: 60 }} />
      </div>

      <nav className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`settings-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        {tab === "openclaw" && <SettingsOpenClawTab />}
        {tab === "pairing" && <SettingsPairingTab />}
        {tab === "notifications" && <SettingsNotificationsTab />}
        {tab === "updates" && <SettingsUpdatesTab />}
        {tab === "about" && <SettingsAboutTab user={user} />}
      </div>
    </div>
  );
}
