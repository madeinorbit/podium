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
 *  POD-4661 deleted the server's Grok exit-patch hold in
 *  messages/service.ts, its one literal: leak 250 → 249, total 286 → 285.
 *  POD-4737 (web label/icon tables) read every harness label off the adapter
 *  descriptor rows via @podium/harness/browser bundled fallback and every web
 *  harness mark through agent-tone's agentIconFor: deleted the emptied
 *  TaskCostSection (4) + QuotaIndicator (1) + QuotaPanel (1) + WorkerLabel (1)
 *  + client-core cost (4) + session-status (8) entries and lowered UsageTasks
 *  5 → 1 (completeness gate stays), quota 7 → 1 + quota-history 7 → 1 (short
 *  marks stay): leak 249 → 214, total 285 → 250.
 *  POD-4737 (daemon/server branching) asked the harness instead of naming it:
 *  version telemetry reads the HARNESS_VERSION_POLICIES set, the spawn path
 *  reads transcript storage (sqlite), and the inbox wake-repair pins the
 *  grok-acp driver id (unique per manifest) rather than the harness: deleted
 *  the emptied version-reporting (3) + inbox (1) entries and lowered
 *  control/session 2 → 1 (admission executable key stays): leak 214 → 209,
 *  total 250 → 245. All five harness-branching violations gone.
 *  POD-4737 (phone defaults + demo fixtures) read the named default harness
 *  (mobile agent-models' issueDefaultAgentKind, the registry's first row) and
 *  took demo variety by registry position: deleted the emptied demoData (9) +
 *  ConfiguredIssueLaunchSheet (1) + NewIssueScreen (1) entries: leak 209 →
 *  198, total 245 → 234.
 *  POD-4737 (named default policy) defined the default ONCE as
 *  DEFAULT_HARNESS_AGENT in @podium/model (product policy: Claude is the
 *  default for new work) and pointed runtime settings, mobile + web
 *  issueDefaultAgentKind, client-core placement and the web launch defaults
 *  at it: deleted the emptied settings policy (1) + placement (1) +
 *  RefMiniview (1) + NewAutomationDialog (1) + ColdStartComposer (1) +
 *  test-issue (1) entries: leak 198 → 193, policy 36 → 35, total 234 → 228.
 *  ExecutionProfiles keeps its own codex preset default; the fenced
 *  NewIssueDialog stays for its lane.
 *  POD-4737 (daemon inventory) derived every inventory row from the
 *  manifests: terminal rows off harnessTerminalDriverId, server rows off
 *  each manifest's server declaration gated by harnessVersionPolicyFor
 *  (no-policy admits, as claude-sdk always did), model-probe executables
 *  off PROBEABLE_AGENTS. One literal stays: the opencode2-server row, whose
 *  version comes from a separate binary probe rather than the harness
 *  version: leak 193 → 171, total 228 → 206. The pi terminal row is now
 *  reported (its manifest declares generic-pty like the rest).
 *  POD-4737 (short-mark descriptor field) stated one arbitrary two-letter
 *  mark per adapter descriptor, served it on the wire (optional, like
 *  provider) and read it through the one markOf rule with per-field
 *  served-over-bundled merge: deleted the emptied quota (1) +
 *  quota-history (1) short-mark entries: leak 171 → 169, total 206 → 204.
 *  POD-4737 (cost gate) read the completeness gate off the model slice
 *  (COST_FULL_ATTRIBUTION_HARNESS): deleted the emptied cost-format (1) +
 *  UsageTasks (1) entries: leak 169 → 167, total 204 → 202.
 *  client-core usage.ts bucketProvider stays: model-id prefixes are model
 *  namespace (the excluded ApiProvider-collision class), not harness
 *  identity — same reason the price rows are uncounted.
 *  POD-4737 (freed fence): the issues NewIssueDialog placeholder default
 *  reads DEFAULT_HARNESS_AGENT: deleted the entry (1): leak 167 → 166,
 *  total 202 → 201. chat/** and HostIndicators carry no entries.
 *  POD-4737 (pass 1: server + shared vocabulary): login propagation iterates
 *  CREDENTIAL_PROPAGATION_HARNESSES (new registry export via metadata);
 *  characterization/oracle/legacy fixtures read DEFAULT_HARNESS_AGENT;
 *  cloud contracts derive z.enum(CLOUD_HARNESS_KINDS); model-vendor mapping
 *  rides the price rows + qualified fallbacks; replica cursor uses share
 *  CURSOR_META_KEY. Sync-cursor keys, provider-namespace spellings and
 *  command vocabulary recategorized leak→policy (unmovable spellings that
 *  never were harness branching; §7-empty needs a lint-level rule for them
 *  — see mail): leak 166 → 137, policy 35 → 51, total 201 → 188.
 *  (A mechanical edit in that pass dropped the llm.ts line with its
 *  alphabetical neighbor; the gate test caught it. Restored here as the
 *  policy entry it should be — ApiProvider check, not harness identity:
 *  leak 137, policy 51 → 52, total 188 → 189.)
 *  Correction (review): ADR 10 policy means product preference, and
 *  homonyms are not preferences — the 17 cursor-vocabulary and
 *  provider-namespace entries go back to leak with homonym reasons naming
 *  POD-4437; every real removal above stands: leak 137 → 154,
 *  policy 52 → 35, total 189 → 189.
 *  POD-4737 D1 (alternative executables): server specs declare `executable`
 *  (opencode primary + opencode2 alternative); the daemon reads admission
 *  binaries via serverDriverExecutable and inventory alternatives via
 *  harnessServerAlternatives, probing each resolved binary with its family
 *  probe. Deleted the emptied inventory (1) + session (1) entries: leak
 *  154 → 152, total 189 → 187.
 *  POD-4737 D3 (harness-internal): discovery providers moved into
 *  adapters/<h>/discovery.ts, opencode auth/cli/paths into
 *  adapters/opencode/, model-probe argv+parsers into
 *  adapters/<h>/model-probe.ts, scanner reads providers off the registry,
 *  session title reads the adapter descriptor label. Deleted twelve
 *  emptied entries (discovery 6×3, scanner 1, model-probe 5, opencode 9,
 *  session-title 1): leak 152 → 118, total 187 → 153.
 *  POD-4737 (daemon leftovers): binding spool kinds read off the resume
 *  kind they validate against, handoff export takes any harness behind its
 *  transcript gate, attach labels collapse to one generic composition
 *  (kind-less adoption keeps its historical opencode default as policy):
 *  deleted binding-store (2) + handoff (2), opencode-attach 4 → policy 1:
 *  leak 118 → 110, policy 35 → 36, total 153 → 146.
 *  Correction (review): the binding-store respelling was the brief's trap —
 *  reverted to the plain historical literals, entry kept with the honest
 *  migration reason: leak 110 → 112, total 146 → 148.
 *  POD-4737 D4 (fixture-path exclusion): check-boundaries honours ADR 10
 *  for demonstrably-fixture paths — apps/web/harness/, apps/mobile/harness/
 *  (dev-harness entries/stores/stubs) and apps/web/src/perf/ (perf harnesses)
 *  — via exact directory prefixes, with a test proving near-miss product
 *  paths still scan. No test-support path rule: no allow-listed file lives
 *  under one. The binding-store migration entry stays: excluding a live
 *  store module would need function-scope machinery, so it waits for the
 *  POD-4437 non-harness-spelling rule instead. Deleted nineteen emptied
 *  entries (web/harness 56, mobile/harness 17, perf 12): leak 112 → 27,
 *  total 148 → 63.
 */
