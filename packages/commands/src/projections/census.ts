/**
 * THE PROJECTION CENSUS — every externally reachable read, and the policy that
 * governs it (A3/PDM-129).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 *
 * The command side has had a per-command policy since ADR 3 D1, checked for
 * totality against the FILESYSTEM by `classification-totality.test.ts`. The read
 * side had nothing: 68 projections across 29 query tables declared `input`,
 * `exposure` and `run`, and `DerivedQuery` has no policy field at all.
 *
 * This is the read side's table. `projection-census.test.ts` in `apps/server`
 * derives the served population from `appRouter._def.procedures` — the dispatch
 * table tRPC actually routes on — and asserts every read appears here EXACTLY
 * ONCE, in exactly one of the two lists below, unless a command definition
 * classifies it elsewhere. That is the same both-directions totality A2's
 * `matrix.test.ts` applies to `SHARED_TASK_POLICY` / `NOT_SHARED_TASK`, and for
 * the same reason: a list that is merely long proves nothing about what is
 * missing from it.
 *
 * ---------------------------------------------------------------------------
 * HOW THE POPULATION WAS COUNTED, AND WHY IT IS NOT 69 (A5.4/PDM-248)
 * ---------------------------------------------------------------------------
 *
 * A3 reported this population as 69 with `machines.list` as the only
 * hand-written exception, and that was the size of the query TABLES somebody had
 * listed rather than of the served surface. The router mounts 108 tRPC reads.
 * A5.4 rebound discovery to the router and the arithmetic came out:
 *
 *   108 served reads
 *  - 32 classified by a command definition elsewhere — the issue and lock
 *       registries, the mail contracts and `SETTINGS_CONTRACTS`, all kept total
 *       by `classification-totality.test.ts` on the command side. A second
 *       policy here would be a second answer to "how is this authorized".
 *  = 76 this census owns.
 *
 * SEVEN of those 76 were outside every instrument until A5.4: `settings.viewer`
 * (the reported finding), `layout.get`, `readPosition.get`, `operations.active`,
 * `operations.history`, `updates.fleet` and `updates.proposal`. None had been
 * waived; their families had simply never been added to the array the old test
 * discovered from, so a read absent from both lists was absent from the
 * comparison too. The raw HTTP, WebSocket and file-route families are outside
 * this census by decision rather than by oversight, and
 * `docs/gates/pdm-248-served-read-census.md` records each with an owner.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO LISTS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * A census reports what it found. For 54 of the 76 there is a rule in the
 * shipped code and {@link PROJECTION_POLICIES} writes it down. For the other 22
 * there is NO server-side reader scoping — the handler returns what the service
 * returns — and inventing a plausible policy for those would put a FALSE entry
 * in the audit surface, which `modules/approvals/queries.ts` correctly
 * identifies as worse than a missing one: a false entry stops anyone looking
 * again.
 *
 * So they go in {@link UNGOVERNED_PROJECTIONS}, each naming the phase that owns
 * closing it. That list is REQUIRED TO BE NON-EMPTY by the census test until it
 * is genuinely empty — a gap list that someone quietly empties by deleting rows
 * rather than fixing reads would otherwise look like success.
 *
 * Several entries are not defects. `models.catalog` and `perf.snapshot` return
 * instance facts about no person, and they are in the governed list saying so.
 * The ungoverned list is for reads whose answer to "whose rows?" nobody has
 * established, and the distinction between those two is the actual work here.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE WIDENS NOTHING
 * ---------------------------------------------------------------------------
 *
 * Every governed entry records the rule the shipped handler already applies. The
 * execution charter's exposure order holds through phases A and B: the
 * owner-or-grant task read predicate in `apps/server/src/feed-visibility.ts` is
 * not touched here, and C4 (PDM-144) replaces it after B7 accepts isolation.
 * Where an entry says `shared-task`, it is describing a read that is ALREADY
 * bounded by that predicate, not licensing a wider one.
 */

