/**
 * A START PAINTS FROM THE POOL'S OWN EFFECT MODEL (POD-6411), through the
 * production wiring (`createRuntimeWorklistPool`) over the real feed
 * (`createRowSource`): the `session.launch` record the paint reads is the
 * pool's `EffectModel`, the one copy on the client, and the paint follows the
 * pool's publication, so neither arrival order leaves a gap.
 *
 * The runtime is a small fake: a replica that dispatches its batches to its
 * subscribers in subscription order (the log first, then the feed, as in the
 * app), and an outbox whose entries the test retires by hand, in the same tick
 * as a replica batch when it needs to.
 */

import type { OutboxEntry } from '@podium/client-core/outbox'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { draftLaunchEffect, SESSION_LAUNCH_KIND } from '@podium/client-core/spawn-agent'
import { asIssueId, asMutationId, asSessionId, type EffectStatus } from '@podium/model'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { here } from '../lookup'
import type { MobxPool } from '../pool'
import { createRuntimeWorklistPool, type WorklistRuntime } from '../runtime-pool'
import { startEffects } from './start-effects'

const USER = 'u-1'
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000aa')
const ISSUE = asIssueId('iss_00000000-0000-4000-8000-0000000000bb')
const EFFECT = 'eff_00000000-0000-4000-8000-0000000000cc'
const STOP = 'eff_00000000-0000-4000-8000-0000000000dd'
const stamp = '2026-11-05T12:00:00.000Z'

type Row = Readonly<Record<string, unknown>>

const create = draftLaunchEffect({
  effectId: EFFECT,
  sessionId: SESSION,
  issueId: ISSUE,
  target: { path: '/r/w', repoPath: '/r' },
  agentKind: 'claude-code',
})

function launchRecord(status: EffectStatus, error?: string): Row {
  return {
    id: EFFECT,
    kind: SESSION_LAUNCH_KIND,
    target: create.target,
    input: create.input,
    cancelRequested: false,
    effect: {
      status,
      attempts: 1,
      ...(error ? { error: { code: 'refused', message: error } } : {}),
    },
    createdBy: USER,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  }
}

const stopRecord = (status: EffectStatus): Row => ({
  ...launchRecord(status),
  id: STOP,
  kind: 'session.interrupt',
  input: { turn: stamp },
})

const sessionRow: Row = {
  sessionId: SESSION,
  cwd: '/r/w',
  title: 'w',
  status: 'live',
  archived: false,
  agentKind: 'claude-code',
  issueId: ISSUE,
  lastActiveAt: stamp,
  createdAt: stamp,
}

function runtime(boot: { effects?: Row[]; queued?: OutboxEntry[] } = {}) {
  const rows = new Map<ReplicaKind, Map<string, Row>>([
    ['sessions', new Map()],
    ['effects', new Map((boot.effects ?? []).map((row) => [row.id as string, row]))],
  ])
  const addressed: ((batch: ReplicaAddressedBatch) => void)[] = []
  let queue: OutboxEntry[] = boot.queued ?? []
  const outboxListeners = new Set<(size: number) => void>()
  const publishOutbox = () => {
    for (const listener of [...outboxListeners]) listener(queue.length)
  }
  const errors: string[] = []
  const rt = {
    principal: { userId: USER },
    readLocal: (key: string) => (key === 'repos' ? [] : null),
    onLocals: () => () => {},
    replica: {
      rows: (kind: ReplicaKind) => [...(rows.get(kind)?.values() ?? [])],
      row: (kind: ReplicaKind, id: string) => rows.get(kind)?.get(id),
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        addressed.push(listener)
        return () => {
          addressed.splice(addressed.indexOf(listener), 1)
        }
      },
    },
    outbox: {
      pending: () => queue,
      awaiting: () => [],
      deadLetters: () => [],
      subscribe(listener: (size: number) => void) {
        outboxListeners.add(listener)
        return () => {
          outboxListeners.delete(listener)
        }
      },
      enqueue: async (
        kind: string,
        input: unknown,
        opts: { mutationId: string; queuedAt: number },
      ) => {
        queue = [...queue, { kind, input, ...opts } as OutboxEntry]
        publishOutbox()
      },
    },
    subscribeOutboxOutcomes: () => () => {},
    attachPoolWriter: () => () => {},
    spawnNotices: { error: (message: string) => errors.push(message), info: () => {} },
  }
  const handle = createRuntimeWorklistPool(rt as unknown as WorklistRuntime)
  return {
    pool: handle.pool,
    errors,
    /** One replica batch: the rows change, then every subscriber hears it, synchronously. */
    batch(changes: { kind: ReplicaKind; id: string; value: Row | undefined }[]) {
      for (const { kind, id, value } of changes) {
        const table = rows.get(kind)!
        if (value === undefined) table.delete(id)
        else table.set(id, value)
      }
      const batch: ReplicaAddressedBatch = {
        type: 'update',
        rows: changes.map(({ kind, id }) => ({ kind, id })),
      }
      for (const listener of [...addressed]) listener(batch)
    },
    /** The server's reply retired every queued entry. */
    retireQueue() {
      queue = []
      publishOutbox()
    },
    dispose: () => handle.dispose(),
  }
}