export const HARNESS_BASELINE_LEAK_COUNT = 27
export const HARNESS_BASELINE_POLICY_COUNT = 36
export const HARNESS_BASELINE_TOTAL = 63

export const HARNESS_BOUNDARY_ALLOWLIST: readonly HarnessBoundaryAllowlistEntry[] = [
  { file: 'apps/cli/src/session-cli.ts', count: 1, category: 'leak', reason: 'homonym: read-command cursor arg (pagination vocabulary), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'apps/daemon/src/binding-store.ts', count: 2, category: 'leak', reason: 'historical migration of legacy Codex receipts (ADR 10 excludes historical migrations; the scan has no migration exemption yet, see D4)', issue: 'POD-4737' },
  { file: 'apps/daemon/src/runtime/opencode-attach.ts', count: 1, category: 'policy', reason: 'kind-less adoption assumes opencode (legacy attach default that stays); the per-harness labels are one generic composition', policy: 'apps/daemon/src/runtime/opencode-attach.ts' },
  { file: 'apps/server/src/llm.ts', count: 1, category: 'leak', reason: 'homonym: Codex ApiProvider check, not the harness id; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'apps/server/src/modules/sessions/session-lifecycle-types.ts', count: 1, category: 'leak', reason: 'homonym: sync-cursor Omit member (feed pagination key), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'apps/server/src/steward.ts', count: 1, category: 'leak', reason: 'homonym: steward_state cursor key (durable poll-window spelling), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'apps/server/src/store/events.ts', count: 1, category: 'leak', reason: 'homonym: steward_state cursor key write, not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'apps/web/src/features/workflows/ExecutionProfiles.tsx', count: 1, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'apps/web/src/lib/agent-tone.ts', count: 1, category: 'leak', reason: 'bundled brand-component key for harnesses this build knows (4.1 amendment: bundled CODE stays)', issue: 'POD-4414/4.1' },
  { file: 'packages/harness/src/driver/headless-interrupt.ts', count: 2, category: 'policy', reason: 'driver FAMILY names (codex/opencode/claude-sdk), not harness names — stays', policy: 'packages/harness/src/driver/headless-interrupt.ts' },
  { file: 'packages/client-core/src/replica/replica.ts', count: 2, category: 'leak', reason: 'homonym: TanStack cursor key + family member (pagination vocabulary), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/harness/src/browser.ts', count: 2, category: 'policy', reason: 'browser-safe no-tools table + bundled composer rules stay in browser entry; tested against manifests', policy: 'packages/harness/src/browser.ts' },
  { file: 'packages/harness/src/registry.ts', count: 7, category: 'policy', reason: 'registry is the allowed closed-set home; lookups degrade for unknown harnesses', policy: 'packages/harness/src/registry.ts' },
  { file: 'packages/janitor/src/janitor.ts', count: 1, category: 'leak', reason: 'homonym: steward_state cursor key in SQL, not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/runtime/src/harness-defaults.ts', count: 6, category: 'policy', reason: 'superagent harness order + shipwright eval harness choice are Podium policy, stay; must not move into an adapter (spec §5)', policy: 'packages/runtime/src/harness-defaults.ts' },
  { file: 'packages/runtime/src/settings.ts', count: 5, category: 'leak', reason: 'homonym: Codex ApiProvider id + provider-selected account (provider collision class), not harness branching; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/sync/src/adapters/indexeddb/schema.ts', count: 1, category: 'leak', reason: 'homonym: meta-table cursor key (adapter DDL spelling), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/sync/src/adapters/mobile-sqlite/schema.ts', count: 1, category: 'leak', reason: 'homonym: meta-table cursor key (adapter DDL spelling), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/sync/src/conformance/suite.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'packages/sync/src/replica/replica.ts', count: 1, category: 'leak', reason: 'homonym: sync event discriminant (cursor frame type), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/sync/src/replica/types.ts', count: 1, category: 'leak', reason: 'homonym: sync event union member (cursor frame type), not the Cursor harness; needs a lint rule for non-harness spellings (POD-4437)', issue: 'POD-4437' },
  { file: 'packages/telemetry/src/example.ts', count: 3, category: 'leak', reason: 'vendor literal outside adapters/families; move into adapter or family', issue: 'POD-4414' },
  { file: 'scripts/agent-smoke-reporter.ts', count: 9, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/agent-smoke-reporter.ts' },
  { file: 'scripts/audit-god-objects.ts', count: 1, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/audit-god-objects.ts' },
  { file: 'scripts/bun-session-smoke.ts', count: 1, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/bun-session-smoke.ts' },
  { file: 'scripts/harness-environment-container-probe.ts', count: 4, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/harness-environment-container-probe.ts' },
  { file: 'scripts/lint-harness-versions.ts', count: 3, category: 'policy', reason: 'build/lint tooling enumerates harnesses; stays in scripts build tier', policy: 'scripts/lint-harness-versions.ts' },
]
