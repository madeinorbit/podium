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
 * A census reports what it found. For 65 of the 76 there is a rule in the
 * shipped code and {@link PROJECTION_POLICIES} writes it down. For the other 11
 * there is NO server-side reader scoping — the handler returns what the service
 * returns — and inventing a plausible policy for those would put a FALSE entry
 * in the audit surface, which `modules/approvals/queries.ts` correctly
 * identifies as worse than a missing one: a false entry stops anyone looking
 * again.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT WAS 54/22 UNTIL THE FINDINGS THEMSELVES WERE RE-READ (B/PDM-253)
 * ---------------------------------------------------------------------------
 *
 * A5.4 rebuilt the MECHANISM — which reads exist, and that the two lists are
 * total against the router. It did not re-verify the CONTENT of the 22 findings
 * it carried forward, and eight of them did not survive being read against the
 * shipped handlers:
 *
 *   · the seven `workflows.*` reads, recorded as "ownership ... not consulted
 *     by the read", every one of which ends at `WorkflowAccess` and a real
 *     owner-or-grant decision over durable rows, on BOTH its transports;
 *   · `machines.list`, whose own finding conceded "the rule is right", and
 *     which was on the gap list for the different complaint that its policy had
 *     nowhere to be written down. It is written down here now.
 *
 * They are governed entries below, each citing the decision site. THE PART
 * WORTH KNOWING BEFORE TRUSTING THEM: nothing in `projection-census.test.ts`
 * can check that a rationale is TRUE. It checks that the lists are total
 * against the router, that no read is in both, and that each policy is well
 * formed. A row moved from findings to governed is a claim backed by the code
 * it cites and by the tests those handlers already have — not by this file's
 * own green.
 *
 * WHAT THE MOVE LEFT BEHIND IS THE RESULT THAT MATTERS. Every remaining phase-B
 * row is a `discloses-private-execution` row. The phase's read gap is no longer
 * a mixed list of fourteen where the urgent ones could wait behind the tidy
 * ones; it is six disclosures, and `docs/gates/pdm-253-phase-b-read-rows.md`
 * gives each one an owner.
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
 *  contract and already classified. Named once rather than repeated 57 times.
 *
 *  Those registry reads are ALSO served on trpc — `issues.get` and the other 31
 *  are live tRPC queries — which is why the census test excludes them by looking
 *  them up in the real registries rather than by trusting this sentence.
 *
 *  NOT every read here is trpc-ONLY: the seven workflow reads also serve the
 *  relay arm and say so with {@link TRPC_RELAY}. */
const TRPC: readonly TransportTag[] = ['trpc']

/** THE ONE FAMILY SERVED ON MORE THAN `trpc`. The seven workflow reads declare
 *  `['trpc', 'relay']` in `WORKFLOW_QUERIES`, and `dispatchWorkflowRpc` serves
 *  the relay arm through the SAME `WorkflowAccess` decision the tRPC arm takes.
 *  Written out rather than folded into {@link TRPC} because a policy that
 *  understated its own exposure would be exactly the false entry this file
 *  refuses — and because the second arm is where a reader should check that the
 *  two transports have not drifted into two answers. */
