/**
 * THE AUTHORITY — unit-tested INDEPENDENT OF apps/server, which is the
 * acceptance criterion. Nothing here imports a server module, a database, or a
 * transport; the store is an in-memory double and `transact` is a real span with
 * observable rollback, so the atomicity claims are measured rather than asserted.
 */

import { describe, expect, it, vi } from 'vitest'
import { OWNERSHIP_MATRIX, type MatrixRow } from '@podium/model'
import { Authority } from './authority'
import type { ScopedChange, StagedChangeSpec } from './change-lifecycle'
import {
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
  DEVICE_GRADE_PRINCIPAL,
} from '../feed/visibility'
import type { ChangeLogStore } from '../change-log'

const rowWith = (rule: string): string => {
  const row = (OWNERSHIP_MATRIX as readonly MatrixRow[]).find((r) => r.conflict === rule)
  if (!row) throw new Error(`no shipped matrix row declares '${rule}'`)
  return row.id
}

/**
 * An in-memory change log with a REAL transaction: `transact` snapshots the row
 * array and restores it on a throw.
 *
 * That matters more than it looks. With a pass-through `(fn) => fn()` every
 * rollback assertion in this file would be vacuous — the append would simply have
 * happened, and "the change log is untouched" would be measuring an append that
 * was never reached rather than one that was undone.
 */
function memoryStore() {
  let rows: { seq: number; entity: string; entityId: string; op: string; payload: string | null }[] =
    []
  let nextSeq = 1
  const store: ChangeLogStore & { rows: typeof rows } = {
    get rows() {
      return rows
    },
    appendChanges(batch, _eventTime) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  }
  const transact = <T>(fn: () => T): T => {
    const snapshot = rows.slice()
    const savedSeq = nextSeq
    try {
      return fn()
    } catch (err) {
      rows = snapshot
      nextSeq = savedSeq
      throw err
    }
  }
  return { store, transact, get rows() {
    return rows
  } }
}

const upsert = (id: string, value: unknown): StagedChangeSpec => ({
  entity: 'session',
  entityId: id,
  op: 'upsert',
  value,
})

function build(now: () => number = () => 1000) {
  const mem = memoryStore()
  return {
    mem,
    authority: new Authority({
      store: mem.store,
      now,
      transact: mem.transact,
      // These cases are about the FUNNEL — order, arbitration, the ordered pipe.
      // They stand for the one-principal deployment, so they name the policy that
      // matches it rather than inventing a permissive fake: a fake here would be a
      // second definition of "everyone", and the audited one is this.
      visibility: new DeviceGradeUnscopedPolicy(),
      anchors: new DeviceGradeNoAnchors(),
    }),
  }
}

/**
 * Subscribe as the single principal these cases stand for, unwrapping the
 * delivery to the rows.
 *
 * The unwrap is deliberate and narrow: `subscribe` now hands over a
 * `ScopedDelivery` (rows plus the range they were evaluated over — see
 * `scoping.ts`), and the cases below are about ORDER and ARBITRATION, which the
 * rows alone express. The scoping properties have their own file
 * (`authority.scoped.test.ts`), so neither suite is asserting the other's job.
 */
function subscribe(
  authority: Authority,
  fn: (changes: readonly ScopedChange[]) => void,
): () => void {
  return authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
    if (delivery.kind === 'batch') fn(delivery.changes)
  })
}

// ---------------------------------------------------------------------------
// THE FUNNEL ORDER — the property the join exists to make structural
// ---------------------------------------------------------------------------

