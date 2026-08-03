/**
 * THE SEVEN SUPERAGENT THREAD COMMAND CONTRACTS (ADR 3 D1, POD-311's L1/L3
 * split; POD-383 is 3.3a of the POD-313 family).
 *
 * `sendTurn · interruptTurn · openInTerminal · clear · restart · startBtw ·
 *  concierge`
 *
 * L1 DATA ONLY. Every handler lives with the superagent feature in
 * `apps/server/src/modules/superagent` and is joined to its contract at
 * `modules/superagent/registry.ts`. The two READS this surface also serves —
 * `listThreads` and `history` — are not contracts and stay hand-written
 * queries: a `visibility` class describes what a command WRITES, and a read
 * writes nothing (the same line `modules/workflows/queries.ts` draws).
 *
 * ---------------------------------------------------------------------------
 * `send` IS GONE, AND WHICH NAME SURVIVED WAS DECIDED BY WHAT CALLS IT
 * ---------------------------------------------------------------------------
 *
 * `router.ts` carried TWO procedures with byte-identical input schemas and one
 * body — `superagent.send` and `superagent.sendTurn`, both forwarding to
 * `SuperagentService.sendTurn`. Two wire names for one operation is the
 * vocabulary fork this programme exists to end, and the deletion audit counted
 * it (`send-turn-duplicate`, POD-313).
 *
 * POD-1075's precedent is that PERSISTENCE decides between two names for one
 * thing, not aesthetics. Measured across every caller in the repo — web
 * (`SuperagentView`, `ChatView`), mobile (`SuperagentScreen`), the client
 * engine (`packages/client-core`), and the browser e2e that asserts on the
 * outgoing request URL — the count is **eleven call sites for `sendTurn` and
 * ZERO for `send`**. `send` was the alias, and its comment
 * ("the generic entry the panel uses") was already false: the panel calls
 * `sendTurn`. So `sendTurn` survives, `send` is deleted, and deleting it is not
 * a behaviour change for any shipped client — the honest caveat is recorded on
 * the contract below rather than left implicit.
 *
 * ---------------------------------------------------------------------------
 * ONE VISIBILITY CLASS, READ OFF THE MATRIX ROW AND NOT COPIED FROM A NEIGHBOUR
 * ---------------------------------------------------------------------------
 *
 * All seven write superagent state, which is ONE row on ADR 1's ownership
 * matrix — `superagent_threads` / `superagent_messages` /
 * `superagent_queued_inputs` / `superagent_pending_turns` — classified
 * `personal` by ADR 9 D8 S2 ("MY threads never surface in YOUR sidebar"). The
 * constant below is asserted against `visibilityClassOf(ROW.superagentState)`
 * in `contracts.test.ts` WITH a non-vacuity probe, because that function
 * returns `'personal'` for a row id it has never heard of: asserting against it
 * without first proving the row resolves is a check that cannot say NO.
 *
 * NOT `per-user-state`. The trap POD-351 found and POD-731 flagged is copying a
 * `personal` contract onto a readAt/snooze/pins-shaped field, whose value
 * DIFFERS PER READER. Nothing here is that shape: a thread's history, binding
 * and turn machine are one fact owned by one person, not one fact rendered
 * differently to several. The distinction is why the matrix row is consulted
 * per family rather than inherited from whichever contract was open.
 *
 * ---------------------------------------------------------------------------
 * DELIVERY: SIX ONLINE-ONLY, ONE OFFLINE-ELIGIBLE, DECIDED PER COMMAND
 * ---------------------------------------------------------------------------
 *
 * The matrix row's `offline: 'offline-eligible'` is a statement about
 * REPLICATING THE ROWS, not about queueing these COMMANDS, and conflating the
 * two is how a queue learns to replay a harness turn. Six of the seven govern a
 * LIVE harness — they refuse while a turn is in flight or while the terminal
 * lock is held, and a refusal conditioned on liveness cannot be honoured at
 * drain time, when the world has moved. `startBtw` is the one exception and it
 * earns it: it upserts a thread row, runs no turn, and is idempotent by
 * construction. Each class carries its own reasoning in
 * `outboxReconciliation`; none is derived from a rule stated elsewhere.
 *
 * NOTHING names `outbox`. ADR 3 D3 is default-closed: a transport is served
 * because a contract names it, never because a delivery class would have
 * permitted it, and no client outbox path exists for the superagent.
 */

