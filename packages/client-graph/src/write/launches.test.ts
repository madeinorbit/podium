/**
 * A START PAINTED FROM ITS LAUNCH EFFECT (POD-6408, POD-6410), through the real
 * transaction log: the queued `effects.create` entry paints it, then the
 * replica's `session.launch` or `issue.start` record, until the rows under the
 * device-minted ids land, with no gap in either arrival order and no timer.
 */

import type { OverlayTarget } from '@podium/client-core/command-reducers'
import { foldRowOverlays } from '@podium/client-core/command-reducers'
import type { OutboxOutcome } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import {
  ISSUE_ADD_SESSION_KIND,
  ISSUE_BEGIN_KIND,
  ISSUE_START_KIND,
  SESSION_LAUNCH_KIND,
} from '@podium/client-core/spawn-agent'
import {
  asIssueId,
  asMutationId,
  asSessionId,
  asUserId,
  type EffectRecordWire,
  type EffectStatus,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createPoolTransactions } from './transactions'

const USER = asUserId('u-1')
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000aa')
const ISSUE = asIssueId('iss_00000000-0000-4000-8000-0000000000bb')
const EFFECT = 'eff_00000000-0000-4000-8000-0000000000cc'
const TARGET = { path: '/r/w', repoPath: '/r' }

function startRecord(status: EffectStatus, error?: string): EffectRecordWire {
  return {
    ...launchRecord(status, error),
    kind: ISSUE_START_KIND,
    target: { kind: 'issue', id: ISSUE },
    input: {
      sessionId: SESSION,
      repoPath: '/r',
      title: 'Fix the login',
      defaultAgent: 'claude-code',
    },
  } as EffectRecordWire
}

/** The family filed it as a proposal (a member's top-level task). */
function proposedRecord(status: EffectStatus): EffectRecordWire {
  const record = startRecord(status)
  return status === 'failed'
    ? ({
        ...record,
        effect: {
          status,
          attempts: 1,
          error: { code: 'proposed', message: 'Filed as a proposal; an admin starts it.' },
        },
      } as EffectRecordWire)
    : record
}

function launchRecord(status: EffectStatus, error?: string): EffectRecordWire {
  return {
    id: EFFECT as EffectRecordWire['id'],
    kind: SESSION_LAUNCH_KIND,
    target: { kind: 'session', id: SESSION },
    input: {
      agentKind: 'claude-code',
      cwd: '/r/w',
      draftIssue: { repoPath: '/r', issueId: ISSUE },
    },
    cancelRequested: false,
    effect: {
      status,
      attempts: 0,
      ...(error ? { error: { code: 'refused', message: error } } : {}),
    },
    createdBy: USER,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    revision: 1,
  } as EffectRecordWire
}