describe('authorize → arbitrate → write → append → broadcast', () => {
  it('runs the steps in that order', () => {
    const { mem, authority } = build()
    const trace: string[] = []
    subscribe(authority, () => trace.push('broadcast'))
    authority.commit({
      authorize: () => trace.push('authorize'),
      arbitrate: { rowId: rowWith('exp-rev'), attempt: {} },
      write: () => {
        trace.push('write')
        return 'ok'
      },
      changes: () => {
        trace.push('changes')
        return [upsert('s1', { a: 1 })]
      },
    })
    expect(trace).toEqual(['authorize', 'write', 'changes', 'broadcast'])
    expect(mem.rows).toHaveLength(1)
  })

  it('a throwing authorize writes NOTHING and appends NOTHING', () => {
    // "A forbidden op must never write" as control flow rather than as every
    // caller remembering. The write is unreachable past the throw.
    const { mem, authority } = build()
    const write = vi.fn()
    expect(() =>
      authority.commit({
        authorize: () => {
          throw new Error('denied')
        },
        write,
        changes: () => [upsert('s1', { a: 1 })],
      }),
    ).toThrow('denied')
    expect(write).not.toHaveBeenCalled()
    expect(mem.rows).toEqual([])
  })

  it('a REJECTED arbitration writes nothing and appends nothing', () => {
    // A rejection must leave no entity change to undo, which is why arbitration
    // runs BEFORE the write rather than being checked after it.
    const { mem, authority } = build()
    const write = vi.fn(() => 'ok')
    const outcome = authority.commit({
      arbitrate: {
        rowId: rowWith('exp-rev'),
        attempt: { expectedRevision: 1 },
        current: { revision: 9 },
      },
      write,
      changes: () => [upsert('s1', { a: 1 })],
    })
    expect(outcome).toEqual({ outcome: 'rejected', reason: 'revision-mismatch' })
    expect(write).not.toHaveBeenCalled()
    expect(mem.rows).toEqual([])
  })

  it('authorization runs BEFORE arbitration', () => {
    // The order is not cosmetic. A principal who may not write at all must be
    // refused without learning anything about the row's revision — a rejection
    // carries a reason and a denial must not, so a denial that arrived AFTER an
    // arbitration verdict would already have leaked whether the row exists.
    const { authority } = build()
    const trace: string[] = []
    expect(() =>
      authority.commit({
        authorize: () => {
          trace.push('authorize')
          throw new Error('denied')
        },
        arbitrate: {
          rowId: rowWith('cmd'),
          attempt: {},
          commandRule: () => {
            trace.push('arbitrate')
            return { ok: true }
          },
        },
        write: () => 'ok',
        changes: () => [],
      }),
    ).toThrow('denied')
    expect(trace).toEqual(['authorize'])
  })
})

// ---------------------------------------------------------------------------
// ONE SPAN — ADR 2 D10
// ---------------------------------------------------------------------------

describe('the entity write and the change append share one span', () => {
  it('rolls the append back when changes() throws', () => {
    const { mem, authority } = build()
    expect(() =>
      authority.commit({
        write: () => 'ok',
        changes: () => {
          throw new Error('boom')
        },
      }),
    ).toThrow('boom')
    expect(mem.rows).toEqual([])
  })

  it('leaves the in-memory baseline untouched after a rollback', () => {
    // The subtle half. If the baseline folded BEFORE the span committed, a
    // rolled-back upsert would be remembered as applied, and the retry of the
    // same write would dedup away — a write silently lost with the log and the
    // tables both consistent and both wrong.
    const { mem, authority } = build()
    let fail = true
    expect(() =>
      authority.commit({
        write: () => 'ok',
        changes: () => {
          const specs = [upsert('s1', { a: 1 })]
          if (fail) throw new Error('boom')
          return specs
        },
      }),
    ).toThrow()
    fail = false
    const outcome = authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 1 })] })
    expect(outcome.outcome).toBe('committed')
    expect(mem.rows).toHaveLength(1)
  })

  it('REFUSES an async write rather than tearing the transaction', () => {
    const { authority } = build()
    expect(() =>
      authority.commit({
        write: () => Promise.resolve('later'),
        changes: () => [],
      }),
    ).toThrow(/must be synchronous/)
  })

  it('does not broadcast a change the span rolled back', () => {
    const { authority } = build()
    const seen: unknown[] = []
    subscribe(authority, (c) => seen.push(c))
    expect(() =>
      authority.commit({
        write: () => 'ok',
        changes: () => {
          throw new Error('boom')
        },
      }),
    ).toThrow()
    expect(seen).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// THE ORDERED PIPE — the reorder bug, reproduced
// ---------------------------------------------------------------------------

describe('the broadcast pipe delivers in APPEND order under reentrancy', () => {
  it('does not deliver a reentrant commit ahead of the batch that caused it', () => {
    // THE BUG, reproduced: subscriber A commits again while being told about
    // batch N. Without the queue, B is told about N+1 first and sees
    // [N-1, N+1, N] — and delta clients apply `seq !== cursor + 1 → heal`, so B's
    // cursor advances past N and heals forever against a log that returns the
    // same rows in the same order.
    const { authority } = build()
    let reentered = false
    subscribe(authority, () => {
      if (reentered) return
      reentered = true
      authority.commit({ write: () => 'ok', changes: () => [upsert('s2', { b: 1 })] })
    })
    const bSaw: number[] = []
    subscribe(authority, (changes) => {
      for (const c of changes) bSaw.push(c.seq)
    })
    authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 1 })] })
    expect(bSaw).toEqual([1, 2])
  })

  it('tells every subscriber even when an earlier one throws', () => {
    // The changes are already durable, so a throwing subscriber must not make a
    // committed write look failed and must not silence the ones after it.
    const { authority } = build()
    const seen: number[] = []
    subscribe(authority, () => {
      throw new Error('subscriber boom')
    })
    subscribe(authority, (changes) => seen.push(changes.length))
    const outcome = authority.commit({
      write: () => 'ok',
      changes: () => [upsert('s1', { a: 1 })],
    })
    expect(outcome.outcome).toBe('committed')
    expect(seen).toEqual([1])
  })

  it('never broadcasts an empty batch', () => {
    const { authority } = build()
    const batches: number[] = []
    subscribe(authority, (c) => batches.push(c.length))
    authority.commit({ write: () => 'ok', changes: () => [] })
    expect(batches).toEqual([])
  })

  it('stops delivering after unsubscribe', () => {
    const { authority } = build()
    const seen: number[] = []
    const off = subscribe(authority, (c) => seen.push(c.length))
    authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 1 })] })
    off()
    authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 2 })] })
    expect(seen).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// DEDUP, RECONCILE, CURSOR