import { asThreadId, IssueIdField, SessionIdField, ThreadIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  RedactionPolicy,
  TransportTag,
} from '../contract'

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

/**
 * WHAT THE CLIENT SAYS THE USER IS LOOKING AT, sent with every turn (#225).
 *
 * MOVED HERE FROM `apps/server/src/modules/superagent/global.ts`, definition
 * and all, rather than restated: a second `z.object({…})` with the same keys is
 * byte-identical on the wire and therefore INVISIBLE to the golden fixtures
 * (POD-305). One instance exists, the contracts below reference it, and
 * `contracts.test.ts` asserts identity with `toBe` per arm. No re-export shim
 * was left in `global.ts` — every import site was repointed, which is the rule
 * POD-311 set when it absorbed the protocol contract sets.
 *
 * Ids only. The server resolves them to names and titles so a client cannot
 * dress them up — the reason `focusedSessionId` is `.max(128).pipe(...)` and
 * not a free string. The `.max(128)` before the shared brand is POD-362's
 * shape and is KEPT: a local `.brand()` here would be byte-identical and
 * invisible to every fixture.
 */
export const superagentUserFocus = z.object({
  /** The web's top-level surface: 'workspace' | 'issues' | 'settings' | … */
  view: z.string().max(40).optional(),
  /** Selected worktree/repo path in the sidebar. */
  worktreePath: z.string().max(1024).optional(),
  /** Selected issue (issue-as-workspace), by id. */
  issueId: z.string().max(128).pipe(IssueIdField).optional(),
  /** The session in the focused pane, and any other on-screen ones. */
  focusedSessionId: z.string().max(128).pipe(SessionIdField).optional(),
  visibleSessionIds: z.array(z.string().max(128).pipe(SessionIdField)).max(4).optional(),
  /** An open file tab in the focused pane. */
  filePath: z.string().max(1024).optional(),
})
export type SuperagentUserFocus = z.infer<typeof superagentUserFocus>

/** The turn text bound the shipped surface validates with — moved, not
 *  re-specified, so the cutover cannot quietly widen what a turn may carry. */
const turnText = z.string().min(1).max(32_768)

// ---------------------------------------------------------------------------
// Shared policy cells, so a repeated rule cannot drift between contracts
// ---------------------------------------------------------------------------

/**
 * The one arm that ships. `router.ts` serves the superagent family; `relay.ts`
 * does not (it is the daemon RPC and carries no superagent procedure), the CLI
 * has no superagent verb, and the superagent's OWN MCP tool belt
 * (`modules/superagent/tools.ts`) calls the service in-process — it does not
 * dispatch these command names, so naming `mcp` here would open a surface
 * nothing asked for.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * ADR 9 D5 A1 / ADR 3 D8 + Amendment 1 D16 — one sentence, one rule, on every
 * contract. The half that is easy to omit is what the SENDER is told: a
 * delegation that no longer resolves must deny the way an unknown thread id
 * denies, or the refusal itself reports that the thread exists.
 */
const REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1): the superagent ' +
  'is a BROAD-SCOPE delegation (D8 S1 — "you, automated"), so its scope is its human’s CURRENT ' +
  'rights and never a capability frozen when the thread was created. A delegation that no longer ' +
  'resolves denies the apply, and the denial is byte-identical to an unknown thread id (Amendment 1 ' +
  'D20.2) so the refusal is not itself an existence oracle.'

/**
 * The live-harness class. Six of the seven, and the reason is the same one each
 * time — stated here once because restating it six times in six wordings is how
 * one rule becomes six.
 */