import { SERVED_NOWHERE, type TransportTag } from '../contract'
import type { ProjectionPolicy } from '../projection'

/** Every read in this census is served on `trpc`; the relay/CLI/MCP arms reach
 *  reads through the issue command registry, which is on the COMMAND side of the
 *  contract and already classified. Named once rather than repeated 53 times.
 *
 *  Those registry reads are ALSO served on trpc — `issues.get` and the other 31
 *  are live tRPC queries — which is why the census test excludes them by looking
 *  them up in the real registries rather than by trusting this sentence. */
const TRPC: readonly TransportTag[] = ['trpc']

/** Nothing in the census is served nowhere today. Imported so that a projection
 *  that becomes unserved is written with the named constant rather than `[]` —
 *  "I forgot" and "I decided" must not look alike (ADR 3 D3 rule 1). */
export const PROJECTION_SERVED_NOWHERE = SERVED_NOWHERE

const p = (policy: ProjectionPolicy): ProjectionPolicy => policy

// ---------------------------------------------------------------------------
// Governed — the rule the shipped code applies, written down
// ---------------------------------------------------------------------------

export const PROJECTION_POLICIES: readonly ProjectionPolicy[] = [
  // ---- sessions: private execution, and the family that gets it right -------
  p({
    name: 'sessions.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale:
      'Filters every row through `mayReadOwned` (POD-335), which refuses an unowned session outright rather than comparing two absent owners as equal. The async filter is written out because `Array.filter` over a promise keeps every element — at this site that showed every session to every caller (POD-3507).',
  }),
  p({
    name: 'sessions.activityHistory',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Caller-supplied session ids are filtered through `mayReadSession` BEFORE the service sees them, so an id the caller may not read is absent from the query rather than dropped from its result.',
  }),
  p({
    name: 'sessions.transcriptRead',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Asserts `mayReadSession` and answers NOT_FOUND rather than FORBIDDEN, so a refusal does not confirm the session exists. Transcript text is the most private thing a session holds.',
  }),
  p({
    name: 'sessions.read',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Same ownership assertion as `transcriptRead`; both are transcript reads.',
  }),
  p({
    name: 'sessions.recap',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Asserts `mayReadSession` before the toolkit call. Named here because its sibling `sessions.status` does not — see the ungoverned list.',
  }),
  p({
    name: 'sessions.concurrencyHistory',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: ['sessionId', 'owner', 'cwd'],
    rationale:
      'An aggregate count of concurrent agents over a time window. It names no session and no person, which is why it needs no reader scoping — and the forbidden fields are what keeps it that way if the underlying shape ever grows them.',
  }),

  // ---- per-user state: the family whose whole point is one person's rows ----
  p({
    name: 'pins.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale:
      "Keyed from `caller.sessionState`, never from input — the schema has no user field, so a frame naming someone else's pins is unrepresentable rather than refused (ADR 3 D7).",
  }),
  p({
    name: 'snoozes.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale: 'Per-user state, keyed from the principal exactly as `pins.list` is.',
  }),
  p({
    name: 'tabs.listOrders',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Per-user state, keyed from the principal exactly as `pins.list` is.',
  }),
  p({
    name: 'layout.get',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "`getSnapshot(actor)` where `actor` is `layoutActor(await layoutAuthzDeps(ctx))` — resolved from the principal and nothing else. The procedure takes NO INPUT, so a frame naming another person's layout is unrepresentable rather than refused (ADR 3 D7), and a principal with no user is refused FORBIDDEN before the read rather than silently scoped to nobody. `resource: 'none'` for `layout.set`'s stated reason: the row IS the principal.",
  }),
  p({
    name: 'readPosition.get',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "The caller's own feed cursors, by the identical shape `layout.get` uses: no input, `readPositionActor` resolved from the principal, FORBIDDEN when the principal has no user. How far someone has read is a fact about that person, which is why it is scoped rather than shared.",
  }),

  // ---- the caller-scoped misc family ---------------------------------------
  p({
    name: 'search.query',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['issue', 'session'],
    forbiddenFields: [],
    rationale:
      "Memory search takes the caller's own `{ kind: 'user', id }` reader ref. Personal memory stays private (execution charter), and the reader is stamped from the principal.",
  }),
  p({
    name: 'superagent.listThreads',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale: "Scoped to `asUserId(caller.userId)` in the handler.",
  }),
  p({
    name: 'superagent.history',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "Scoped to `asUserId(caller.userId)`; the thread id is a filter within the caller's own threads, not a selector across everyone's.",
  }),
  p({
    name: 'settings.get',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'settings-domain',
    indirectResources: [],
    forbiddenFields: ['apiKey', 'token', 'secret'],
    rationale:
      "`getSettingsFor(asUserId(caller.userId))` — per-person settings since POD-1554. Credential VALUES are forbidden here; `accounts.list` serves masked identities instead.",
  }),
  p({
    name: 'settings.viewer',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'settings-domain',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "Answers WHICH SETTINGS COMMANDS THIS CALLER MAY ATTEMPT, so an admin-grade control renders disabled-with-a-reason instead of editable-then-refused (POD-421). Caller-only because every input is the caller's own: `settingsAuthzDeps` resolves the principal from `ctx.capability` and reads `roleOf` for that principal's OWN user, and the procedure takes no input, so there is no way to ask about anybody else. It returns one boolean per name in `SETTINGS_CONTRACTS` and no settings VALUE, which is why nothing is forbidden here while `settings.get` forbids three fields. It is not a capability snapshot and must not become one — it is recomputed per request and the server re-runs the identical gate at apply time (ADR 3 D8), so a stale client copy widens nothing.",
  }),
  p({
    name: 'automations.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale:
      'Automations are private and singly owned (execution charter), and there is no sharing or transfer verb in v1. Scoped with `listForUser`.',
  }),
  p({
    name: 'automations.runs',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale: "`runsForUser` — a run belongs to the automation's owner, and automations are private.",
  }),

  // ---- instance facts about no person --------------------------------------
  p({
    name: 'models.catalog',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: ['machine'],
    forbiddenFields: ['apiKey'],
    rationale:
      'The models a machine can run. An instance fact about no person — but it reaches a MACHINE to answer, which is why the indirect resource is recorded even though the direct one is global.',
  }),
  p({
    name: 'perf.snapshot',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: "This process's own event-loop accounting rings. Names nothing owned.",
  }),
  p({
    name: 'features.state',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Experimental feature flags [spec:SP-f4b9] — instance configuration, no rows.',
  }),
  p({
    name: 'setup.info',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Instance identity and version, reachable during bootstrap before any account exists.',
  }),
  p({
    name: 'setup.options',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Static setup choices. No rows.',
  }),
  p({
    name: 'setup.commandFor',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'none',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Formats an install command from its arguments. Reads nothing.',
  }),
  p({
    name: 'setup.channel',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'The update channel this instance is on — instance configuration.',
  }),
  p({
    name: 'setup.provenance',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'How this build was produced. A property of the binary, not of anyone using it.',
  }),
  p({
    name: 'auth.status',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: ['passwordHash', 'password'],
    rationale:
      'Whether login is required on this instance. Deliberately answerable before authentication — it is what a client asks in order to know whether to authenticate — so it must carry no credential material at all.',
  }),
  p({
    name: 'auth.profile',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: ['passwordHash'],
    rationale: "The caller's own account row. One person's identity, keyed from the principal.",
  }),
  p({
    name: 'telemetry.state',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Consent state, read from `config.json` by the instance service rather than from the request — turning telemetry off has to work with no server.',
  }),
  p({
    name: 'telemetry.preview',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: ['session', 'issue'],
    forbiddenFields: ['transcript', 'cwd', 'repoPath'],
    rationale:
      'Shows exactly what would be sent [spec:SP-f933]. The indirect resources are real — the preview is assembled from session and issue counts — and the forbidden fields are the point of a preview: a person must be able to see the payload without the payload being the thing they feared.',
  }),
  p({
    name: 'updates.proposal',
    exposure: TRPC,
    roleFloor: 'admin',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "The pending development release awaiting approval — a build, named by head SHA and version, belonging to the instance and to no person. `releaseProposalFor` checks `ctx.capability.role !== 'admin'` and returns NULL rather than throwing, which is deliberate and is why the role floor is recorded here: a member is not refused, they are told there is nothing to approve, and the panel renders empty. Its sibling write `approveProposal` re-checks the same grade and throws, so the read cannot be mistaken for the authority.",
  }),

  // ---- approvals, interactions, conversations ------------------------------
  p({
    name: 'approvals.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'shared-task',
    resource: 'issue',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      'The pending approval queue. An approval is a request made OF the operator about a task, so it follows the task-collaboration axis rather than the private one; bounded today by the unchanged feed predicate.',
  }),
  p({
    name: 'interactions.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'shared-task',
    resource: 'issue',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      'Open asks awaiting an answer — task collaboration, same class as approvals. The optional `sessionId` narrows within the result, it does not widen the population.',
  }),
  p({
    name: 'interactions.forSession',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'shared-task',
    resource: 'issue',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      'The audit read — who answered, with what, and how it was delivered. Same class as `interactions.list`.',
  }),

  // ---- git and repo reads: the indirect-resource cases ---------------------
  p({
    name: 'git.status',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale:
      'A registered repo on an owned machine. The repo is the direct resource and the machine is indirect — the read PLACES a git invocation on that machine, which is the owned-compute boundary `machineVerb: use` covers on the command side.',
  }),
  p({
    name: 'git.log',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale: 'Same shape as `git.status`.',
  }),
  p({
    name: 'git.diffFile',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale: 'Same shape as `git.status`; returns file contents from a registered repo root.',
  }),
  p({
    name: 'git.commitFiles',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale: 'Same shape as `git.status`.',
  }),
  p({
    name: 'git.commitDiffFile',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale: 'Same shape as `git.status`.',
  }),
  p({
    name: 'repos.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'The instance\'s registered repositories. Shared working substrate, not personal state.',
  }),
  p({
    name: 'repos.listDetailed',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale:
      'The `repos.list` population plus per-machine presence. The machine is named as an indirect resource because presence is a fact about someone\u2019s compute.',
  }),
  p({
    name: 'repos.inferFromPath',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'none',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Matches a path against the registered prefixes. Answers from its argument.',
  }),
  p({
    name: 'repos.browse',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: ['machine'],
    forbiddenFields: [],
    rationale:
      'Bounded by the registered repo-root allowlist, which is why it cannot be pointed at an arbitrary path.',
  }),
  p({
    name: 'repos.githubStatus',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: ['token', 'accessToken'],
    rationale:
      'Whether a GitHub connection exists. The token itself is forbidden — a connection belongs to a human (execution charter) and its identity is all a status read needs.',
  }),
  p({
    name: 'repos.githubList',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: ['token', 'accessToken'],
    rationale:
      'Lists repositories reachable through the stored GitHub connection. The connection belongs to a human; the token never leaves the server.',
  }),
  p({
    name: 'discovery.lastMachineScan',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'machine',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'When a machine was last scanned — a timestamp about the fleet, naming no person.',
  }),

  // ---- cost, usage and quota ------------------------------------------------
  p({
    name: 'usage.summary',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: ['session'],
    forbiddenFields: ['transcript'],
    rationale:
      'Aggregate spend for the instance. Reaches sessions to total them, which is why the indirect resource is recorded; per-person attribution is a v1 non-goal (usage limits, PDM-177, are deferred).',
  }),
  p({
    name: 'cost.task',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'shared-task',
    resource: 'issue',
    indirectResources: ['session'],
    forbiddenFields: ['transcript'],
    rationale: 'One task\'s cost. Follows the task, so it follows the task-collaboration axis.',
  }),
  p({
    name: 'cost.tasks',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'shared-task',
    resource: 'issue',
    indirectResources: ['session'],
    forbiddenFields: ['transcript'],
    rationale: 'As `cost.task`, across tasks.',
  }),
  p({
    name: 'quota.summary',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Provider quota headroom for the instance. An instance fact.',
  }),
  p({
    name: 'quota.history',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'global',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'As `quota.summary`, over time.',
  }),

  // ---- specs ----------------------------------------------------------------
  p({
    name: 'specs.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: [],
    rationale: 'Specs live in the repository and are shared working material.',
  }),
  p({
    name: 'specs.get',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Repository material, addressed by id. Same population as `specs.list`: what is in the checkout, which every member works from.',
  }),
  p({
    name: 'specs.search',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'instance-wide',
    resource: 'repo',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'A filter over the `specs.list` population; searching shared repository material discloses nothing that listing it does not.',
  }),
] as const

