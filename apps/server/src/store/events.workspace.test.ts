/**
 * EVENTS, EFFECTS, WORKFLOWS, AUTOMATIONS AND LOCKS ARE A WORKSPACE'S (POD-6959 design 2.4,
 * 2.5; task POD-7020).
 *
 * Two workspaces over one database (`openEventStoreSlices`, on the test run's engine: SQLite on
 * the store shard, Postgres on the `server-store-pg` lane), each seeded through its own
 * repositories: the event log and its runtime checkpoints, projection cursors, steward state,
 * subscriptions and deliveries; effects; workflows with revisions, bindings, runs, steps and
 * events; automations and their runs; pending interactions; superagent threads, messages, queued
 * inputs and pending turns; observation leases, rebind receipts and terminal candidates;
 * transcript costs; the maintenance ledger; locks and their waiters.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same sessions, issues,
 * member, effects, workflow, revision, run, automations, interactions, fingerprints, thread,
 * queued inputs, turns, subscriptions, steward and projector keys, transcript ids, ledger run
 * keys, repository and lock. Every key leads with workspace_id (POD-7024), so the same id is
 * two rows, told apart only by the workspace. The content differs (names, prompts, payloads,
 * cursors, provider ids, labels, owners, effect and event kinds), so a read that crossed over
 * would answer the other workspace's content. Event ids and lock waiter ids are the tables'
 * own numbers, so they differ by construction. Where a case needs an id the other workspace
 * does not hold, it plants one only the other holds (`only-<tag>…`).
 *
 * For every repository method of the group:
 *   - a read answers only its own workspace's rows, including the reads no id narrows (the feed
 *     window, the boot reconcile walks, every list);
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for the
 *     ids the two share and for ids only the other holds (which must find nothing to change),
 *     and the sweeps (the
 *     event prune, the maintenance ledger prune, the effect expiry and purge, the interaction
 *     prune, the superagent turn sync);
 *   - joins and subqueries hold the other table to the same workspace: a row in A that names an
 *     id only B holds finds nothing through it.
 *
 * The maintenance LEASE is the installation's (an install table): both workspaces read the one
 * lease, which is the design (2.1), and the test says so.
 */

import {
  type AutomationId,
  type AutomationRunId,
  asIssueId,
  asMachineId,
  asRepoId,
  asSessionId,
  asThreadId,
  asUserId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MaintenanceCommandReply, SessionObservationCheckpointV1 } from '@podium/protocol'
import type { RuntimeEvent } from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openEventStoreSlices, type WorkspaceEventSlice } from '../test-support/event-store-slice'
import type { AutomationRow, AutomationRunRow } from './automations'
import { RUNTIME_EVENT_LOG_KIND } from './events'
import type { SessionRow, Subscription, TerminalCandidateFacts } from './types'
import type { WorkflowActor, WorkflowRunRow } from './workflows'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const EARLIER = '2026-11-01T00:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'
const NOW_MS = Date.parse('2026-11-17T10:00:00.000Z')
const scope = fixtureWriteScope()
const OPERATOR: WorkflowActor = { kind: 'operator', id: null }

const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
// The same ids and natural keys in both workspaces.
const ALICE: UserId = asUserId('user:alice')
const sid = (n: number): SessionId => asSessionId(`s${n}`)
const iss = (n: number) => asIssueId(`iss-${n}`)
const REPO = asRepoId('repo-1')
const MACHINE = asMachineId('machine-1')
const eff = (n: number, prefix = '') => `${prefix}eff-${n}`
const WF = 'wf-1'
const REV = 'rev-1'
const RUN = 'run-1'
const auto = (n: number) => `auto-${n}` as AutomationId
const autoRun = (n: number) => `arun-${n}` as AutomationRunId
const ixn = (n: number, prefix = '') => `${prefix}ixn-${n}`
const THREAD = asThreadId('thread-1')
const sub = (n: number) => `sub-${n}`
const LOCK = 'lock-1'
const STEWARD_KEY = 'key-1'
const PROJECTOR = 'projector-1'
const runKey = (n: number) => `mrun-${n}`
/** The workflows' and automations' owner: the same people, a different owner per workspace. */
const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : asUserId('user:bob'))
/** The turn epoch of s1's failure: A's fails in turn 1, B's in turn 2. */
const failureEpoch = (tag: Tag) => (tag === 'a' ? 1 : 2)
// An id only `tag`'s workspace holds.
const only = (tag: Tag): SessionId => asSessionId(`only-${tag}`)

let opened: WorkspaceEventSlice | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
  'podium_events',
  'runtime_event_checkpoints',
  'runtime_event_projection_cursors',
  'steward_state',
  'subscriptions',
  'subscription_deliveries',
  'effects',
  'workflows',
  'workflow_revisions',
  'workflow_bindings',
  'workflow_runs',
  'workflow_run_steps',
  'workflow_events',
  'automations',
  'automation_runs',
  'pending_interactions',
  'superagent_threads',
  'superagent_messages',
  'superagent_queued_inputs',
  'superagent_pending_turns',
  'session_observation_checkpoints',
  'session_observation_rebinds',
  'session_terminal_candidates',
  'transcript_costs',
  'maintenance_commands',
  'locks',
  'lock_waiters',
] as const

/**
 * Every row of each table in `tag`'s workspace, as a set: sorted by its text, so the
 * order is the same on both engines (Postgres has no rowid to read them back by).
 */
async function rowsOf(store: WorkspaceEventSlice, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) {
    const rows = await store.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${WS[tag]}`,
    )
    out[table] = rows
      .map((row) => [JSON.stringify(row), row] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([, row]) => row)
  }
  return out
}

function session(tag: Tag, n: number, id: SessionId = sid(n)): SessionRow {
  return {
    id,
    ownerUserId: ALICE,
    agentKind: 'codex',
    cwd: `/repo/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `resume-${id}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${id}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: MACHINE,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: null,
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
  }
}

/** An issue row, raw: the issues repository is another task's (B2). */
async function insertIssue(
  store: WorkspaceEventSlice,
  tag: Tag,
  n: number,
  id: string = iss(n),
): Promise<void> {
  await store.run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq, title,
         stage, default_agent, created_at, updated_at)
       VALUES (${WS[tag]}, ${id}, ${ALICE}, ${ALICE}, ${'/repo'}, ${REPO},
         ${n}, ${`${tag} ${n}`}, 'backlog', 'codex', ${AT}, ${AT})`,
  )
}

/** A member row, raw: the users repository is another task's. */
async function insertMember(
  store: WorkspaceEventSlice,
  tag: Tag,
  id: UserId = ALICE,
): Promise<void> {
  await store.run(
    sql`INSERT INTO users (workspace_id, id, display_name, role, created_at)
       VALUES (${WS[tag]}, ${id}, ${`${tag} alice`}, 'member', ${AT})`,
  )
}

