/**
 * Architecture-manifest violation allowlist (POD-296) — the WARN-mode ledger.
 *
 * Every entry is DEBT, not a blessing: it records a violation that exists today,
 * how many times it occurs in that file, and the phase that deletes it. The
 * counts are the ratchet — a NEW violation, or one more in an already-listed
 * file, fails the build. Entries only ever shrink; when one hits zero the lint
 * tells you to delete it. POD-335 is done when this array is empty and the
 * manifest runs at error level.
 *
 * Counts here are MEASURED, not guessed: `bun scripts/check-boundaries.ts`
 * prints the live tally, and a count that no longer matches reality is reported
 * as stale.
 *
 * On "declared exceptions" (the axiom permits icon/label maps): a Record lookup
 * keyed by harness — `KIND_ICON[kind]` — is not a comparison, so the harness
 * rule never flags it and it needs no entry here. Everything below is a real
 * `===`/`case` branch. That is why no entry is a 'permanent-exception': each of
 * these can become a manifest field or a table lookup, which is exactly what
 * Phase 5 does.
 */

import type { AllowlistEntry } from './architecture-manifest'

/** Phase 5 — confine agent-CLI variance to the harness layer. */
const P5 = 'POD-292'
/** Phase 7 — final deletions / ops single-sourcing. */
const P7 = 'POD-294'