const LIVE_TURN_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'NEVER queued. Every one of these commands is a decision about a harness that is running RIGHT ' +
    'NOW: sendTurn and restart refuse while a turn is in flight or the terminal lock is held, ' +
    'interruptTurn addresses the turn that is live at the instant it arrives, and clear tears down ' +
    'the binding a running turn is using. Draining any of them from a queue applies a decision made ' +
    'about one turn to whatever turn exists later — the same failure as POD-730 §6’s double-advance, ' +
    'reached by a different road. ADR 3 D4 rule 4’s distinction applies: the server’s durable turn ' +
    'rows are a delivery mechanism for an already-authorized ONLINE command, not a client Outbox class.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * `startBtw`'s class, and the exception is argued rather than assumed. It runs
 * NO turn (the seed is prepended to the thread's next `sendTurn` by
 * `composeContext`), it upserts one row whose conflict rule is `exp-rev` on the
 * matrix, and re-running it returns `{isNew: false}` — so a replay after the
 * world moved is a no-op and not a lost or duplicated edit.
 */
const THREAD_UPSERT_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'Entity-shaped and idempotent: it upserts one thread row (`exp-rev` on ADR 1’s matrix) and runs ' +
    'no turn, so a queued replay after the origin session moved returns the existing thread rather ' +
    'than duplicating or overwriting one. NOT exposed on `outbox` — no client outbox path exists for ' +
    'the superagent, and ADR 3 D3 serves a transport because a contract NAMES it, never because a ' +
    'class would have permitted it.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * The turn payload is the user's own prose plus the ids of what is on their
 * screen — including two filesystem paths. Reviewed and NAMED rather than
 * declared empty: `focus.worktreePath` and `focus.filePath` are paths into the
 * caller's machine, and a log that captured them would leak a private tree's
 * layout. No credential is on this path.
 */
const TURN_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: ['text', 'focus.worktreePath', 'focus.filePath'],
  outputPaths: [],
  note: 'The turn text is the user’s private prose to their own orchestrator, and `focus` carries two filesystem paths into their machine. Both are redaction-worthy in logs and neither is a credential. The ack (`threadId`, `podiumSessionId`) carries no content.',
}

/** Thread control carries an id and nothing else. */
const CONTROL_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'A thread id (or an origin session id) and nothing else — no prose, no path, no credential. Reviewed and empty, which is a different statement from unreviewed.',
}

/**
 * ADR 9 D5 A3 and the matrix row's own `attribution` cell, which requires BOTH
 * halves for superagent state (`actor: 'required'`, `onBehalfOf: 'required'`).
 * Folding the human into the thread's routing id — the one substitution A3
 * forbids — would make "did the person or their orchestrator send this turn?"
 * unanswerable, and that is precisely the question a broad-scope delegation's
 * history exists to answer (D8 S1).
 */
const ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'ADR 9 D5 A3 and the `superagentState` matrix row (actor required, onBehalfOf required): every ' +
    'turn records WHICH session or agent dispatched it and WHICH human it acted for, both stamped ' +
    'from the transport principal and never from payload. The superagent is a delegation, not a ' +
    'principal kind (D8 S1), so its writes are exactly as attributable as any other agent’s.',
}

/**
 * THE VISIBILITY CLASS OF WHAT ALL SEVEN WRITE (ADR 9 D3/D4 + D8 S2, matrix row
 * `superagentState`). See the file header for why this is one constant, why it
 * is not `per-user-state`, and why the test that pins it needs a non-vacuity
 * probe to mean anything.
 */
const SUPERAGENT_VISIBILITY = 'personal' as const

/**
 * Ownership on create — ADR 9 D5 A4 plus the matrix row's OWN
 * `inheritanceOnCreate` cell, which declares `on-behalf-of-human` for this row
 * (not `parent`). Declared per contract rather than left to handler code.
 */
const OWNED_BY_HUMAN = (creates: readonly string[], note: string) =>
  ({
    creates,
    owner: 'on-behalf-of-human',
    visibility: SUPERAGENT_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note,
  }) as const

