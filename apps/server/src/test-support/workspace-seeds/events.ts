/**
 * THE SAME-ID SEED OF EVENTS, EFFECTS, WORKFLOWS, AUTOMATIONS AND LOCKS, shared by its two-
 * workspace test (`store/events.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
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
import type { AutomationRow, AutomationRunRow } from '../../store/automations'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import type { SessionRow, Subscription, TerminalCandidateFacts } from '../../store/types'
import type { WorkflowActor, WorkflowRunRow } from '../../store/workflows'
import type { WorkspaceEventSlice } from '../event-store-slice'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
export const AT = '2026-11-17T10:00:00.000Z'
export const EARLIER = '2026-11-01T00:00:00.000Z'
export const LATER = '2099-01-01T00:00:00.000Z'
export const NOW_MS = Date.parse('2026-11-17T10:00:00.000Z')
export const scope = fixtureWriteScope()
export const OPERATOR: WorkflowActor = { kind: 'operator', id: null }

export const otherOf = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
// The same ids and natural keys in both workspaces.
export const ALICE: UserId = asUserId('user:alice')
export const sid = (n: number): SessionId => asSessionId(`s${n}`)
export const iss = (n: number) => asIssueId(`iss-${n}`)
export const REPO = asRepoId('repo-1')
export const MACHINE = asMachineId('machine-1')
export const eff = (n: number, prefix = '') => `${prefix}eff-${n}`
export const WF = 'wf-1'
export const REV = 'rev-1'
export const RUN = 'run-1'
export const auto = (n: number) => `auto-${n}` as AutomationId
export const autoRun = (n: number) => `arun-${n}` as AutomationRunId
export const ixn = (n: number, prefix = '') => `${prefix}ixn-${n}`
export const THREAD = asThreadId('thread-1')
export const sub = (n: number) => `sub-${n}`
export const LOCK = 'lock-1'
export const STEWARD_KEY = 'key-1'
export const PROJECTOR = 'projector-1'
export const runKey = (n: number) => `mrun-${n}`
/** The workflows' and automations' owner: the same people, a different owner per workspace. */
export const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : asUserId('user:bob'))
/** The turn epoch of s1's failure: A's fails in turn 1, B's in turn 2. */
export const failureEpoch = (tag: Tag) => (tag === 'a' ? 1 : 2)
// An id only `tag`'s workspace holds.
export const only = (tag: Tag): SessionId => asSessionId(`only-${tag}`)
/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
export const TABLES = [
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
export async function rowsOf(
  store: WorkspaceEventSlice,
  tag: Tag,
): Promise<Record<string, unknown[]>> {
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

export function session(tag: Tag, n: number, id: SessionId = sid(n)): SessionRow {
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
export async function insertIssue(
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
export async function insertMember(
  store: WorkspaceEventSlice,
  tag: Tag,
  id: UserId = ALICE,
): Promise<void> {
  await store.run(
    sql`INSERT INTO users (workspace_id, id, display_name, role, created_at)
       VALUES (${WS[tag]}, ${id}, ${`${tag} alice`}, 'member', ${AT})`,
  )
}

export const runtimeState = (tag: Tag, seq: number): RuntimeEvent =>
  ({
    t: 'state',
    change: { kind: 'activity' },
    at: AT,
    provenance: 'live',
    cursor: { segmentId: `${tag}-segment`, components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }) as RuntimeEvent

export const runtimeItem = (tag: Tag, seq: number): RuntimeEvent =>
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

export const runtimeFailure = (tag: Tag, seq: number): RuntimeEvent =>
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

export function subscription(tag: Tag, n: number, patch: Partial<Subscription> = {}): Subscription {
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

export function automation(tag: Tag, n: number): AutomationRow {
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

export function automationRun(tag: Tag, n: number, sessionId: SessionId | null): AutomationRunRow {
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

export function workflowRun(tag: Tag): WorkflowRunRow {
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

export function checkpoint(
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

export function terminalFacts(tag: Tag, sessionId: SessionId): TerminalCandidateFacts {
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
export const applied = (tag: Tag, n: number): MaintenanceCommandReply => ({
  status: 'applied',
  jobKind: 'message-expiry',
  runKey: runKey(n),
  deleted: tag === 'a' ? n : 10 + n,
})

export interface Seeded {
  /** The ids of this workspace's appended events, in order. */
  readonly events: number[]
  /** This workspace's lock waiter ids. */
  readonly waiters: number[]
}

/**
 * The effects of one workspace (`prefix` names a set only it holds): 1 an imported copy not
 * yet published, 2 gated, 3 past its deadline, 4 running, 5 succeeded, 6 failed and tombstoned.
 */
export async function seedEffects(
  store: WorkspaceEventSlice,
  tag: Tag,
  prefix = '',
): Promise<void> {
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
export async function seedInteractions(
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
export async function seed(store: WorkspaceEventSlice, tag: Tag): Promise<Seeded> {
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