const runtimeState = (tag: Tag, seq: number): RuntimeEvent =>
  ({
    t: 'state',
    change: { kind: 'activity' },
    at: AT,
    provenance: 'live',
    cursor: { segmentId: `${tag}-segment`, components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }) as RuntimeEvent

const runtimeItem = (tag: Tag, seq: number): RuntimeEvent =>
  ({
    t: 'item',
    item: {
      kind: 'complete',
      item: { id: `${tag}-item-${seq}`, cursor: `${seq}`, role: 'assistant', text: tag, ts: AT },
    },
    at: AT,
    provenance: 'live',
    cursor: { segmentId: `${tag}-segment`, components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }) as RuntimeEvent

const runtimeFailure = (tag: Tag, seq: number): RuntimeEvent =>
  ({
    t: 'turn',
    ev: {
      ev: 'failed',
      turnEpoch: failureEpoch(tag),
      reason: 'provider-error',
      disposition: 'needs-human',
    },
    at: AT,
    provenance: 'live',
    cursor: { segmentId: `${tag}-segment`, components: { seq } },
    observerGeneration: 1,
    turnEpoch: failureEpoch(tag),
  }) as RuntimeEvent

function subscription(tag: Tag, n: number, patch: Partial<Subscription> = {}): Subscription {
  return {
    id: sub(n),
    subscriberKind: 'session',
    subscriberId: sid(1),
    event: `${tag}.event`,
    sourceKind: 'session',
    sourceRef: sid(2),
    deliverNudge: true,
    deliverNotify: false,
    origin: 'custom',
    enabled: true,
    createdAt: `2026-11-17T10:0${n}:00.000Z`,
    ...patch,
  }
}

function automation(tag: Tag, n: number): AutomationRow {
  return {
    id: auto(n),
    name: `${tag} nightly ${n}`,
    enabled: true,
    repoPath: '/repo',
    scheduleKind: 'cron',
    cron: '0 3 * * *',
    runAt: null,
    targetSessionId: null,
    agentKind: 'claude-code',
    model: 'auto',
    effort: 'auto',
    prompt: `${tag} prompt`,
    sessionMode: 'fresh',
    nextRunAt: LATER,
    lastRunAt: null,
    createdAt: AT,
    ownerUserId: owner(tag),
    createdByActor: `${tag}-actor`,
    createdByOnBehalfOf: owner(tag),
  }
}

function automationRun(tag: Tag, n: number, sessionId: SessionId | null): AutomationRunRow {
  return {
    id: autoRun(n),
    automationId: auto(1),
    firedAt: `2026-11-17T10:0${n}:00.000Z`,
    sessionId,
    outcome: sessionId === null ? 'skipped_overlap' : 'spawned',
    detail: `${tag} run ${n}`,
    actor: 'system:automation',
    onBehalfOf: owner(tag),
  }
}

function workflowRun(tag: Tag): WorkflowRunRow {
  return {
    id: RUN,
    subjectKind: 'issue',
    subjectId: iss(1),
    coordinatorSessionId: sid(1),
    revisionId: REV,
    status: 'active',
    supersedesRunId: null,
    startedAt: AT,
    completedAt: null,
    ownerUserId: owner(tag),
  }
}

function checkpoint(
  tag: Tag,
  generation: number,
  sessionId: SessionId = sid(1),
): SessionObservationCheckpointV1 {
  return {
    schemaVersion: 1,
    podiumSessionId: sessionId,
    provider: 'codex',
    providerSessionId: `${tag}-thread-${sessionId}`,
    bindingVersion: 1,
    lifecycleObservationGeneration: generation,
    providerCursor: { segmentId: `${tag}-rollout`, components: { file: 42 } },
    bootstrapCursor: { segmentId: `${tag}-rollout`, components: { file: 42 } },
    lastAcceptedLiveCursor: null,
    turnEpoch: 0,
    providerTurnId: null,
    providerPromptId: null,
    turnState: { phase: 'idle', since: AT, workingMsTotal: 0, nativeSubagentCount: 0 },
    terminalFence: null,
    providerAt: AT,
    acceptedAt: AT,
    lastLiveReceiptAt: null,
    lastTransitionId: `${tag}-snapshot`,
  } as SessionObservationCheckpointV1
}

function terminalFacts(tag: Tag, sessionId: SessionId): TerminalCandidateFacts {
  return {
    schemaVersion: 1,
    sessionId,
    terminalTransitionId: `${tag}-transition-${sessionId}`,
    terminalTurnEpoch: 1,
    provider: 'codex',
    providerSessionId: `${tag}-thread-${sessionId}`,
    bindingVersion: 1,
    observerGeneration: 1,
    providerCursor: { segmentId: `${tag}-rollout`, components: { file: 42 } },
    lastLiveReceiptAt: null,
    lastTransitionId: `${tag}-transition-${sessionId}`,
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
    machineId: MACHINE,
  } as TerminalCandidateFacts
}

/** A ledger reply: the same run keys in both, a different deleted count per workspace. */
const applied = (tag: Tag, n: number): MaintenanceCommandReply => ({
  status: 'applied',
  jobKind: 'message-expiry',
  runKey: runKey(n),
  deleted: tag === 'a' ? n : 10 + n,
})

interface Seeded {
  /** The ids of this workspace's appended events, in order. */
  readonly events: number[]
  /** This workspace's lock waiter ids. */
  readonly waiters: number[]
}

/**
 * The effects of one workspace (`prefix` names a set only it holds): 1 an imported copy not
 * yet published, 2 gated, 3 past its deadline, 4 running, 5 succeeded, 6 failed and tombstoned.
 */
async function seedEffects(store: WorkspaceEventSlice, tag: Tag, prefix = ''): Promise<void> {
  const fx = store.effects
  const effect = (n: number, gated = false) => ({
    id: eff(n, prefix),
    kind: `${tag}.kind`,
    target: { kind: 'issue' as const, id: iss(1) },
    input: { tag },
    deadlineAt: n === 3 ? NOW_MS - 1 : undefined,
    createdBy: ALICE,
    gated,
  })
  await fx.insert(scope, effect(1), NOW_MS)
  await fx.insert(scope, effect(2, true), NOW_MS)
  await fx.insert(scope, effect(3), NOW_MS)
  await fx.insert(scope, effect(4), NOW_MS)
  await fx.claim(scope, eff(4, prefix), NOW_MS)
  await fx.insert(scope, effect(5), NOW_MS)
  await fx.claim(scope, eff(5, prefix), NOW_MS)
  await fx.settle(scope, eff(5, prefix), 'succeeded', {}, NOW_MS)
  await fx.insert(scope, effect(6), NOW_MS)
  await fx.claim(scope, eff(6, prefix), NOW_MS)
  await fx.settle(scope, eff(6, prefix), 'failed', { error: { code: 'x', message: 'x' } }, NOW_MS)
  await fx.tombstone(scope, eff(6, prefix), NOW_MS)
  // An imported copy not yet published (revision 0), set directly.
  await store.run(
    sql`UPDATE effects SET revision = 0 WHERE workspace_id = ${WS[tag]} AND id = ${eff(1, prefix)}`,
  )
}

/**
 * The interactions of one workspace's `sessionId` (`prefix` names a set only it holds): 1 open,
 * 2 answered, 3 expired.
 */
async function seedInteractions(
  store: WorkspaceEventSlice,
  tag: Tag,
  sessionId: SessionId,
  prefix = '',
): Promise<void> {
  const ix = store.interactions
  for (const n of [1, 2, 3]) {
    await ix.insert({
      id: ixn(n, prefix),
      sessionId,
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: `${tag} ${n}`, offered: ['full-resume'] },
      source: 'protocol',
      answerable: 'structured',
      fingerprint: `${prefix}fp-${n}`,
      askedAt: `2026-11-17T10:0${n}:00.000Z`,
    })
  }
  await ix.answer({
    id: ixn(2, prefix),
    answer: { kind: 'recovery', choice: 'full-resume' },
    answeredBy: 'human',
    deliveredVia: 'structured',
    at: AT,
  })
  await ix.close(ixn(3, prefix), 'expired', EARLIER)
}

/**
 * One workspace's rows, written through its own repositories (sessions, issues and members are
 * planted only as the subjects the reads join to).
 */
async function seed(store: WorkspaceEventSlice, tag: Tag): Promise<Seeded> {
  // One session per call: a three-row upsert pads its batch to four by repeating the last
  // row, which Postgres refuses ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time"); the sessions repository is another task's (POD-6983).
  for (const n of [1, 2, 3]) await store.sessions.upsertSessions(scope, [session(tag, n)])
  await store.sessions.upsertSessions(scope, [session(tag, 4, only(tag))])
  await insertIssue(store, tag, 1)
  await insertIssue(store, tag, 2)
  await insertMember(store, tag)

  // --- events -----------------------------------------------------------------
  const ev = store.events
  const events: number[] = []
  events.push(
    await ev.appendEvent(
      { ts: EARLIER, kind: 'issue.updated', subject: iss(1), repoPath: '/repo' },
      { announce: false },
    ),
  )
  events.push(
    await ev.appendEvent(
      { ts: AT, kind: 'issue.closed', subject: iss(2), repoPath: '/repo' },
      { announce: false },
    ),
  )
  for (const [n, payload] of [
    [1, runtimeState(tag, 1)],
    [2, runtimeItem(tag, 2)],
    [3, runtimeFailure(tag, 3)],
  ] as const) {
    events.push(
      await ev.appendEvent(
        {
          ts: `2026-11-17T10:0${n}:00.000Z`,
          kind: RUNTIME_EVENT_LOG_KIND,
          subject: sid(1),
          payload,
        },
        { announce: false },
      ),
    )
  }
  await ev.saveRuntimeEventCheckpoint({
    sessionId: sid(1),
    observerGeneration: 1,
    cursor: { segmentId: `${tag}-segment`, components: { seq: 3 } },
    turnEpoch: 1,
    closedTurnEpoch: null,
    updatedAt: AT,
    turnState: {
      phase: 'idle',
      since: AT,
      workingMsTotal: tag === 'a' ? 1 : 2,
      nativeSubagentCount: 0,
    },
  })
  await ev.saveRuntimeEventProjectionCursor(PROJECTOR, events[2]!, AT)
  await ev.saveRuntimeEventProjectionCursor(`only-${tag}-projector`, events[2]!, AT)
  await ev.setStewardState(STEWARD_KEY, `${tag}-value`)
  await ev.addSubscription(subscription(tag, 1))
  await ev.addSubscription(
    subscription(tag, 2, {
      subscriberKind: 'issue',
      subscriberId: iss(1),
      sourceKind: 'relationship',
      sourceRef: '',
    }),
  )
  // A subscriber only the OTHER workspace holds: its EXISTS probe must find nothing here.
  await ev.addSubscription(subscription(tag, 3, { subscriberId: only(otherOf(tag)) }))
  await ev.markDelivered(sub(1), events[0]!)

  // --- effects ----------------------------------------------------------------
  await seedEffects(store, tag)

  // --- workflows --------------------------------------------------------------
  const w = store.workflows
  await w.insertWorkflow({
    id: WF,
    name: `${tag} flow`,
    description: tag,
    scope: 'global',
    scopeRef: null,
    actor: OPERATOR,
    ownerUserId: owner(tag),
    now: AT,
  })
  await w.insertRevision({
    id: REV,
    workflowId: WF,
    instructions: tag,
    steps: [{ id: 'step-1', title: 'one', instructions: 'i', completionGuidance: 'g' } as never],
    actor: OPERATOR,
    now: AT,
  })
  await w.publishRevision(REV, AT)
  await w.setBinding({
    targetKind: 'issue',
    targetId: iss(1),
    revisionId: REV,
    actor: OPERATOR,
    ownerUserId: owner(tag),
    now: AT,
  })
  await w.insertRun({
    run: workflowRun(tag),
    steps: [
      {
        id: 'step-1',
        title: 'one',
        instructions: 'i',
        completionGuidance: 'g',
        profileId: null,
        profile: null,
      } as never,
    ],
  })
  await w.assignStep(RUN, 'step-1', sid(2))
  await w.appendEvent({
    workflowId: WF,
    runId: RUN,
    kind: `${tag}.started`,
    actor: OPERATOR,
    now: AT,
  })

  // --- automations ------------------------------------------------------------
  const au = store.automations
  await au.insert(scope, automation(tag, 1))
  await au.insert(scope, automation(tag, 2))
  await au.addRun(scope, automationRun(tag, 1, sid(1)))
  await au.addRun(scope, automationRun(tag, 2, null))

  // --- interactions -----------------------------------------------------------
  await seedInteractions(store, tag, sid(1))

  // --- superagent -------------------------------------------------------------
  const sa = store.superagent
  await sa.upsertSuperagentThread({
    id: THREAD,
    ownerUserId: ALICE,
    kind: 'btw',
    title: tag,
  })
  await sa.appendSuperagentMessage(THREAD, { role: 'user', content: `${tag} hello` })
  await sa.putQueuedInput({
    inputId: 'input-1',
    ownerUserId: ALICE,
    threadId: THREAD,
    text: `${tag} queued`,
  })
  await sa.putQueuedInput({
    inputId: 'input-2',
    ownerUserId: ALICE,
    threadId: THREAD,
    text: `${tag} queued 2`,
  })
  await sa.putPendingTurn({
    turnId: 'turn-1',
    ownerUserId: ALICE,
    threadId: THREAD,
    podiumSessionId: sid(1),
    payload: { agent: 'codex', cwd: '/repo', prompt: tag },
    firstTurn: true,
  })
  await sa.setTurnRunning(THREAD, true)

  // --- observation checkpoints ------------------------------------------------
  const oc = store.observationCheckpoints
  await oc.advanceGeneration(sid(1), 'codex', `${tag}-thread-${sid(1)}`)
  await oc.save(checkpoint(tag, 1))
  await oc.advanceGeneration(sid(2), 'codex', `${tag}-thread-${sid(2)}`)
  await oc.rebindExact({
    sessionId: sid(2),
    provider: 'codex',
    providerSessionId: `${tag}-thread-${sid(2)}`,
    bindingVersion: 1,
    observationGeneration: 1,
    nextProviderSessionId: `${tag}-thread-s2b`,
  })
  await oc.advanceGeneration(sid(3), 'codex', `${tag}-thread-${sid(3)}`)
  await oc.recordTerminalCandidate(terminalFacts(tag, sid(1)), AT)
  await oc.recordTerminalCandidate(terminalFacts(tag, sid(3)), AT)

  // --- transcript costs, maintenance, locks -----------------------------------
  await store.transcriptCosts.record(
    [
      {
        machineId: MACHINE,
        nativeId: 'native-1',
        path: '/repo/t1.jsonl',
        harness: 'codex',
        sessionId: sid(1),
        issueId: iss(1),
        scannedBytes: 10,
        firstTsMs: 1,
        lastTsMs: 2,
        models: [{ model: `${tag}-model`, inputTokens: 1, outputTokens: 1, messages: 5 } as never],
        windowModels: [],
        windowSinceMs: tag === 'a' ? 100 : 200,
      },
    ],
    AT,
  )
  await store.maintenance.recordCommand(applied(tag, 1), 7, EARLIER)
  await store.maintenance.recordCommand(applied(tag, 2), 7, AT)
  await store.locks.upsertLock({
    repoId: REPO,
    name: LOCK,
    holderSessionId: sid(1),
    holderIssueId: iss(1),
    holderLabel: tag,
    note: null,
    acquiredAt: EARLIER,
    expiresAt: AT,
  })
  await store.locks.enqueueWaiter({
    repoId: REPO,
    name: LOCK,
    sessionId: sid(2),
    issueId: null,
    label: `${tag} waiter`,
    ttlSeconds: 60,
    note: null,
    enqueuedAt: AT,
  })
  const waiters = (await store.locks.listWaiters(REPO, LOCK)).map((w) => w.id)
  return { events, waiters }
}

async function twoSeeded(): Promise<{
  readonly stores: readonly [WorkspaceEventSlice, WorkspaceEventSlice]
  readonly seeded: Record<Tag, Seeded>
}> {
  const stores = await openEventStoreSlices([WS.a, WS.b])
  opened = stores[0]
  const a = await seed(stores[0], 'a')
  const b = await seed(stores[1], 'b')
  return { stores, seeded: { a, b } }
}

const both = (stores: readonly [WorkspaceEventSlice, WorkspaceEventSlice]) =>
  [
    [stores[0], 'a'],
    [stores[1], 'b'],
  ] as const

/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  expect(JSON.stringify(value)).not.toMatch(
    new RegExp(`\\b${other}[-.]|"${other} |"${other}"|"${WS[other]}"`),
  )
}

