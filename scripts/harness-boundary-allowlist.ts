/**
 * Harness vendor-boundary allow-list (POD-4467, epic POD-4414 §5).
 *
 * Rule: no vendor-specific operational behaviour outside
 * packages/harness/src/adapters/ and packages/harness/src/driver/families/.
 * The mechanical gate is the identifier lint in scripts/check-boundaries.ts
 * (harness-vendor-boundary): a harness literal (BuiltinHarnessKind closed set
 * from packages/model/src/entities/agent.ts, plus display names) as a quoted
 * string literal outside the two homes is a violation. Comments, test files,
 * fixtures (*.fixtures.ts, __fixtures__, fixtures/ via isTestFile),
 * e2e (/e2e/, *.e2e.*) and historical migrations (/migrations/) are
 * excluded. The authoritative definition
 * (packages/model/src/entities/agent.ts) is excluded — it IS the definition.
 * The gate files themselves (check-boundaries, this allow-list,
 * architecture-manifest) are excluded — they must name the set to enforce it.
 *
 * Each entry carries a required category:
 * - leak (must shrink; names the issue/lane that removes it), or
 * - policy (a product preference which stays and points at a policy module,
 *   e.g. packages/runtime/src/harness-defaults.ts superagent harness order).
 * Unsure = leak.
 *
 * One file may carry TWO entries with different categories (POD-4601:
 * packages/runtime/src/settings.ts holds five provider-namespace leaks plus
 * one policy default). The lint aggregates coverage by file — the entries'
 * counts sum to the file's allowance — while the leak/policy/total ratchet
 * sums by category, so the split moves one literal from the remaining-work
 * count to the stays count with the file total unchanged.
 *
 * Ratchet (in scripts/check-boundaries.ts):
 * - a new literal outside the homes (file not listed, or over count) FAILS;
 * - an allow-list entry whose file no longer contains the literal (0 remain,
 *   or fewer than listed — slack) FAILS and must be removed/lowered;
 * - a leak allow-list total that grew beyond HARNESS_BASELINE_LEAK_COUNT
 *   FAILS; same for policy/total. The list can only shrink.
 *
 * Seeded at integrate/4414-single-harness-transport tip 570448172 (2026-09-20).
 * POD-4469 (one harness package) shrank it by 65: the six `manifests/<h>.ts`
 * files moved into `adapters/<h>/`, the seven driver runtime/version files
 * into `driver/families/`, and `composer/src/driver.ts` into
 * `driver/families/terminal/` — all inside the two homes, so their entries
 * were deleted and the baselines lowered to match. Two entries were renamed
 * with counts unchanged (`headless-interrupt.ts` → `driver/`,
 * `discovery/scanner.ts` → `store/`).
 * Counts are literal occurrences (one violation per quoted literal), not files.
 * Inventory at base (non-test, outside drivers/manifests, quoted kinds):
 * apps/daemon/src 31 files, apps/server/src 17 (18 raw incl. comment-only relay),
 * apps/web/src 22 (+13 dev-harness entries under apps/web/harness/),
 * packages/client-core/src 9, packages/model/src 5 (+agent definition +comment-only),
 * packages/protocol/src 2, packages/runtime/src 2,
 * packages/agent-runtime/src 8 (7 drivers +1 outside).
 * Full lint baseline (comment-stripped, quoted kinds+displays, excl. definition
 * /test/fixtures/e2e/migrations/gate): 162 files, 652 literals
 * (leak 622, policy 30).
 */

export type HarnessBoundaryCategory = 'leak' | 'policy'

export interface HarnessBoundaryAllowlistEntry {
  /** Repo-relative file path. */
  file: string
  /** How many harness literals this file is allowed to contain. New ones fail. */
  count: number
  category: HarnessBoundaryCategory
  /** One-line reason. */
  reason: string
  /** For leak: the issue/lane that removes it (e.g. POD-4414/1.5). */
  issue?: string
  /** For policy: the policy module it points at. */
  policy?: string
}

