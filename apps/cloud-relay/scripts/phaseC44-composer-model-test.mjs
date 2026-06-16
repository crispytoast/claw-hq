#!/usr/bin/env node
/**
 * Phase C step 44 — composer redesign + in-composer model selector.
 *
 * Closes the side-by-side OHQ-parity gap Frank flagged after step 43:
 *  - Composer reshaped from a single horizontal row into OHQ's two-row
 *    pill: textarea on top, action row beneath ([+] [mic] [history] [model]
 *    spacer [↑]).
 *  - Default chip removed from the sub-header.
 *  - Model selector moved into the composer action row. Driven by
 *    models.list + sessions.patch — same RPCs the Models page (step 30)
 *    locked in.
 *
 * Source-aware smoke. No live relay needed.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const chatTsx = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatDetailView.tsx"),
  "utf-8",
);
const css = readFileSync(
  resolve(REPO, "apps/web/src/styles.css"),
  "utf-8",
);

let assertions = 0;
let failures = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

console.log("Phase C step 44 — composer redesign source checks");

// Sub-header model chip must be gone.
ok(
  !/className="chat-subheader-model"/.test(chatTsx),
  "sub-header model chip removed from JSX",
);

// Composer state hooks.
ok(
  /const \[currentModel, setCurrentModel\] = useState<string \| null>/.test(chatTsx),
  "currentModel state declared",
);
ok(
  /const \[modelMenuOpen, setModelMenuOpen\] = useState\(false\)/.test(chatTsx),
  "modelMenuOpen state declared",
);
ok(
  /const \[availableModels, setAvailableModels\]/.test(chatTsx),
  "availableModels state declared",
);
ok(
  /const \[modelPatching, setModelPatching\]/.test(chatTsx),
  "modelPatching state declared",
);

// Wire-up uses the same RPCs as ModelsPage step 30.
ok(
  chatTsx.includes('client.call<SessionsListResp>("sessions.list"'),
  "sessions.list used to probe current resolved model",
);
ok(
  chatTsx.includes('client.call<ModelsListResp>("models.list"'),
  "models.list used to populate menu",
);
ok(
  chatTsx.includes('"sessions.patch"'),
  "sessions.patch used to apply model override",
);

// resolvedModel preference matches ModelsPage pattern.
ok(
  /result\?\.resolvedModel \?\? result\?\.model \?\? modelId/.test(chatTsx),
  "pickModel reads resolvedModel before falling back",
);

// JSX shape — textarea above action row.
const composerRowMatch = chatTsx.match(/<div className="row">[\s\S]*?<\/div>\s*<\/div>\s*<\/>\s*\);/);
ok(composerRowMatch !== null, "composer row JSX block findable");
if (composerRowMatch) {
  const block = composerRowMatch[0];
  const textareaIdx = block.indexOf("<textarea");
  const actionsIdx = block.indexOf('className="composer-actions"');
  ok(textareaIdx >= 0 && actionsIdx >= 0 && textareaIdx < actionsIdx,
    "textarea appears BEFORE composer-actions row (OHQ vertical layout)");
}

// Composer action buttons.
ok(
  /className="composer-attach"\s*[\s\S]*?onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}/.test(chatTsx),
  "+ attach button click handler wired to file picker",
);
ok(
  /composer-model-chip/.test(chatTsx),
  ".composer-model-chip rendered",
);
ok(
  /aria-haspopup="listbox"/.test(chatTsx),
  "model chip declares listbox popup semantics",
);
ok(
  /className="composer-model-menu"/.test(chatTsx),
  ".composer-model-menu popover rendered",
);
ok(
  /role="listbox"/.test(chatTsx),
  "popover has listbox role",
);
ok(
  /onClick=\{\(\) => void pickModel\(null\)\}/.test(chatTsx),
  "Default row resets to gateway-default via pickModel(null)",
);

// CSS rules.
ok(
  /\.composer \.row \{[\s\S]*?flex-direction:\s*column/.test(css),
  ".composer .row is column-flex (textarea over actions)",
);
ok(
  /\.composer-actions \{/.test(css),
  ".composer-actions CSS rule defined",
);
ok(
  /\.composer-actions-spacer \{[\s\S]*?flex:\s*1/.test(css),
  ".composer-actions-spacer pushes send to the right",
);
ok(
  /\.composer-model-chip \{/.test(css),
  ".composer-model-chip CSS rule defined",
);
ok(
  /\.composer-model-menu \{/.test(css),
  ".composer-model-menu CSS rule defined",
);
ok(
  /\.composer-model-menu-row\.active \{/.test(css),
  ".composer-model-menu-row.active styling defined",
);

// Sub-header model CSS should be gone since the element is removed.
ok(
  !/\.chat-subheader-model \{/.test(css),
  ".chat-subheader-model CSS removed",
);
ok(
  !/\.chat-subheader-model-caret \{/.test(css),
  ".chat-subheader-model-caret CSS removed",
);

console.log(`\nphaseC44: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
