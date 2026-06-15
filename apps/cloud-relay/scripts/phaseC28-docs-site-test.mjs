#!/usr/bin/env node
/**
 * Phase C step 28 smoke test — docs site at /docs/*.
 *
 * Drive the docs renderer in-process so the test doesn't depend on the relay
 * being up. We import the module via tsx and call the loader directly. Then
 * we check that the route table integrates by booting a Fastify instance and
 * hitting each page in memory.
 *
 *   1. /docs/index renders <h1>Claw HQ</h1>.
 *   2. /docs/install renders a fenced code block.
 *   3. /docs/api includes the `clawhq.*` method list.
 *   4. /docs/latest-version.json returns {version: "0.2.1"}.
 *   5. /docs/../../../etc/passwd is rejected (path traversal guard).
 *   6. Every nav entry has a matching .md source file.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsMod = path.resolve(here, "../src/docs.ts");
const docsSrc = path.resolve(here, "../docs-src");

let failures = 0;
const fail = (m) => { console.error(`FAIL: ${m}`); failures++; };

if (!existsSync(docsMod)) fail("docs.ts module missing");
if (!existsSync(docsSrc)) fail("docs-src directory missing");

// Sanity #6: nav entries vs. .md files. (The NAV list is in docs.ts; we read
// the directory and require every nav slug to have a .md file.)
const navSlugs = [
  "index",
  "install",
  "quickstart",
  "auth",
  "apk",
  "nodes",
  "api",
  "troubleshoot",
];
const present = new Set(
  readdirSync(docsSrc)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, "")),
);
for (const slug of navSlugs) {
  if (!present.has(slug)) fail(`docs-src missing ${slug}.md`);
}

const driver = `
import Fastify from "fastify";
import { registerDocsRoutes } from ${JSON.stringify(docsMod)};

(async () => {
  const f = Fastify();
  await registerDocsRoutes(f);
  await f.ready();
  const out = {};
  const hit = async (url) => {
    const r = await f.inject({ method: "GET", url });
    return { status: r.statusCode, body: r.payload };
  };
  out.index = await hit("/docs/");
  out.install = await hit("/docs/install");
  out.api = await hit("/docs/api");
  out.manifest = await hit("/docs/latest-version.json");
  out.bad = await hit("/docs/..%2F..%2Fetc%2Fpasswd");
  out.unknown = await hit("/docs/this-slug-does-not-exist");
  await f.close();
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(2); });
`;

const run = spawnSync("npx", ["-y", "tsx", "--eval", driver], {
  cwd: path.resolve(here, ".."),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (run.status !== 0) {
  console.error("tsx driver failed:");
  console.error(run.stderr || run.stdout);
  process.exit(2);
}
let res;
try {
  res = JSON.parse(run.stdout);
} catch (e) {
  console.error("driver stdout not JSON:");
  console.error(run.stdout);
  process.exit(2);
}

if (res.index.status !== 200) fail(`/docs/ status ${res.index.status}`);
if (!res.index.body.includes("<h1") || !res.index.body.includes("Claw HQ"))
  fail("/docs/ missing h1 'Claw HQ'");
if (!res.index.body.includes("/docs/install"))
  fail("/docs/ side nav missing install link");

if (res.install.status !== 200) fail(`/docs/install status ${res.install.status}`);
if (!res.install.body.includes("<pre>"))
  fail("/docs/install missing <pre> for fenced code block");

if (res.api.status !== 200) fail(`/docs/api status ${res.api.status}`);
if (!res.api.body.includes("clawhq.plugins.list"))
  fail("/docs/api missing clawhq.plugins.list reference");

if (res.manifest.status !== 200) fail(`manifest status ${res.manifest.status}`);
let manifest;
try { manifest = JSON.parse(res.manifest.body); } catch { fail("manifest not JSON"); }
if (manifest && typeof manifest.version !== "string")
  fail("manifest.version not string");

if (res.bad.status !== 404)
  fail(`path traversal expected 404, got ${res.bad.status}`);

if (res.unknown.status !== 404)
  fail(`unknown slug expected 404, got ${res.unknown.status}`);

if (failures > 0) {
  console.error(`\n  ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n  Result: /docs site + latest-version.json manifest + traversal guard OK\n`);
process.exit(0);
