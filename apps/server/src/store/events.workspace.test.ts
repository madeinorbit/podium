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
 * transcript costs; the maintenance ledger; locks and their waiters. The ids and names differ
 * between the workspaces: until the key migration (C1, POD-7024) no unique constraint includes
 * `workspace_id`, so the same id in both would collide on the old key.
 *
 * For every repository method of the group:
 *   - a read answers only its own workspace's rows, including the reads no id narrows (the feed
 *     window, the boot reconcile walks, every list);
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including a
 *     write in A addressed at B's own ids, which must find nothing to change, and the sweeps (the
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
  type IssueId,
  type SessionId,
  type ThreadId,
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
const alice = (tag: Tag): UserId => asUserId(`user:${tag}-alice`)
const sid = (tag: Tag, n: number): SessionId => asSessionId(`${tag}-s${n}`)
const iss = (tag: Tag, n: number): IssueId => asIssueId(`${tag}-iss-${n}`)
const repo = (tag: Tag) => asRepoId(`${tag}-repo`)
const eff = (tag: Tag, n: number) => `${tag}-eff-${n}`
const wf = (tag: Tag) => `${tag}-wf`
const rev = (tag: Tag) => `${tag}-rev`
const run = (tag: Tag) => `${tag}-run`
const auto = (tag: Tag, n: number) => `${tag}-auto-${n}` as AutomationId
const autoRun = (tag: Tag, n: number) => `${tag}-arun-${n}` as AutomationRunId
const ixn = (tag: Tag, n: number) => `${tag}-ixn-${n}`
const thread = (tag: Tag): ThreadId => asThreadId(`${tag}-thread`)
const sub = (tag: Tag, n: number) => `${tag}-sub-${n}`
const lockName = (tag: Tag) => `${tag}-lock`

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