export const BOUNDARY_ALLOWLIST: readonly AllowlistEntry[] = [
  // -------------------------------------------------------------------------
  // LEGACY rule 2 (agent-bridge-consumers) — POD-740.
  // -------------------------------------------------------------------------
  // These two are why `bun run lint:boundaries` has been red on EVERY branch.
  // Grandfathered here on the coordinator's instruction: restore green lint now,
  // and leave the real fix (extract HARNESS_ADAPTERS and the SYSTEM_POINTER
  // constants into an allowed package) to POD-740, rather than restructuring
  // packages from inside a Phase 0 guardrail issue.
  //
  // Deliberately in THIS list rather than check-boundaries' older
  // GRANDFATHERED_AGENT_BRIDGE set: that set is rule-2-only, uncounted and
  // unphased, and its own doc says not to add to it. Here the debt is counted,
  // phase-mapped and ratcheted like everything else — one mechanism, and it can
  // only shrink.
  {
    rule: 'agent-bridge-consumers',
    file: 'apps/server/src/accounts.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports HARNESS_ADAPTERS from @podium/agent-bridge for login/profile detection. POD-740 extracts it to an allowed package (@podium/transcript or protocol).',
  },
  {
    rule: 'agent-bridge-consumers',
    file: 'apps/server/src/relay.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports ISSUE_SYSTEM_POINTER/SPEC_SYSTEM_POINTER from @podium/agent-bridge. POD-740 moves those constants somewhere apps/server may legally reach.',
  },

  // -------------------------------------------------------------------------
  // Harness axiom — behavioral branching outside packages/agent-bridge.
  // Removed by Phase 5: POD-292 confines agent-CLI variance to the harness
  // layer, and POD-325 (5.3) folds the capability tables into ONE manifest per
  // CLI — at which point each branch below becomes a manifest lookup.
  // -------------------------------------------------------------------------
  {
    rule: 'harness-branching',
    file: 'packages/client-core/src/viewmodels/derive.ts',
    count: 10,
    phase: P5,
    note: "panelLabel's 5-case display switch + defaultChatCapable's 5 capability comparisons. Both become manifest fields (label, chatCapable) under POD-325.",
  },
  {
    rule: 'harness-branching',
    file: 'apps/web/src/features/settings/sections/shared.tsx',
    count: 5,
    phase: P5,
    note: 'harnessAgentLabel: one 5-case display switch — a manifest `label` field under POD-325.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/server/src/modules/sessions/service.ts',
    count: 5,
    phase: P5,
    note: 'Transcript/title/dedup behavior keyed on claude-code vs codex — POD-292 moves it behind the harness layer.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/durable-headless.ts',
    count: 5,
    phase: P5,
    note: 'Headless launch variance per CLI — the exact variance POD-325 folds into per-CLI manifests.',
  },
  {
    rule: 'harness-branching',
    file: 'packages/runtime/src/settings.ts',
    count: 2,
    phase: P5,
    note: 'Codex-specific harness migration (harnessAgent) and the background-role harness check — manifest-driven under POD-325. A third codex comparison in this file reads an ApiProvider rather than a HarnessAgent, so it is out of this axiom by design (see HARNESS_CONTEXT_RE).',
  },
  {
    rule: 'harness-branching',
    file: 'apps/web/src/features/terminal/AgentPanel.tsx',
    count: 3,
    phase: P5,
    note: 'Per-CLI composer scraping (claude box vs codex dim line) + a claude-only mode hint. Capability/affordance knowledge — POD-325 manifest fields.',
  },
  {
    rule: 'harness-branching',
    file: 'packages/domain/src/machine-selection.ts',
    count: 2,
    phase: P5,
    note: 'Machine selection restricted to claude-code/codex — a manifest capability predicate under POD-325, not a hardcoded pair.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/server/src/modules/superagent/service.ts',
    count: 2,
    phase: P5,
    note: 'Session-id minting for claude-code/grok — manifest capability under POD-325.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/session-observers.ts',
    count: 2,
    phase: P5,
    note: 'Observer wiring per CLI — POD-292 names this file explicitly as scattered binding logic to consolidate.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/headless-drivers.ts',
    count: 2,
    phase: P5,
    note: 'Headless driver selection per CLI — collapses into the per-CLI manifest under POD-325.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/handoff-package.ts',
    count: 2,
    phase: P5,
    note: 'Handoff packaging limited to claude-code/codex — a manifest capability under POD-325.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/control/handoff.ts',
    count: 2,
    phase: P5,
    note: 'Handoff control path limited to claude-code/codex — a manifest capability under POD-325.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/web/src/lib/WorkerLabel.tsx',
    count: 1,
    phase: P5,
    note: 'Brand tone (a ternary on the claude-code literal) sitting right next to the KIND_ICON record. Fix is local: make the tone a record lookup like its neighbour, which the axiom permits.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/web/src/features/worklist/SidebarUnified.tsx',
    count: 1,
    phase: P5,
    note: 'Brand tone keyed on defaultAgent — same local record-lookup fix as WorkerLabel.tsx.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/web/src/features/worklist/SidebarRail.tsx',
    count: 1,
    phase: P5,
    note: 'Brand tone keyed on defaultAgent — same local record-lookup fix as WorkerLabel.tsx.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/control/exec.ts',
    count: 1,
    phase: P5,
    note: 'MCP config only wired for claude-code — a manifest capability flag under POD-325.',
  },

  // -------------------------------------------------------------------------
  // Layer + platform — apps/desktop -> scripts.
  // -------------------------------------------------------------------------
  // HONEST CAVEAT: these two are a TAG-GRANULARITY artifact as much as real
  // debt. The manifest tags whole workspaces (per POD-296: "every package/app
  // carries tags"), so apps/desktop is one unit tagged L4/browser-safe — but
  // this file is a BUILD script, not the Tauri bundle, and a build script
  // sharing scripts/build-bun.js is reasonable forever. The real resolutions
  // are (a) move it under scripts/, or (b) give apps/*/scripts its own
  // build-tier tag. Recorded here rather than silently special-cased, so the
  // decision is made in the open at Phase 7 instead of by this lint's author.
  {
    rule: 'manifest-layer',
    file: 'apps/desktop/scripts/stage-sidecar.ts',
    count: 1,
    phase: P7,
    note: "Imports UP into scripts (L5) via '../../../scripts/build-bun.js'. See the caveat above — build script, not app source.",
  },
  {
    rule: 'manifest-platform',
    file: 'apps/desktop/scripts/stage-sidecar.ts',
    count: 1,
    phase: P7,
    note: 'Same edge as the manifest-layer entry: browser-safe apps/desktop reaching node-only scripts. Nothing reaches a browser bundle — this is build tooling.',
  },
]