/** The sorted ids of `rows`, which hold no content of the other workspace: the ids are the
 *  same in both, so the content is what tells a crossed-over row. */
function ids(rows: Iterable<{ id: string | number }>, tag: Tag) {
  const list = [...rows]
  onlyOwn(list, tag)
  return list.map((row) => row.id).sort()
}

describe('the group writes every row under its own workspace', () => {
  it('seeds each table in both workspaces, each with only its own content', async () => {
    const { stores } = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = await rowsOf(stores[0], tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        // The third subscription names the other workspace's session on purpose (the probe case).
        const named = (rows[table] as { id?: unknown }[]).filter((row) => row.id !== sub(3))
        onlyOwn(named, tag)
      }
    }
  })
})

describe('the events repository reads only its own workspace', () => {
  it('answers the runtime log, checkpoint and cursor reads with its own rows', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ev = store.events
      const other = otherOf(tag)
      expect((await ev.runtimeEventCheckpoint(sid(1)))?.cursor.segmentId).toBe(`${tag}-segment`)
      const turns = await ev.runtimeTurnStatesOf([sid(1), only(other)])
      expect([...turns.keys()]).toEqual([sid(1)])
      expect(turns.get(sid(1))?.workingMsTotal).toBe(tag === 'a' ? 1 : 2)
      const runtime = await ev.listRuntimeEvents(sid(1))
      expect(runtime).toHaveLength(3)
      onlyOwn(runtime, tag)
      expect([...(await ev.runtimeTranscriptSessionIds())]).toEqual([sid(1)])
      expect([...(await ev.runtimeTranscriptAvailableOf([sid(1), only(other)]))]).toEqual([sid(1)])
      const transcript = await ev.listRuntimeTranscriptEvents(sid(1))
      expect(transcript).toHaveLength(1)
      onlyOwn(transcript, tag)
      // The same session, each workspace's own failure: A's in turn 1, B's in turn 2.
      expect(await ev.hasCausalTurnFailure(sid(1), 1)).toBe(true)
      expect(await ev.hasCausalTurnFailure(sid(1), 2)).toBe(tag === 'b')
      const after = await ev.listRuntimeEventsAfter(0)
      expect(after.map((r) => r.id)).toEqual(seeded[tag].events.slice(2))
      expect(await ev.runtimeEventProjectionCursor(PROJECTOR)).toBe(seeded[tag].events[2])
      expect(await ev.runtimeEventProjectionCursor(`only-${tag}-projector`)).toBe(
        seeded[tag].events[2],
      )
      expect(await ev.runtimeEventProjectionCursor(`only-${other}-projector`)).toBe(0)
    }
  })

  it('answers the event log, feed window and steward reads with its own rows', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ev = store.events
      const own = seeded[tag].events
      expect((await ev.listEventsSince(0, { limit: 100 })).map((e) => e.id).sort()).toEqual(
        [...own].sort(),
      )
      expect(
        (await ev.listEventsSince(0, { subject: iss(1), order: 'desc', limit: 10 })).map(
          (e) => e.id,
        ),
      ).toEqual([own[0]])
      expect(
        (await ev.listKindSubjectSinceWithPrior('issue.closed', iss(2), EARLIER)).map((e) => e.id),
      ).toEqual([own[1]])
      const window = await ev.feedWindow({ limit: 50 })
      onlyOwn(window, tag)
      const windowIds = await ev.feedWindowIds({ limit: 50 })
      expect(windowIds.map((r) => r.id).sort()).toEqual(window.map((e) => e.id).sort())
      const allIds = [...seeded.a.events, ...seeded.b.events]
      expect((await ev.feedWindowByIds(allIds, 50)).map((e) => e.id).sort()).toEqual(
        window.map((e) => e.id).sort(),
      )
      const ofSubjects = await ev.feedWindowOfSubjects([iss(1), iss(2)], 50)
      onlyOwn(ofSubjects, tag)
      expect(ofSubjects.every((e) => own.includes(e.id))).toBe(true)
      expect(await ev.maxEventId()).toBe(Math.max(...own))
      expect(await ev.getStewardState(STEWARD_KEY)).toBe(`${tag}-value`)
    }
  })

  it('answers the subscription reads with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ev = store.events
      const other = otherOf(tag)
      const own = [sub(1), sub(2), sub(3)]
      expect(ids(await ev.listSubscriptions({ subscriberId: sid(1) }), tag)).toEqual([sub(1)])
      // The third subscription names the session only the other workspace holds, stored here.
      expect(
        (await ev.listSubscriptions({ subscriberId: only(other) })).map((row) => row.id),
      ).toEqual([sub(3)])
      expect((await ev.listSubscriptionsPage()).map((row) => row.event)).toEqual(
        own.map(() => `${tag}.event`),
      )
      // The EXISTS probes hold the subscriber's session and issue to this workspace: the third
      // subscription names a session only the other workspace holds, so no owner reaches it.
      expect(ids(await ev.listOwnSubscriptionsPage(ALICE), tag)).toEqual([sub(1), sub(2)])
      expect(
        (await ev.allSubscriptionsForBootReconcile()).map((row) => [row.id, row.event]),
      ).toEqual(own.map((id) => [id, `${tag}.event`]))
      expect(
        (await ev.subscriptionsByIds([...own, 'sub-9'])).map((row) => [row.id, row.event]).sort(),
      ).toEqual(own.map((id) => [id, `${tag}.event`]))
      expect((await ev.getSubscription(sub(1)))?.event).toBe(`${tag}.event`)
      // An event name only one workspace's subscriptions carry.
      expect(await ev.hasRelationshipSubscription([`${tag}.event`])).toBe(true)
      expect(await ev.hasRelationshipSubscription([`${other}.event`])).toBe(false)
      expect(
        (
          await ev.listMatchingSubscriptions({
            events: [`${tag}.event`, `${other}.event`],
            sources: [sid(2)],
            anchorIssueIds: [iss(1)],
          })
        )
          .map((row) => [row.id, row.event])
          .sort(),
      ).toEqual(own.map((id) => [id, `${tag}.event`]))
      expect(
        await ev.listMatchingSubscriptions({
          events: [`${other}.event`],
          sources: [sid(2)],
          anchorIssueIds: [iss(1)],
        }),
      ).toEqual([])
    }
  })
})

