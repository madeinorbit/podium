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

/** Phase 7 — final deletions / ops single-sourcing. */
const P7 = 'POD-294'

export const BOUNDARY_ALLOWLIST: readonly AllowlistEntry[] = [
  // -------------------------------------------------------------------------
  // LEGACY rule 2 (agent-host-consumers) — POD-740.
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
    rule: 'agent-host-consumers',
    file: 'apps/server/src/accounts.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports AGENT_MANIFESTS from @podium/harness for login/profile detection. POD-740 extracts it to an allowed package (@podium/transcript or protocol).',
  },
  {
    rule: 'agent-host-consumers',
    file: 'apps/server/src/relay.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports ISSUE_SYSTEM_POINTER/SPEC_SYSTEM_POINTER from @podium/harness. POD-740 moves those constants somewhere apps/server may legally reach.',
  },
  {
    rule: 'agent-host-consumers',
    file: 'apps/server/src/harness-manifest.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Narrow static projection introduced by POD-398: capability metadata, resume labels and pure transcript mapper selection flow from the canonical per-CLI manifests without exposing process-driving APIs to server consumers. POD-740 moves this projection to an allowed browser-safe package.',
  },
  // MOVED FILE, NOT NEW DEBT (POD-1385). This entry named lifecycle.ts until
  // 72e99bfe ("refactor(sessions): split workspace and daemon lifecycle",
  // 2026-08-01) moved the acceptAgentObservation import into daemon-lifecycle.ts
  // and did not bring the entry with it. The gate has been red for that file
  // ever since — an exemption does not travel with the code, and a per-file
  // allowlist is what makes that visible. Re-pointed, not widened: still ONE
  // entry for ONE import.
  //
  // A third case of the SAME debt, found red on issue/279-integration (POD-1105).
  // Not new debt: this ledger was authored 2026-07-16 and the import landed
  // 2026-07-18 (ae03d500, "Establish causal session reattachment"), so it is an
  // entry that was never added while the gate itself was dark behind biome
  // (POD-30) — the ratchet never got the chance to refuse it.
  //
  // WHY IT IS SANCTIONED rather than fixed here: `acceptAgentObservation` lives
  // in packages/harness/src/agent-state/causal.ts, whose only imports are
  // TYPES from @podium/protocol. It contains no harness knowledge at all — it is
  // a protocol-level causal state machine (cursor succession, binding version,
  // terminal fence) that is merely FILED in agent-bridge. So this import does not
  // give apps/server the harness coupling the rule exists to prevent; it records
  // that the symbol is in the wrong package. The fix is the same relocation
  // POD-740 already owns for the two entries above, and doing it here would mean
  // moving a module plus its three test suites out of a guardrail issue's scope.
  {
    rule: 'agent-host-consumers',
    file: 'apps/server/src/modules/sessions/daemon-lifecycle.ts',
    count: 1,
    phase: 'POD-740',
    note: 'Imports acceptAgentObservation (agent-state/causal.ts) for the observation ledger. That function is harness-agnostic — it depends only on @podium/protocol types — so this is a misfiled protocol symbol, not harness coupling. POD-740 relocates it to a package apps/server may legally reach, at which point this entry goes to zero.',
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