// ---------------------------------------------------------------------------
// Ungoverned — the census's findings, each with the phase that owns it
// ---------------------------------------------------------------------------

/**
 * A read with no server-side reader scoping, named rather than guessed at.
 *
 * `owner` is a PHASE, not a person: these are handed to the phase whose write set
 * already covers the module, per the A3 specification's instruction to *"record
 * remaining module integrations in B/F with explicit owners"*. `severity`
 * separates a read that discloses one person's private execution from one that
 * returns shared working material nobody has classified.
 */
export interface UngovernedProjection {
  readonly name: string
  /** Which phase's write set covers the module this read lives in. */
  readonly owner: 'B' | 'C' | 'F'
  readonly severity: 'discloses-private-execution' | 'unclassified'
  readonly finding: string
}

export const UNGOVERNED_PROJECTIONS: readonly UngovernedProjection[] = [
  {
    name: 'sessions.status',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding:
      "Reads any session by ref with NO ownership check, while `recap` and `transcriptRead` — declared in the same table — both assert `mayReadSession`. `readToolkit.status` logs the read and then returns the session's issue, its repo's `git log` and `git status`, and the files it touched. The asymmetry is the evidence: three sibling reads of the same resource, two guarded.",
  },
  {
    name: 'accounts.list',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding:
      'Returns the credential rows Podium holds plus the native CLI logins observed on every machine. Provider connections belong to a human (execution charter) and exactly one human may execute on a machine, so this list is per-person by construction — but the handler scopes to nobody. Masked identities are still identities.',
  },
  {
    name: 'files.read',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding:
      "Three input shapes — by session, by issue artifact, and by raw `{ machineId, root, path }`. The first two name a resource whose ownership is knowable and is not consulted; the third places a filesystem read on a named machine, which is the owned-compute boundary. No reader scoping on any arm.",
  },
  {
    name: 'files.list',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding: 'As `files.read`: a directory listing on a named machine with no reader scoping.',
  },
  {
    name: 'files.search',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding: 'As `files.read`: content search across a root on a named machine, with no reader scoping.',
  },
  {
    name: 'conversations.search',
    owner: 'B',
    severity: 'discloses-private-execution',
    finding:
      'Searches conversation history by free text and project path with no reader scoping. Conversations are session transcripts under another name.',
  },
  {
    name: 'sync.changesSince',
    owner: 'C',
    severity: 'unclassified',
    finding:
      "Falls back to a synthesised feed principal when `feedPrincipal` is absent. The fallback is the seam C4 (PDM-144) replaces when it swaps the owner-or-grant task read predicate; classifying it now would either freeze today's predicate in a second place or pre-empt C4's decision.",
  },
  {
    name: 'sync.feedChangesSince',
    owner: 'C',
    severity: 'unclassified',
    finding: 'As `sync.changesSince` — same principal fallback, same C4 dependency.',
  },
  {
    name: 'sync.feedSlice',
    owner: 'C',
    severity: 'unclassified',
    finding: 'As `sync.changesSince` — same principal fallback, same C4 dependency.',
  },
  {
    name: 'cloud.capabilities',
    owner: 'F',
    severity: 'unclassified',
    finding:
      'What the hosted runtime provider supports. Probably an instance fact, but the cloud surface is phase F\'s and its multi-user shape is not settled here.',
  },
  {
    name: 'cloud.runtime',
    owner: 'F',
    severity: 'unclassified',
    finding:
      'Returns one hosted runtime by id with no reader scoping. A runtime is compute someone started, so it plausibly belongs to the private-execution axis — phase F owns deciding that.',
  },
  {
    name: 'workflows.list',
    owner: 'B',
    severity: 'unclassified',
    finding: 'No reader scoping. Workflow ownership is declared in `workflows/ownership.ts` but not consulted by the read.',
  },
  {
    name: 'workflows.get',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'One workflow by id, with no reader scoping. Ownership is declared in `workflows/ownership.ts` and not consulted by the read.',
  },
  {
    name: 'workflows.bindings',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'Which triggers are bound to which workflows, unscoped. A binding names the work someone automated, so it carries the same question as the workflow itself.',
  },
  {
    name: 'workflows.profiles',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'Execution profiles, unscoped. Named separately from `workflows.list` because a profile can carry machine and model selection, which is owned-compute configuration.',
  },
  {
    name: 'workflows.runs',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'As `workflows.list`, and a run is an execution — the same shape `automations.runs` scopes per user and this one does not.',
  },
  {
    name: 'workflows.prime',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'Priming data for a workflow, unscoped. Same population question as `workflows.list`, and the same unanswered owner.',
  },
  {
    name: 'workflows.status',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'Live state of a workflow run, unscoped. A run is an execution in progress, so this is the read most likely to disclose another person\u2019s work as it happens.',
  },
  {
    name: 'updates.fleet',
    owner: 'F',
    severity: 'unclassified',
    finding:
      "Returns the whole fleet's update state — every machine's current and target version, its channel and its reconciliation status — with no reader scoping, while `machines.list`, the only other fleet-wide read, routes through `visibleMachinesFor` and shows a principal only the machines it may see. Two reads over the same population, one scoped and one not, is the same asymmetry that convicted `sessions.status`. A machine is owned compute (ADR 9 D6), so the question is whose machines these are, and the handler does not ask it.",
  },
  {
    name: 'operations.active',
    owner: 'F',
    severity: 'unclassified',
    finding:
      "Serves the live durable operation's STORED BYTES verbatim (`JSON.parse(row.payload)`, deliberately, so a swapped web bundle can render a field its build never heard of — POD-2097 P8). No reader scoping of any kind. The evidence that one is missing is in the same file: all three sibling MUTATIONS run `assertActionAuthorized`, which requires an admin account and then a `manage` verb on `details.targetMachineId`. The read reaches that identical `details` object and asks neither question.",
  },
  {
    name: 'operations.history',
    owner: 'F',
    severity: 'unclassified',
    finding:
      "The operation audit trail — 'did last night's update finish?' — returning up to a hundred stored payloads with no reader scoping, by the same route and with the same missing question as `operations.active`. A history is the more durable disclosure of the two: a live operation ends, its record does not.",
  },
  {
    name: 'machines.list',
    owner: 'B',
    severity: 'unclassified',
    finding:
      'The ONE hand-written read left in `router.ts`, and the only one that is already an authorization projection: `visibleMachinesFor` scopes to what the principal may see and attaches each machine\'s `use` decision. It is listed here rather than governed because its policy lives in the router rather than in a table the census can read — the rule is right and its HOME is wrong.',
  },
] as const

/** Both lists, as the census test consumes them. */
export const CENSUS_TOTAL =
  PROJECTION_POLICIES.length + UNGOVERNED_PROJECTIONS.length