// ---------------------------------------------------------------------------

describe('dedup and the boot reconcile', () => {
  it('drops a no-op upsert', () => {
    const { mem, authority } = build()
    authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 1 })] })
    const second = authority.commit({ write: () => 'ok', changes: () => [upsert('s1', { a: 1 })] })
    expect(second).toMatchObject({ outcome: 'committed', changes: [] })
    expect(mem.rows).toHaveLength(1)
  })

  it('drops a remove of an id the log never recorded', () => {
    const { mem, authority } = build()
    authority.capture([{ entity: 'session', entityId: 'ghost', op: 'remove' }])
    expect(mem.rows).toEqual([])
  })

  it('stages an upsert and a remove of the same id in ONE batch', () => {
    // Batch-local overlay: the remove compares against the batch's own staged
    // state, not against the pre-batch baseline, so a first-sight upsert
    // followed by a remove stages BOTH.
    const { authority } = build()
    const changes = authority.capture([
      upsert('s1', { a: 1 }),
      { entity: 'session', entityId: 's1', op: 'remove' },
    ])
    expect(changes.map((c) => c.op)).toEqual(['upsert', 'remove'])
  })

  it('reconcile emits a REMOVE for an id that vanished while the Authority was down', () => {
    // The only surviving full-list diff, and the reason reconcile exists: a
    // deletion that happened while nothing was running has no write to have
    // declared it, so the truth of "what is here now" is the only evidence.
    const { authority } = build()
    authority.capture([upsert('s1', { a: 1 }), upsert('s2', { b: 1 })])
    const changes = authority.reconcile('session', [{ id: 's1', value: { a: 1 } }])
    expect(changes).toEqual([
      expect.objectContaining({ entityId: 's2', op: 'remove', entity: 'session' }),
    ])
  })

  it('cursor is 0 before any change and tracks the highest seq after', () => {
    const { authority } = build()
    expect(authority.cursor()).toBe(0)
    authority.capture([upsert('s1', { a: 1 })])
    expect(authority.cursor()).toBe(1)
  })

  it('changesSince(null) means "re-bootstrap", not "nothing changed"', () => {
    // A cold reader has no cursor to heal from, and an empty array would tell it
    // it was already up to date.
    const { authority } = build()
    authority.capture([upsert('s1', { a: 1 })])
    expect(authority.changesSince(null, DEVICE_GRADE_PRINCIPAL)).toBeNull()
    const reply = authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)
    expect(reply?.kind).toBe('batch')
    expect(reply?.kind === 'batch' && reply.changes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// THE CLOCK — ADR 1 D3 condition 1
// ---------------------------------------------------------------------------

describe('the arbitration clock is the AUTHORITY’s', () => {
  it('stamps the attempt from its own clock, not from the caller', () => {
    // The port has nowhere for a caller to supply an event time, so the only way
    // to observe which clock was used is to watch what the rule is handed.
    const { authority } = build(() => 4242)
    let seen: number | undefined
    authority.commit({
      arbitrate: {
        rowId: rowWith('cmd'),
        attempt: {},
        commandRule: (attempt) => {
          seen = attempt.eventTime
          return { ok: true }
        },
      },
      write: () => 'ok',
      changes: () => [],
    })
    expect(seen).toBe(4242)
  })

  it('a later write beats an earlier one on a field-LWW row, by the Authority clock', () => {
    let clock = 100
    const { authority } = build(() => clock)
    const lww = rowWith('field-LWW')
    clock = 50
    expect(
      authority.commit({
        arbitrate: { rowId: lww, attempt: {}, current: { eventTime: 100 } },
        write: () => 'ok',
        changes: () => [],
      }),
    ).toMatchObject({ outcome: 'rejected', reason: 'stale-write' })
    clock = 200
    expect(
      authority.commit({
        arbitrate: { rowId: lww, attempt: {}, current: { eventTime: 100 } },
        write: () => 'ok',
        changes: () => [],
      }),
    ).toMatchObject({ outcome: 'committed' })
  })
})