function pool(
  boot: {
    awaiting?: OutboxEntry[]
    effects?: EffectRecordWire[]
    record?: typeof launchRecord
  } = {},
) {
  const record = boot.record ?? launchRecord
  const truth = new Map<string, Record<string, unknown>>()
  let queue: OutboxEntry[] = []
  let awaiting: OutboxEntry[] = boot.awaiting ?? []
  let effects: EffectRecordWire[] = boot.effects ?? []
  let dead: OutboxEntry[] = []
  let publish: (size: number) => void = () => {}
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const errors: string[] = []
  const infos: string[] = []
  let serial = 0
  const tx = createPoolTransactions({
    userId: USER,
    outbox: {
      pending: () => queue,
      awaiting: () => awaiting,
      deadLetters: () => dead.map((entry) => ({ entry, reason: { code: 'invalid' } }) as never),
      subscribe: (listener) => {
        publish = listener
        return () => {}
      },
    },
    outcomes: (_listener: (o: OutboxOutcome) => void) => () => {},
    addressed: (listener) => {
      addressed = listener
      return () => {}
    },
    mintId: () => asMutationId(`m-${++serial}`),
    enqueue: async (kind, input, opts) => {
      queue = [...queue, { kind, input, ...opts }]
      publish(queue.length)
    },
    launchEffects: () => effects,
    spawn: {
      userId: USER,
      notices: {
        error: (message: string) => errors.push(message),
        info: (message: string) => infos.push(message),
      } as never,
      sortKey: () => 'k',
    },
  })
  tx.bind({ truth: (e: OverlayTarget, id: string) => truth.get(`${e}:${id}`), repaint: () => null })
  const changed = () => addressed({ type: 'update', rows: [{ kind: 'effects', id: EFFECT }] })
  return {
    tx,
    errors,
    infos,
    queue: () => queue,
    shown: (entity: OverlayTarget, id: string) =>
      foldRowOverlays(truth.get(`${entity}:${id}`), tx.pending.byRow(entity).get(id) ?? []),
    painted: (entity: OverlayTarget, id: string) => tx.pending.byRow(entity).get(id)?.length ?? 0,
    /** The server took the create: its receipt is covered, the record is in the replica. */
    confirmed(status: EffectStatus, error?: string) {
      awaiting = []
      queue = []
      effects = [record(status, error)]
      publish(0)
      changed()
    },
    effect(status: EffectStatus, error?: string) {
      effects = [record(status, error)]
      changed()
    },
    /** The entry left the queue with no record yet (retired, or refused). */
    entryGone(refused = false) {
      if (refused) dead = [...queue]
      queue = []
      awaiting = []
      publish(0)
    },
    dismissed() {
      effects = []
      changed()
    },
    row(entity: OverlayTarget, id: string, value: Record<string, unknown>) {
      truth.set(`${entity}:${id}`, value)
      addressed({
        type: 'update',
        rows: [{ kind: entity === 'sessions' ? 'sessions' : 'issueProjections', id } as never],
      })
    },
  }
}

const start = (p: ReturnType<typeof pool>) =>
  p.tx.spawnDraftAgent({
    sessionId: SESSION,
    issueId: ISSUE,
    mutationId: asMutationId('m-spawn'),
    target: TARGET,
    agentKind: 'claude-code',
    firstPrompt: 'hello',
  })

describe('a draft-agent start as a launch effect (POD-6408)', () => {
  it('paints the starting session and its draft task at once and queues effects.create', async () => {
    const p = pool()
    start(p)
    await Promise.resolve()
    expect(p.shown('sessions', SESSION)).toMatchObject({ sessionId: SESSION, status: 'starting' })
    expect(p.painted('issueProjections', ISSUE)).toBeGreaterThan(0)
    const [entry] = p.queue()
    expect(entry?.kind).toBe('effectCreate')
    expect(entry?.input).toMatchObject({
      kind: SESSION_LAUNCH_KIND,
      target: { kind: 'session', id: SESSION },
      input: { agentKind: 'claude-code', cwd: '/r/w', initialPrompt: 'hello' },
    })
    p.tx.dispose()
  })

  it('keeps painting from the record after the create is confirmed, however long it waits', async () => {
    const p = pool()
    start(p)
    await Promise.resolve()
    p.confirmed('pending')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.effect('running')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.tx.dispose()
  })

  it('paints again after a reload, from the queued create or from the record alone', () => {
    const queued = pool({
      awaiting: [
        {
          mutationId: asMutationId('m-boot'),
          kind: 'effectCreate',
          input: {
            id: EFFECT,
            kind: SESSION_LAUNCH_KIND,
            target: { kind: 'session', id: SESSION },
            input: {
              agentKind: 'claude-code',
              cwd: '/r/w',
              draftIssue: { repoPath: '/r', issueId: ISSUE },
            },
          },
          queuedAt: 0,
          state: 'awaiting-truth',
        } as OutboxEntry,
      ],
    })
    expect(queued.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    queued.tx.dispose()
    const recorded = pool({ effects: [launchRecord('pending')] })
    expect(recorded.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    expect(recorded.painted('issueProjections', ISSUE)).toBeGreaterThan(0)
    recorded.tx.dispose()
  })

  it('hands over to the real row with no gap when the launch succeeds first', async () => {
    const p = pool()
    start(p)
    await Promise.resolve()
    p.confirmed('succeeded')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'live' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'live' })
    p.tx.dispose()
  })

  it('hands over to the real row with no gap when the row lands first', async () => {
    const p = pool()
    const { settled } = start(p)
    await Promise.resolve()
    p.confirmed('running')
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'starting' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    p.effect('succeeded')
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    expect(await settled).toBe(true)
    p.tx.dispose()
  })

  it('a failed launch shows its error on the session once; Dismiss takes it off the feed', async () => {
    const p = pool()
    const { settled } = start(p)
    await Promise.resolve()
    p.confirmed('failed', 'no harness on that machine')
    expect(p.shown('sessions', SESSION)).toMatchObject({
      status: 'exited',
      spawnFailure: 'no harness on that machine',
    })
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    // It was queued, so the composer let go; the failure is the session's now.
    expect(await settled).toBe(true)
    await p.tx.waitForSpawnConfirmed(SESSION)
    p.effect('failed', 'no harness on that machine')
    expect(p.errors).toEqual(["Couldn't start the agent — no harness on that machine"])

    expect(p.tx.dismissLaunch(SESSION)).toBe(true)
    await Promise.resolve()
    expect(p.queue().at(-1)).toMatchObject({ kind: 'effectDismiss', input: { id: EFFECT } })
    expect(p.painted('sessions', SESSION)).toBe(0)
    p.dismissed()
    expect(p.painted('sessions', SESSION)).toBe(0)
    p.tx.dispose()
  })

  it('an expired launch reads as failed; a live session is never dismissed', () => {
    const p = pool({
      effects: [launchRecord('expired', 'It waited past its deadline and never ran.')],
    })
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'exited' })
    expect(p.tx.dismissLaunch(asSessionId('00000000-0000-4000-8000-0000000000dd'))).toBe(false)
    p.tx.dispose()
  })

  it('an own start whose entry retired before its record arrived keeps painting', async () => {
    const p = pool()
    start(p)
    await Promise.resolve()
    await Promise.resolve()
    p.entryGone()
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.effect('pending')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'live' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    await p.tx.waitForSpawnConfirmed(SESSION)
    p.tx.dispose()
  })

  it('a refused create takes its paint away', async () => {
    const p = pool()
    const { settled } = start(p)
    await Promise.resolve()
    await Promise.resolve()
    expect(await settled).toBe(true)
    p.entryGone(true)
    expect(p.painted('sessions', SESSION)).toBe(0)
    p.tx.dispose()
  })
})

