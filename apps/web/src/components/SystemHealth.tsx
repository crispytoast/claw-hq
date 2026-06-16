import { useEffect, useState } from "react";

interface Health {
  cpu: { usage: number | null; temp: number | null };
  ram: { used: number; total: number } | null;
  gpu: { load: number; temp: number; vramUsed: number; vramTotal: number } | null;
  disk: { used: number; total: number } | null;
  ts: number;
}

function pct(used: number, total: number): number {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

function colorFor(v: number | null): string {
  if (v === null) return "var(--muted-foreground)";
  if (v >= 90) return "var(--red, #f06868)";
  if (v >= 75) return "var(--accent)";
  return "var(--foreground)";
}

// Inline SVG icons modeled on lucide-react's stroke style (so we don't add a
// dependency just for the vitals strip). All 13×13 viewBox 0 0 24 24.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const CpuIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
  </Icon>
);
const GpuIcon = () => (
  <Icon>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h2M10 10h2M14 10h2M18 10h0M6 14h2M10 14h2M14 14h2M18 14h0" />
  </Icon>
);
const ThermIcon = () => (
  <Icon>
    <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />
  </Icon>
);
const RamIcon = () => (
  <Icon>
    <path d="M3 9h18M3 9v6h18V9M6 12v3M10 12v3M14 12v3M18 12v3" />
  </Icon>
);
const DiskIcon = () => (
  <Icon>
    <line x1="22" x2="2" y1="12" y2="12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <line x1="6" x2="6.01" y1="16" y2="16" />
    <line x1="10" x2="10.01" y1="16" y2="16" />
  </Icon>
);

function Val({ v, suffix }: { v: number | null; suffix: string }) {
  return <span style={{ color: colorFor(v) }}>{v === null ? "—" : `${v}${suffix}`}</span>;
}

/**
 * PC vitals strip ported from OHQ's SystemHealth. Polls /api/system/health
 * every 2s, pauses when the tab is backgrounded. Renders 6 metrics:
 * CPU%, CPU°, GPU%, GPU°, RAM%, Disk%. Last-good readings persist across
 * network blips.
 */
export function SystemHealth() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/system/health", { cache: "no-store", credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as Health;
        if (!cancelled) setHealth(data);
      } catch {
        // network blip — keep last reading
      }
    }
    void tick();
    const id = setInterval(() => { if (!document.hidden) void tick(); }, 2000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!health) {
    return <div className="sys-health sys-health-loading" aria-label="System health loading" />;
  }

  const cpuUsage = health.cpu.usage;
  const cpuT = health.cpu.temp;
  const ramPct = health.ram ? pct(health.ram.used, health.ram.total) : null;
  const diskPct = health.disk ? pct(health.disk.used, health.disk.total) : null;
  const gpuLoad = health.gpu?.load ?? null;
  const gpuT = health.gpu?.temp ?? null;

  const title = [
    `CPU: ${cpuUsage ?? "?"}%  ${cpuT ?? "?"}°C`,
    health.gpu ? `GPU: ${gpuLoad}%  ${gpuT}°C` : "GPU: n/a",
    health.ram ? `RAM: ${ramPct}%` : "RAM: n/a",
    health.disk ? `Disk /: ${diskPct}%` : "Disk: n/a",
  ].join("\n");

  return (
    <div className="sys-health" title={title}>
      <span className="sys-health-metric"><CpuIcon /><Val v={cpuUsage} suffix="%" /></span>
      <span className="sys-health-sep">·</span>
      <span className="sys-health-metric"><ThermIcon /><Val v={cpuT} suffix="°" /></span>
      <span className="sys-health-sep">·</span>
      <span className="sys-health-metric"><GpuIcon /><Val v={gpuLoad} suffix="%" /></span>
      <span className="sys-health-sep">·</span>
      <span className="sys-health-metric"><ThermIcon /><Val v={gpuT} suffix="°" /></span>
      <span className="sys-health-sep">·</span>
      <span className="sys-health-metric"><RamIcon /><Val v={ramPct} suffix="%" /></span>
      <span className="sys-health-sep">·</span>
      <span className="sys-health-metric"><DiskIcon /><Val v={diskPct} suffix="%" /></span>
    </div>
  );
}