describe('the events repository writes only its own workspace', () => {
  it('leaves the other workspace unchanged by writes of the ids both hold', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const otherSteward = await stores[tag === 'a' ? 1 : 0].events.getStewardState(STEWARD_KEY)
      const ev = store.events
      await ev.removeSubscription(sub(1))
      expect(await ev.setSubscriptionEnabled(sub(2), false)).toBe(true)
      expect(await ev.markDelivered(sub(2), seeded[tag].events[1]!)).toBe(true)
      await ev.setStewardState(STEWARD_KEY, `${tag}-changed`)
      await ev.saveRuntimeEventProjectionCursor(PROJECTOR, seeded[tag].events[4]!, AT)
      await ev.saveRuntimeEventCheckpoint({
        sessionId: sid(1),
        observerGeneration: 2,
        cursor: { segmentId: `${tag}-segment`, components: { seq: 4 } },
        turnEpoch: 2,
        closedTurnEpoch: 1,
        updatedAt: AT,
      })
      expect(await ev.appendEventOnce({ ts: AT, kind: `${tag}.once`, subject: iss(1) })).toEqual(
        expect.any(Number),
      )
      expect(await rowsOf(store, other)).toEqual(before)
      expect(await stores[tag === 'a' ? 1 : 0].events.getStewardState(STEWARD_KEY)).toBe(
        otherSteward,
      )
    }
  })

  it('claims the janitor steward in its own workspace only', async () => {
    // The steward's `cursor` key is the same name in every workspace: since the keys migration
    // (POD-7024) each claim is its own workspace's row.
    const { stores, seeded } = await twoSeeded()
    const [a, b] = stores
    const before = await rowsOf(a, 'b')
    expect(await a.events.activateJanitorSteward()).toBe(Math.max(...seeded.a.events))
    expect(await a.events.getStewardState('cursor')).toBe(String(Math.max(...seeded.a.events)))
    expect(await b.events.getStewardState('cursor')).toBeUndefined()
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect(await b.events.activateJanitorSteward()).toBe(Math.max(...seeded.b.events))
    expect(await b.events.getStewardState('cursor')).toBe(String(Math.max(...seeded.b.events)))
    expect(await a.events.getStewardState('cursor')).toBe(String(Math.max(...seeded.a.events)))
  })

  it('reads its own grouped appends and announces its own events only', async () => {
    const { stores, seeded } = await twoSeeded()
    const [a, b] = stores
    const announced: number[] = []
    await a.events.onAppend((id) => {
      announced.push(id)
    })
    const before = await rowsOf(a, 'b')
    const id = await a.events.appendEventGrouped({
      ts: AT,
      kind: 'a.grouped',
      subject: iss(1),
    })
    await a.events.settleGroupedAppends()
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect((await a.events.listEventsSince(id - 1, { limit: 1 }))[0]?.kind).toBe('a.grouped')
    await a.events.announceEvent(id)
    expect(announced).toContain(id)
    // An event id only B holds.
    await expect(a.events.announceEvent(seeded.b.events[0]!)).rejects.toThrow(
      /unknown podium event/,
    )
    expect(await b.events.listEventsSince(id - 1, { limit: 1 })).toEqual([])
  })

  it('prunes only its own workspace: a prune that takes every row here takes nothing there', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const ev = store.events
      // A far-future cutoff and a zero cap: every row of this workspace is a candidate.
      const plan = await ev.planEventPrune({ maxAgeDays: -36_500, maxRows: 0 })
      expect(plan.capThroughId).toBe(
        Math.max(...(await ev.listEventsSince(0, { limit: 100 })).map((e) => e.id)),
      )
      while ((await ev.pruneEventBatch(plan, 500)) > 0) {}
      expect(await rowsOf(store, other)).toEqual(before)
      // The runtime rows beyond the board projector's head stay (it never ran here).
      expect(
        (await ev.listEventsSince(0, { limit: 100 })).every(
          (e) => e.kind === RUNTIME_EVENT_LOG_KIND,
        ),
      ).toBe(true)
    }
  })
})