const startTask = (p: ReturnType<typeof pool>, mutationId = asMutationId('m-task')) =>
  p.tx.spawnIssueAgent({
    sessionId: SESSION,
    issueId: ISSUE,
    mutationId,
    target: TARGET,
    title: 'Fix the login',
    description: 'the private plan',
    agentKind: 'claude-code',
  })

describe('a named task with its first agent as an issue.start effect (POD-6410)', () => {
  it('paints the task and its starting session at once and queues effects.create', async () => {
    const p = pool({ record: startRecord })
    const { outcome } = startTask(p)
    await Promise.resolve()
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting', issueId: ISSUE })
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({
      id: ISSUE,
      title: 'Fix the login',
      stage: 'in_progress',
    })
    const [entry] = p.queue()
    expect(entry?.kind).toBe('effectCreate')
    expect(entry?.input).toMatchObject({
      kind: ISSUE_START_KIND,
      target: { kind: 'issue', id: ISSUE },
      input: { sessionId: SESSION, repoPath: '/r', title: 'Fix the login' },
    })
    // Durably queued is started: the record carries it from here.
    expect(await outcome).toBe('started')
    p.tx.dispose()
  })

  it('carries priority and the chosen stage, and paints the task there (POD-6421)', async () => {
    const p = pool({ record: startRecord })
    p.tx.spawnIssueAgent({
      sessionId: SESSION,
      issueId: ISSUE,
      mutationId: asMutationId('m-task'),
      target: TARGET,
      title: 'Fix the login',
      description: 'the private plan',
      agentKind: 'codex',
      inheritAgent: true,
      priority: 1,
      stage: 'planning',
    })
    await Promise.resolve()
    const [entry] = p.queue()
    expect(entry?.input).toMatchObject({
      kind: ISSUE_START_KIND,
      input: { title: 'Fix the login', priority: 1, stage: 'planning' },
    })
    // Left on the configured agent: the record names none, so the server
    // resolves it when it runs; this device still paints the one it showed.
    expect((entry?.input as { input: object }).input).not.toHaveProperty('defaultAgent')
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ priority: 1, stage: 'planning' })
    expect(p.shown('sessions', SESSION)).toMatchObject({ agentKind: 'codex', status: 'starting' })
    p.tx.dispose()
  })

  it('a retry of the same reservation writes the same record', async () => {
    const p = pool({ record: startRecord })
    const id = '00000000-0000-4000-8000-0000000000ee'
    startTask(p, asMutationId(id))
    await Promise.resolve()
    expect(p.queue()[0]?.input).toMatchObject({ id: `eff_${id}` })
    p.tx.dispose()
  })

  it('paints again after a reload from the record alone, without the description', () => {
    const p = pool({ effects: [startRecord('pending')], record: startRecord })
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ title: 'Fix the login' })
    p.tx.dispose()
  })

  it('hands over with no gap when the task row lands, then the session row', async () => {
    const p = pool({ record: startRecord })
    const { proposed } = startTask(p)
    await Promise.resolve()
    p.confirmed('running')
    p.row('issueProjections', ISSUE, { id: ISSUE, title: 'Fix the login' })
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.effect('succeeded')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'live' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'live' })
    expect(await proposed).toBe(false)
    p.tx.dispose()
  })

  it('hands over with no gap when the start succeeds before either row lands', async () => {
    const p = pool({ record: startRecord })
    startTask(p)
    await Promise.resolve()
    p.confirmed('succeeded')
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ title: 'Fix the login' })
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'live' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    // The task's placeholder retires only with its own row.
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ title: 'Fix the login' })
    p.row('issueProjections', ISSUE, { id: ISSUE, title: 'Fix the login' })
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    p.tx.dispose()
  })

  it('filed, then its agent failed: the task stays, and its session shows the failure', async () => {
    const p = pool({ record: startRecord })
    startTask(p)
    await Promise.resolve()
    p.confirmed('running')
    p.row('issueProjections', ISSUE, { id: ISSUE, title: 'Fix the login' })
    p.effect('failed', 'no harness on that machine')
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ id: ISSUE })
    expect(p.shown('sessions', SESSION)).toMatchObject({
      status: 'exited',
      issueId: ISSUE,
      spawnFailure: 'no harness on that machine',
    })
    expect(p.errors).toEqual([
      "The task was saved, but its agent couldn't start — no harness on that machine",
    ])
    p.tx.dispose()
  })

  it('refused before filing: no task painted, and the failure is said once', async () => {
    const p = pool({ record: startRecord })
    startTask(p)
    await Promise.resolve()
    p.confirmed('failed', 'no longer allowed to use this machine')
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'exited' })
    p.effect('failed', 'no longer allowed to use this machine')
    expect(p.errors).toEqual(["Couldn't start the task — no longer allowed to use this machine"])
    expect(p.tx.dismissLaunch(SESSION)).toBe(true)
    p.tx.dispose()
  })

  it('filed as a proposal: the task shows as proposed, no session, and a plain notice', async () => {
    const p = pool({ record: proposedRecord })
    const { outcome, proposed } = startTask(p)
    await Promise.resolve()
    expect(await outcome).toBe('started')
    p.confirmed('failed')
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.tx.spawnPrompts.has(SESSION)).toBe(false)
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ id: ISSUE, stage: 'proposed' })
    expect(p.errors).toEqual([])
    expect(p.infos).toEqual(['Filed as a proposal; an admin starts it.'])
    expect(await proposed).toBe(true)
    p.row('issueProjections', ISSUE, { id: ISSUE, stage: 'proposed' })
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    p.effect('failed')
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.infos).toHaveLength(1)
    await p.tx.waitForSpawnConfirmed(SESSION)
    p.tx.dispose()
  })

  it('a proposal read back after a reload paints no session and says nothing', () => {
    const p = pool({ effects: [proposedRecord('failed')], record: proposedRecord })
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.shown('issueProjections', ISSUE)).toMatchObject({ stage: 'proposed' })
    expect(p.errors).toEqual([])
    expect(p.infos).toEqual([])
    p.tx.dispose()
  })
})