const TRPC_RELAY: readonly TransportTag[] = ['trpc', 'relay']

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
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      'Same ownership assertion as `transcriptRead`; both are transcript reads. TWO TRANSPORTS: `RELAY_ALLOWED.sessions` carries `read`, and the relay arm gated on the target ISSUE rather than on session ownership until POD-3900. Recorded as `TRPC` until then, which is how a read with two transports and two different gates stayed invisible to the instrument built to find exactly that — see the note on `sessions.status`.',
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
      'Asserts `mayReadSession` before the toolkit call, as all four reads in this family now do — `sessions.status` was the exception until PDM-229.',
  }),
  p({
    name: 'sessions.status',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'session',
    // The worked example in `ProjectionPolicy.indirectResources`: recording only
    // `session` here would be true and useless, because the disclosure is the
    // repository.
    indirectResources: ['issue', 'repo'],
    forbiddenFields: [],
    rationale:
      'Asserts `mayReadSession` and answers NOT_FOUND, like its three siblings. Governed since PDM-229; before that it was the one read in this table with no check, while returning more than any of them — the target\'s issue, its repo\'s `git log` and `git status`, and the files it touched. It takes a REF rather than a session id, so the rule is that the ref is resolved exactly once and the resolved id is both what is checked and what is projected: a second resolution could authorize one member of an issue and describe another. TWO TRANSPORTS, AND THIS ROW SAID ONE. `RELAY_ALLOWED.sessions` carries `status`, and the relay arm gated on the target ISSUE where this one gates on session OWNERSHIP — a colleague with issue write received the full payload D13 gives only an owner, until POD-3900. This row recorded the tRPC gate as THE gate. That is the failure mode the census exists to prevent, found in the census itself: an exposure tag naming one transport makes the other one\'s gate unaskable, so record every transport that serves a read even when their gates agree. `sessions.recap` stays `TRPC` deliberately: it is NOT in the relay allowlist, checked rather than assumed.',
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

  // ---- conversations: the same bytes as a transcript, reached one hop further -
  p({
    name: 'conversations.search',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    // `session` rather than a `conversation` of its own: CommandResource has no
    // such member, and `session` is also the honest answer, because the rule
    // below decides on the SESSION that can resume the conversation.
    resource: 'session',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale:
      "Free-text and project-path search over the durable conversation index. `modules/conversations/trpc.ts` builds the service as `forReader({ kind: 'user', id: caller.userId })`, and `modules/memory/search.ts` filters EVERY candidate through `mayRead`, keeping only an explicit true and applying the limit AFTER the filter — so a row the caller may not read cannot consume a slot and reveal itself by absence. That ends at `mayReadNativeConversation`, which resolves the conversation's sibling segments to the sessions that can resume them and asks `mayReadOwned`: the same owner-or-grant rule `sessions.transcriptRead` applies to the same bytes. A conversation matching no session is denied to everyone. A3.2 listed it as ungoverned on the reading that the query table hands its three arguments straight to the service; the principal is two hops further down, and PDM-274 is the ninth finding to fall to reading past a one-line forward. Served on trpc ONLY — `router.ts` is the single consumer of CONVERSATION_QUERIES and there is no relay arm; the one other consumer of the service method, the superagent `search_conversations` tool, builds its reader from the thread's owner and refuses without one. Refusals are observed, not argued, in `apps/server/src/search.test.ts` ('conversations.search reader scoping'), which refuses a second member both the projectPath-narrowed and the untargeted read and admits a grantee.",
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
    name: 'accounts.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'secret',
    indirectResources: ['machine'],
    forbiddenFields: ['credential'],
    rationale:
      "TWO ARMS, and the reason this row reads `caller-only` is that every row naming a PERSON is the caller's. The NATIVE arm is the disclosure the census found: a harness login identity, the machine NAMES it was observed on, the machines offered as login targets, and any attempt in flight. PDM-271 resolves all four against ONE answer per call — `machineIdsUsableBy` (`modules/accounts/machine-scope.ts`), which is `machine-access.ts`'s own `checkMachineUse` over a live ownership snapshot, imported rather than restated. `use` and not `see`, because a native row says which provider account an agent spawned there would authenticate as and `accounts.login` is already `machineVerb: 'use'`; offering a see-only machine would be readiness §3.1.4 M5 from the reading side. Resolving it once is load-bearing — the two machine reads here were independent fleet listings, and gating one would have left the other answering the same question differently. The MANAGED arm returns four credential SLOTS (`managed:anthropic`, `managed:openai`, `managed:openrouter`, `managed:claude-oauth`) whose ids are derived server-side; since PDM-280 each slot is read out of the CALLER's own credentials (`managed_credentials`, keyed `(owner_user_id, id)`), so the id names a slot inside one person's keys rather than an instance singleton, and their `identity` is `maskCredential`'s display-only preview — the reviewed output `accounts.connect`'s redaction policy names, never a human's identity. `resource: 'secret'` matches `accounts.connect`'s own `policy.resource` on the same table so the read and the write name one resource; `indirectResources: ['machine']` carries the actual finding, because A ROW THAT RECORDED ONLY `'secret'` WOULD BE TRUE AND USELESS — the `discloses-private-execution` severity came entirely from what this read reaches THROUGH the credential table. The stricter label is recorded deliberately: `instance-wide` would LICENSE returning instance rows that name people, which is the thing this read must never do again. Served on trpc ONLY, and checked rather than assumed — `accountViews()` has exactly one production caller, and `modules/issues/relay-dispatch.ts` has no accounts arm. Refusals are observed, not argued, in `modules/accounts/list-scope.test.ts` (a second member refused the first's identity AND host names, an owner-less machine refused to everyone, a `use` grant admitted and a `see` grant refused) and `modules/accounts/native-login.test.ts` (an in-flight attempt shown to its owner and not to another human). PDM-280 CLOSED THE ARM THIS ROW USED TO CARRY AN EXCEPTION FOR: the managed slots now have an owner column, `accounts.connect`'s declared `owner: 'on-behalf-of-human'` is stored, and `caller-only` is literally true of every row this read returns rather than true only of the rows that name somebody. WHAT IS STILL INSTANCE-WIDE, and is the whole of the exception now: the LEGACY arm, `settings.apiKeyFor` -> `server_secrets`, which holds pre-hub provider keys with no owner recorded anywhere to scope them by (`credentialSource: 'legacy'`). Those rows carry a masked preview and no person's identity, and `resolveAccountEnv` has never injected them. Two further gaps are filed and do NOT belong to this row: the `roleFloor` above is declared and unenforced for this whole contract family (PDM-294), and the preferences viewer this family's siblings read resolves the earliest admin rather than the caller (PDM-295).",
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

  // ---- workflows: seven rows A3 listed as ungoverned that are not ----------
  //
  // A3.2 recorded all seven as having "no reader scoping", with
  // `workflows/ownership.ts` "declared ... but not consulted by the read".
  // Re-read at the repaired census (A5.4/PDM-248, verified by PDM-253), that is
  // FALSE — and a false entry in this surface is the failure this file's header
  // calls worse than a missing one, because it stops anyone looking again.
  //
  // Every one of the seven ends at `WorkflowAccess`
  // (apps/server/src/modules/workflows/handlers/context.ts:247), whose
  // `workflowDecision` (packages/commands/src/workflows/ownership.ts:172) is:
  // no live human denies FIRST, then owner wins, then an explicit grant, then
  // an admin floor, then denied. Both served transports carry a REAL principal
  // — `workflowCaller` (modules/workflows/trpc.ts:68) throws `UNAUTHORIZED`
  // without one, and the relay arm builds its caller through
  // `principalForCapability` (relay.ts:638). The shipped composition does NOT
  // use the single-user ownership constant: `resolveOwnership` (relay.ts:2146)
  // reads `store.workflows.ownerOf` and `store.grants.listForResource` once per
  // pass, treating absence as denial.
  //
  // The refusals are observed rather than argued: `multi-user.test.ts` in the
  // same module asserts "refuses one member READING another member's workflow,
  // and honours an explicit grant" and "does not list another member's RUNS,
  // BINDINGS or PROFILES", each with the counterfactual that the owner is
  // allowed through the same call.
  //
  // `resource` is `'none'` for all seven: `CommandResource` has no workflow
  // member, and `automations.runs` above already answers `'none'` for the same
  // reason on the same kind of row. Widening a shared vocabulary from inside a
  // census entry is not this file's decision to take.
  p({
    name: 'workflows.list',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      '`WorkflowService.list` resolves ownership once for the page and keeps only rows `canReadWorkflow` allows, so a workflow the caller neither owns nor was granted is absent rather than filtered late.',
  }),
  p({
    name: 'workflows.get',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      '`assertWorkflowRead` takes the decision at ONE site with ONE message for both "no such workflow" and "not yours" (ADR 3 Am.1 D20.2), so a refusal does not confirm the row exists.',
  }),
  p({
    name: 'workflows.bindings',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['issue'],
    forbiddenFields: [],
    rationale:
      'Returned every binding in the instance until POD-732; `visibleBindings` now asks the same decision the workflow mutations ask, against the same per-pass ownership view.',
  }),
  p({
    name: 'workflows.profiles',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['machine', 'secret'],
    forbiddenFields: [],
    rationale:
      'Had no gate at all and listed every profile — including its `accountId`, which NAMES A MANAGED CREDENTIAL — to any caller; `visibleProfiles` now scopes it. The indirect resources are recorded because a profile carries machine placement and an account reference, neither of which the direct row name would have made a reviewer ask about.',
  }),
  p({
    name: 'workflows.runs',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      'Both arms end at `canSeeRun` — the same decision `runFor` takes — so a run the caller cannot open is a run it cannot list, rather than two rules free to disagree. A session caller sees only its own live run.',
  }),
  p({
    name: 'workflows.prime',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      'Scoped by CONSTRUCTION rather than by a predicate: it renders the live run of `caller.actor.id` and has no input naming another run, so there is no id with which to ask for someone else’s. An operator context with no actor gets a message, not a row.',
  }),
  p({
    name: 'workflows.status',
    exposure: TRPC_RELAY,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'none',
    indirectResources: ['session'],
    forbiddenFields: [],
    rationale:
      '`runFor` refuses an unknown run id and a run the principal may not see with the SAME throw and the same message, so the live-state read cannot be used to confirm another member’s run exists.',
  }),

  // ---- machines: the read whose rule was right and whose home was wrong -----
  p({
    name: 'machines.list',
    exposure: TRPC,
    roleFloor: 'member',
    rowScope: 'caller-only',
    resource: 'machine',
    indirectResources: [],
    forbiddenFields: [],
    rationale:
      "`visibleMachinesFor` is an authorization projection: `canSeeMachine` filters the rows and `machineUseDecision` attaches each machine's `use` answer, so a machine the principal may not execute on is never OFFERED and one it may not see is simply absent. A3.2 listed it as ungoverned because its rule lives in a `router.ts` procedure rather than in a table this census can read — but the ungoverned list means A READ WITH NO SERVER-SIDE READER SCOPING, and this read has one. The rule is recorded HERE, which is the home it was missing; that its procedure is still the one hand-written read in `router.ts` is a structural note for B2, not a gap in reader scoping.",
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
] as const

/** Both lists, as the census test consumes them. */
export const CENSUS_TOTAL =
  PROJECTION_POLICIES.length + UNGOVERNED_PROJECTIONS.length
