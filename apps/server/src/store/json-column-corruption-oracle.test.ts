/**
 * THE CORRUPT-BLOB ORACLE — what every JSON column does TODAY when its stored
 * value is unreadable (POD-3245, epic POD-3221 step [0.3]).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT EXISTS *BEFORE* THE CONVERSION
 * ---------------------------------------------------------------------------
 *
 * The store is being moved off hand-written SQL onto Drizzle. Every column below
 * was declared `mode: 'json'` in `migrations/schema.ts` when this file was
 * written, which was then only a MIGRATION-TIME declaration: the readers are raw `SELECT`s, and each one decides
 * for itself what a corrupt blob means. Some quarantine it to a safe default and
 * warn; some hand the junk straight through unchecked; some throw.
 *
 * A Drizzle read of a `mode: 'json'` column does none of those things — it calls
 * `JSON.parse` in the driver mapper and lets the error out. So the conversion can
 * silently turn "one bad row, warned about, load continues" into "the whole table
 * load aborts", and for the issues table that is a boot crash-loop (the case
 * `issues.boot-quarantine.test.ts` exists for).
 *
 * This file is therefore written FIRST and asserts TODAY'S behaviour, per column,
 * for BOTH failure modes (invalid JSON, and valid JSON of the wrong shape). It is
 * the oracle: after the conversion, every assertion here must still hold, or the
 * conversion changed a durable failure mode and has to say so out loud.
 *
 * The column list is DERIVED from `schema.ts` at test time, not typed out.
 *
 * WHAT [0.12] (POD-3254) THEN DID WITH IT, since it changes how to read the file:
 * the decisions in the last column below are now APPLIED in `schema.ts`. Only the
 * five whole-column THROW IS INTENDED cases are still `mode: 'json'`; the other
 * eighteen are plain `text`, so their existing readers keep the quarantine or the
 * passthrough pinned here. The assertions below therefore check two things rather
 * than one — that all 23 classified columns still exist, and that the retained
 * `mode: 'json'` set is exactly those five.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE — observed behaviour, and the decision the conversion will apply
 * ---------------------------------------------------------------------------
 *
 * `quarantine` = the bad value is replaced by a safe default and the load survives.
 * `passthrough` = the bad value reaches the caller UNCHECKED (no parse, no schema).
 * `throw`      = the read fails, by design or by accident.
 * `unread`     = no store read path projects this column today.
 *
 * This table feeds [0.12].
 *
 * | column (case)                                        | invalid JSON | wrong shape | conversion decision |
 * | ---------------------------------------------------- | ------------ | ----------- | ------------------- |
 * | issues.blocked_by                                     | quarantine   | quarantine  | KEEP QUARANTINE — text + `parseStringArray`, or a quarantining customType. A throw here crash-loops boot. |
 * | issues.human_question_options                         | quarantine   | quarantine  | KEEP QUARANTINE — same load; quarantines to `null` (no chips), not `[]`. |
 * | podium_events.payload                                 | quarantine   | passthrough | KEEP QUARANTINE — the event log must stay readable past one bad row. Shape is unvalidated today and stays that way. |
 * | root_integration_receipts.descendants                 | quarantine   | quarantine  | KEEP QUARANTINE at the parse step; `RootIntegrationReceipt.parse` above it is the real guard. |
 * | session_observation_checkpoints.checkpoint_json       | quarantine   | quarantine  | KEEP QUARANTINE — a corrupt checkpoint degrades to "no checkpoint"; the lease still reads. |
 * | session_terminal_candidates.proof_json                | quarantine   | quarantine  | KEEP QUARANTINE — an unreadable proof is "no candidate". |
 * | settings_audit_events.detail_json                     | quarantine   | passthrough | KEEP QUARANTINE — deliberately `undefined`, NOT `{}`: unreadable is a different fact from empty in an audit trail. |
 * | settings_audit_events.redacted_paths                  | quarantine   | passthrough | KEEP QUARANTINE — and note the passthrough: a non-array is cast to `string[]` with no check today. |
 * | ship_holds.actions                                    | throw        | throw       | THROW, BUT BY ACCIDENT — `jsonArray` quarantines to `[]` and `ShipHold.parse` then refuses an empty `actions` (min 1). `mode: 'json'` is acceptable because it throws either way, but [0.12] should decide whether ONE bad hold ought to make `listHolds()` unreadable. |
 * | ship_holds.evidence_refs                              | quarantine   | quarantine  | KEEP QUARANTINE — no minimum above it, so the hold still loads. |
 * | ship_orders.current_integration_receipt (stacked order)   | throw        | throw       | THROW IS INTENDED — dropping the receipt off an order that HAS descendants breaks the binding `ShipOrder.parse` exists to enforce. |
 * | ship_orders.delivery_depends_on                       | quarantine   | quarantine  | KEEP QUARANTINE — an order whose dependency list is unreadable still has to be enumerable. |
 * | ship_orders.descendant_manifest (order with no descendants)    | quarantine   | quarantine  | KEEP QUARANTINE — the order still loads. |
 * | ship_orders.descendant_manifest (stacked order)    | throw        | throw       | THROW IS INTENDED — same binding refinement, from the other side. Both cases are pinned because the column's behaviour depends on the ROW, not the column. |
 * | ship_orders.provider_ref                              | quarantine   | quarantine  | KEEP QUARANTINE — `jsonObject` drops it to absent; the order still loads. |
 * | ship_orders.validation_profile                        | throw        | throw       | THROW IS INTENDED — profile and digest must be present together, so dropping one half is refused. |
 * | ship_steps.input_fence                                | throw        | throw       | THROW IS INTENDED — a step whose fence is unreadable cannot be replayed or compared; `ShipStep.parse` refuses it. |
 * | ship_train_manifests.provider_ref                     | throw        | throw       | THROW IS INTENDED — the normalized columns are cross-checked against the canonical manifest; a mismatch is a custody failure, not a degraded read. |
 * | ship_train_manifests.validation_profile               | throw        | throw       | THROW IS INTENDED — same custody check. |
 * | ship_train_members.delivery_depends_on                | throw        | throw       | THROW IS INTENDED — same custody check, member half. |
 * | workflow_events.payload_json                          | unread       | unread      | NO READER — `listRunEvents` projects the attribution pair and deliberately not the payload. A conversion must NOT add one: a reader here is a redaction decision, not a mapping change. |
 * | workflow_revisions.steps_json                         | quarantine   | throw       | KEEP QUARANTINE for the parse; the zod throw on a wrong shape is intended and stays. |
 * | workflow_run_steps.evidence_json                      | quarantine   | throw       | KEEP QUARANTINE for the parse (`{}` then fills the schema's defaults); same split. |
 * | workflow_run_steps.warnings_json                      | quarantine   | throw       | KEEP QUARANTINE for the parse; same split. |
 *
 * The three text columns below are NOT `mode: 'json'` but are read through the
 * same shared quarantine helpers, so the conversion touches them too:
 *
 * | column                                | invalid JSON | wrong shape | conversion decision |
 * | ------------------------------------- | ------------ | ----------- | ------------------- |
 * | superagent_messages.tool_calls         | quarantine   | passthrough | KEEP QUARANTINE — `parseJsonColumn`, unchanged. |
 * | superagent_queued_inputs.focus_json    | quarantine   | passthrough | KEEP QUARANTINE — same. |
 * | superagent_pending_turns.payload_json  | throw        | passthrough | THROW IS INTENDED — `parseJsonColumn` quarantines to `undefined` and the caller turns that into a refusal, because a turn with no payload cannot be resumed. |
 *
 * ---------------------------------------------------------------------------
 * HOW THE CORRUPTION IS PLANTED
 * ---------------------------------------------------------------------------
 *
 * Several of these tables carry append-only/immutability triggers, so a bad blob
 * can never be written THROUGH the product. That is the point: the scenario is a
 * value that is already bad on disk — a legacy row, a partial restore, an
 * externally edited database. `plant()` therefore drops the table's triggers, does
 * the raw UPDATE, and puts them back, which is the closest a test can get to
 * "this is what was on disk when we opened it".
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asSessionId,
  asShipHoldId,
  asShipOrderId,
  asThreadId,
  FIRST_ADMIN_USER_ID,
  type ShipAttempt,
  type ShipOrder,
} from '@podium/model'
import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../migrations/schema'
import { SessionStore } from '../store'

// ---------------------------------------------------------------------------
// the raw seam
// ---------------------------------------------------------------------------

interface RawStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface RawDatabase {
  prepare(sql: string): RawStatement
  exec(sql: string): unknown
}

/** The store's own connection. A probe seam, exactly as `store-issues.test.ts`
 *  and `store.search-index.test.ts` already use it. */