/**
 * Amendment 1 D20.3 for the commands that only READ a thread by id: invisible
 * must fail as nonexistent. Today `sendTurn` and `restart` both throw
 * `unknown thread: <id>`, which is already the right shape; this records it as
 * metadata so the next handler inherits it instead of re-deciding it.
 */
const THREAD_ERRORS = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note: 'A thread id the principal may not see fails identically to one that does not exist — same message, no code on either. This path places nothing on owned compute, so readiness §3.1.4 M5’s carve-out (which pulls the other way) does not apply here; see the machine-placing contracts, where it does.',
} as const

/**
 * The SAME rule, resolved the other way, for the three commands that place work
 * on owned compute. Readiness §3.1.4 M5 is explicit that machine placement is
 * the one carve-out from D20.2: "you may not use this machine" and "this
 * machine is unreachable" MUST stay distinguishable, or a user cannot tell a
 * permissions problem from a dead daemon. `classificationErrors` enforces the
 * pairing — a `use` verb with a caller-supplied id and this flag false is a
 * build error, which is why the two fields are decided together.
 */
const MACHINE_ERRORS = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: true,
  note: 'Thread VISIBILITY still fails closed as nonexistent (D20.2). But once the thread resolves and the work is placed, an unreachable daemon and a machine the principal may not `use` report differently — readiness §3.1.4 M5’s carve-out, without which a dead daemon is indistinguishable from a revoked grant.',
} as const

// ---------------------------------------------------------------------------
// THE TURN COMMANDS — work placed on owned compute
// ---------------------------------------------------------------------------

export const superagentSendTurnInput = z.object({
  threadId: ThreadIdField.default(asThreadId('global')),
  text: turnText,
  focus: superagentUserFocus.optional(),
})

/**
 * ONE headless harness turn on an existing thread — and the ONE name for it.
 *
 * `superagent.send` was its byte-identical alias and is deleted; see the file
 * header for the caller census that decided which name survives. THE HONEST
 * CAVEAT: tRPC serves procedures by name over HTTP, so a client bundle older
 * than this change that still calls `send` would now 404. No shipped client
 * does — every in-repo caller, including the browser e2e that asserts on the
 * outgoing URL, names `sendTurn` — and the alias was never on a documented
 * public surface. A deprecation window would therefore preserve a name nothing
 * has ever sent, which is how a fork survives a dedupe.
 */
export const superagentSendTurnContract = {
  name: 'superagent.sendTurn',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentSendTurnInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'A turn RUNS A CODING AGENT on the thread’s machine — it spawns or resumes a headless harness ' +
      'session through the daemon. That is a code-execution boundary and is authorized as machine ' +
      '`use` (readiness §3.1.4 M2), not as a personal write, even though the STATE it writes is ' +
      'personal (ADR 9 D6 and the note in `classificationErrors`: a machine resource does not imply ' +
      'owned-compute state). A member may do it on their own machine; it needs no confirmation ' +
      'because sending a message to your own orchestrator is the ordinary act, and the destructive ' +
      'thing an agent might then do is gated where that thing happens, not here.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: TURN_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['podium-session', 'superagent-queued-input', 'superagent-pending-turn'],
    'The first turn on a thread mints the headless Podium session; every turn mints a queued input ' +
      'and a pending turn row. All three are owned by the human the superagent is acting for — the ' +
      'matrix row declares `inheritanceOnCreate: on-behalf-of-human` explicitly rather than ' +
      'inheriting from the thread, because a broad-scope delegation’s ceiling IS its human (D8 S1).',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: MACHINE_ERRORS,
  cli: { summary: 'Send one turn to a superagent thread' },
  conflict: 'append',
} as const satisfies CommandContract<typeof superagentSendTurnInput>

export const superagentConciergeInput = z.object({
  repoPath: z.string().min(1),
  text: turnText,
  focus: superagentUserFocus.optional(),
})

