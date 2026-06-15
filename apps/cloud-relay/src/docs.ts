/**
 * Tiny Markdown-rendered docs site served at /docs/*.
 *
 * No npm marked / remark dep — we ship one small renderer so the relay stays
 * dep-light. The renderer covers what our docs use: ATX headings, fenced code
 * blocks (with HTML escape), inline `code`, **bold**, _italic_, links, ordered
 * and unordered lists, tables, blockquotes, horizontal rules, and YAML-style
 * frontmatter (title + description). Anything fancier is out of scope; if
 * we ever need it, we add `marked`.
 *
 * The source lives at `apps/cloud-relay/docs-src/` and is bundled into the
 * cloud-relay's package, NOT served from disk at runtime — the path is
 * resolved relative to this module's file location so it works under tsx,
 * dist, and pnpm filtered builds without env-var gymnastics.
 *
 * Also exposes `/docs/latest-version.json`, a tiny manifest the APK polls
 * for self-update.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { CLAW_HQ_VERSION } from "./version.js";

interface DocPage {
  slug: string;
  title: string;
  description: string;
  bodyHtml: string;
}

function docsRoot(): string {
  if (process.env.CLAW_HQ_DOCS_SRC) return resolve(process.env.CLAW_HQ_DOCS_SRC);
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/docs.js -> ../docs-src ; src/docs.ts -> ../docs-src
  const candidate = resolve(here, "..", "docs-src");
  if (existsSync(candidate)) return candidate;
  // Source-tree fallback when running under tsx from cloud-relay/src.
  return resolve(here, "..", "..", "docs-src");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body };
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first so other replacements don't run inside <code>.
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // Links: [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const safeUrl = /^[a-z]+:|^\//i.test(url) ? url : "#";
    const external = /^https?:\/\//i.test(safeUrl);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${safeUrl}"${attrs}>${label}</a>`;
  });
  // Bold + italic — bold first so __ isn't mistaken for italic _.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?;:]|$)/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  return out;
}

function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // consume closing ```
      const cls = lang ? ` class="lang-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }
    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      out.push("<hr/>");
      i++;
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) {
      const level = h[1]!.length;
      const slug = h[2]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${level} id="${slug}">${renderInline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        quoteLines.push(lines[i]!.slice(2));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join(" "))}</blockquote>`);
      continue;
    }
    // Unordered list
    if (/^(\s*)[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^(\s*)[-*]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    // Table — header | separator | rows
    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[i + 1]!)) {
      const head = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|")) {
        const row = lines[i]!.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
        if (row.length === 0) break;
        rows.push(row);
        i++;
      }
      const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // Paragraph — gather until blank line
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}|```|>|\d+\.\s|\s*[-*]\s)/.test(lines[i]!)) {
      paraLines.push(lines[i]!);
      i++;
    }
    out.push(`<p>${renderInline(paraLines.join(" "))}</p>`);
  }
  return out.join("\n");
}

interface NavEntry {
  slug: string;
  title: string;
}

const NAV: NavEntry[] = [
  { slug: "index", title: "Overview" },
  { slug: "install", title: "Install" },
  { slug: "quickstart", title: "Quickstart" },
  { slug: "auth", title: "Auth modes" },
  { slug: "apk", title: "APK + push" },
  { slug: "nodes", title: "Nodes" },
  { slug: "api", title: "API & RPC" },
  { slug: "troubleshoot", title: "Troubleshoot" },
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function loadPage(slug: string): DocPage | null {
  if (!SLUG_RE.test(slug)) return null;
  const root = docsRoot();
  const file = resolve(root, `${slug}.md`);
  if (!file.startsWith(root + "/") && file !== root) return null; // belt + suspenders
  if (!existsSync(file)) return null;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
  } catch { return null; }
  const raw = readFileSync(file, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  return {
    slug,
    title: meta.title ?? slug,
    description: meta.description ?? "",
    bodyHtml: renderMarkdown(body),
  };
}

function shell(page: DocPage): string {
  const navHtml = NAV.map((n) => {
    const active = n.slug === page.slug ? " class=\"active\"" : "";
    const href = n.slug === "index" ? "/docs/" : `/docs/${n.slug}`;
    return `<a href="${href}"${active}>${n.title}</a>`;
  }).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(page.title)} — Claw HQ docs</title>
<meta name="description" content="${escapeHtml(page.description)}" />
<style>
  :root {
    --bg: #1B1B1B;
    --bg-elev: #232323;
    --bg-elev2: #2c2c2c;
    --fg: #e7e7e7;
    --muted: #9a9a9a;
    --border: #353535;
    --cyan: #2ECCD9;
    --maroon: #B83C5C;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    line-height: 1.55; }
  a { color: var(--cyan); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: var(--bg-elev2); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 16px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; border-radius: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.92rem; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  th { background: var(--bg-elev); }
  blockquote { border-left: 3px solid var(--maroon); margin: 10px 0; padding: 4px 14px; color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
  .docs-wrap { display: grid; grid-template-columns: 220px 1fr; gap: 32px; max-width: 1100px;
    margin: 0 auto; padding: 32px 24px; min-height: 100vh; }
  .docs-side { border-right: 1px solid var(--border); padding-right: 24px; position: sticky; top: 24px; height: max-content; }
  .docs-brand { font-size: 0.78rem; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; margin-bottom: 16px; }
  .docs-side nav { display: flex; flex-direction: column; gap: 6px; }
  .docs-side nav a { color: var(--fg); font-size: 0.92rem; padding: 4px 8px; border-radius: 6px; }
  .docs-side nav a.active { background: var(--bg-elev2); color: var(--cyan); }
  .docs-side nav a:hover { background: var(--bg-elev); text-decoration: none; }
  .docs-back { font-size: 0.8rem; color: var(--muted); margin-top: 20px; }
  .docs-main h1 { margin-top: 0; }
  .docs-main h2 { margin-top: 1.6em; border-top: 1px solid var(--border); padding-top: 1em; }
  .docs-main p { margin: 0.6em 0; }
  @media (max-width: 720px) {
    .docs-wrap { grid-template-columns: 1fr; padding: 16px; }
    .docs-side { border-right: 0; border-bottom: 1px solid var(--border); padding-right: 0; padding-bottom: 16px; position: static; }
  }
</style>
</head>
<body>
<div class="docs-wrap">
  <aside class="docs-side">
    <div class="docs-brand">Claw HQ docs</div>
    <nav>
      ${navHtml}
    </nav>
    <div class="docs-back"><a href="/">‹ Back to app</a></div>
  </aside>
  <main class="docs-main">
    ${page.bodyHtml}
  </main>
</div>
</body>
</html>`;
}

export async function registerDocsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/docs/latest-version.json", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    return {
      version: CLAW_HQ_VERSION,
      releaseUrl: `https://github.com/crispytoast/claw-hq/releases/tag/v${CLAW_HQ_VERSION}`,
      releasedAt: null,
    };
  });

  fastify.get("/docs", async (_req, reply) => {
    reply.code(301).redirect("/docs/");
  });

  fastify.get("/docs/", async (_req, reply) => {
    const page = loadPage("index");
    if (!page) {
      reply.code(500);
      return { error: "docs source missing" };
    }
    reply.type("text/html; charset=utf-8");
    return shell(page);
  });

  fastify.get<{ Params: { slug: string } }>("/docs/:slug", async (req, reply) => {
    const slug = (req.params.slug || "").toLowerCase();
    if (slug === "latest-version.json") {
      // /docs/latest-version.json is the manifest route registered above; if
      // we reach here the matcher hit the dynamic route first — return JSON.
      reply.code(301).redirect("/docs/latest-version.json");
      return;
    }
    const page = loadPage(slug);
    if (!page) {
      reply.code(404);
      reply.type("text/html; charset=utf-8");
      return shell({
        slug: "not-found",
        title: "Not found",
        description: "",
        bodyHtml: `<h1>Not found</h1><p>No docs page at <code>/docs/${escapeHtml(slug)}</code>.</p><p><a href="/docs/">Back to overview</a></p>`,
      });
    }
    reply.type("text/html; charset=utf-8");
    return shell(page);
  });
}