describe('the effects repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const fx = store.effects
      const other = otherOf(tag)
      const all = [1, 2, 3, 4, 5, 6].map((n) => eff(n))
      expect(ids(await fx.liveByIds(all), tag)).toEqual([1, 2, 3, 4, 5].map((n) => eff(n)))
      const pages: { id: string }[] = []
      for await (const page of fx.livePages(2)) pages.push(...page)
      expect(ids(pages, tag)).toEqual([1, 2, 3, 4, 5].map((n) => eff(n)))
      expect((await fx.get(eff(1)))?.kind).toBe(`${tag}.kind`)
      const target = { kind: 'issue' as const, id: iss(1) }
      expect((await fx.newestOnTarget(`${tag}.kind`, target, 'active'))?.id).toEqual(
        expect.any(String),
      )
      // A kind only the other workspace's effects carry, on the same target.
      expect(await fx.newestOnTarget(`${other}.kind`, target, 'active')).toBeUndefined()
      expect((await fx.newestOnTarget(`${tag}.kind`, target, 'succeeded'))?.id).toBe(eff(5))
      expect([...(await fx.audiencesOf(all)).keys()].sort()).toEqual(all)
      onlyOwn(await fx.liveOnTargets([target]), tag)
      expect(await fx.liveOnTargets([target])).toHaveLength(5)
      expect(ids(await fx.listAwaiting(`${tag}.kind`, 10), tag)).toEqual([eff(2)])
      expect(await fx.listAwaiting(`${other}.kind`, 10)).toEqual([])
      onlyOwn(await fx.listInStatus('pending', 10), tag)
      expect(ids(await fx.listInStatus('running', 10), tag)).toEqual([eff(4)])
    }
  })

  it('leaves the other workspace unchanged by writes aimed at ids only it holds and by the sweeps', async () => {
    const { stores } = await twoSeeded()
    // Effects only each workspace holds, in the same states as the shared ones.
    for (const [store, tag] of both(stores)) await seedEffects(store, tag, `only-${tag}-`)
    for (const [store, tag] of both(stores)) {
      const fx = store.effects
      const other = otherOf(tag)
      const O = (n: number) => eff(n, `only-${other}-`)
      const own = (...ns: number[]) => ns.flatMap((n) => [eff(n), eff(n, `only-${tag}-`)]).sort()
      const before = await rowsOf(store, other)
      expect(await fx.claim(scope, O(3), NOW_MS)).toBeUndefined()
      expect(await fx.settle(scope, O(4), 'succeeded', {}, NOW_MS)).toBeUndefined()
      expect(await fx.setStage(scope, O(4), 'stage', NOW_MS)).toBeUndefined()
      expect(await fx.decide(scope, O(2), 'approve', 1, NOW_MS)).toBeUndefined()
      expect(await fx.requestCancel(scope, O(4), NOW_MS)).toBeUndefined()
      expect(await fx.tombstone(scope, O(5), NOW_MS)).toBeUndefined()
      // The sweeps, which no id narrows, take this workspace's rows only: the shared ids'
      // rows here, never the other's of the same ids.
      expect(ids(await fx.publishCopied(scope, 10), tag)).toEqual(own(1))
      expect(ids(await fx.expireDue(scope, NOW_MS, 10), tag)).toEqual(own(3))
      expect(ids(await fx.pruneFinished(scope, NOW_MS + 1, NOW_MS, 10), tag)).toEqual(own(3, 5))
      expect(await fx.purgeTombstones(scope, NOW_MS + 1, 10)).toBe(6)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the workflows repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const w = store.workflows
      // The same ids, each workspace's own owner.
      for (const kind of ['workflow-definition', 'workflow-library-entry'])
        expect(await w.ownerOf(kind, WF)).toBe(owner(tag))
      expect(await w.ownerOf('workflow-revision', REV)).toBe(owner(tag))
      expect(await w.ownerOf('workflow-binding', `issue:${iss(1)}`)).toBe(owner(tag))
      expect(await w.ownerOf('workflow-run', RUN)).toBe(owner(tag))
      const listed = await w.listWorkflows()
      expect(ids(listed, tag)).toEqual([WF])
      // The latest version subquery counts this workspace's revisions only.
      expect(listed[0]?.latestVersion).toBe(1)
      expect(ids(await w.listWorkflows({ includeArchived: true, scope: 'global' }), tag)).toEqual([
        WF,
      ])
      const facts = await w.visibilityFacts({
        workflowIds: [WF, 'wf-9'],
        revisionIds: [REV, 'rev-9'],
        bindings: [
          { targetKind: 'issue', targetId: iss(1) },
          { targetKind: 'issue', targetId: iss(9) },
        ],
        runIds: [RUN, 'run-9'],
      })
      expect([...facts.workflows.keys()]).toEqual([WF])
      expect([...facts.revisions.keys()]).toEqual([REV])
      expect([...facts.bindings.keys()]).toEqual([`issue:${iss(1)}`])
      expect([...facts.runs.keys()]).toEqual([RUN])
      onlyOwn(
        [facts.workflows, facts.revisions, facts.bindings, facts.runs].map((m) => [...m.values()]),
        tag,
      )
      expect(ids(await w.allWorkflowsForBootReconcile(), tag)).toEqual([WF])
      expect(ids(await w.allRevisionsForBootReconcile(), tag)).toEqual([REV])
      const runs = await w.allRunsForBootReconcile()
      expect(runs.map((r) => [r.run.id, r.workflowId, r.steps.length, r.run.ownerUserId])).toEqual([
        [RUN, WF, 1, owner(tag)],
      ])
      expect(ids(await w.workflowsByIds([WF]), tag)).toEqual([WF])
      expect(ids(await w.revisionsByIds([REV]), tag)).toEqual([REV])
      expect((await w.runsByIds([RUN])).map((r) => [r.run.id, r.run.ownerUserId])).toEqual([
        [RUN, owner(tag)],
      ])
      expect(await w.runIdsOfRevisions([REV])).toEqual([RUN])
      expect((await w.getWorkflow(WF))?.name).toBe(`${tag} flow`)
      expect(ids(await w.listRevisions(WF), tag)).toEqual([REV])
      expect((await w.getRevision(REV))?.instructions).toBe(tag)
      // A binding carries no owner on the wire: `ownerOf` above holds it to its own.
      expect((await w.getBinding('issue', iss(1)))?.revisionId).toBe(REV)
      expect((await w.listBindings()).map((b) => b.targetId)).toEqual([iss(1)])
      expect(ids(await w.listRuns(), tag)).toEqual([RUN])
      expect(ids(await w.listRunsPage({ limit: 10 }), tag)).toEqual([RUN])
      expect((await w.getRun(RUN))?.ownerUserId).toBe(owner(tag))
      expect((await w.getRunSteps(RUN)).map((s) => s.stepId)).toEqual(['step-1'])
      expect((await w.listRunEvents(RUN)).map((e) => e.kind)).toEqual([`${tag}.started`])
      expect((await w.findLiveRun('issue', iss(1)))?.ownerUserId).toBe(owner(tag))
      expect((await w.findLiveRunForSession(sid(1)))?.ownerUserId).toBe(owner(tag))
      expect((await w.findLiveRunForSession(sid(2)))?.ownerUserId).toBe(owner(tag))
    }
  })

  it('leaves the other workspace unchanged by writes of the ids both hold', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const w = store.workflows
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await w.publishRevision(REV, LATER)
      await w.updateStep({
        runId: RUN,
        stepId: 'step-1',
        status: 'complete',
        assignedSessionId: null,
        summary: 'changed',
        evidence: { summary: 'changed', tests: [], artifacts: [] },
        observation: null,
        warnings: [],
        startedAt: null,
        completedAt: LATER,
      })
      await w.assignStep(RUN, 'step-1', null)
      await w.insertRevision({
        id: 'rev-2',
        workflowId: WF,
        instructions: tag,
        steps: [],
        actor: OPERATOR,
        now: LATER,
      })
      expect((await w.getWorkflow(WF))?.latestVersion).toBe(2)
      await w.updateRunStatus(RUN, 'complete', LATER)
      await w.resetStep(RUN, 'step-1')
      await w.appendEvent({ runId: RUN, kind: `${tag}.done`, actor: OPERATOR, now: LATER })
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the automations repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const au = store.automations
      const allAutos = [auto(1), auto(2), auto(9)]
      const allRuns = [autoRun(1), autoRun(2), autoRun(9)]
      expect(ids(await au.list(), tag)).toEqual([auto(1), auto(2)])
      expect((await au.get(auto(1)))?.name).toBe(`${tag} nightly 1`)
      expect(await au.ownerOf(auto(1))).toBe(owner(tag))
      expect(await au.runOwnerOf(autoRun(1))).toBe(owner(tag))
      const owners = await au.ownersOf(allAutos)
      expect([...owners.keys()].sort()).toEqual([auto(1), auto(2)])
      expect(new Set(owners.values())).toEqual(new Set([owner(tag)]))
      const runOwners = await au.runOwnersOf(allRuns)
      expect([...runOwners.keys()].sort()).toEqual([autoRun(1), autoRun(2)])
      expect(new Set(runOwners.values())).toEqual(new Set([owner(tag)]))
      expect(ids(await au.getMany(allAutos), tag)).toEqual([auto(1), auto(2)])
      expect(ids(await au.getRuns(allRuns), tag)).toEqual([autoRun(1), autoRun(2)])
      expect((await au.getRun(autoRun(1)))?.detail).toBe(`${tag} run 1`)
      expect(ids(await au.listRuns(auto(1)), tag)).toEqual([autoRun(1), autoRun(2)])
      expect(ids(await au.listAllRuns(), tag)).toEqual([autoRun(1), autoRun(2)])
      expect([...(await au.lastSpawnedSessions())]).toEqual([[auto(1), sid(1)]])
      expect(await au.lastSpawnedSessionOf(auto(1))).toBe(sid(1))
      expect([...(await au.liveRunIdsOf(auto(1)))].sort()).toEqual([autoRun(1), autoRun(2)])
    }
  })

  it('leaves the other workspace unchanged by writes of the ids both hold', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const au = store.automations
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const otherAuto = await stores[tag === 'a' ? 1 : 0].automations.get(auto(1))
      await au.updateRun(scope, autoRun(1), {
        sessionId: null,
        outcome: 'error',
        detail: 'changed',
      })
      expect(await au.remove(scope, auto(2), LATER)).toBe(true)
      // An update and a removal, which take its runs with it.
      await au.update(scope, { ...automation(tag, 1), name: `${tag} renamed` })
      expect(await au.remove(scope, auto(1), LATER)).toBe(true)
      expect(await rowsOf(store, other)).toEqual(before)
      expect(await stores[tag === 'a' ? 1 : 0].automations.get(auto(1))).toEqual(otherAuto)
    }
  })
})

