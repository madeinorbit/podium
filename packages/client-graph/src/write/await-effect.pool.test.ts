/**
 * WAITING FOR AN EFFECT RECORD TO END (POD-6523), through the production pool
 * wiring (`createRuntimeWorklistPool`) over the real feed: the helper reads the
 * pool's own `EffectModel`, waits for a record the pool does not hold yet, and
 * resolves only on a terminal status.
 */

import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { SESSION_CONFIGURE_KIND } from '@podium/client-core/spawn-agent'
import type { EffectStatus } from '@podium/model'
import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { here } from '../lookup'
import { createRuntimeWorklistPool, type WorklistRuntime } from '../runtime-pool'
import { awaitEffect } from './await-effect'

const EFFECT = 'eff_00000000-0000-4000-8000-0000000000ee'
const stamp = '2026-11-06T12:00:00.000Z'

type Row = Readonly<Record<string, unknown>>

function configureRecord(status: EffectStatus, result?: unknown): Row {
  return {
    id: EFFECT,
    kind: SESSION_CONFIGURE_KIND,
    target: { kind: 'session', id: '00000000-0000-4000-8000-0000000000aa' },
    input: { model: 'claude-sonnet-5-5' },
    ...(result !== undefined ? { result } : {}),
    cancelRequested: false,
    effect: { status, attempts: status === 'pending' ? 0 : 1 },
    createdBy: 'u-1',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  }
}

function runtime() {
  const rows = new Map<ReplicaKind, Map<string, Row>>([
    ['sessions', new Map()],
    ['effects', new Map()],
  ])
  const addressed: ((batch: ReplicaAddressedBatch) => void)[] = []
  const rt = {
    principal: { userId: 'u-1' },
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
      pending: () => [],
      awaiting: () => [],
      deadLetters: () => [],
      subscribe: () => () => {},
      enqueue: async () => {},
    },
    subscribeOutboxOutcomes: () => () => {},
    attachPoolWriter: () => () => {},
    spawnNotices: { error: () => {}, info: () => {} },
  }
  const handle = createRuntimeWorklistPool(rt as unknown as WorklistRuntime)
  return {
    pool: handle.pool,
    record(value: Row) {
      rows.get('effects')!.set(EFFECT, value)
      const batch: ReplicaAddressedBatch = {
        type: 'update',
        rows: [{ kind: 'effects', id: EFFECT }],
      }
      for (const listener of [...addressed]) listener(batch)
    },
    dispose: () => handle.dispose(),
  }
}

/** The feed publishes on a microtask; let it. */
const published = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('awaitEffect (POD-6523)', () => {
  it('waits for a record the pool does not hold yet, past pending and running, to its end', async () => {
    const rt = runtime()
    try {
      let settled = false
      const ending = awaitEffect(rt.pool, EFFECT).then((effect) => {
        settled = true
        return effect
      })
      await published()
      expect(settled).toBe(false)
      rt.record(configureRecord('pending'))
      await published()
      expect(settled).toBe(false)
      rt.record(configureRecord('running'))
      await published()
      expect(settled).toBe(false)
      rt.record(configureRecord('succeeded', { ok: true, effective: 'now' }))
      const effect = await ending
      // The pool's own model: the one copy every other reader sees.
      expect(effect).toBe(runInAction(() => here(rt.pool.model('effect', EFFECT))))
      expect(runInAction(() => [effect.status, effect.result])).toEqual([
        'succeeded',
        { ok: true, effective: 'now' },
      ])
    } finally {
      rt.dispose()
    }
  })

  it('resolves at once for a record that has already ended, failures included', async () => {
    const rt = runtime()
    try {
      rt.record(configureRecord('failed', { reason: 'refused' }))
      await published()
      const effect = await awaitEffect(rt.pool, EFFECT)
      expect(runInAction(() => effect.status)).toBe('failed')
    } finally {
      rt.dispose()
    }
  })

  it("stops waiting when the caller's signal aborts", async () => {
    const rt = runtime()
    try {
      const abort = new AbortController()
      const ending = awaitEffect(rt.pool, EFFECT, { signal: abort.signal })
      abort.abort(new Error('left the screen'))
      await expect(ending).rejects.toThrow()
    } finally {
      rt.dispose()
    }
  })
})