/**
 * Seeded baseline totals. The ratchet refuses any allow-list whose leak,
 * policy or combined total exceeds these — bumping a count to admit new
 * vendor behaviour fails instead of going quiet. The constants must equal
 * the seeded sums (checked by `lint:boundaries` itself in
 * checkHarnessAllowlistTotals: a baseline above the seeded total fails with
 * "baseline constants exceed the seeded allow-list" so the next lane cannot
 * reintroduce slack by shrinking the list without lowering the baseline).
 * POD-4470 (1.5) shrank the list to leak 487 / policy 30 / total 517;
 * POD-4493 (1.6) lowered the baselines to match.
 * POD-4473 (3.3) deleted the eight daemon credential/quota/usage files and
 * un-named the harness in cost/service + login-propagation: leak 487 → 461.
 * POD-4478 (4.4) moved the CLI install steps into adapter install sections
 * and reads quota labels off the Inventory: leak 461 → 438.
 * POD-4476 (4.2) derived every retyped harness-name enum from the single
 * definition (slices in model/entities/agent.ts, HARNESS_KINDS off the
 * registry): removed the seven 4.2 entries at zero literals and lowered
 * runtime/settings.ts 19 → 6 (provider-namespace 'codex' + one local default
 * remain): leak 438 → 402.
 * POD-4472 retired dead entries: leak 402 → 394.
 * POD-4520 (3.2 remainder) moved the per-harness state providers, causal
 * observers and locate/binding helpers from `agent-state/` into
 * `adapters/<h>/state.ts` + `state-*.ts` siblings: deleted the four
 * agent-state entries (1+6+2+1 = 10) and lowered the baselines to match:
 * leak 394 → 384, total 424 → 414.
 *  POD-4529 (4.4/deviation 7) served the provider label in the wire
 *  descriptor and deleted the accounts.ts harness→provider table: removed
 *  the emptied accounts entry (10): leak 297 → 287, total 327 → 317.
 *  POD-4539 (4.R deviation D2) derived the five server harness enums from
 *  the single definition (CLOUD_HARNESS_KINDS slice, HarnessAgent/AgentKind
 *  options, descriptor login.command, shipwright policy): removed
 *  cloud-runtime (2) + machines/rpc (8) + shipwright-router (8) +
 *  harness-error (2) + superagent/tools (6) = 26, recategorised
 *  headless-interrupt (2) leak → policy (driver families, not harnesses),
 *  and grew harness-defaults policy 4 → 6 (shipwright eval harness choice):
 *  leak 287 → 259, policy 31 → 35, total 318 → 294.
 *  POD-4601 split the runtime/settings.ts entry in two without moving code:
 *  the file holds five provider-namespace 'codex' literals (genuine leaks)
 *  plus one DEFAULT_HARNESS_KIND 'claude-code' (product policy, the default
 *  harness choice — never removable, and unmovable: settings ↔
 *  harness-defaults would cycle). One file, two entries, file total
 *  unchanged: leak 259 → 258, policy 35 → 36, total 294.
 *  POD-4612 deleted the bespoke Claude adopt/resume arm in
 *  control/session.ts (the Claude engine rebinds through the generic
 *  server-family arm): that file 5 → 2, leak 253 → 250, total 289 → 286.
 */
export const HARNESS_BASELINE_LEAK_COUNT = 250
export const HARNESS_BASELINE_POLICY_COUNT = 36
export const HARNESS_BASELINE_TOTAL = 286