/** Per-repo concierge intake (#64): ensure the repo's thread, then run the
 *  message as a turn. Same placement as `sendTurn`, plus a thread on first use. */
export const superagentConciergeContract = {
  name: 'superagent.concierge',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentConciergeInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'Identical placement to `sendTurn` — it ends in one — with a thread upsert in front. The ' +
      'repoPath is checked against the registered repo list before anything is created, which is a ' +
      'pre-existing guard this migration does not relax: an unregistered path is refused rather than ' +
      'silently registered.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: {
    ...TURN_REDACTION,
    inputPaths: ['text', 'repoPath', 'focus.worktreePath', 'focus.filePath'],
    note: 'As `sendTurn`, plus `repoPath` — a third path into the caller’s machine, and the one that names which project they are working on.',
  },
  ownership: OWNED_BY_HUMAN(
    ['superagent-thread', 'podium-session', 'superagent-queued-input', 'superagent-pending-turn'],
    'First intake for a repo mints the concierge thread as well as the turn’s rows; later intakes ' +
      'reuse it (`isNew` on the ack says which happened). Owned by the acting principal’s human.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: {
    ...MACHINE_ERRORS,
    note: 'An unregistered repo is refused by name (`unknown repo: <path> — register it in Podium first`). That is NOT an existence oracle in the D20.2 sense: the caller supplied the path, it names their own filesystem, and the refusal reports the state of Podium’s registry rather than the visibility of someone else’s row.',
  },
  cli: { summary: 'Send a concierge intake message for a repo' },
  conflict: 'append',
} as const satisfies CommandContract<typeof superagentConciergeInput>

export const superagentOpenInTerminalInput = z.object({ threadId: ThreadIdField })

/**
 * The escape hatch: open the thread's harness session as a NORMAL PTY session
 * and TAKE THE THREAD LOCK — one writer at a time. `sendTurn` and `restart`
 * refuse while that terminal session is live; the lock clears lazily when it
 * exits, and `clear` RELEASES it rather than refusing (see that contract).
 *
 * The lock is service state, not contract state, and this migration does not
 * move it: the contract describes who may ask and what class the write is, and
 * the one-writer rule stays exactly where it is enforced today.
 */
export const superagentOpenInTerminalContract = {
  name: 'superagent.openInTerminal',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentOpenInTerminalInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'It spawns a PTY running the harness CLI on the thread’s machine (`claude --resume <id>` and ' +
      'friends) — a code-execution boundary, so machine `use` (readiness §3.1.4 M2), the same verb ' +
      '`sessions.handoff` and the spawns carry. What it WRITES is the thread’s terminal binding, ' +
      'which is personal state; ADR 9 D6 keeps those two answers separate on purpose.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: CONTROL_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['podium-session'],
    'A PTY session resuming the thread’s harness conversation, owned by the human the thread is ' +
      'owned by. Re-opening while an earlier attachment is live reuses the row rather than minting a ' +
      'second writer — which is the lock, expressed as identity.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: MACHINE_ERRORS,
  cli: { summary: 'Open a superagent thread’s harness session in a terminal' },
  conflict: 'cmd',
  conflictRule:
    'Re-opening while an earlier attachment is live REUSES the session row rather than minting a second writer — the rule the ownership note already states',
} as const satisfies CommandContract<typeof superagentOpenInTerminalInput>

// ---------------------------------------------------------------------------
// THREAD CONTROL — live decisions that place no new work
// ---------------------------------------------------------------------------

export const superagentInterruptTurnInput = z.object({ threadId: ThreadIdField })

/**
 * Stop the thread's running headless turn.
 *
 * NOT machine `use`, and the line matters: this places no work. It addresses a
 * turn ALREADY placed and authorized, on a session the caller can already see,
 * and delivers a signal to it. Classifying every touch of a running process as
 * `use` would make the verb mean "anything near compute" instead of "may cause
 * code to run", which is the distinction readiness §3.1.4 M2 draws.
 */