const rawDb = (store: SessionStore): RawDatabase => (store as unknown as { db: RawDatabase }).db

/**
 * Make one column of one row hold `value`, whatever the table's triggers think.
 *
 * The triggers protect the PRODUCT's writes; they say nothing about what a
 * restored or externally edited file contains, and that is the case under test.
 */
function plant(
  store: SessionStore,
  table: string,
  column: string,
  where: string,
  params: readonly unknown[],
  value: string,
): void {
  const db = rawDb(store)
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
    .all(table) as { name: string; sql: string }[]
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`)
  try {
    const changed = db
      .prepare(`UPDATE "${table}" SET "${column}" = ? WHERE ${where}`)
      .run(value, ...params) as { changes?: number }
    // A planted value nobody stored is a vacuous green: the read below would see
    // a row that does not exist and "quarantine" would be indistinguishable from
    // "absent". Fail loudly instead.
    if (changed.changes !== undefined && changed.changes < 1) {
      throw new Error(`corruption planted on no row: ${table}.${column} WHERE ${where}`)
    }
  } finally {
    for (const trigger of triggers) db.exec(trigger.sql)
  }
}

// ---------------------------------------------------------------------------
// the oracle's vocabulary
// ---------------------------------------------------------------------------

type Behaviour =
  /** The bad value was replaced by a safe default and the load survived. */
  | { readonly kind: 'quarantine'; readonly value: unknown }
  /** The bad value reached the caller unchecked. */
  | { readonly kind: 'passthrough'; readonly value: unknown }
  /** The read failed. */
  | { readonly kind: 'throw'; readonly message: RegExp }
  /** No store read path projects this column. */
  | { readonly kind: 'unread' }

type Observed =
  | { readonly outcome: 'value'; readonly value: unknown }
  | { readonly outcome: 'throw'; readonly message: string }

const observe = (read: () => unknown): Observed => {
  try {
    return { outcome: 'value', value: read() }
  } catch (err) {
    return { outcome: 'throw', message: err instanceof Error ? err.message : String(err) }
  }
}

interface Fixture {
  readonly store: SessionStore
  readonly orderId: string
  readonly stackedOrderId: string
  readonly stepId: string
  readonly attemptId: ShipAttempt['id']
  readonly trainId: string
  readonly runId: string
  readonly revisionId: string
  readonly sessionId: string
}

interface OracleEntry {
  readonly table: string
  readonly column: string
  /** Set when one column has more than one interesting case. */
  readonly scenario?: string
  /** The store call whose result the assertions below are about. */
  readonly reader: string
  /** Row selector for `plant()`. */
  readonly where: string
  readonly params: (f: Fixture) => readonly unknown[]
  /** The projected value the reader hands back, or `undefined` for an unread column. */
  readonly read?: (f: Fixture) => unknown
  /** Valid JSON whose SHAPE is wrong for this column (object where an array
   *  belongs, and the reverse). */
  readonly wrongShapeValue: string
  readonly onInvalidJson: Behaviour
  readonly onWrongShape: Behaviour
}

/** Not JSON under any reading. */
const INVALID_JSON = '{not json'

const key = (entry: { table: string; column: string }) => `${entry.table}.${entry.column}`
const caseName = (entry: OracleEntry) =>
  entry.scenario ? `${key(entry)} (${entry.scenario})` : key(entry)

// ---------------------------------------------------------------------------
// the fixture — one seeded database holding a valid row for every column below
// ---------------------------------------------------------------------------

const AT = '2026-08-12T10:00:00.000Z'
const SESSION = asSessionId('sess_oracle')

const issueRow = (overrides: Record<string, unknown> = {}) => ({
  id: asIssueId('iss_1'),
  repoPath: '/r',
  seq: 1,
  title: 'Fix login',
  description: 'desc',
  ownerUserId: FIRST_ADMIN_USER_ID,
  visibility: 'personal' as const,
  createdByActor: FIRST_ADMIN_USER_ID,
  createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
  stage: 'backlog',
  worktreePath: '/r/wt',
  branch: 'issue/1',
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: asMachineId('machine-1'),
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [] as string[],
  dependencyNote: null,
  prUrl: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  pinned: false,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  createdAt: AT,
  updatedAt: AT,
  archived: false,
  ...overrides,
})

const VALIDATION_PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root',
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

const shipOrderInput = (overrides: Partial<ShipOrder> = {}): ShipOrder =>
  ({
    id: asShipOrderId('order-1'),
    issueId: asIssueId('iss_1'),
    descendantManifest: [],
    repoId: asRepoId('repo-1'),
    repoPath: '/r',
    machineId: asMachineId('machine-1'),
    targetBranch: 'main',
    destination: 'origin/main',
    approvedBaseSha: 'approved-base',
    approvedHeadSha: 'approved-head',
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
      onBehalfOf: FIRST_ADMIN_USER_ID,
    },
    requestedAt: AT,
    policyId: 'default',
    // Present on every fixture order so the claimed train's lane carries one too:
    // `ship_train_manifests.provider_ref` is a NULL column otherwise, and a NULL
    // column cannot be corrupted into anything the oracle could observe.
    providerRef: { provider: 'github', id: '42' },
    validationProfile: VALIDATION_PROFILE,
    validationProfileDigest: createHash('sha256')
      .update(JSON.stringify(VALIDATION_PROFILE))
      .digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: AT,
    ...overrides,
  }) as ShipOrder

function seed(): Fixture {
  const store = new SessionStore(':memory:')

  // --- issues ---------------------------------------------------------------
  store.issues.upsertIssue(issueRow())
  // `upsertIssue` has no field for it; the oracle only needs a readable value
  // in the column, which is what a live "needs human" issue holds.
  rawDb(store)
    .prepare('UPDATE issues SET human_question_options = ? WHERE id = ?')
    .run(JSON.stringify(['yes', 'no']), 'iss_1')

  // --- podium_events --------------------------------------------------------
  store.events.appendEvent(
    { ts: AT, kind: 'issue.updated', subject: 'iss_1', repoPath: '/r', payload: { ok: true } },
    { announce: false },
  )

  // --- settings_audit_events ------------------------------------------------
  store.settingsAudit.append({
    command: 'settings.set',
    outcome: 'applied',
    actorKind: 'user',
    actorId: FIRST_ADMIN_USER_ID,
    onBehalfOf: FIRST_ADMIN_USER_ID,
    detail: { path: 'roles.coding.model' },
    redactedPaths: ['roles.coding.model'],
    createdAt: AT,
  })

  // --- observation checkpoints + terminal candidates -------------------------
  store.observationCheckpoints.advanceGeneration(SESSION, 'codex', 'thread-1')
  store.observationCheckpoints.save({
    schemaVersion: 1,
    podiumSessionId: SESSION,
    provider: 'codex',
    providerSessionId: 'thread-1',
    bindingVersion: 1,
    lifecycleObservationGeneration: 1,
    providerCursor: { segmentId: 'rollout-1', components: { file: 42 } },
    bootstrapCursor: { segmentId: 'rollout-1', components: { file: 42 } },
    lastAcceptedLiveCursor: null,
    turnEpoch: 0,
    providerTurnId: null,
    providerPromptId: null,
    turnState: { phase: 'idle', since: AT, workingMsTotal: 0, nativeSubagentCount: 0 },
    terminalFence: null,
    providerAt: AT,
    acceptedAt: AT,
    lastLiveReceiptAt: null,
    lastTransitionId: 'snapshot-1',
  })
  store.observationCheckpoints.recordTerminalCandidate(
    {
      schemaVersion: 1,
      sessionId: SESSION,
      terminalTransitionId: 'transition-1',
      terminalTurnEpoch: 1,
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observerGeneration: 1,
      providerCursor: { segmentId: 'rollout-1', components: { file: 42 } },
      lastLiveReceiptAt: null,
      lastTransitionId: 'transition-1',
      lastActiveAt: AT,
      lastInputAtMs: 0,
      lastOutputAtMs: 0,
      lastResumedAtMs: 0,
      inputCount: 0,
      outputCount: 0,
      activityCount: 0,
      queuedInputCount: 0,
      pendingMessages: [],
      autoContinueActive: false,
      activeWork: {
        nativeSubagentCount: 0,
        nativeSubagentIds: [],
        awaitingSubagents: false,
        childSessions: [],
        queueDrainActive: false,
      },
      resumable: true,
      machineId: asMachineId('machine-1'),
    },
    AT,
  )

  // --- shipping: orders, a claimed train (manifest + members + attempts +
  //     steps), a root integration receipt and an open hold -------------------
  store.issues.upsertIssue(
    issueRow({ id: asIssueId('iss_2'), seq: 2, branch: 'issue/2', title: 'Second' }),
  )
  const lower = shipOrderInput()
  const covering = shipOrderInput({
    id: asShipOrderId('order-2'),
    issueId: asIssueId('iss_2'),
    approvedHeadSha: 'covering-head',
    deliveryDependsOn: [asShipOrderId('order-1')],
  })
  store.shipping.createOrder(lower)
  store.shipping.createOrder(covering)
  const train = store.shipping.claimTrain({
    leaderOrderId: covering.id,
    startedAt: AT,
    members: [{ orderId: lower.id }, { orderId: covering.id }],
  })
  const leader = train.manifest.members.at(-1)
  if (!leader) throw new Error('fixture: claimed train has no members')
  const steps = store.shipping.stepsForAttempt(leader.attemptId)
  const step = steps[0]
  if (!step) throw new Error('fixture: claimed train wrote no ship step')

  // A STACKED order — one that carries a descendant manifest and the integration
  // receipt that binds it. Kept out of the train on purpose: the same two columns
  // behave differently on an order with descendants and one without, and the
  // oracle records both.
  store.issues.upsertIssue(
    issueRow({ id: asIssueId('iss_3'), seq: 3, branch: 'issue/3', title: 'Third' }),
  )
  const stackedDescendants = [{ issueId: asIssueId('iss_2'), approvedHeadSha: 'covering-head' }]
  const stacked = shipOrderInput({
    id: asShipOrderId('order-3'),
    issueId: asIssueId('iss_3'),
    approvedHeadSha: 'stacked-head',
    descendantManifest: stackedDescendants,
    currentIntegrationReceipt: {
      rootIssueId: asIssueId('iss_3'),
      approvedHeadSha: 'stacked-head',
      descendants: stackedDescendants,
    },
    providerRef: { provider: 'github', id: '42' },
  })
  store.shipping.createOrder(stacked)

  store.shipping.recordRootIntegrationReceipt({
    rootIssueId: asIssueId('iss_1'),
    approvedHeadSha: 'approved-head',
    descendants: [{ issueId: asIssueId('iss_2'), approvedHeadSha: 'covering-head' }],
  })

  store.shipping.raiseHold({
    id: asShipHoldId('hold-1'),
    orderId: lower.id,
    generation: 1,
    reasonCode: 'validation-failed',
    headline: 'Validation needs a decision',
    detail: 'The configured validation profile failed.',
    evidenceRefs: ['artifact://validation/1'],
    actions: ['retry'],
    raisedAt: AT,
  })

  // --- workflows ------------------------------------------------------------
  const actor = { kind: 'operator' as const, id: null }
  store.workflows.insertWorkflow({
    id: 'wf-1',
    name: 'Ship it',
    description: 'a workflow',
    scope: 'global',
    scopeRef: null,
    actor,
    ownerUserId: FIRST_ADMIN_USER_ID,
    now: AT,
  })
  const revision = store.workflows.insertRevision({
    id: 'wfrev-1',
    workflowId: 'wf-1',
    instructions: 'do the thing',
    steps: [
      {
        id: 'step-1',
        title: 'First',
        instructions: 'go',
        completionGuidance: 'done when done',
      },
    ],
    actor,
    now: AT,
  })
  store.workflows.insertRun({
    run: {
      id: 'wfrun-1',
      subjectKind: 'issue',
      subjectId: 'iss_1',
      coordinatorSessionId: SESSION,
      revisionId: revision.id,
      status: 'active',
      supersedesRunId: null,
      startedAt: AT,
      completedAt: null,
      ownerUserId: FIRST_ADMIN_USER_ID,
    },
    steps: [
      {
        id: 'step-1',
        title: 'First',
        instructions: 'go',
        completionGuidance: 'done when done',
        profile: null,
      },
    ],
  })
  store.workflows.appendEvent({
    workflowId: 'wf-1',
    runId: 'wfrun-1',
    kind: 'run.started',
    actor,
    onBehalfOf: FIRST_ADMIN_USER_ID,
    payload: { note: 'started' },
    now: AT,
  })

  // --- superagent -----------------------------------------------------------
  store.superagent.seedGlobalThread(FIRST_ADMIN_USER_ID)
  store.superagent.appendSuperagentMessage(asThreadId('global'), {
    role: 'assistant',
    content: 'hi',
    toolCalls: [{ id: 'call-1', name: 'noop', arguments: '{}' }],
  })
  store.superagent.putQueuedInput({
    inputId: 'queued-1',
    ownerUserId: FIRST_ADMIN_USER_ID,
    threadId: asThreadId('global'),
    text: 'do it',
    focus: { view: 'issues', issueId: asIssueId('iss_1') },
  })
  store.superagent.putPendingTurn({
    turnId: 'turn-1',
    ownerUserId: FIRST_ADMIN_USER_ID,
    threadId: asThreadId('global'),
    podiumSessionId: SESSION,
    payload: { agent: 'claude-code', cwd: '/r', prompt: 'do it' },
    firstTurn: true,
  })

  return {
    store,
    orderId: lower.id,
    stackedOrderId: stacked.id,
    stepId: step.id,
    attemptId: leader.attemptId,
    trainId: train.manifest.id,
    runId: 'wfrun-1',
    revisionId: revision.id,
    sessionId: SESSION,
  }
}

// ---------------------------------------------------------------------------
// the oracle
// ---------------------------------------------------------------------------

/** Every `mode: 'json'` column in `schema.ts`, classified. */
const JSON_COLUMNS: readonly OracleEntry[] = [
  {
    table: 'issues',
    column: 'blocked_by',
    reader: 'issues.getIssue().blockedBy',
    where: 'id = ?',
    params: () => ['iss_1'],
    read: (f) => f.store.issues.getIssue('iss_1')?.blockedBy,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'quarantine', value: [] },
  },
  {
    table: 'issues',
    column: 'human_question_options',
    reader: 'issues.getIssue().humanQuestionOptions',
    where: 'id = ?',
    params: () => ['iss_1'],
    read: (f) => f.store.issues.getIssue('iss_1')?.humanQuestionOptions,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: null },
    onWrongShape: { kind: 'quarantine', value: null },
  },
  {
    table: 'podium_events',
    column: 'payload',
    reader: 'events.listEventsSince(0)[0].payload',
    where: 'id = (SELECT MIN(id) FROM podium_events)',
    params: () => [],
    read: (f) => f.store.events.listEventsSince(0)[0]?.payload,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: {} },
    onWrongShape: { kind: 'passthrough', value: [1, 2] },
  },
  {
    table: 'root_integration_receipts',
    column: 'descendants',
    reader: 'shipping.rootIntegrationReceipt().descendants',
    where: 'root_issue_id = ?',
    params: () => ['iss_1'],
    read: (f) =>
      f.store.shipping.rootIntegrationReceipt(asIssueId('iss_1'), 'approved-head')?.descendants,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'quarantine', value: [] },
  },
  {
    table: 'session_observation_checkpoints',
    column: 'checkpoint_json',
    reader: 'observationCheckpoints.get().checkpoint',
    where: 'session_id = ?',
    params: (f) => [f.sessionId],
    read: (f) => f.store.observationCheckpoints.get(SESSION)?.checkpoint,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: null },
    onWrongShape: { kind: 'quarantine', value: null },
  },
  {
    table: 'session_terminal_candidates',
    column: 'proof_json',
    reader: 'observationCheckpoints.getTerminalCandidate()',
    where: 'session_id = ?',
    params: (f) => [f.sessionId],
    read: (f) => f.store.observationCheckpoints.getTerminalCandidate(SESSION),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: null },
    onWrongShape: { kind: 'quarantine', value: null },
  },
  {
    table: 'settings_audit_events',
    column: 'detail_json',
    reader: 'settingsAudit.list()[0].detail',
    where: 'id = (SELECT MIN(id) FROM settings_audit_events)',
    params: () => [],
    read: (f) => f.store.settingsAudit.list()[0]?.detail,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: undefined },
    onWrongShape: { kind: 'passthrough', value: [1, 2] },
  },
  {
    table: 'settings_audit_events',
    column: 'redacted_paths',
    reader: 'settingsAudit.list()[0].redactedPaths',
    where: 'id = (SELECT MIN(id) FROM settings_audit_events)',
    params: () => [],
    read: (f) => f.store.settingsAudit.list()[0]?.redactedPaths,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'passthrough', value: { a: 1 } },
  },
  {
    table: 'ship_holds',
    column: 'actions',
    reader: 'shipping.openHoldForOrder().actions',
    where: 'id = ?',
    params: () => ['hold-1'],
    read: (f) => f.store.shipping.openHoldForOrder(f.orderId)?.actions,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'throw', message: /at least 1 element/ },
    onWrongShape: { kind: 'throw', message: /at least 1 element/ },
  },
  {
    table: 'ship_holds',
    column: 'evidence_refs',
    reader: 'shipping.openHoldForOrder().evidenceRefs',
    where: 'id = ?',
    params: () => ['hold-1'],
    read: (f) => f.store.shipping.openHoldForOrder(f.orderId)?.evidenceRefs,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'quarantine', value: [] },
  },
  {
    table: 'ship_orders',
    column: 'current_integration_receipt',
    scenario: 'stacked order',
    reader: 'shipping.getOrder()',
    where: 'id = ?',
    params: (f) => [f.stackedOrderId],
    read: (f) => f.store.shipping.getOrder(f.stackedOrderId),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /required when descendantManifest is non-empty/ },
    onWrongShape: { kind: 'throw', message: /required when descendantManifest is non-empty/ },
  },
  {
    table: 'ship_orders',
    column: 'delivery_depends_on',
    reader: 'shipping.getOrder().deliveryDependsOn',
    where: 'id = ?',
    params: (f) => [f.orderId],
    read: (f) => f.store.shipping.getOrder(f.orderId)?.deliveryDependsOn,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'quarantine', value: [] },
  },
  {
    table: 'ship_orders',
    column: 'descendant_manifest',
    scenario: 'order with no descendants',
    reader: 'shipping.getOrder().descendantManifest',
    where: 'id = ?',
    params: (f) => [f.orderId],
    read: (f) => f.store.shipping.getOrder(f.orderId)?.descendantManifest,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'quarantine', value: [] },
  },
  {
    table: 'ship_orders',
    column: 'descendant_manifest',
    scenario: 'stacked order',
    reader: 'shipping.getOrder()',
    where: 'id = ?',
    params: (f) => [f.stackedOrderId],
    read: (f) => f.store.shipping.getOrder(f.stackedOrderId),
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'throw', message: /must bind approvedHeadSha/ },
    onWrongShape: { kind: 'throw', message: /must bind approvedHeadSha/ },
  },
  {
    table: 'ship_orders',
    column: 'provider_ref',
    reader: 'shipping.getOrder().providerRef',
    where: 'id = ?',
    params: (f) => [f.stackedOrderId],
    read: (f) => f.store.shipping.getOrder(f.stackedOrderId)?.providerRef,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: undefined },
    onWrongShape: { kind: 'quarantine', value: undefined },
  },
  {
    table: 'ship_orders',
    column: 'validation_profile',
    reader: 'shipping.getOrder()',
    where: 'id = ?',
    params: (f) => [f.orderId],
    read: (f) => f.store.shipping.getOrder(f.orderId),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /must be present together/ },
    onWrongShape: { kind: 'throw', message: /must be present together/ },
  },
  {
    table: 'ship_steps',
    column: 'input_fence',
    reader: 'shipping.stepById()',
    where: 'id = ?',
    params: (f) => [f.stepId],
    read: (f) => f.store.shipping.stepById(f.stepId),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /input/i },
    onWrongShape: { kind: 'throw', message: /input/i },
  },
  {
    table: 'ship_train_manifests',
    column: 'provider_ref',
    reader: 'shipping.trainManifestForAttempt()',
    where: 'id = ?',
    params: (f) => [f.trainId],
    read: (f) => f.store.shipping.trainManifestForAttempt(f.attemptId),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /authority mismatch/ },
    onWrongShape: { kind: 'throw', message: /authority mismatch/ },
  },
  {
    table: 'ship_train_manifests',
    column: 'validation_profile',
    reader: 'shipping.trainManifestForAttempt()',
    where: 'id = ?',
    params: (f) => [f.trainId],
    read: (f) => f.store.shipping.trainManifestForAttempt(f.attemptId),
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /authority mismatch/ },
    onWrongShape: { kind: 'throw', message: /authority mismatch/ },
  },
  {
    table: 'ship_train_members',
    column: 'delivery_depends_on',
    reader: 'shipping.trainManifestForAttempt()',
    where: 'train_id = ? AND ordinal = 1',
    params: (f) => [f.trainId],
    read: (f) => f.store.shipping.trainManifestForAttempt(f.attemptId),
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'throw', message: /member authority mismatch/ },
    onWrongShape: { kind: 'throw', message: /member authority mismatch/ },
  },
  {
    table: 'workflow_events',
    column: 'payload_json',
    reader: '(none — listRunEvents projects attribution only)',
    where: 'id = (SELECT MIN(id) FROM workflow_events)',
    params: () => [],
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'unread' },
    onWrongShape: { kind: 'unread' },
  },
  {
    table: 'workflow_revisions',
    column: 'steps_json',
    reader: 'workflows.getRevision().steps',
    where: 'id = ?',
    params: (f) => [f.revisionId],
    read: (f) => f.store.workflows.getRevision(f.revisionId)?.steps,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'throw', message: /./ },
  },
  {
    table: 'workflow_run_steps',
    column: 'evidence_json',
    reader: 'workflows.getRunSteps()[0].evidence',
    where: 'run_id = ? AND position = 0',
    params: (f) => [f.runId],
    read: (f) => f.store.workflows.getRunSteps(f.runId)[0]?.evidence,
    wrongShapeValue: '[1,2]',
    onInvalidJson: {
      kind: 'quarantine',
      value: { summary: '', tests: [], artifacts: [] },
    },
    onWrongShape: { kind: 'throw', message: /./ },
  },
  {
    table: 'workflow_run_steps',
    column: 'warnings_json',
    reader: 'workflows.getRunSteps()[0].warnings',
    where: 'run_id = ? AND position = 0',
    params: (f) => [f.runId],
    read: (f) => f.store.workflows.getRunSteps(f.runId)[0]?.warnings,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: [] },
    onWrongShape: { kind: 'throw', message: /./ },
  },
]

/**
 * Text columns that are NOT `mode: 'json'` but ARE read through the shared
 * quarantine helpers (`parseJsonColumn`/`parseStringArray`). They move with the
 * same conversion, so they are pinned in the same oracle — they are just not part
 * of the schema-derived coverage check below.
 */
const HELPER_COLUMNS: readonly OracleEntry[] = [
  {
    table: 'superagent_messages',
    column: 'tool_calls',
    reader: 'superagent.loadSuperagentMessages()[0].toolCalls',
    where: 'id = (SELECT MIN(id) FROM superagent_messages)',
    params: () => [],
    read: (f) => f.store.superagent.loadSuperagentMessages()[0]?.toolCalls,
    wrongShapeValue: '{"a":1}',
    onInvalidJson: { kind: 'quarantine', value: undefined },
    onWrongShape: { kind: 'passthrough', value: { a: 1 } },
  },
  {
    table: 'superagent_queued_inputs',
    column: 'focus_json',
    reader: 'superagent.listQueuedInputs()[0].focus',
    where: 'input_id = ?',
    params: () => ['queued-1'],
    read: (f) => f.store.superagent.listQueuedInputs()[0]?.focus,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'quarantine', value: undefined },
    onWrongShape: { kind: 'passthrough', value: [1, 2] },
  },
  {
    table: 'superagent_pending_turns',
    column: 'payload_json',
    reader: 'superagent.listPendingTurns()',
    where: 'turn_id = ?',
    params: () => ['turn-1'],
    read: (f) => f.store.superagent.listPendingTurns()[0]?.payload,
    wrongShapeValue: '[1,2]',
    onInvalidJson: { kind: 'throw', message: /invalid persisted superagent turn payload/ },
    onWrongShape: { kind: 'passthrough', value: [1, 2] },
  },
]

const ALL_ENTRIES = [...JSON_COLUMNS, ...HELPER_COLUMNS]

// ---------------------------------------------------------------------------
// the assertions
// ---------------------------------------------------------------------------

/** Every `mode: 'json'` column drizzle knows about, read out of `schema.ts`. */
function declaredJsonColumns(): string[] {
  const found: string[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    for (const column of config.columns) {
      if ((column as unknown as { columnType: string }).columnType !== 'SQLiteTextJson') continue
      found.push(`${config.name}.${column.name}`)
    }
  }
  return found.sort()
}

/** Every column drizzle knows about, `<table>.<column>`, read out of `schema.ts`. */
function declaredColumns(): string[] {
  const found: string[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    for (const column of config.columns) found.push(`${config.name}.${column.name}`)
  }
  return found.sort()
}

/**
 * The header table's own rows, read back out of this file.
 *
 * The table is what a human reads and what [0.12] consumes; the entries below are
 * what actually runs. A comment that has drifted from the code it documents is
 * worse than no comment, so they are compared.
 */
function headerTableRows(): string[] {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const header = source.slice(0, source.indexOf('*/'))
  return header
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(
      (line) => line.startsWith('|') && !line.startsWith('| -') && !line.includes('invalid JSON'),
    )
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim())
      return `${cells[1]} => ${cells[2]} / ${cells[3]}`
    })
    .sort()
}

/**
 * The columns [0.12] (POD-3254) LEFT as `mode: 'json'` — the five the table above
 * marks THROW IS INTENDED for the whole column, where drizzle's own parse failure
 * IS the contract. Every other column in the table became plain `text` in the same
 * commit, so that its reader keeps the quarantine or the passthrough pinned here.
 *
 * WRITTEN DOWN RATHER THAN DERIVED FROM THE TABLE, and the reason is
 * `ship_orders.current_integration_receipt`: it throws in the only case pinned
 * above (a stacked order) and so a derivation over the case kinds would demand
 * `mode: 'json'` for it, but its behaviour depends on the ROW — a plain order
 * quarantines — and a column mode cannot. Spec §6 rule 4 puts it with the
 * quarantining columns for exactly that reason. A rule that is wrong for one of
 * twenty-three is not a rule; this is the decision, spelled.
 */
const RETAINED_JSON_COLUMNS = [
  'ship_orders.validation_profile',
  'ship_steps.input_fence',
  'ship_train_manifests.provider_ref',
  'ship_train_manifests.validation_profile',
  'ship_train_members.delivery_depends_on',
].sort()

describe('the corrupt-blob oracle', () => {
  it('classifies every column the conversion decisions were made from', () => {
    // Derived from the entries, not typed out: the table above is what [0.12]
    // consumed, and it must not shrink silently after the fact.
    const classified = [...new Set(JSON_COLUMNS.map(key))].sort()
    expect(classified.length).toBe(23)
    // Every classified column still EXISTS in schema.ts. Before [0.12] this was
    // `columnType === 'SQLiteTextJson'` for all 23; the decisions turned
    // eighteen of them into plain `text`, so the existence check is by name now.
    expect(classified.filter((name) => !declaredColumns().includes(name))).toEqual([])
  })

  it("keeps mode: 'json' only where the throw is intended", () => {
    // The decision itself, pinned: a nineteenth `mode: 'json'` column — or one of
    // the five quietly demoted — fails here with its own name.
    expect(declaredJsonColumns()).toEqual(RETAINED_JSON_COLUMNS)
  })

  it('names each case exactly once', () => {
    // A column may appear twice when two states of the same row behave
    // differently (a stacked ship order versus a plain one); the CASE names must
    // still be unique, or one silently shadows the other in the report.
    const names = ALL_ENTRIES.map(caseName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has a header table that says what the entries below actually assert', () => {
    expect(headerTableRows()).toEqual(
      ALL_ENTRIES.map(
        (entry) => `${caseName(entry)} => ${entry.onInvalidJson.kind} / ${entry.onWrongShape.kind}`,
      ).sort(),
    )
  })

  it('seeds a readable value in every column it is about to corrupt', () => {
    const fixture = seed()
    const db = rawDb(fixture.store)
    for (const entry of ALL_ENTRIES) {
      const row = db
        .prepare(`SELECT "${entry.column}" AS value FROM "${entry.table}" WHERE ${entry.where}`)
        .get(...entry.params(fixture)) as { value: unknown } | undefined
      // A column the fixture never populated would make every "quarantine"
      // below true for the wrong reason.
      expect({ column: caseName(entry), seeded: typeof row?.value }).toEqual({
        column: caseName(entry),
        seeded: 'string',
      })
      expect(() => JSON.parse(String(row?.value))).not.toThrow()
    }
    fixture.store.close()
  })
})

describe.each(
  ALL_ENTRIES.map((entry) => [caseName(entry), entry] as const),
)('%s', (_name, entry) => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = seed()
    return () => fixture.store.close()
  })

  const check = (planted: string, expected: Behaviour) => {
    plant(fixture.store, entry.table, entry.column, entry.where, entry.params(fixture), planted)
    if (expected.kind === 'unread') {
      // Nothing projects the column, so the claim under test is that the read
      // model does not change — not that some value comes back.
      expect(entry.read).toBeUndefined()
      return
    }
    const read = entry.read
    if (!read) throw new Error(`${key(entry)} has no reader but expects ${expected.kind}`)
    const observed = observe(() => read(fixture))
    if (expected.kind === 'throw') {
      expect(observed).toMatchObject({ outcome: 'throw' })
      if (observed.outcome === 'throw') expect(observed.message).toMatch(expected.message)
      return
    }
    expect(observed).toEqual({ outcome: 'value', value: expected.value })
  }

  it(`on invalid JSON: ${entry.onInvalidJson.kind}`, () => {
    check(INVALID_JSON, entry.onInvalidJson)
  })

  it(`on valid JSON of the wrong shape: ${entry.onWrongShape.kind}`, () => {
    check(entry.wrongShapeValue, entry.onWrongShape)
  })
})