export const HARNESS_BOUNDARY_ALLOWLIST: readonly HarnessBoundaryAllowlistEntry[] = [
  { file: 'apps/cli/src/session-cli.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/daemon/src/binding-store.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/daemon/src/control/inventory.ts', count: 23, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'apps/daemon/src/control/session.ts', count: 2, category: 'leak', reason: 'lifecycle names a harness; move into session/terminal lifecycle (2.1)', issue: 'POD-4414/2.1' },
  { file: 'apps/daemon/src/handoff-package.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/daemon/src/harness-version-reporting.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/daemon/src/runtime/opencode-attach.ts', count: 4, category: 'leak', reason: 'daemon headless host/driver names a harness; move into driver families (1.5)', issue: 'POD-4414/1.5' },
  { file: 'apps/mobile/harness/agent-mark-entry.tsx', count: 13, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/mobile/harness/backend-rail-entry.tsx', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/mobile/src/client/demoData.ts', count: 9, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/mobile/src/components/ConfiguredIssueLaunchSheet.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/mobile/src/screens/NewIssueScreen.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/gateway/daemon-socket.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/llm.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/modules/messages/characterization-support.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/modules/messages/service.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/modules/sessions/inbox.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/modules/sessions/oracle-support.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/modules/sessions/session-lifecycle-types.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/steward.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/server/src/store/events.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/coldstart-store.ts', count: 7, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/cost-entry.tsx', count: 14, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/deck-store-stub.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/dock-launch-entry.tsx', count: 6, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/dock-rename-entry.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/issue-page-entry.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/loadpanel-store.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/newtask-store.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/quota-ledger-entry.tsx', count: 8, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'apps/web/harness/quota-walkthrough-entry.tsx', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'apps/web/harness/setup-store.ts', count: 5, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/sidebar-store.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/harness/usage-tasks-fixture.ts', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/components/RefMiniview.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/automations/NewAutomationDialog.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/cost/TaskCostSection.tsx', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/cost/cost-format.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/issues/NewIssueDialog.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/machines/QuotaIndicator.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/machines/QuotaPanel.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/setup/ColdStartComposer.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/usage/UsageTasks.tsx', count: 5, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/features/workflows/ExecutionProfiles.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/lib/WorkerLabel.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/lib/agent-tone.ts', count: 1, category: 'leak', reason: 'bundled brand-component key for harnesses this build knows (4.1 amendment: bundled CODE stays)', issue: 'POD-4414/4.1' },
  { file: 'apps/web/src/lib/test-issue.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/perf/kernel-scenarios.frontend-perf.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/perf/large-state.frontend-perf.tsx', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/perf/responsive-filtering.frontend-perf.tsx', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/perf/tuck-fanout.probe.tsx', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/harness/src/driver/headless-interrupt.ts', count: 2, category: 'policy', reason: 'driver FAMILY names (codex/opencode/claude-sdk), not harness names — stays', policy: 'packages/harness/src/driver/headless-interrupt.ts' },
  { file: 'packages/client-core/src/replica/legacy-snapshot.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/client-core/src/replica/replica.ts', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/client-core/src/viewmodels/cost.ts', count: 4, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/client-core/src/viewmodels/quota-history.ts', count: 7, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/client-core/src/viewmodels/quota.ts', count: 7, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/client-core/src/viewmodels/session-status.ts', count: 8, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/client-core/src/viewmodels/slices/machines/placement.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/client-core/src/viewmodels/usage.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/commands/src/cloud/contracts.ts', count: 2, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/harness/src/browser.ts', count: 2, category: 'policy', reason: 'browser-safe no-tools table + bundled composer rules stay in browser entry; tested against manifests', policy: 'packages/harness/src/browser.ts' },
  { file: 'packages/harness/src/discovery/providers/claude-code.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/discovery/providers/codex.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/discovery/providers/cursor.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/discovery/providers/grok.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/discovery/providers/opencode.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/discovery/providers/pi.ts', count: 3, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/store/scanner.ts', count: 1, category: 'leak', reason: 'credentials/usage/inventory names a harness; move into adapter sections (3.3)', issue: 'POD-4414/3.3' },
  { file: 'packages/harness/src/model-probe.ts', count: 5, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/harness/src/opencode/auth.ts', count: 1, category: 'leak', reason: 'per-harness knowledge outside adapters/; move into adapters/<h>/', issue: 'POD-4414/6.2' },
  { file: 'packages/harness/src/opencode/cli.ts', count: 6, category: 'leak', reason: 'per-harness knowledge outside adapters/; move into adapters/<h>/', issue: 'POD-4414/6.2' },
  { file: 'packages/harness/src/opencode/db.ts', count: 2, category: 'leak', reason: 'per-harness knowledge outside adapters/; move into adapters/<h>/', issue: 'POD-4414/6.2' },
  { file: 'packages/harness/src/registry.ts', count: 7, category: 'policy', reason: 'registry is the allowed closed-set home; lookups degrade for unknown harnesses', policy: 'packages/harness/src/registry.ts' },
  { file: 'packages/harness/src/session-title.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/janitor/src/janitor.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/runtime/src/harness-defaults.ts', count: 6, category: 'policy', reason: 'superagent harness order + shipwright eval harness choice are Podium policy, stay; must not move into an adapter (spec §5)', policy: 'packages/runtime/src/harness-defaults.ts' },
  { file: 'packages/runtime/src/settings.ts', count: 5, category: 'leak', reason: 'provider-namespace codex literals (ApiProvider + legacy harness migration + background mapping); AgentChoice derived (4.2 enums)', issue: 'POD-4414/4.1' },
  { file: 'packages/runtime/src/settings.ts', count: 1, category: 'policy', reason: 'DEFAULT_HARNESS_KIND claude-code is the product default harness choice; stays', policy: 'packages/runtime/src/settings.ts' },
  { file: 'packages/sync/src/adapters/indexeddb/schema.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/sync/src/adapters/mobile-sqlite/schema.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/sync/src/conformance/suite.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/sync/src/replica/replica.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/sync/src/replica/types.ts', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/telemetry/src/example.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'scripts/agent-smoke-reporter.ts', count: 9, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/agent-smoke-reporter.ts' },
  { file: 'scripts/audit-god-objects.ts', count: 1, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/audit-god-objects.ts' },
  { file: 'scripts/bun-session-smoke.ts', count: 1, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/bun-session-smoke.ts' },
  { file: 'scripts/harness-environment-container-probe.ts', count: 4, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/harness-environment-container-probe.ts' },
  { file: 'scripts/lint-harness-versions.ts', count: 3, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/lint-harness-versions.ts' },
]
