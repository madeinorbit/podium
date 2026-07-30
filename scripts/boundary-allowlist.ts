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
 * ONE-TIME RECONCILIATION, 2026-07-30 (POD-1105). Four backend entries were
 * below reality, so the gate failed on `issue/279-integration` for debt no
 * implementer on that branch had introduced. Each was reconciled SITE BY SITE
 * with the commit and date that produced it (see the notes), not by rounding the
 * numbers up: some sites predate this ledger and were simply miscounted, others
 * landed after it and were never refused because `bun run lint` dies at biome
 * before this gate runs (POD-30). Raising a count to the measured truth is not a
 * loosening — no rule was weakened, no detector narrowed, and the number now
 * pins the debt so the NEXT one fails. It does mean the ratchet's floor for
 * those four files is honest instead of flattering. Nothing about the phase that
 * deletes them changed.
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
  // A third case of the SAME debt, found red on issue/279-integration (POD-1105).
  // Not new debt: this ledger was authored 2026-07-16 and the import landed
  // 2026-07-18 (ae03d500, "Establish causal session reattachment"), so it is an
  // entry that was never added while the gate itself was dark behind biome
  // (POD-30) — the ratchet never got the chance to refuse it.
  //
  // WHY IT IS SANCTIONED rather than fixed here: `acceptAgentObservation` lives
  // in packages/agent-bridge/src/agent-state/causal.ts, whose only imports are
  // TYPES from @podium/protocol. It contains no harness knowledge at all — it is
  // a protocol-level causal state machine (cursor succession, binding version,
  // terminal fence) that is merely FILED in agent-bridge. So this import does not
  // give apps/server the harness coupling the rule exists to prevent; it records
  // that the symbol is in the wrong package. The fix is the same relocation
  // POD-740 already owns for the two entries above, and doing it here would mean
  // moving a module plus its three test suites out of a guardrail issue's scope.
  {
    rule: 'agent-bridge-consumers',
    file: 'apps/server/src/modules/sessions/service.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports acceptAgentObservation (agent-state/causal.ts) for the observation ledger. That function is harness-agnostic — it depends only on @podium/protocol types — so this is a misfiled protocol symbol, not harness coupling. POD-740 relocates it to a package apps/server may legally reach, at which point this entry goes to zero.',
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
    count: 9,
    phase: P5,
    note: 'Transcript/title/dedup behavior keyed on claude-code vs codex — POD-292 moves it behind the harness layer. Count RE-MEASURED 2026-07-30 (POD-1105): 5 → 9. The four added sites are :2947 (codex half of a pair whose claude-code half was already counted), :4921 + :4926 (codex non-headless lock-loop dedup, bebb8127f 2026-07-15) and :5031 (claude-only title lock, 86fd9b597 2026-07-07) — all three commits PREDATE this ledger (2026-07-16), so this is a miscount being corrected, not new debt admitted.',
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
    count: 2,
    phase: P5,
    note: "Per-CLI composer scraping (claude box vs codex dim line) — capability knowledge that POD-325 folds into the manifest, or that could read @podium/composer's driver registry (see POD-1105's deferred note). The two claude-only display branches that were also counted here are gone: the prompt-mode hint row now asks AGENT_CAPABILITIES.promptModeHints, and the brand dot is a table lookup.",
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
    count: 6,
    phase: P5,
    note: 'Observer wiring per CLI — POD-292 names this file explicitly as scattered binding logic to consolidate. Count RE-MEASURED 2026-07-30 (POD-1105): 2 → 6. One added site predates this ledger (:1018, 3578f3ece 2026-07-16); three ARRIVED AFTER it (:1313, :1342, :1356 — 8de33f327 and 5af0138b6, both 2026-07-19) and were never refused because the gate was dark behind biome (POD-30). They are counted here so the ratchet refuses a seventh; POD-292 still owns deleting all six.',
  },
  // These two files were absent from the ledger entirely and are the clearest
  // evidence of what a dark gate costs: BOTH arrived after this list was written
  // (2026-07-16) and neither was refused. Counted now — phase-mapped like every
  // other row, so the ratchet holds the line at today's number.
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/control/credentials.ts',
    count: 2,
    phase: P5,
    note: 'Credential-file location per CLI (codex, grok — bd9e99c0b 2026-07-23). Harness-specific path resolution: exactly what POD-292 moves onto the adapter, alongside transcriptSourceFor.',
  },
  {
    rule: 'harness-branching',
    file: 'apps/daemon/src/control/session.ts',
    count: 1,
    phase: P5,
    note: 'Codex-only draft-sync wiring on the session control path (783cd0c96 2026-07-18) — the `composerScrape` capability already describes this in AGENT_CAPABILITIES, so POD-325 turns it into that lookup.',
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
  // WorkerLabel.tsx, SidebarUnified.tsx and SidebarRail.tsx were HERE and are
  // gone (POD-1105): their brand-tone ternaries became the record lookups the
  // three notes prescribed, in apps/web/src/lib/agent-tone.ts. Deleted rather
  // than zeroed — the gate calls a zero-count entry dead and tells you to remove
  // it, so the ledger cannot keep credit for ground already taken.
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