/** A plain start's record: in a folder, joining an existing task (POD-6523). */
function plainRecord(status: EffectStatus, error?: string): EffectRecordWire {
  const record = launchRecord(status, error)
  return {
    ...record,
    input: { agentKind: 'opencode', cwd: '/r/w', issueId: ISSUE },
  } as EffectRecordWire
}

describe('a plain session start as a launch effect (POD-6523)', () => {
  it('paints the starting session in its task, paints no task, and queues the launch', async () => {
    const p = pool({ record: plainRecord })
    const started = p.tx.launchSession({
      sessionId: SESSION,
      target: { ...TARGET, machineId: 'm-1' as never },
      agentKind: 'opencode',
      issueId: ISSUE,
      requestedDriverId: 'opencode-server',
    })
    expect(started.sessionId).toBe(SESSION)
    await Promise.resolve()
    expect(p.shown('sessions', SESSION)).toMatchObject({
      sessionId: SESSION,
      status: 'starting',
      issueId: ISSUE,
      cwd: '/r/w',
      machineId: 'm-1',
    })
    // The task is already a row: the start joins it, it never paints one.
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    const [entry] = p.queue()
    expect(entry?.kind).toBe('effectCreate')
    expect(entry?.input).toMatchObject({
      kind: SESSION_LAUNCH_KIND,
      target: { kind: 'session', id: SESSION },
      input: {
        agentKind: 'opencode',
        cwd: '/r/w',
        machineId: 'm-1',
        issueId: ISSUE,
        requestedDriverId: 'opencode-server',
      },
    })
    expect((entry?.input as { input: object }).input).not.toHaveProperty('draftIssue')
    await expect(started.settled).resolves.toBe(true)
    p.tx.dispose()
  })

  it('keeps painting from its record, and shows a failed launch as exited with its error', async () => {
    const p = pool({ record: plainRecord })
    p.tx.launchSession({
      sessionId: SESSION,
      target: TARGET,
      agentKind: 'opencode',
      issueId: ISSUE,
    })
    await Promise.resolve()
    p.confirmed('pending')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting', issueId: ISSUE })
    p.effect('failed', 'machine refused')
    expect(p.shown('sessions', SESSION)).toMatchObject({
      status: 'exited',
      spawnFailure: 'machine refused',
    })
    expect(p.errors).toEqual(["Couldn't start the agent — machine refused"])
    p.tx.dispose()
  })
})

