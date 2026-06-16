/**
 * Stylized minimalist icon library. Single source for every glyph in the SPA.
 *
 * All icons are 14×14 by default, viewBox 0 0 24 24, lucide-style stroked
 * outlines (currentColor, stroke-width 2, round caps + joins). No fills —
 * icons inherit their color from the parent so they tint cleanly with
 * --accent / --muted-foreground / --foreground.
 *
 * Why inline SVG (not a lucide-react dep): adds zero install footprint, lets
 * us draw a few custom-fit shapes (Brain, Stethoscope, Models) that don't
 * map cleanly to lucide names, and keeps every shape visible in the diff.
 *
 * Usage: <Plus />, <Bell size={16} />, <Chevron dir="down" />.
 */
import type { CSSProperties } from "react";

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

function Svg({
  size = 14,
  className,
  style,
  title,
  children,
}: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

// ---------------- structure / nav ----------------
export const Home = (p: Props) => (<Svg {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z" /></Svg>);
export const Leaf = (p: Props) => (<Svg {...p}><path d="M11 20A7 7 0 0 1 4 13c0-5 5-9 16-9 0 11-4 16-9 16Z" /><path d="M2 22 17 7" /></Svg>);
export const Check = (p: Props) => (<Svg {...p}><polyline points="20 6 9 17 4 12" /></Svg>);
export const Books = (p: Props) => (<Svg {...p}><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></Svg>);
export const Folder = (p: Props) => (<Svg {...p}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></Svg>);
export const Document = (p: Props) => (<Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></Svg>);
export const Brain = (p: Props) => (<Svg {...p}><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4.5 17a2.5 2.5 0 0 1-1.98-3 2.5 2.5 0 0 1 0-4.96A2.5 2.5 0 0 1 4.5 7a2.5 2.5 0 0 1 2.54-2.96A2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2a2.5 2.5 0 0 0-2.5 2.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 19.5 17a2.5 2.5 0 0 0 1.98-3 2.5 2.5 0 0 0 0-4.96A2.5 2.5 0 0 0 19.5 7a2.5 2.5 0 0 0-2.54-2.96A2.5 2.5 0 0 0 14.5 2Z" /></Svg>);
export const Tools = (p: Props) => (<Svg {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Svg>);
export const Models = (p: Props) => (<Svg {...p}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" /><line x1="12" y1="22" x2="12" y2="15.5" /><polyline points="22 8.5 12 15.5 2 8.5" /><polyline points="2 15.5 12 8.5 22 15.5" /></Svg>);
export const Hand = (p: Props) => (<Svg {...p}><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></Svg>);
export const Clock = (p: Props) => (<Svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></Svg>);
export const Phone = (p: Props) => (<Svg {...p}><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12" y2="18" /></Svg>);
export const Settings = (p: Props) => (<Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.83 2.83l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.83-2.83l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.83-2.83l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.83 2.83l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>);
export const Stethoscope = (p: Props) => (<Svg {...p}><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" /><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4" /><circle cx="20" cy="10" r="2" /></Svg>);
export const Plug = (p: Props) => (<Svg {...p}><path d="M12 22v-5" /><path d="M9 7V2" /><path d="M15 7V2" /><path d="M6 13V8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" /></Svg>);

// ---------------- composer / chat ----------------
export const Plus = (p: Props) => (<Svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Svg>);
export const Mic = (p: Props) => (<Svg {...p}><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M19 10v1a7 7 0 0 1-14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /></Svg>);
export const Clip = (p: Props) => (<Svg {...p}><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></Svg>);
export const Clipboard = (p: Props) => (<Svg {...p}><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></Svg>);
export const Image = (p: Props) => (<Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></Svg>);
export const Chat = (p: Props) => (<Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Svg>);
export const Pencil = (p: Props) => (<Svg {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" /></Svg>);

// ---------------- chrome ----------------
export const Bell = (p: Props) => (<Svg {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></Svg>);
export const Menu = (p: Props) => (<Svg {...p}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></Svg>);
export const X = (p: Props) => (<Svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>);
export const Kebab = (p: Props) => (<Svg {...p}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Svg>);
export const Chevron = ({ dir = "down", ...p }: Props & { dir?: "down" | "up" | "left" | "right" }) => {
  const path =
    dir === "down" ? "M6 9l6 6 6-6" :
    dir === "up" ? "M6 15l6-6 6 6" :
    dir === "left" ? "M15 6l-6 6 6 6" :
    "M9 6l6 6-6 6";
  return <Svg {...p}><path d={path} /></Svg>;
};
export const Hourglass = (p: Props) => (<Svg {...p}><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.86a2 2 0 0 0-.59-1.41L13 12l3.41-3.66A2 2 0 0 0 17 6.92V2H7v4.92a2 2 0 0 0 .59 1.42L11 12l-3.41 3.73A2 2 0 0 0 7 17.14V22" /></Svg>);
export const Warning = (p: Props) => (<Svg {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Svg>);
export const Lock = (p: Props) => (<Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>);

// ---------------- arrows (kept SVG for icon consistency, used as button glyphs) ----------------
export const ArrowUp = (p: Props) => (<Svg {...p}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></Svg>);
export const ArrowRight = (p: Props) => (<Svg {...p}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></Svg>);
