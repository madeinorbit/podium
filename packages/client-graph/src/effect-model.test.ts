/**
 * EFFECT RECORDS IN THE POOL (POD-6397): the replica's `effects` rows arrive
 * through the REAL feed (`createRowSource`), become one shared `EffectModel`
 * each, and a session reaches its Stop through `session.interrupt`.
 */

import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import { createWorklistPool } from './create'
import { requireHere } from './lookup'
import type { EffectModel, SessionModel } from './models'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const stamp = '2026-11-05T12:00:00.000Z'
const later = '2026-11-05T12:00:05.000Z'

const session = {
  sessionId: 'seat',
  cwd: '/synthetic',
  title: 'Working session',
  status: 'live',
  archived: false,
  agentKind: 'claude-code',
  lastActiveAt: stamp,
  createdAt: stamp,
  agentState: { phase: 'working', since: stamp, nativeSubagentCount: 0, turnStartedAt: stamp },
}

const effect = (
  id: string,
  status: string,
  options: {
    kind?: string
    createdAt?: string
    target?: { kind: string; id: string }
    stage?: string
  } = {},
) => ({
  id,
  kind: options.kind ?? 'session.interrupt',
  target: options.target ?? { kind: 'session', id: 'seat' },
  input: { turn: stamp },
  cancelRequested: false,
  effect: { status, attempts: 1, ...(options.stage ? { stage: options.stage } : {}) },
  createdBy: 'operator',
  createdAt: options.createdAt ?? stamp,
  updatedAt: options.createdAt ?? stamp,
  revision: 1,
})

function fixture(effects: readonly Readonly<Record<string, unknown>>[]) {
  const rows = new Map<ReplicaKind, Map<string, Readonly<Record<string, unknown>>>>([
    ['sessions', new Map([['seat', session]])],
    ['effects', new Map(effects.map((row) => [row.id as string, row]))],
  ])
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const discovery: readonly never[] = []
  const feed = createRowSource(
    { principal: { userId: 'operator' }, readLocal: () => discovery, onLocals: () => () => {} },
    {
      rows: vi.fn((kind: ReplicaKind) => [...(rows.get(kind)?.values() ?? [])]),
      row: (kind, id) => rows.get(kind)?.get(id),
      subscribeAddressedBatch(listener) {
        addressed = listener
        return () => {}
      },
    },
    { pending: EMPTY_PENDING },
  )
  const handle = createWorklistPool(
    feed.source,
    fixedLocals({ selectedIssueId: null, coarseNow: Date.parse(stamp) }).source,
  )
  return {
    pool: handle.pool,
    publish(id: string, value: Readonly<Record<string, unknown>> | undefined) {
      if (value) rows.get('effects')!.set(id, value)
      else rows.get('effects')!.delete(id)
      addressed({ type: 'update', rows: [{ kind: 'effects', id }] })
      feed.flush()
    },
    dispose() {
      handle.dispose()
      feed.dispose()
    },
  }
}

it('an effect row is one shared model with its status read leniently', () => {
  const f = fixture([effect('eff_a', 'running', { stage: 'interrupting' })])
  try {
    const model = requireHere(f.pool.model('effect', 'eff_a')) as EffectModel
    expect(model.kind).toBe('session.interrupt')
    expect(model.status).toBe('running')
    expect(model.stage).toBe('interrupting')
    expect(model.inFlight).toBe(true)
    expect(f.pool.model('effect', 'eff_a')).toBe(model)
    f.publish('eff_a', effect('eff_a', 'from-a-newer-server'))
    expect(model.status).toBe('unknown')
  } finally {
    f.dispose()
  }
})

it("session.interrupt is the session's latest Stop and follows its status", () => {
  const f = fixture([
    effect('eff_old', 'succeeded'),
    effect('eff_other_kind', 'running', { kind: 'issue.merge', createdAt: later }),
    effect('eff_elsewhere', 'running', {
      target: { kind: 'session', id: 'other' },
      createdAt: later,
    }),
  ])
  try {
    const seat = requireHere(f.pool.model('session', 'seat')) as SessionModel
    expect(seat.interrupt?.id).toBe('eff_old')
    expect(seat.turnStartedAt).toBe(stamp)

    const seen: (string | undefined)[] = []
    const stop = autorun(() => seen.push(seat.interrupt?.status))
    f.publish('eff_new', effect('eff_new', 'running', { createdAt: later }))
    expect(seat.interrupt?.id).toBe('eff_new')
    f.publish('eff_new', effect('eff_new', 'failed', { createdAt: later }))
    expect(seat.interrupt?.unsuccessful).toBe(true)
    f.publish('eff_new', undefined)
    expect(seat.interrupt?.id).toBe('eff_old')
    stop()
    expect(seen).toEqual(['succeeded', 'running', 'failed', 'succeeded'])
  } finally {
    f.dispose()
  }
})

it('interrupting while the Stop is on its way; stuck only while its turn still runs', () => {
  const f = fixture([effect('eff_stop', 'running', { stage: 'interrupting' })])
  try {
    const seat = requireHere(f.pool.model('session', 'seat')) as SessionModel
    expect(seat.interrupting).toBe(true)
    expect(seat.interruptStuck).toBe(false)
    f.publish('eff_stop', {
      ...effect('eff_stop', 'failed'),
      effect: { status: 'failed', attempts: 1, error: { code: 'deadline', message: 'too slow' } },
    })
    expect(seat.interrupting).toBe(false)
    // The turn it named (the fixture's `stamp`) still runs: offer Kill.
    expect(seat.interruptStuck).toBe(true)
    expect(seat.interrupt?.error?.message).toBe('too slow')
    // A cancel is the person's own choice: nothing to offer.
    f.publish('eff_stop', effect('eff_stop', 'cancelled'))
    expect(seat.interruptStuck).toBe(false)
  } finally {
    f.dispose()
  }
})