/**
 * A SESSION STARTED ON AN EXISTING ISSUE (POD-6526): `issue.begin` (its first
 * session, with its worktree) or `issue.addSession` (one more agent, a shell).
 * The issue is a row already: only the session is painted, in its checkout.
 */
describe('a session on an existing issue as its effect record (POD-6526)', () => {
  const ISSUE_ROW = {
    id: ISSUE,
    repoPath: '/r',
    worktreePath: '/r/.worktrees/fix',
    branch: 'issue/fix',
    machineId: 'm-1',
    defaultAgent: 'codex',
  }

  /** The record of an own start, answering `answer` when it succeeds. */
  const onIssue =
    (kind: string, input: Record<string, unknown>, answer: unknown) =>
    (status: EffectStatus, error?: string): EffectRecordWire =>
      ({
        ...launchRecord(status, error),
        kind,
        target: { kind: 'issue', id: ISSUE },
        input: { sessionId: SESSION, ...input },
        ...(status === 'succeeded' ? { result: answer } : {}),
      }) as EffectRecordWire

  it('adds an agent to a started issue: paints the session in its checkout, queues issue.addSession', async () => {
    const p = pool({ record: onIssue(ISSUE_ADD_SESSION_KIND, {}, { id: ISSUE }) })
    p.row('issueProjections', ISSUE, ISSUE_ROW)
    const started = p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION })
    expect(started.mode).toBe('agent')
    await Promise.resolve()
    expect(p.shown('sessions', SESSION)).toMatchObject({
      status: 'starting',
      issueId: ISSUE,
      cwd: '/r/.worktrees/fix',
      machineId: 'm-1',
      agentKind: 'codex',
    })
    // The issue is a row: nothing of it is painted.
    expect(p.painted('issueProjections', ISSUE)).toBe(0)
    const [entry] = p.queue()
    expect(entry?.kind).toBe('effectCreate')
    expect(entry?.input).toMatchObject({
      kind: ISSUE_ADD_SESSION_KIND,
      target: { kind: 'issue', id: ISSUE },
      input: { sessionId: SESSION },
    })
    await expect(started.settled).resolves.toBe(true)
    // Its record keeps the paint while the machine is away, then the row lands.
    p.confirmed('pending')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.confirmed('succeeded')
    p.row('sessions', SESSION, { sessionId: SESSION, status: 'live' })
    expect(p.painted('sessions', SESSION)).toBe(0)
    p.tx.dispose()
  })

  it('begins an issue that was never started (no branch) without being told to', async () => {
    const p = pool({ record: onIssue(ISSUE_BEGIN_KIND, {}, { agentId: SESSION }) })
    p.row('issueProjections', ISSUE, { id: ISSUE, repoPath: '/r', branch: null, worktreePath: null })
    const started = p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION, agentKind: 'grok' })
    expect(started.mode).toBe('begin')
    await Promise.resolve()
    expect(p.queue()[0]?.input).toMatchObject({
      kind: ISSUE_BEGIN_KIND,
      input: { sessionId: SESSION, agentKind: 'grok' },
    })
    // Until a begin cuts the worktree, the session paints in the repo.
    expect(p.shown('sessions', SESSION)).toMatchObject({ cwd: '/r', agentKind: 'grok' })
    p.tx.dispose()
  })

  it('a freed checkout keeps its branch, so adding rebuilds it there rather than beginning', () => {
    const p = pool()
    p.row('issueProjections', ISSUE, { ...ISSUE_ROW, worktreePath: null })
    expect(p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION }).mode).toBe('agent')
    p.tx.dispose()
  })

  it('a retried begin under the same mutation id writes the same record', async () => {
    const p = pool()
    p.row('issueProjections', ISSUE, ISSUE_ROW)
    const mutationId = asMutationId('00000000-0000-4000-8000-0000000000dd')
    const first = p.tx.startIssueSession({ issueId: ISSUE, mode: 'begin', mutationId })
    expect(first.effectId).toBe(`eff_${mutationId}`)
    p.tx.dispose()
  })

  it("drops the paint when a begin finds the issue already started (the server's no-op)", async () => {
    const p = pool({ record: onIssue(ISSUE_BEGIN_KIND, {}, { id: ISSUE, seq: 7 }) })
    p.row('issueProjections', ISSUE, ISSUE_ROW)
    p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION, mode: 'begin' })
    await Promise.resolve()
    p.confirmed('running')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    // Succeeded, naming no session of ours: no row will ever come under this id.
    p.confirmed('succeeded')
    expect(p.painted('sessions', SESSION)).toBe(0)
    expect(p.shown('sessions', SESSION)).toBeUndefined()
    expect(p.errors).toEqual([])
    p.tx.dispose()
  })

  it('keeps the paint for a succeeded begin that names our session until its row lands', async () => {
    const p = pool({ record: onIssue(ISSUE_BEGIN_KIND, {}, { id: ISSUE, agentId: SESSION }) })
    p.row('issueProjections', ISSUE, ISSUE_ROW)
    p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION, mode: 'begin' })
    await Promise.resolve()
    p.confirmed('succeeded')
    expect(p.shown('sessions', SESSION)).toMatchObject({ status: 'starting' })
    p.tx.dispose()
  })

  it('opens a shell as issue.addSession with shell: true, and names a failed one a shell', async () => {
    const p = pool({ record: onIssue(ISSUE_ADD_SESSION_KIND, { shell: true }, { id: ISSUE }) })
    p.row('issueProjections', ISSUE, ISSUE_ROW)
    p.tx.startIssueSession({ issueId: ISSUE, sessionId: SESSION, mode: 'shell' })
    await Promise.resolve()
    expect(p.queue()[0]?.input).toMatchObject({
      kind: ISSUE_ADD_SESSION_KIND,
      input: { sessionId: SESSION, shell: true },
    })
    expect(p.shown('sessions', SESSION)).toMatchObject({ agentKind: 'shell' })
    p.confirmed('failed', 'issue not started')
    expect(p.shown('sessions', SESSION)).toMatchObject({
      status: 'exited',
      spawnFailure: 'issue not started',
    })
    expect(p.errors).toEqual(["Couldn't open the shell — issue not started"])
    p.tx.dispose()
  })
})