function session(tag: Tag, n: number): SessionRow {
  return {
    id: sid(tag, n),
    ownerUserId: alice(tag),
    agentKind: 'codex',
    cwd: `/repo-${tag}/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `${tag}-resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${tag}-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: asMachineId(`${tag}-machine`),
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
async function insertIssue(store: WorkspaceEventSlice, tag: Tag, n: number): Promise<void> {
  await store.run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq, title,
         stage, default_agent, created_at, updated_at)
       VALUES (${WS[tag]}, ${iss(tag, n)}, ${alice(tag)}, ${alice(tag)}, ${`/repo-${tag}`}, ${repo(tag)},
         ${n}, ${`${tag} ${n}`}, 'backlog', 'codex', ${AT}, ${AT})`,
  )
}

/** A member row, raw: the users repository is another task's. */
async function insertMember(store: WorkspaceEventSlice, tag: Tag): Promise<void> {
  await store.run(
    sql`INSERT INTO users (workspace_id, id, display_name, role, created_at)
       VALUES (${WS[tag]}, ${alice(tag)}, ${`${tag} alice`}, 'member', ${AT})`,
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
    ev: { ev: 'failed', turnEpoch: 1, reason: 'provider-error', disposition: 'needs-human' },
    at: AT,
    provenance: 'live',
    cursor: { segmentId: `${tag}-segment`, components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }) as RuntimeEvent

function subscription(tag: Tag, n: number, patch: Partial<Subscription> = {}): Subscription {
  return {
    id: sub(tag, n),
    subscriberKind: 'session',
    subscriberId: sid(tag, 1),
    event: `${tag}.event`,
    sourceKind: 'session',
    sourceRef: sid(tag, 2),
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
    id: auto(tag, n),
    name: `${tag} nightly ${n}`,
    enabled: true,
    repoPath: `/repo-${tag}`,
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
    ownerUserId: alice(tag),
    createdByActor: `${tag}-actor`,
    createdByOnBehalfOf: alice(tag),
  }
}

function automationRun(tag: Tag, n: number, sessionId: SessionId | null): AutomationRunRow {
  return {
    id: autoRun(tag, n),
    automationId: auto(tag, 1),
    firedAt: `2026-11-17T10:0${n}:00.000Z`,
    sessionId,
    outcome: sessionId === null ? 'skipped_overlap' : 'spawned',
    detail: null,
    actor: 'system:automation',
    onBehalfOf: alice(tag),
  }
}

function workflowRun(tag: Tag): WorkflowRunRow {
  return {
    id: run(tag),
    subjectKind: 'issue',
    subjectId: iss(tag, 1),
    coordinatorSessionId: sid(tag, 1),
    revisionId: rev(tag),
    status: 'active',
    supersedesRunId: null,
    startedAt: AT,
    completedAt: null,
    ownerUserId: alice(tag),
  }
}

function checkpoint(tag: Tag, generation: number): SessionObservationCheckpointV1 {
  return {
    schemaVersion: 1,
    podiumSessionId: sid(tag, 1),
    provider: 'codex',
    providerSessionId: `${tag}-thread-1`,
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

function terminalFacts(tag: Tag, n: number): TerminalCandidateFacts {
  return {
    schemaVersion: 1,
    sessionId: sid(tag, n),
    terminalTransitionId: `${tag}-transition-${n}`,
    terminalTurnEpoch: 1,
    provider: 'codex',
    providerSessionId: `${tag}-thread-${n}`,
    bindingVersion: 1,
    observerGeneration: 1,
    providerCursor: { segmentId: `${tag}-rollout`, components: { file: 42 } },
    lastLiveReceiptAt: null,
    lastTransitionId: `${tag}-transition-${n}`,
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
    machineId: asMachineId(`${tag}-machine`),
  } as TerminalCandidateFacts
}

const applied = (tag: Tag, n: number): MaintenanceCommandReply => ({
  status: 'applied',
  jobKind: 'message-expiry',
  runKey: `${tag}-run-${n}`,
  deleted: 0,
})

interface Seeded {
  /** The ids of this workspace's appended events, in order. */
  readonly events: number[]
  /** This workspace's lock waiter ids. */
  readonly waiters: number[]
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
  await insertIssue(store, tag, 1)
  await insertIssue(store, tag, 2)
  await insertMember(store, tag)

  // --- events -----------------------------------------------------------------
  const ev = store.events
  const events: number[] = []
  events.push(
    await ev.appendEvent(
      { ts: EARLIER, kind: 'issue.updated', subject: iss(tag, 1), repoPath: `/repo-${tag}` },
      { announce: false },
    ),
  )
  events.push(
    await ev.appendEvent(
      { ts: AT, kind: 'issue.closed', subject: iss(tag, 2), repoPath: `/repo-${tag}` },
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
          subject: sid(tag, 1),
          payload,
        },
        { announce: false },
      ),
    )
  }
  await ev.saveRuntimeEventCheckpoint({
    sessionId: sid(tag, 1),
    observerGeneration: 1,
    cursor: { segmentId: `${tag}-segment`, components: { seq: 3 } },
    turnEpoch: 1,
    closedTurnEpoch: null,
    updatedAt: AT,
    turnState: { phase: 'idle', since: AT, workingMsTotal: 0, nativeSubagentCount: 0 },
  })
  await ev.saveRuntimeEventProjectionCursor(`${tag}-projector`, events[2]!, AT)
  await ev.setStewardState(`${tag}-key`, `${tag}-value`)
  await ev.addSubscription(subscription(tag, 1))
  await ev.addSubscription(
    subscription(tag, 2, {
      subscriberKind: 'issue',
      subscriberId: iss(tag, 1),
      sourceKind: 'relationship',
      sourceRef: '',
    }),
  )
  // A subscriber only the OTHER workspace holds: its EXISTS probe must find nothing here.
  await ev.addSubscription(subscription(tag, 3, { subscriberId: sid(otherOf(tag), 1) }))
  await ev.markDelivered(sub(tag, 1), events[0]!)

  // --- effects ----------------------------------------------------------------
  const fx = store.effects
  const effect = (n: number, gated = false) => ({
    id: eff(tag, n),
    kind: `${tag}.kind`,
    target: { kind: 'issue' as const, id: iss(tag, 1) },
    input: { tag },
    deadlineAt: n === 3 ? NOW_MS - 1 : undefined,
    createdBy: alice(tag),
    gated,
  })
  await fx.insert(scope, effect(1), NOW_MS)
  await fx.insert(scope, effect(2, true), NOW_MS)
  await fx.insert(scope, effect(3), NOW_MS)
  await fx.insert(scope, effect(4), NOW_MS)
  await fx.claim(scope, eff(tag, 4), NOW_MS)
  await fx.insert(scope, effect(5), NOW_MS)
  await fx.claim(scope, eff(tag, 5), NOW_MS)
  await fx.settle(scope, eff(tag, 5), 'succeeded', {}, NOW_MS)
  await fx.insert(scope, effect(6), NOW_MS)
  await fx.claim(scope, eff(tag, 6), NOW_MS)
  await fx.settle(scope, eff(tag, 6), 'failed', { error: { code: 'x', message: 'x' } }, NOW_MS)
  await fx.tombstone(scope, eff(tag, 6), NOW_MS)
  // An imported copy not yet published (revision 0), set directly.
  await store.run(
    sql`UPDATE effects SET revision = 0 WHERE workspace_id = ${WS[tag]} AND id = ${eff(tag, 1)}`,
  )

  // --- workflows --------------------------------------------------------------
  const w = store.workflows
  await w.insertWorkflow({
    id: wf(tag),
    name: `${tag} flow`,
    description: tag,
    scope: 'global',
    scopeRef: null,
    actor: OPERATOR,
    ownerUserId: alice(tag),
    now: AT,
  })
  await w.insertRevision({
    id: rev(tag),
    workflowId: wf(tag),
    instructions: tag,
    steps: [{ id: 'step-1', title: 'one', instructions: 'i', completionGuidance: 'g' } as never],
    actor: OPERATOR,
    now: AT,
  })
  await w.publishRevision(rev(tag), AT)
  await w.setBinding({
    targetKind: 'issue',
    targetId: iss(tag, 1),
    revisionId: rev(tag),
    actor: OPERATOR,
    ownerUserId: alice(tag),
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
  await w.assignStep(run(tag), 'step-1', sid(tag, 2))
  await w.appendEvent({
    workflowId: wf(tag),
    runId: run(tag),
    kind: `${tag}.started`,
    actor: OPERATOR,
    now: AT,
  })

  // --- automations ------------------------------------------------------------
  const au = store.automations
  await au.insert(scope, automation(tag, 1))
  await au.insert(scope, automation(tag, 2))
  await au.addRun(scope, automationRun(tag, 1, sid(tag, 1)))
  await au.addRun(scope, automationRun(tag, 2, null))

  // --- interactions -----------------------------------------------------------
  const ix = store.interactions
  for (const n of [1, 2, 3]) {
    await ix.insert({
      id: ixn(tag, n),
      sessionId: sid(tag, 1),
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: `${tag} ${n}`, offered: ['full-resume'] },
      source: 'protocol',
      answerable: 'structured',
      fingerprint: `${tag}-fp-${n}`,
      askedAt: `2026-11-17T10:0${n}:00.000Z`,
    })
  }
  await ix.answer({
    id: ixn(tag, 2),
    answer: { kind: 'recovery', choice: 'full-resume' },
    answeredBy: 'human',
    deliveredVia: 'structured',
    at: AT,
  })
  await ix.close(ixn(tag, 3), 'expired', EARLIER)

  // --- superagent -------------------------------------------------------------
  const sa = store.superagent
  await sa.upsertSuperagentThread({
    id: thread(tag),
    ownerUserId: alice(tag),
    kind: 'btw',
    title: tag,
  })
  await sa.appendSuperagentMessage(thread(tag), { role: 'user', content: `${tag} hello` })
  await sa.putQueuedInput({
    inputId: `${tag}-input-1`,
    ownerUserId: alice(tag),
    threadId: thread(tag),
    text: `${tag} queued`,
  })
  await sa.putQueuedInput({
    inputId: `${tag}-input-2`,
    ownerUserId: alice(tag),
    threadId: thread(tag),
    text: `${tag} queued 2`,
  })
  await sa.putPendingTurn({
    turnId: `${tag}-turn-1`,
    ownerUserId: alice(tag),
    threadId: thread(tag),
    podiumSessionId: sid(tag, 1),
    payload: { agent: 'codex', cwd: `/repo-${tag}`, prompt: tag },
    firstTurn: true,
  })
  await sa.setTurnRunning(thread(tag), true)

  // --- observation checkpoints ------------------------------------------------
  const oc = store.observationCheckpoints
  await oc.advanceGeneration(sid(tag, 1), 'codex', `${tag}-thread-1`)
  await oc.save(checkpoint(tag, 1))
  await oc.advanceGeneration(sid(tag, 2), 'codex', `${tag}-thread-2`)
  await oc.rebindExact({
    sessionId: sid(tag, 2),
    provider: 'codex',
    providerSessionId: `${tag}-thread-2`,
    bindingVersion: 1,
    observationGeneration: 1,
    nextProviderSessionId: `${tag}-thread-2b`,
  })
  await oc.advanceGeneration(sid(tag, 3), 'codex', `${tag}-thread-3`)
  await oc.recordTerminalCandidate(terminalFacts(tag, 1), AT)
  await oc.recordTerminalCandidate(terminalFacts(tag, 3), AT)

  // --- transcript costs, maintenance, locks -----------------------------------
  await store.transcriptCosts.record(
    [
      {
        machineId: asMachineId(`${tag}-machine`),
        nativeId: `${tag}-native-1`,
        path: `/repo-${tag}/t1.jsonl`,
        harness: 'codex',
        sessionId: sid(tag, 1),
        issueId: iss(tag, 1),
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
    repoId: repo(tag),
    name: lockName(tag),
    holderSessionId: sid(tag, 1),
    holderIssueId: iss(tag, 1),
    holderLabel: tag,
    note: null,
    acquiredAt: EARLIER,
    expiresAt: AT,
  })
  await store.locks.enqueueWaiter({
    repoId: repo(tag),
    name: lockName(tag),
    sessionId: sid(tag, 2),
    issueId: null,
    label: `${tag} waiter`,
    ttlSeconds: 60,
    note: null,
    enqueuedAt: AT,
  })
  const waiters = (await store.locks.listWaiters(repo(tag), lockName(tag))).map((w) => w.id)
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

/** Every string in `value` that names a seeded thing starts with the workspace's tag. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = otherOf(tag)
  expect(JSON.stringify(value)).not.toMatch(new RegExp(`\\b${other}[-.]`))
}

const ids = (rows: Iterable<{ id: string | number }>) => [...rows].map((row) => row.id).sort()

describe('the group writes every row under its own workspace', () => {
  it('seeds each table in both workspaces, each with only its own names', async () => {
    const { stores } = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = await rowsOf(stores[0], tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        // The third subscription names the other workspace's session on purpose (the probe case).
        const named = (rows[table] as { id?: unknown }[]).filter((row) => row.id !== sub(tag, 3))
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
      expect((await ev.runtimeEventCheckpoint(sid(tag, 1)))?.cursor.segmentId).toBe(
        `${tag}-segment`,
      )
      expect(await ev.runtimeEventCheckpoint(sid(other, 1))).toBeNull()
      expect([...(await ev.runtimeTurnStatesOf([sid(tag, 1), sid(other, 1)])).keys()]).toEqual([
        sid(tag, 1),
      ])
      expect(await ev.listRuntimeEvents(sid(tag, 1))).toHaveLength(3)
      expect(await ev.listRuntimeEvents(sid(other, 1))).toEqual([])
      expect([...(await ev.runtimeTranscriptSessionIds())]).toEqual([sid(tag, 1)])
      expect([...(await ev.runtimeTranscriptAvailableOf([sid(tag, 1), sid(other, 1)]))]).toEqual([
        sid(tag, 1),
      ])
      expect(await ev.listRuntimeTranscriptEvents(sid(tag, 1))).toHaveLength(1)
      expect(await ev.listRuntimeTranscriptEvents(sid(other, 1))).toEqual([])
      expect(await ev.hasCausalTurnFailure(sid(tag, 1), 1)).toBe(true)
      expect(await ev.hasCausalTurnFailure(sid(other, 1), 1)).toBe(false)
      const after = await ev.listRuntimeEventsAfter(0)
      expect(after.map((r) => r.id)).toEqual(seeded[tag].events.slice(2))
      expect(await ev.runtimeEventProjectionCursor(`${tag}-projector`)).toBe(seeded[tag].events[2])
      expect(await ev.runtimeEventProjectionCursor(`${other}-projector`)).toBe(0)
    }
  })

  it('answers the event log, feed window and steward reads with its own rows', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ev = store.events
      const other = otherOf(tag)
      const own = seeded[tag].events
      expect(ids(await ev.listEventsSince(0, { limit: 100 }))).toEqual([...own].sort())
      expect(
        ids(await ev.listEventsSince(0, { subject: iss(tag, 1), order: 'desc', limit: 10 })),
      ).toEqual([own[0]])
      expect(await ev.listEventsSince(0, { subject: iss(other, 1), limit: 10 })).toEqual([])
      expect(
        ids(await ev.listKindSubjectSinceWithPrior('issue.closed', iss(tag, 2), EARLIER)),
      ).toEqual([own[1]])
      expect(
        await ev.listKindSubjectSinceWithPrior('issue.closed', iss(other, 2), EARLIER),
      ).toEqual([])
      const window = await ev.feedWindow({ limit: 50 })
      onlyOwn(window, tag)
      const windowIds = await ev.feedWindowIds({ limit: 50 })
      expect(windowIds.map((r) => r.id).sort()).toEqual(ids(window))
      const allIds = [...seeded.a.events, ...seeded.b.events]
      expect(ids(await ev.feedWindowByIds(allIds, 50))).toEqual(ids(window))
      onlyOwn(await ev.feedWindowOfSubjects([iss(tag, 1), iss(other, 1), iss(other, 2)], 50), tag)
      expect(await ev.feedWindowOfSubjects([iss(other, 1), iss(other, 2)], 50)).toEqual([])
      expect(await ev.maxEventId()).toBe(Math.max(...own))
      expect(await ev.getStewardState(`${tag}-key`)).toBe(`${tag}-value`)
      expect(await ev.getStewardState(`${other}-key`)).toBeUndefined()
    }
  })

  it('answers the subscription reads with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ev = store.events
      const other = otherOf(tag)
      const own = [sub(tag, 1), sub(tag, 2), sub(tag, 3)]
      expect(ids(await ev.listSubscriptions({ subscriberId: sid(tag, 1) }))).toEqual([sub(tag, 1)])
      // The third subscription names the other workspace's session id, stored here.
      expect(ids(await ev.listSubscriptions({ subscriberId: sid(other, 1) }))).toEqual([
        sub(tag, 3),
      ])
      expect(ids(await ev.listSubscriptionsPage())).toEqual(own)
      // The EXISTS probes hold the subscriber's session and issue to this workspace: the third
      // subscription names a session only the other workspace holds, so no owner reaches it.
      expect(ids(await ev.listOwnSubscriptionsPage(alice(tag)))).toEqual([sub(tag, 1), sub(tag, 2)])
      expect(await ev.listOwnSubscriptionsPage(alice(other))).toEqual([])
      expect(ids(await ev.allSubscriptionsForBootReconcile())).toEqual(own)
      expect(ids(await ev.subscriptionsByIds([...own, sub(other, 1), sub(other, 2)]))).toEqual(own)
      expect((await ev.getSubscription(sub(tag, 1)))?.id).toBe(sub(tag, 1))
      expect(await ev.getSubscription(sub(other, 1))).toBeUndefined()
      expect(await ev.hasRelationshipSubscription([`${tag}.event`])).toBe(true)
      expect(await ev.hasRelationshipSubscription([`${other}.event`])).toBe(false)
      expect(
        ids(
          await ev.listMatchingSubscriptions({
            events: [`${tag}.event`, `${other}.event`],
            sources: [sid(tag, 2), sid(other, 2)],
            anchorIssueIds: [iss(tag, 1), iss(other, 1)],
          }),
        ),
      ).toEqual([sub(tag, 1), sub(tag, 2), sub(tag, 3)])
      expect(
        await ev.listMatchingSubscriptions({
          events: [`${other}.event`],
          sources: [sid(other, 2)],
          anchorIssueIds: [iss(other, 1)],
        }),
      ).toEqual([])
    }
  })
})

describe('the events repository writes only its own workspace', () => {
  it('leaves the other workspace unchanged by writes aimed at its ids', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      const ev = store.events
      await ev.removeSubscription(sub(other, 1))
      expect(await ev.setSubscriptionEnabled(sub(other, 2), false)).toBe(false)
      // Own writes, which reach the other workspace's rows only if a predicate is missing.
      expect(await ev.markDelivered(sub(tag, 2), seeded[tag].events[1]!)).toBe(true)
      await ev.setStewardState(`${tag}-key`, `${tag}-changed`)
      await ev.saveRuntimeEventProjectionCursor(`${tag}-projector`, seeded[tag].events[4]!, AT)
      await ev.saveRuntimeEventCheckpoint({
        sessionId: sid(tag, 1),
        observerGeneration: 2,
        cursor: { segmentId: `${tag}-segment`, components: { seq: 4 } },
        turnEpoch: 2,
        closedTurnEpoch: 1,
        updatedAt: AT,
      })
      expect(
        await ev.appendEventOnce({ ts: AT, kind: `${tag}.once`, subject: iss(tag, 1) }),
      ).toEqual(expect.any(Number))
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })

  it('claims the janitor steward in its own workspace only', async () => {
    // One workspace only: the steward's `cursor` key is the same name in every workspace, and
    // until C1 the old key would make the second claim's upsert hit the first one's row.
    const { stores, seeded } = await twoSeeded()
    const [a, b] = stores
    const before = await rowsOf(a, 'b')
    expect(await a.events.activateJanitorSteward()).toBe(Math.max(...seeded.a.events))
    expect(await a.events.getStewardState('cursor')).toBe(String(Math.max(...seeded.a.events)))
    expect(await b.events.getStewardState('cursor')).toBeUndefined()
    expect(await rowsOf(a, 'b')).toEqual(before)
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
      subject: iss('a', 1),
    })
    await a.events.settleGroupedAppends()
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect((await a.events.listEventsSince(id - 1, { limit: 1 }))[0]?.kind).toBe('a.grouped')
    await a.events.announceEvent(id)
    expect(announced).toContain(id)
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
      const all = [1, 2, 3, 4, 5, 6].flatMap((n) => [eff('a', n), eff('b', n)])
      expect(ids(await fx.liveByIds(all))).toEqual([1, 2, 3, 4, 5].map((n) => eff(tag, n)))
      const pages: string[] = []
      for await (const page of fx.livePages(2)) pages.push(...page.map((row) => row.id))
      expect(pages.sort()).toEqual([1, 2, 3, 4, 5].map((n) => eff(tag, n)))
      expect((await fx.get(eff(tag, 1)))?.id).toBe(eff(tag, 1))
      expect(await fx.get(eff(other, 1))).toBeUndefined()
      const target = { kind: 'issue' as const, id: iss(tag, 1) }
      expect((await fx.newestOnTarget(`${tag}.kind`, target, 'active'))?.id).toEqual(
        expect.any(String),
      )
      expect(
        await fx.newestOnTarget(`${other}.kind`, { kind: 'issue', id: iss(other, 1) }, 'active'),
      ).toBeUndefined()
      expect((await fx.newestOnTarget(`${tag}.kind`, target, 'succeeded'))?.id).toBe(eff(tag, 5))
      expect([...(await fx.audiencesOf(all)).keys()].sort()).toEqual(
        [1, 2, 3, 4, 5, 6].map((n) => eff(tag, n)),
      )
      onlyOwn(
        await fx.liveOnTargets([
          { kind: 'issue', id: iss(tag, 1) },
          { kind: 'issue', id: iss(other, 1) },
        ]),
        tag,
      )
      expect(await fx.liveOnTargets([{ kind: 'issue', id: iss(other, 1) }])).toEqual([])
      expect(ids(await fx.listAwaiting(`${tag}.kind`, 10))).toEqual([eff(tag, 2)])
      expect(await fx.listAwaiting(`${other}.kind`, 10)).toEqual([])
      onlyOwn(await fx.listInStatus('pending', 10), tag)
      expect(ids(await fx.listInStatus('running', 10))).toEqual([eff(tag, 4)])
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids and by the sweeps', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const fx = store.effects
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      expect(await fx.claim(scope, eff(other, 3), NOW_MS)).toBeUndefined()
      expect(await fx.settle(scope, eff(other, 4), 'succeeded', {}, NOW_MS)).toBeUndefined()
      expect(await fx.setStage(scope, eff(other, 4), 'stage', NOW_MS)).toBeUndefined()
      expect(await fx.decide(scope, eff(other, 2), 'approve', 1, NOW_MS)).toBeUndefined()
      expect(await fx.requestCancel(scope, eff(other, 4), NOW_MS)).toBeUndefined()
      expect(await fx.tombstone(scope, eff(other, 5), NOW_MS)).toBeUndefined()
      // The sweeps, which no id narrows, take this workspace's rows only.
      expect(ids(await fx.publishCopied(scope, 10))).toEqual([eff(tag, 1)])
      expect(ids(await fx.expireDue(scope, NOW_MS, 10))).toEqual([eff(tag, 3)])
      expect(ids(await fx.pruneFinished(scope, NOW_MS + 1, NOW_MS, 10))).toEqual([
        eff(tag, 3),
        eff(tag, 5),
      ])
      expect(await fx.purgeTombstones(scope, NOW_MS + 1, 10)).toBe(3)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the workflows repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const w = store.workflows
      const other = otherOf(tag)
      for (const kind of ['workflow-definition', 'workflow-library-entry'])
        expect(await w.ownerOf(kind, wf(tag))).toBe(alice(tag))
      expect(await w.ownerOf('workflow-revision', rev(tag))).toBe(alice(tag))
      expect(await w.ownerOf('workflow-binding', `issue:${iss(tag, 1)}`)).toBe(alice(tag))
      expect(await w.ownerOf('workflow-run', run(tag))).toBe(alice(tag))
      for (const [kind, id] of [
        ['workflow-definition', wf(other)],
        ['workflow-revision', rev(other)],
        ['workflow-binding', `issue:${iss(other, 1)}`],
        ['workflow-run', run(other)],
      ] as const)
        expect(await w.ownerOf(kind, id)).toBeNull()
      const listed = await w.listWorkflows()
      expect(ids(listed)).toEqual([wf(tag)])
      // The latest version subquery counts this workspace's revisions only.
      expect(listed[0]?.latestVersion).toBe(1)
      expect(ids(await w.listWorkflows({ includeArchived: true, scope: 'global' }))).toEqual([
        wf(tag),
      ])
      const facts = await w.visibilityFacts({
        workflowIds: [wf(tag), wf(other)],
        revisionIds: [rev(tag), rev(other)],
        bindings: [
          { targetKind: 'issue', targetId: iss(tag, 1) },
          { targetKind: 'issue', targetId: iss(other, 1) },
        ],
        runIds: [run(tag), run(other)],
      })
      expect([...facts.workflows.keys()]).toEqual([wf(tag)])
      expect([...facts.revisions.keys()]).toEqual([rev(tag)])
      expect([...facts.bindings.keys()]).toEqual([`issue:${iss(tag, 1)}`])
      expect([...facts.runs.keys()]).toEqual([run(tag)])
      expect(ids(await w.allWorkflowsForBootReconcile())).toEqual([wf(tag)])
      expect(ids(await w.allRevisionsForBootReconcile())).toEqual([rev(tag)])
      const runs = await w.allRunsForBootReconcile()
      expect(runs.map((r) => [r.run.id, r.workflowId, r.steps.length])).toEqual([
        [run(tag), wf(tag), 1],
      ])
      expect(ids(await w.workflowsByIds([wf(tag), wf(other)]))).toEqual([wf(tag)])
      expect(ids(await w.revisionsByIds([rev(tag), rev(other)]))).toEqual([rev(tag)])
      expect((await w.runsByIds([run(tag), run(other)])).map((r) => r.run.id)).toEqual([run(tag)])
      expect(await w.runIdsOfRevisions([rev(tag), rev(other)])).toEqual([run(tag)])
      expect((await w.getWorkflow(wf(tag)))?.id).toBe(wf(tag))
      expect(await w.getWorkflow(wf(other))).toBeNull()
      expect(ids(await w.listRevisions(wf(tag)))).toEqual([rev(tag)])
      expect(await w.listRevisions(wf(other))).toEqual([])
      expect((await w.getRevision(rev(tag)))?.id).toBe(rev(tag))
      expect(await w.getRevision(rev(other))).toBeNull()
      expect((await w.getBinding('issue', iss(tag, 1)))?.revisionId).toBe(rev(tag))
      expect(await w.getBinding('issue', iss(other, 1))).toBeNull()
      expect((await w.listBindings()).map((b) => b.targetId)).toEqual([iss(tag, 1)])
      expect(ids(await w.listRuns())).toEqual([run(tag)])
      expect(ids(await w.listRunsPage({ limit: 10 }))).toEqual([run(tag)])
      expect((await w.getRun(run(tag)))?.id).toBe(run(tag))
      expect(await w.getRun(run(other))).toBeNull()
      expect((await w.getRunSteps(run(tag))).map((s) => s.stepId)).toEqual(['step-1'])
      expect(await w.getRunSteps(run(other))).toEqual([])
      expect((await w.listRunEvents(run(tag))).map((e) => e.kind)).toEqual([`${tag}.started`])
      expect(await w.listRunEvents(run(other))).toEqual([])
      expect((await w.findLiveRun('issue', iss(tag, 1)))?.id).toBe(run(tag))
      expect(await w.findLiveRun('issue', iss(other, 1))).toBeNull()
      expect((await w.findLiveRunForSession(sid(tag, 1)))?.id).toBe(run(tag))
      expect((await w.findLiveRunForSession(sid(tag, 2)))?.id).toBe(run(tag))
      expect(await w.findLiveRunForSession(sid(other, 1))).toBeNull()
      expect(await w.findLiveRunForSession(sid(other, 2))).toBeNull()
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const w = store.workflows
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await w.publishRevision(rev(other), LATER)
      await w.updateRunStatus(run(other), 'complete', LATER)
      await w.updateStep({
        runId: run(other),
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
      await w.assignStep(run(other), 'step-1', null)
      await w.resetStep(run(other), 'step-1')
      // Own writes, which reach the other workspace's rows only if a predicate is missing.
      await w.insertRevision({
        id: `${tag}-rev-2`,
        workflowId: wf(tag),
        instructions: tag,
        steps: [],
        actor: OPERATOR,
        now: LATER,
      })
      expect((await w.getWorkflow(wf(tag)))?.latestVersion).toBe(2)
      await w.updateRunStatus(run(tag), 'complete', LATER)
      await w.resetStep(run(tag), 'step-1')
      await w.appendEvent({ runId: run(tag), kind: `${tag}.done`, actor: OPERATOR, now: LATER })
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the automations repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const au = store.automations
      const other = otherOf(tag)
      const allAutos = [auto(tag, 1), auto(tag, 2), auto(other, 1), auto(other, 2)]
      const allRuns = [autoRun(tag, 1), autoRun(tag, 2), autoRun(other, 1), autoRun(other, 2)]
      expect(ids(await au.list())).toEqual([auto(tag, 1), auto(tag, 2)])
      expect((await au.get(auto(tag, 1)))?.id).toBe(auto(tag, 1))
      expect(await au.get(auto(other, 1))).toBeUndefined()
      expect(await au.ownerOf(auto(tag, 1))).toBe(alice(tag))
      expect(await au.ownerOf(auto(other, 1))).toBeUndefined()
      expect(await au.runOwnerOf(autoRun(tag, 1))).toBe(alice(tag))
      expect(await au.runOwnerOf(autoRun(other, 1))).toBeUndefined()
      expect([...(await au.ownersOf(allAutos)).keys()].sort()).toEqual([auto(tag, 1), auto(tag, 2)])
      expect([...(await au.runOwnersOf(allRuns)).keys()].sort()).toEqual([
        autoRun(tag, 1),
        autoRun(tag, 2),
      ])
      expect(ids(await au.getMany(allAutos))).toEqual([auto(tag, 1), auto(tag, 2)])
      expect(ids(await au.getRuns(allRuns))).toEqual([autoRun(tag, 1), autoRun(tag, 2)])
      expect((await au.getRun(autoRun(tag, 1)))?.id).toBe(autoRun(tag, 1))
      expect(await au.getRun(autoRun(other, 1))).toBeUndefined()
      expect(ids(await au.listRuns(auto(tag, 1)))).toEqual([autoRun(tag, 1), autoRun(tag, 2)])
      expect(await au.listRuns(auto(other, 1))).toEqual([])
      expect(ids(await au.listAllRuns())).toEqual([autoRun(tag, 1), autoRun(tag, 2)])
      expect([...(await au.lastSpawnedSessions())]).toEqual([[auto(tag, 1), sid(tag, 1)]])
      expect(await au.lastSpawnedSessionOf(auto(tag, 1))).toBe(sid(tag, 1))
      expect(await au.lastSpawnedSessionOf(auto(other, 1))).toBeUndefined()
      expect([...(await au.liveRunIdsOf(auto(tag, 1)))].sort()).toEqual([
        autoRun(tag, 1),
        autoRun(tag, 2),
      ])
      expect(await au.liveRunIdsOf(auto(other, 1))).toEqual([])
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const au = store.automations
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await au.update(scope, { ...automation(other, 1), name: 'changed' })
      expect(await au.remove(scope, auto(other, 2), LATER)).toBe(false)
      await au.updateRun(scope, autoRun(other, 1), {
        sessionId: null,
        outcome: 'error',
        detail: 'changed',
      })
      // Own writes: an update and a removal, which take its runs with it.
      await au.update(scope, { ...automation(tag, 1), name: `${tag} renamed` })
      expect(await au.remove(scope, auto(tag, 1), LATER)).toBe(true)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the interactions repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ix = store.interactions
      const other = otherOf(tag)
      expect((await ix.get(ixn(tag, 1)))?.id).toBe(ixn(tag, 1))
      expect(await ix.get(ixn(other, 1))).toBeNull()
      expect((await ix.openByFingerprint(sid(tag, 1), `${tag}-fp-1`))?.id).toBe(ixn(tag, 1))
      expect(await ix.openByFingerprint(sid(other, 1), `${other}-fp-1`)).toBeNull()
      expect(ids(await ix.listOpen())).toEqual([ixn(tag, 1)])
      expect(ids(await ix.listOpen(sid(tag, 1)))).toEqual([ixn(tag, 1)])
      expect(await ix.listOpen(sid(other, 1))).toEqual([])
      expect(ids(await ix.openOfIds([ixn(tag, 1), ixn(other, 1)]))).toEqual([ixn(tag, 1)])
      expect(ids(await ix.listForSession(sid(tag, 1)))).toEqual([1, 2, 3].map((n) => ixn(tag, n)))
      expect(await ix.listForSession(sid(other, 1))).toEqual([])
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids and by the prune', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const ix = store.interactions
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      expect(await ix.enrich(ixn(other, 1), { changed: true })).toBe(false)
      expect(
        await ix.answer({
          id: ixn(other, 1),
          answer: { kind: 'recovery', choice: 'full-resume' },
          answeredBy: 'human',
          deliveredVia: 'structured',
          at: LATER,
        }),
      ).toBe(false)
      expect(await ix.recordDelivery(ixn(other, 2), 'menu')).toBe(false)
      expect(await ix.reopen(ixn(other, 2), 'human')).toBe(false)
      expect(await ix.retireClaimed(ixn(other, 2), 'expired', LATER, 'human')).toBe(false)
      expect(await ix.close(ixn(other, 1), 'expired', LATER)).toBe(false)
      expect(await ix.closeSession(sid(other, 1), 'expired', LATER)).toEqual([])
      // The prune, which no id narrows: it takes this workspace's resolved rows only.
      expect(await ix.pruneResolvedBefore(LATER)).toBe(2)
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the superagent repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const sa = store.superagent
      const other = otherOf(tag)
      const threads = await sa.allThreadsForBootReconcile()
      expect(threads.map((t) => t.id)).toContain(thread(tag))
      onlyOwn(threads, tag)
      expect((await sa.loadSuperagentMessages(thread(tag))).map((m) => m.content)).toEqual([
        `${tag} hello`,
      ])
      expect(await sa.loadSuperagentMessages(thread(other))).toEqual([])
      expect((await sa.listSuperagentThreads(alice(tag))).map((t) => t.id)).toContain(thread(tag))
      expect(await sa.listSuperagentThreads(alice(other))).toEqual([])
      expect(ids(await sa.superagentThreadsByIds([thread(tag), thread(other)]))).toEqual([
        thread(tag),
      ])
      expect((await sa.getSuperagentThread(thread(tag)))?.id).toBe(thread(tag))
      expect((await sa.getSuperagentThread(thread(tag), alice(tag)))?.id).toBe(thread(tag))
      expect(await sa.getSuperagentThread(thread(other))).toBeUndefined()
      expect(await sa.getSuperagentThread(thread(other), alice(other))).toBeUndefined()
      expect((await sa.listQueuedInputs()).map((q) => q.inputId).sort()).toEqual([
        `${tag}-input-1`,
        `${tag}-input-2`,
      ])
      expect((await sa.listQueuedInputs(thread(tag))).length).toBe(2)
      expect(await sa.listQueuedInputs(thread(other))).toEqual([])
      expect((await sa.listPendingTurns()).map((p) => p.turnId)).toEqual([`${tag}-turn-1`])
    }
  })

  it('seeds a member thread only for a member of its own workspace', async () => {
    const { stores } = await twoSeeded()
    const [a, b] = stores
    const before = await rowsOf(a, 'b')
    // The users read is held to this workspace: B's member is nobody here.
    await a.superagent.seedMemberGlobalThread(alice('b'))
    expect(await rowsOf(a, 'b')).toEqual(before)
    expect(await a.superagent.getSuperagentThread(`global:${alice('b')}`)).toBeUndefined()
    await a.superagent.seedMemberGlobalThread(alice('a'))
    expect((await a.superagent.getSuperagentThread(`global:${alice('a')}`))?.ownerUserId).toBe(
      alice('a'),
    )
    expect(await b.superagent.getSuperagentThread(`global:${alice('a')}`)).toBeUndefined()
    expect(await rowsOf(a, 'b')).toEqual(before)
  })

  it('leaves the other workspace unchanged by writes aimed at its ids and by the turn sync', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const sa = store.superagent
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await sa.setTurnRunning(thread(other), false)
      await sa.setTurnFailure(thread(other), null)
      await sa.clearSuperagentMessages(thread(other))
      await sa.setThreadWatermark(thread(other), 'item', AT)
      await sa.updateSuperagentThreadBinding(thread(other), { agentKind: 'changed' })
      await sa.archiveSuperagentThread(thread(other))
      await sa.deleteQueuedInput(`${other}-input-1`)
      await sa.deletePendingTurn(`${other}-turn-1`)
      // Own writes: the sync clears a running flag that has no pending turn HERE, and the
      // other workspace's running thread (which has one) is not this workspace's to clear.
      await sa.deletePendingTurn(`${tag}-turn-1`)
      await sa.syncTurnRunningWithPendingTurns()
      expect((await sa.getSuperagentThread(thread(tag)))?.turnRunning).toBe(false)
      await sa.promoteQueuedInput(`${tag}-input-2`, {
        turnId: `${tag}-turn-2`,
        ownerUserId: alice(tag),
        threadId: thread(tag),
        podiumSessionId: sid(tag, 1),
        payload: { agent: 'codex', cwd: `/repo-${tag}`, prompt: tag },
        firstTurn: false,
      })
      await sa.clearSuperagentMessages(thread(tag))
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the observation checkpoints repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const oc = store.observationCheckpoints
      const other = otherOf(tag)
      expect([...(await oc.checkpointsOf([sid(tag, 1), sid(other, 1)])).keys()]).toEqual([
        sid(tag, 1),
      ])
      expect((await oc.get(sid(tag, 1)))?.providerSessionId).toBe(`${tag}-thread-1`)
      expect((await oc.get(sid(tag, 2)))?.providerSessionId).toBe(`${tag}-thread-2b`)
      expect(await oc.get(sid(other, 1))).toBeNull()
      expect((await oc.getTerminalCandidate(sid(tag, 1)))?.facts.sessionId).toBe(sid(tag, 1))
      expect(await oc.getTerminalCandidate(sid(other, 1))).toBeNull()
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const oc = store.observationCheckpoints
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      await expect(oc.save(checkpoint(other, 1))).rejects.toThrow(/lease changed/)
      await expect(
        oc.rebindExact({
          sessionId: sid(other, 1),
          provider: 'codex',
          providerSessionId: `${other}-thread-1`,
          bindingVersion: 1,
          observationGeneration: 1,
          nextProviderSessionId: 'changed',
        }),
      ).rejects.toThrow(/missing observation lease/)
      expect(await oc.renewTerminalCandidate(terminalFacts(other, 1), LATER)).toBe(false)
      expect(await oc.consumeTerminalCandidate(terminalFacts(other, 1), LATER)).toBe(false)
      await oc.cancelTerminalCandidate(sid(other, 3))
      await oc.purge(sid(other, 1))
      // Own writes.
      expect(await oc.confirmTerminalCandidate(terminalFacts(tag, 1), 5, AT)).toEqual(
        expect.any(String),
      )
      await oc.advanceGeneration(sid(tag, 1), 'codex', `${tag}-thread-1`)
      await oc.cancelTerminalCandidate(sid(tag, 3))
      await oc.purge(sid(tag, 2))
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})

describe('the transcript costs repository reads and writes only its own workspace', () => {
  it('answers every read with its own rows, and joins its own issues only', async () => {
    const { stores } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const tc = store.transcriptCosts
      const other = otherOf(tag)
      expect((await tc.forIssues([iss(tag, 1), iss(other, 1)])).map((c) => c.nativeId)).toEqual([
        `${tag}-native-1`,
      ])
      expect((await tc.allAttributed()).map((c) => c.nativeId)).toEqual([`${tag}-native-1`])
      onlyOwn(await tc.ownCohortTotals(0), tag)
      expect(await tc.ownCohortTotals(0)).toHaveLength(1)
      expect([...(await tc.costedSessionIds())]).toEqual([sid(tag, 1)])
      expect(await tc.latestWindowSinceMs()).toBe(tag === 'a' ? 100 : 200)
      expect(await tc.countAll()).toBe(1)
    }
  })

  it('records under its own workspace, and a fold naming the other workspace’s issue joins nothing', async () => {
    const { stores } = await twoSeeded()
    const [a] = stores
    const before = await rowsOf(a, 'b')
    await a.transcriptCosts.record(
      [
        {
          machineId: asMachineId('a-machine'),
          nativeId: 'a-native-2',
          path: '/repo-a/t2.jsonl',
          harness: 'codex',
          sessionId: sid('a', 2),
          issueId: iss('b', 1),
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
      expect((await m.getCommand('message-expiry', `${tag}-run-1`))?.runKey).toBe(`${tag}-run-1`)
      expect(await m.getCommand('message-expiry', `${other}-run-1`)).toBeUndefined()
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
      const other = otherOf(tag)
      const lock = await l.getLock(repo(tag), lockName(tag))
      expect(lock?.holderLabel).toBe(tag)
      expect(lock).not.toHaveProperty('workspaceId')
      expect(await l.getLock(repo(other), lockName(other))).toBeNull()
      expect((await l.listLocks(repo(tag))).map((x) => x.name)).toEqual([lockName(tag)])
      expect(await l.listLocks(repo(other))).toEqual([])
      expect((await l.listExpiredLocks(repo(tag), LATER)).map((x) => x.name)).toEqual([
        lockName(tag),
      ])
      expect(await l.listExpiredLocks(repo(other), LATER)).toEqual([])
      expect((await l.listLocksHeldBySession(sid(tag, 1))).map((x) => x.name)).toEqual([
        lockName(tag),
      ])
      expect(await l.listLocksHeldBySession(sid(other, 1))).toEqual([])
      const waiters = await l.listWaiters(repo(tag), lockName(tag))
      expect(waiters.map((x) => x.label)).toEqual([`${tag} waiter`])
      expect(waiters[0]).not.toHaveProperty('workspaceId')
      expect(await l.listWaiters(repo(other), lockName(other))).toEqual([])
      expect((await l.listWaitsBySession(sid(tag, 2))).map((x) => x.label)).toEqual([
        `${tag} waiter`,
      ])
      expect(await l.listWaitsBySession(sid(other, 2))).toEqual([])
    }
  })

  it('leaves the other workspace unchanged by writes aimed at its ids', async () => {
    const { stores, seeded } = await twoSeeded()
    for (const [store, tag] of both(stores)) {
      const l = store.locks
      const other = otherOf(tag)
      const before = await rowsOf(store, other)
      expect(await l.renewLock(repo(other), lockName(other), sid(other, 1), LATER)).toBe(false)
      await l.deleteLock(repo(other), lockName(other))
      await l.removeWaiter(seeded[other].waiters[0]!)
      await l.removeWaiterBySession(repo(other), lockName(other), sid(other, 2))
      // Own writes.
      expect(await l.renewLock(repo(tag), lockName(tag), sid(tag, 1), LATER)).toBe(true)
      await l.removeWaiter(seeded[tag].waiters[0]!)
      await l.deleteLock(repo(tag), lockName(tag))
      expect(await rowsOf(store, other)).toEqual(before)
    }
  })
})
