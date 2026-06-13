interface NavItem {
  id: string;
  label: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat",      label: "Chat",      icon: "💬" },
  { id: "sessions",  label: "Sessions",  icon: "📚" },
  { id: "channels",  label: "Channels",  icon: "📡" },
  { id: "mcps",      label: "MCPs",      icon: "🛠️" },
  { id: "skills",    label: "Skills",    icon: "🧠" },
  { id: "models",    label: "Models",    icon: "🧮" },
  { id: "approvals", label: "Approvals", icon: "✋" },
  { id: "doctor",    label: "Doctor",    icon: "🩺" },
  { id: "rpc",       label: "RPC",       icon: "⚙️" },
];

interface Props {
  active: string;
  onSelect(id: string): void;
}

export function NavRail({ active, onSelect }: Props) {
  return (
    <nav className="nav-rail" aria-label="primary">
      {NAV_ITEMS.map((it) => (
        <button
          key={it.id}
          className={`nav-rail-btn ${active === it.id ? "active" : ""}`}
          onClick={() => onSelect(it.id)}
          aria-label={it.label}
          title={it.label}
        >
          <span className="nav-rail-icon">{it.icon}</span>
          <span className="nav-rail-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