describe('the interactions repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ix = store.interactions
      expect((await ix.get(ixn(1)))?.payload).toMatchObject({ prompt: `${tag} 1` })
      expect(ids([(await ix.openByFingerprint(sid(1), 'fp-1'))!], tag)).toEqual([ixn(1)])
      expect(ids(await ix.listOpen(), tag)).toEqual([ixn(1)])
      expect(ids(await ix.listOpen(sid(1)), tag)).toEqual([ixn(1)])
      expect(ids(await ix.openOfIds([ixn(1), ixn(9)]), tag)).toEqual([ixn(1)])
      expect(ids(await ix.listForSession(sid(1)), tag)).toEqual([1, 2, 3].map((n) => ixn(n)))
    }
  })

  it('leaves the other workspace unchanged by writes aimed at ids only it holds and by the prune', async () => {
    const { stores } = await twoSeeded()
    // Interactions only each workspace holds, on its session only it holds.
    for (const [store, tag] of both(stores)) {
      await seedInteractions(store, tag, only(tag), `only-${tag}-`)
    }
    for (const [store, tag] of both(stores)) {
      const ix = store.interactions
      const other = otherOf(tag)
      const O = (n: number) => ixn(n, `only-${other}-`)
      const before = await rowsOf(store, other)
      expect(await ix.enrich(O(1), { changed: true })).toBe(false)
      expect(
        await ix.answer({
          id: O(1),
          answer: { kind: 'recovery', choice: 'full-resume' },
          answeredBy: 'human',
          deliveredVia: 'structured',
          at: LATER,
        }),
      ).toBe(false)
      expect(await ix.recordDelivery(O(2), 'menu')).toBe(false)
      expect(await ix.reopen(O(2), 'human')).toBe(false)
      expect(await ix.retireClaimed(O(2), 'expired', LATER, 'human')).toBe(false)
      expect(await ix.close(O(1), 'expired', LATER)).toBe(false)
      expect(await ix.closeSession(only(other), 'expired', LATER)).toEqual([])
      // The prune, which no id narrows: it takes this workspace's resolved rows only, the
      // shared ids' and its own plant's.
      expect(await ix.pruneResolvedBefore(LATER)).toBe(4)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the superagent repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const sa = store.superagent
      const threads = await sa.allThreadsForBootReconcile()
      expect(threads.map((t) => t.id)).toContain(THREAD)
      onlyOwn(threads, tag)
      expect((await sa.loadSuperagentMessages(THREAD)).map((m) => m.content)).toEqual([
        `${tag} hello`,
      ])
      const listed = await sa.listSuperagentThreads(ALICE)
      expect(listed.map((t) => t.id)).toContain(THREAD)
      onlyOwn(listed, tag)
      expect(ids(await sa.superagentThreadsByIds([THREAD]), tag)).toEqual([THREAD])
      expect((await sa.getSuperagentThread(THREAD))?.title).toBe(tag)
      expect((await sa.getSuperagentThread(THREAD, ALICE))?.title).toBe(tag)
      const queued = await sa.listQueuedInputs()
      expect(queued.map((q) => q.inputId).sort()).toEqual(['input-1', 'input-2'])
      onlyOwn(queued, tag)
      expect((await sa.listQueuedInputs(THREAD)).length).toBe(2)
      const turns = await sa.listPendingTurns()
      expect(turns.map((p) => p.turnId)).toEqual(['turn-1'])
      onlyOwn(turns, tag)
    }
  })

  it('seeds a member thread only for a member of its own workspace', async () => {
    const { stores } = await twoSeeded()
    const [a, b] = stores
    // A member only B holds is nobody in A: the users read is held to this workspace.
    const ONLY_B = asUserId('user:only-b')
    await insertMember(b, 'b', ONLY_B)
    const before = await rowsOf(a, 'b')
    await a.superagent.seedMemberGlobalThread(ONLY_B)
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect(await a.superagent.getSuperagentThread(`global:${ONLY_B}`)).toBeUndefined()
    // The member both hold: A's thread, and none in B until B seeds its own.
    await a.superagent.seedMemberGlobalThread(ALICE)
    expect((await a.superagent.getSuperagentThread(`global:${ALICE}`))?.ownerUserId).toBe(ALICE)
    expect(await b.superagent.getSuperagentThread(`global:${ALICE}`)).toBeUndefined()
    expect(await rowsOf(a, 'b')).toEqual(before)
  })

  it('leaves the other workspace unchanged by writes of the ids both hold and by the turn sync', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const sa = store.superagent
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const otherThread = await stores[tag === 'a' ? 1 : 0].superagent.getSuperagentThread(THREAD)
      await sa.setTurnFailure(THREAD, null)
      await sa.setThreadWatermark(THREAD, 'item', AT)
      await sa.updateSuperagentThreadBinding(THREAD, { agentKind: 'changed' })
      await sa.deleteQueuedInput('input-1')
      // The sync clears a running flag that has no pending turn HERE, and the other
      // workspace's running thread of the same id (which has one) is not this workspace's to
      // clear.
      await sa.deletePendingTurn('turn-1')
      await sa.syncTurnRunningWithPendingTurns()
      expect((await sa.getSuperagentThread(THREAD))?.turnRunning).toBe(false)
      expect(await rowsOf(store, other)).toEqual(before)
      await sa.promoteQueuedInput('input-2', {
        turnId: 'turn-2',
        ownerUserId: ALICE,
        threadId: THREAD,
        podiumSessionId: sid(1),
        payload: { agent: 'codex', cwd: '/repo', prompt: tag },
        firstTurn: false,
      })
      await sa.clearSuperagentMessages(THREAD)
      await sa.setTurnRunning(THREAD, false)
      await sa.archiveSuperagentThread(THREAD)
      expect(await rowsOf(store, other)).toEqual(before)
      expect(await stores[tag === 'a' ? 1 : 0].superagent.getSuperagentThread(THREAD)).toEqual(
        otherThread,
      )
    }
  })
})