export const superagentInterruptTurnContract = {
  name: 'superagent.interruptTurn',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentInterruptTurnInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'Control of a turn that is already running on a session the principal owns: it causes no new ' +
      'code to run, so it is a session write and not machine `use`. No confirmation — stopping your ' +
      'own agent mid-thought is recoverable (the next turn re-sends), and a confirmation on the ' +
      'STOP button is a confirmation on the wrong side of the risk.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: CONTROL_REDACTION,
  ownership: {
    creates: [],
    note: 'Creates nothing. It signals an existing headless session; the turn’s own completion path writes the turn-end.',
  },
  attribution: ATTRIBUTION,
  errorConsistency: {
    ...THREAD_ERRORS,
    note: 'A thread with no headless session refuses with `no headless session for thread: <id>` — the same message whether the thread is invisible, absent, or simply has never run a turn, so the refusal distinguishes none of the three.',
  },
  cli: { summary: 'Interrupt a superagent thread’s running turn' },
  conflict: 'cmd',
  conflictRule:
    'Signals an existing headless session; idempotent, and interrupting a turn that has already ended is a no-op rather than a rejection',
} as const satisfies CommandContract<typeof superagentInterruptTurnInput>

export const superagentRestartInput = z.object({
  threadId: ThreadIdField.default(asThreadId('global')),
})

/**
 * Reset the thread's harness session — the next turn mints a fresh one (#199).
 * Recovery for a wedged or stale harness; the thread and its history survive.
 *
 * THREAD-LOCK SEMANTICS PRESERVED, and they are asymmetric on purpose: restart
 * REFUSES while the terminal lock is held (a fresh harness session while a PTY
 * writes the old one is two writers), whereas `clear` RELEASES it. Both
 * behaviours are the service's today and neither moves here.
 */
export const superagentRestartContract = {
  name: 'superagent.restart',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentRestartInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'Drops the thread’s harness+headless binding so the NEXT turn starts cold. It runs nothing ' +
      'itself, so it is a session write rather than machine `use` — the placement happens later, ' +
      'under `sendTurn`’s own contract, which is where the verb belongs. Recoverable and ' +
      'history-preserving, so no confirmation.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: CONTROL_REDACTION,
  ownership: {
    creates: [],
    note: 'Creates nothing; it nulls two binding columns on an existing thread row. The fresh harness session is minted by the next `sendTurn`, under that contract.',
  },
  attribution: ATTRIBUTION,
  errorConsistency: THREAD_ERRORS,
  cli: { summary: 'Reset a superagent thread’s harness session' },
  conflict: 'cmd',
  conflictRule:
    'Nulls two binding columns on the thread row; the next sendTurn mints the replacement session, so two concurrent restarts leave one nulled row rather than two sessions',
} as const satisfies CommandContract<typeof superagentRestartInput>

export const superagentClearInput = z.object({
  threadId: ThreadIdField.default(asThreadId('global')),
})

/**
 * Reset a thread's context (#225). The harness owns the conversation, so this
 * drops the binding and the watermark — the next turn is a first turn, re-primed
 * with the seed digest. A btw/concierge thread IS its context, so clearing one
 * archives it.
 *
 * `confirmation: 'confirm'` and it is the only one of the seven. Clearing the
 * global thread kills its headless session and drops the harness binding: the
 * conversation the agent held is not recoverable from Podium afterwards, and a
 * btw thread is archived outright. ADR 3 D2 asks for confirmation on
 * destructive writes and this is the family's destructive write.
 */
