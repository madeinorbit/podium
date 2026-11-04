/**
 * A DRAFT-AGENT START PAINTED FROM ITS LAUNCH EFFECT (POD-6408), through the
 * real transaction log: the queued `effects.create` entry paints it, then the
 * replica's `session.launch` record, until the session row under the
 * device-minted id lands, with no gap in either arrival order and no timer.
 */

import type { OverlayTarget } from '@podium/client-core/command-reducers'
import { foldRowOverlays } from '@podium/client-core/command-reducers'
import type { OutboxOutcome } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { SESSION_LAUNCH_KIND } from '@podium/client-core/spawn-agent'
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

function pool(boot: { awaiting?: OutboxEntry[]; effects?: EffectRecordWire[] } = {}) {
  const truth = new Map<string, Record<string, unknown>>()
  let queue: OutboxEntry[] = []
  let awaiting: OutboxEntry[] = boot.awaiting ?? []
  let effects: EffectRecordWire[] = boot.effects ?? []
  let dead: OutboxEntry[] = []
  let publish: (size: number) => void = () => {}
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const errors: string[] = []
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
      api: {} as never,
      userId: USER,
      notices: { error: (message: string) => errors.push(message), info: () => {} } as never,
      sortKey: () => 'k',
    },
  })
  tx.bind({ truth: (e: OverlayTarget, id: string) => truth.get(`${e}:${id}`), repaint: () => null })
  const changed = () => addressed({ type: 'update', rows: [{ kind: 'effects', id: EFFECT }] })
  return {
    tx,
    errors,
    queue: () => queue,
    shown: (entity: OverlayTarget, id: string) =>
      foldRowOverlays(truth.get(`${entity}:${id}`), tx.pending.byRow(entity).get(id) ?? []),
    painted: (entity: OverlayTarget, id: string) => tx.pending.byRow(entity).get(id)?.length ?? 0,
    /** The server took the create: its receipt is covered, the record is in the replica. */
    confirmed(status: EffectStatus, error?: string) {
      awaiting = []
      queue = []
      effects = [launchRecord(status, error)]
      publish(0)
      changed()
    },
    effect(status: EffectStatus, error?: string) {
      effects = [launchRecord(status, error)]
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