/** The feed publishes on a microtask; let it. */
const published = () => new Promise((resolve) => setTimeout(resolve, 0))

const session = (pool: MobxPool) =>
  here(pool.model('session', SESSION)) as { storedField(field: string): unknown } | undefined

/** Every state the session showed in, as a person would have seen it. */
function watch(pool: MobxPool): { seen: (string | undefined)[]; stop: () => void } {
  const seen: (string | undefined)[] = []
  const stop = autorun(() => {
    seen.push(session(pool)?.storedField('status') as string | undefined)
  })
  return { seen, stop }
}

describe('a start paints from the pool effect model (POD-6411)', () => {
  it('reads the record as the pool holds it, and only the starts among the effects', async () => {
    const rt = runtime({ effects: [launchRecord('running'), stopRecord('running')] })
    try {
      await published()
      runInAction(() => {
        expect(session(rt.pool)?.storedField('status')).toBe('starting')
        // The one copy: the paint's record is the pool's own effect model.
        const starts = startEffects(rt.pool)
        expect(starts).toEqual([here(rt.pool.model('effect', EFFECT))])
      })
      // A Stop's progress does not re-list the starts.
      const before = runInAction(() => startEffects(rt.pool))
      const listed = watchStarts(rt.pool)
      rt.batch([{ kind: 'effects', id: STOP, value: stopRecord('succeeded') }])
      await published()
      expect(listed.runs()).toBe(1)
      expect(runInAction(() => startEffects(rt.pool))).toBe(before)
      listed.stop()
    } finally {
      rt.dispose()
    }
  })

  it('paints a record that lands after boot once the pool has it', async () => {
    const rt = runtime()
    try {
      await published()
      expect(runInAction(() => session(rt.pool))).toBeUndefined()
      rt.batch([{ kind: 'effects', id: EFFECT, value: launchRecord('pending') }])
      await published()
      expect(runInAction(() => session(rt.pool)?.storedField('status'))).toBe('starting')
      // It fails: the session shows exited with the record's error.
      rt.batch([{ kind: 'effects', id: EFFECT, value: launchRecord('failed', 'no daemon') }])
      await published()
      runInAction(() => {
        expect(session(rt.pool)?.storedField('status')).toBe('exited')
        expect(session(rt.pool)?.storedField('spawnFailure')).toBe('no daemon')
      })
      // Dismissed: the record leaves the feed, and the paint with it.
      rt.batch([{ kind: 'effects', id: EFFECT, value: undefined }])
      await published()
      expect(runInAction(() => session(rt.pool))).toBeUndefined()
    } finally {
      rt.dispose()
    }
  })

  it('hands over to the session row with no gap when both land in one batch', async () => {
    const rt = runtime({ effects: [launchRecord('running')] })
    try {
      await published()
      const shown = watch(rt.pool)
      rt.batch([
        { kind: 'effects', id: EFFECT, value: launchRecord('succeeded') },
        { kind: 'sessions', id: SESSION, value: sessionRow },
      ])
      await published()
      shown.stop()
      expect(shown.seen.at(-1)).toBe('live')
      expect(shown.seen).not.toContain(undefined)
    } finally {
      rt.dispose()
    }
  })

  it('keeps a queued start painted when its entry retires in the tick its record lands', async () => {
    // A start queued before a reload: this pool did not make it, so only the
    // entry, and then the record, say it is on its way.
    const queued = {
      mutationId: asMutationId('m-queued'),
      kind: 'effectCreate',
      input: create,
      queuedAt: Date.parse(stamp),
    } as OutboxEntry
    const rt = runtime({ queued: [queued] })
    try {
      await published()
      expect(runInAction(() => session(rt.pool)?.storedField('status'))).toBe('starting')
      const shown = watch(rt.pool)
      // The record lands, and in the same tick the reply retires the entry,
      // before the feed's publication has brought the record to the pool.
      rt.batch([{ kind: 'effects', id: EFFECT, value: launchRecord('pending') }])
      rt.retireQueue()
      await published()
      shown.stop()
      expect(shown.seen).not.toContain(undefined)
      expect(shown.seen.at(-1)).toBe('starting')
    } finally {
      rt.dispose()
    }
  })
})

/** How often the pool's start list is recomputed while observed. */
function watchStarts(pool: MobxPool): { runs: () => number; stop: () => void } {
  let runs = 0
  const stop = autorun(() => {
    startEffects(pool)
    runs += 1
  })
  return { runs: () => runs, stop }
}