describe('the observation checkpoints repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const oc = store.observationCheckpoints
      const other = otherOf(tag)
      const checkpoints = await oc.checkpointsOf([sid(1), only(other)])
      expect([...checkpoints.keys()]).toEqual([sid(1)])
      onlyOwn([...checkpoints.values()], tag)
      expect((await oc.get(sid(1)))?.providerSessionId).toBe(`${tag}-thread-${sid(1)}`)
      expect((await oc.get(sid(2)))?.providerSessionId).toBe(`${tag}-thread-s2b`)
      expect((await oc.getTerminalCandidate(sid(1)))?.facts.terminalTransitionId).toBe(
        `${tag}-transition-${sid(1)}`,
      )
    }
  })

  it('leaves the other workspace unchanged by writes aimed at ids only it holds, and by its own', async () => {
    const { stores } = await twoSeeded()
    // A lease, a checkpoint and a terminal candidate of the session only each workspace holds.
    for (const [store, tag] of both(stores)) {
      const oc = store.observationCheckpoints
      await oc.advanceGeneration(only(tag), 'codex', `${tag}-thread-${only(tag)}`)
      await oc.save(checkpoint(tag, 1, only(tag)))
      await oc.recordTerminalCandidate(terminalFacts(tag, only(tag)), AT)
    }
    for (const [store, tag] of both(stores)) {
      const oc = store.observationCheckpoints
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await expect(oc.save(checkpoint(other, 1, only(other)))).rejects.toThrow(/lease changed/)
      await expect(
        oc.rebindExact({
          sessionId: only(other),
          provider: 'codex',
          providerSessionId: `${other}-thread-${only(other)}`,
          bindingVersion: 1,
          observationGeneration: 1,
          nextProviderSessionId: 'changed',
        }),
      ).rejects.toThrow(/missing observation lease/)
      expect(await oc.renewTerminalCandidate(terminalFacts(other, only(other)), LATER)).toBe(false)
      expect(await oc.consumeTerminalCandidate(terminalFacts(other, only(other)), LATER)).toBe(
        false,
      )
      await oc.cancelTerminalCandidate(only(other))
      await oc.purge(only(other))
      // Own writes, at the ids both hold.
      expect(await oc.confirmTerminalCandidate(terminalFacts(tag, sid(1)), 5, AT)).toEqual(
        expect.any(String),
      )
      await oc.advanceGeneration(sid(1), 'codex', `${tag}-thread-${sid(1)}`)
      await oc.cancelTerminalCandidate(sid(3))
      await oc.purge(sid(2))
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the transcript costs repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows, and joins its own issues only', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const tc = store.transcriptCosts
      const forIssues = await tc.forIssues([iss(1)])
      expect(forIssues.map((c) => c.nativeId)).toEqual(['native-1'])
      onlyOwn(forIssues, tag)
      const attributed = await tc.allAttributed()
      expect(attributed.map((c) => c.nativeId)).toEqual(['native-1'])
      onlyOwn(attributed, tag)
      onlyOwn(await tc.ownCohortTotals(0), tag)
      expect(await tc.ownCohortTotals(0)).toHaveLength(1)
      expect([...(await tc.costedSessionIds())]).toEqual([sid(1)])
      expect(await tc.latestWindowSinceMs()).toBe(tag === 'a' ? 100 : 200)
      expect(await tc.countAll()).toBe(1)
    }
  })

  it('records under its own workspace, and a fold naming an issue only the other holds joins nothing', async () => {
    const { stores } = await twoSeeded()
    const [a, b] = stores
    await insertIssue(b, 'b', 9, 'only-b-iss')
    const before = await rowsOf(a, 'b')
    await a.transcriptCosts.record(
      [
        {
          machineId: MACHINE,
          nativeId: 'native-2',
          path: '/repo/t2.jsonl',
          harness: 'codex',
          sessionId: sid(2),
          issueId: asIssueId('only-b-iss'),
          scannedBytes: 1,
          firstTsMs: 1,
          lastTsMs: 1,
          models: [{ model: 'a-model', inputTokens: 1, outputTokens: 1, messages: 9 } as never],
          windowModels: [],
          windowSinceMs: 50,
        },
      ],
      LATER,
    )
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect(await a.transcriptCosts.countAll()).toBe(2)
    // The issue join holds `issues` to this workspace: B's issue is no surviving issue here.
    expect(await a.transcriptCosts.ownCohortTotals(0)).toHaveLength(1)
  })
})