export const superagentClearContract = {
  name: 'superagent.clear',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentClearInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'confirm',
    rationale:
      'The destructive one: it archives a btw/concierge thread or drops the global thread’s binding, ' +
      'watermark and buffered rows, and best-effort kills the headless session. ADR 3 D2 asks for ' +
      'confirmation on a destructive write. Still a session write and not machine `use` — killing a ' +
      'session ENDS execution rather than causing it, and the kill is best-effort precisely so a ' +
      'stale row cannot block the reset the user asked for.',
  },
  exposure: SERVED_ON,
  delivery: LIVE_TURN_DELIVERY,
  redaction: CONTROL_REDACTION,
  ownership: {
    creates: [],
    note: 'Creates nothing. It archives a thread (soft-delete, the matrix row’s tombstone rule) or nulls the global thread’s bindings.',
  },
  attribution: ATTRIBUTION,
  errorConsistency: {
    ...THREAD_ERRORS,
    note: 'Clearing an unknown thread is a no-op rather than an error (`getSuperagentThread` returns undefined and the global path returns early), so this command reports nothing about which threads exist — the strongest form of D20.2 compliance and the one behaviour here that predates the rule.',
  },
  cli: { summary: 'Clear a superagent thread’s context' },
  conflict: 'cmd',
  conflictRule:
    'Archives the thread (soft-delete, the matrix row tombstone rule) or nulls the global thread bindings; idempotent either way',
} as const satisfies CommandContract<typeof superagentClearInput>

export const superagentStartBtwInput = z.object({ sessionId: SessionIdField })

/**
 * Ensure (or re-open) a `btw` thread for a chat session. NO TURN RUNS HERE: the
 * seed (new thread) or origin-transcript delta (re-open) is prepended to the
 * thread's next `sendTurn` by `composeContext`, so the harness sees it exactly
 * once. That is why this is the one offline-eligible contract of the seven.
 */
export const superagentStartBtwContract = {
  name: 'superagent.startBtw',
  version: 1,
  visibility: SUPERAGENT_VISIBILITY,
  input: superagentStartBtwInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'session',
    confirmation: 'none',
    rationale:
      'Upserts a thread bound to a chat session the principal must already be able to see — the ' +
      'session is the resource, and the thread inherits its reach. Nothing runs, nothing is ' +
      'destroyed, and re-running returns the existing thread, so neither confirmation nor a machine ' +
      'verb applies.',
  },
  exposure: SERVED_ON,
  delivery: THREAD_UPSERT_DELIVERY,
  redaction: CONTROL_REDACTION,
  ownership: OWNED_BY_HUMAN(
    ['superagent-thread'],
    'The btw thread is owned by the human whose session it hangs off. It inherits `on-behalf-of-human` ' +
      'rather than `parent` because that is what the `superagentState` matrix row declares — and the ' +
      'two answers coincide here only because the origin session has the same owner, which is a ' +
      'coincidence of today’s single-user deployment and not a rule to lean on.',
  ),
  attribution: ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Takes a caller-supplied SESSION id. An unknown session yields a thread titled with the raw id rather than an error, so the command reports nothing about which sessions exist. When POD-1077 scopes the session feed, the visibility check lands on the session read this already performs.',
  },
  cli: { summary: 'Open a btw thread for a chat session' },
  conflict: 'cmd',
  conflictRule:
    'One btw thread per parent session; a concurrent start returns the existing thread rather than minting a second',
} as const satisfies CommandContract<typeof superagentStartBtwInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * THE SEVEN, keyed by the BARE PROC NAME every transport already dispatches on.
 * The wire names are kept — renaming one is a client-compatibility change and
 * this is a migration. The single deliberate exception is the DELETION of
 * `send`, which is this issue's assignment and is argued in the file header.
 */
export const SUPERAGENT_CONTRACTS = {
  sendTurn: superagentSendTurnContract,
  interruptTurn: superagentInterruptTurnContract,
  openInTerminal: superagentOpenInTerminalContract,
  clear: superagentClearContract,
  restart: superagentRestartContract,
  startBtw: superagentStartBtwContract,
  concierge: superagentConciergeContract,
} as const

export type SuperagentContractName = keyof typeof SUPERAGENT_CONTRACTS

/** The dotted wire names, derived — never a second hand-typed list. */
export const SUPERAGENT_COMMAND_NAMES: readonly string[] = Object.values(SUPERAGENT_CONTRACTS).map(
  (c) => c.name,
)