describe('the maintenance repository: the ledger is per workspace, the lease is the installation’s', () => {
  it('reads and prunes its own ledger only', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const m = store.maintenance
      const other = otherOf(tag)
      expect(await m.getCommand('message-expiry', runKey(1))).toEqual(applied(tag, 1))
      const before = await rowsOf(store, other)
      expect(await m.pruneCommandsBatch(LATER, 100)).toBe(2)
      await m.recordCommand(applied(tag, 3), 8, AT)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })

  it('shares the one lease between workspaces', async () => {
    const { stores } = await twoSeeded()
    const [a, b] = stores
    const lease = {
      name: 'maintenance',
      generationId: 'gen-1',
      fencingToken: 7,
      expiresAt: LATER,
      protocolVersion: 3,
      schemaVersion: 'v1',
      updatedAt: AT,
    }
    await a.maintenance.putLease(lease)
    expect(await b.maintenance.getLease('maintenance')).toEqual(lease)
  })
})

describe('the locks repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows, and no row carries the workspace', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const l = store.locks
      const lock = await l.getLock(REPO, LOCK)
      expect(lock?.holderLabel).toBe(tag)
      expect(lock).not.toHaveProperty('workspaceId')
      expect((await l.listLocks(REPO)).map((x) => [x.name, x.holderLabel])).toEqual([[LOCK, tag]])
      expect((await l.listExpiredLocks(REPO, LATER)).map((x) => [x.name, x.holderLabel])).toEqual([
        [LOCK, tag],
      ])
      expect((await l.listLocksHeldBySession(sid(1))).map((x) => [x.name, x.holderLabel])).toEqual([
        [LOCK, tag],
      ])
      const waiters = await l.listWaiters(REPO, LOCK)
      expect(waiters.map((x) => x.label)).toEqual([`${tag} waiter`])
      expect(waiters[0]).not.toHaveProperty('workspaceId')
      expect((await l.listWaitsBySession(sid(2))).map((x) => x.label)).toEqual([`${tag} waiter`])
    }
  })

  it('leaves the other workspace unchanged by writes of the ids both hold, and of a waiter only it holds', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const l = store.locks
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const otherLock = await stores[tag === 'a' ? 1 : 0].locks.getLock(REPO, LOCK)
      // A waiter id is the table's own number: the other workspace's is an id only it holds.
      await l.removeWaiter(seeded[other].waiters[0]!)
      expect(await rowsOf(store, other)).toEqual(before)
      expect(await l.renewLock(REPO, LOCK, sid(1), LATER)).toBe(true)
      await l.removeWaiterBySession(REPO, LOCK, sid(2))
      await l.removeWaiter(seeded[tag].waiters[0]!)
      await l.deleteLock(REPO, LOCK)
      expect(await rowsOf(store, other)).toEqual(before)
      expect(await stores[tag === 'a' ? 1 : 0].locks.getLock(REPO, LOCK)).toEqual(otherLock)
    }
  })
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const SAME = asSessionId('same-session')
    const rowsIn = async (store: WorkspaceEventSlice, tag: Tag) =>
      await store.all<Record<string, unknown>>(
        sql`SELECT * FROM runtime_event_checkpoints WHERE workspace_id = ${WS[tag]} AND session_id = ${SAME}`,
      )
    const { stores } = await twoSeeded()
    const [a, b] = stores
    const save = async (store: WorkspaceEventSlice, tag: Tag, observerGeneration: number) =>
      await store.events.saveRuntimeEventCheckpoint({
        sessionId: SAME,
        observerGeneration,
        cursor: { segmentId: `${tag}-same-segment`, components: { seq: 1 } },
        turnEpoch: 1,
        closedTurnEpoch: null,
        updatedAt: AT,
      })
    await save(b, 'b', 1)
    const before = await rowsIn(b, 'b')
    await save(a, 'a', 1)
    expect(await rowsIn(a, 'a')).toHaveLength(1)
    expect(await rowsIn(b, 'b')).toEqual(before)
    await save(a, 'a', 2)
    expect(await rowsIn(a, 'a')).toEqual([expect.objectContaining({ observer_generation: 2 })])
    expect(await rowsIn(b, 'b')).toEqual(before)
  })
})
