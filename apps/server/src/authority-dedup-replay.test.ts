/**
 * The Authority decides "unchanged, skip it" from the database exactly as it did
 * from its in-memory baseline (POD-6156 step 2).
 *
 * A generated write sequence is replayed through two Authorities on two stores:
 * one deduplicating against the baseline (every installed row, parsed at boot
 * and folded on every append), one reading the stored rows of each commit's keys
 * inside its span. The sequence covers every entity kind, unchanged writes,
 * conversation writes that move only the fields detection ignores, several
 * specs for one key in one batch, removes of absent ids, savepoint rollbacks,
 * nested spans, full-truth reconciles, restarts and corrupt stored rows. The
 * emitted changes, the change log and every snapshot must be byte-identical.
 *
 * ONE DELIBERATE DIFFERENCE: the ORDER of a reconcile's removes. The baseline
 * removed ids in the order its map first held them; the database knows only
 * each row's latest seq, so removes follow that. The two differ only when a
 * reconcile later in a process's life removes several ids one of which was
 * written after the others were installed. The removed rows, the seq range they
 * take and the world they leave are the same; which removed id gets which seq
 * inside that range is not. Removes of different entities are independent, so a
 * replica that applies the batch ends in the same state. The comparison below
 * holds every reconcile's removes as one group, and counts the groups whose
 * order differed so the difference stays visible.
 */

import { createHash } from 'node:crypto'
import { MetadataEntityKind } from '@podium/protocol'
import {
  Authority,
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
  type SequencedChange,
  type StagedChangeSpec,
} from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { afterCommit, applyAfterCommit, spanOpen } from './store/executor/executor'
import { openTestStore } from './test-support/open-test-store'
import { expectConstantStatements, measureAtSizes, type StatementPin } from './test-support/statement-count'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

type Kind = MetadataEntityKind
const KINDS = MetadataEntityKind.options

type Op =
  | { kind: 'commit'; specs: StagedChangeSpec[] }
  | { kind: 'capture'; specs: StagedChangeSpec[] }
  | { kind: 'reconcile'; entity: Kind; rows: { id: string; value: unknown }[] }
  | { kind: 'rollback'; ops: Op[] }
  | { kind: 'nested'; ops: Op[] }
  | { kind: 'restart' }
  | { kind: 'corrupt'; entity: Kind; id: string; payload: string }
  | { kind: 'snapshot'; entity: Kind }

/** A small deterministic PRNG (mulberry32), so a seed names one sequence. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T,
  }
}

/**
 * The generated sequence. Ids come from a small pool per kind so writes collide;
 * values come from a small pool so many writes are unchanged. A conversation's
 * value moves its stable field (`title`) or only the fields detection ignores.
 */
function generate(seed: number, length: number): Op[] {
  const r = random(seed)
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const valueFor = (entity: Kind, id: string): unknown => {
    if (entity === 'conversation') {
      return {
        id,
        title: `t${r.int(2)}`,
        updatedAt: `2026-10-16T00:00:0${r.int(4)}Z`,
        messageCount: r.int(3),
        statusHint: r.pick(['idle', 'busy']),
      }
    }
    return { id, v: r.int(3), tag: r.pick(['x', 'y']) }
  }
  const spec = (): StagedChangeSpec => {
    const entity = r.pick(KINDS)
    const entityId = r.pick(ids)
    return r.chance(0.25)
      ? { entity, entityId, op: 'remove' }
      : ({ entity, entityId, op: 'upsert', value: valueFor(entity, entityId) } as StagedChangeSpec)
  }
  const batch = (): StagedChangeSpec[] => {
    const out = Array.from({ length: 1 + r.int(4) }, spec)
    // Several specs for one key in one batch: upsert then remove, remove then upsert.
    if (r.chance(0.2)) {
      const first = out[0] as StagedChangeSpec
      out.push(
        first.op === 'upsert'
          ? { entity: first.entity, entityId: first.entityId, op: 'remove' }
          : ({
              entity: first.entity,
              entityId: first.entityId,
              op: 'upsert',
              value: valueFor(first.entity, first.entityId),
            } as StagedChangeSpec),
      )
    }
    return out
  }
  const op = (depth: number): Op => {
    const roll = r.int(100)
    if (roll < 40) return { kind: 'commit', specs: batch() }
    if (roll < 60) return { kind: 'capture', specs: batch() }
    if (roll < 70) {
      const entity = r.pick(KINDS)
      return {
        kind: 'reconcile',
        entity,
        rows: ids.filter(() => r.chance(0.6)).map((id) => ({ id, value: valueFor(entity, id) })),
      }
    }
    if (roll < 78 && depth < 2) return { kind: 'rollback', ops: Array.from({ length: 1 + r.int(3) }, () => op(depth + 1)) }
    if (roll < 86 && depth < 2) return { kind: 'nested', ops: Array.from({ length: 1 + r.int(3) }, () => op(depth + 1)) }
    if (roll < 89 && depth === 0) return { kind: 'restart' }
    if (roll < 92 && depth === 0) {
      return {
        kind: 'corrupt',
        entity: r.pick(['conversation', 'issueProjection', 'session'] as const),
        id: r.pick(ids),
        payload: r.pick(['{not json', 'null', '7']),
      }
    }
    return { kind: 'snapshot', entity: r.pick(KINDS) }
  }
  return Array.from({ length }, () => op(0))
}

const ROLLBACK = new Error('roll this span back')

/** One arm: a store and an Authority over it, rebuilt on `restart`. */
async function arm(dedupFrom: 'baseline' | 'database') {
  const store = await openTestStore(':memory:')
  stores.push(store)
  let clock = 1_000
  const build = () =>
    new Authority({
      store: store.sync,
      now: () => clock++,
      transact: async (fn) => await store.transact(fn),
      postCommit: (step, label) => afterCommit(step, label),
      applyCommit: { spanOpen, onCommit: applyAfterCommit },
      visibility: new DeviceGradeUnscopedPolicy(),
      anchors: new DeviceGradeNoAnchors(),
      dedupFrom,
    })
  let authority = build()
  const record: unknown[] = []
  /** Each reconcile's remove seqs, in log order; the group the comparison frees. */
  const removeGroups: number[][] = []
  const row = (c: SequencedChange) => [c.seq, c.entity, c.entityId, c.op, JSON.stringify((c as { value?: unknown }).value ?? null)]
  const emitted = (label: string, changes: readonly SequencedChange[]) => record.push([label, changes.map(row)])
  const run = async (op: Op): Promise<void> => {
    switch (op.kind) {
      case 'commit': {
        const outcome = await authority.commit({ write: async () => undefined, changes: () => op.specs })
        if (outcome.outcome === 'committed') emitted('commit', outcome.changes)
        return
      }
      case 'capture':
        emitted('capture', await authority.capture(op.specs))
        return
      case 'reconcile': {
        const changes = await authority.reconcile(op.entity, op.rows)
        const removes = changes.filter((c) => c.op === 'remove')
        removeGroups.push(removes.map((c) => c.seq))
        record.push([
          'reconcile',
          changes.filter((c) => c.op !== 'remove').map(row),
          removes.map((c) => c.seq),
          removes.map((c) => `${c.entity}:${c.entityId}`).sort(),
          // The raw order, compared separately and only counted.
          { order: removes.map((c) => c.entityId) },
        ])
        return
      }
      case 'rollback':
        try {
          await store.transact(async () => {
            for (const inner of op.ops) await run(inner)
            throw ROLLBACK
          })
        } catch (error) {
          if (error !== ROLLBACK) throw error
        }
        record.push(['rolled back'])
        return
      case 'nested':
        await store.transact(async () => {
          await store.transact(async () => {
            for (const inner of op.ops) await run(inner)
          })
        })
        return
      case 'restart':
        authority = build()
        return
      case 'corrupt':
        // Written past the Authority, then a restart: the baseline only ever saw
        // stored rows through its seed, so that is when it can see this one.
        await store.sync.appendChanges(
          [{ entity: op.entity, entityId: op.id, op: 'upsert', payload: op.payload }],
          clock++,
        )
        authority = build()
        return
      case 'snapshot': {
        const values = await authority.snapshot(op.entity)
        // A snapshot is a set: compared by id.
        record.push([
          'snapshot',
          op.entity,
          values.map((v) => JSON.stringify(v)).sort(),
        ])
        return
      }
    }
  }
  return {
    store,
    /** The record without the raw remove order. */
    get record() {
      return record.map((entry) =>
        Array.isArray(entry) && entry[0] === 'reconcile' ? entry.slice(0, 4) : entry,
      )
    },
    removeOrders: () =>
      record.filter((entry) => Array.isArray(entry) && entry[0] === 'reconcile').map((entry) => (entry as unknown[])[4]),
    /** The change log, each reconcile's removes sorted inside their own seq range. */
    log: async () => {
      const rows = (await store.sync.changesSince(0, 100_000)).map(
        (r) => [r.seq, r.entity, r.entityId, r.op, r.payload] as [number, string, string, string, string | null],
      )
      const bySeq = new Map(rows.map((r) => [r[0], r]))
      for (const seqs of removeGroups) {
        const group = seqs.map((seq) => bySeq.get(seq)).filter((r) => r !== undefined)
        const sorted = [...group].sort((a, b) => `${a[1]}:${a[2]}`.localeCompare(`${b[1]}:${b[2]}`))
        seqs.forEach((seq, i) => {
          const r = sorted[i]
          if (r) bySeq.set(seq, [seq, r[1], r[2], r[3], r[4]])
        })
      }
      return rows.map((r) => bySeq.get(r[0]))
    },
    run,
    world: async () =>
      (await store.sync.latestChangeStates()).map((row) => [row.seq, row.entity, row.entityId, row.payload]),
  }
}

describe('Authority dedup: the database answers like the baseline', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`replays generated write sequence ${seed} to byte-identical changes`, async () => {
      const ops = generate(seed, 400)
      const old = await arm('baseline')
      const current = await arm('database')
      for (const op of ops) {
        await old.run(op)
        await current.run(op)
      }
      expect(current.record).toEqual(old.record)
      expect(await current.log()).toEqual(await old.log())
      expect(await current.world()).toEqual(await old.world())
      const oldOrders = old.removeOrders()
      const reordered = current.removeOrders().filter((order, i) => JSON.stringify(order) !== JSON.stringify(oldOrders[i])).length
      // What the baseline emitted, as one fingerprint the database path is held
      // to once the baseline is gone.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([old.record, await old.log(), await old.world()]))
        .digest('hex')
      console.log(
        `[replay] seed ${seed}: ${(await old.log()).length} log rows, ${oldOrders.length} reconciles, ` +
          `${reordered} with removes in another order, fingerprint ${fingerprint}`,
      )
      // The sequence is live: it appended, deduped, rolled back and reconciled.
      expect((await old.log()).length).toBeGreaterThan(100)
      expect(old.record.filter((entry) => (entry as unknown[])[0] === 'rolled back').length).toBeGreaterThan(0)
    }, 120_000)
  }
})

describe('Authority dedup: statements per commit', () => {
  /** `size` installed rows of each of three kinds, then one commit of three specs:
   *  a changed upsert, an unchanged upsert and a remove. */
  interface Fixture {
    store: SessionStore
    authority: Authority
  }
  const pinFor = (dedupFrom: 'baseline' | 'database'): StatementPin<Fixture> => ({
    name: `commit (${dedupFrom})`,
    setup: async (size: number) => {
      const store = await openTestStore(':memory:')
      const rows = (['issueProjection', 'session', 'conversation'] as const).flatMap((entity) =>
        Array.from({ length: size }, (_, i) => ({
          entity,
          entityId: `${entity}-${i}`,
          op: 'upsert' as const,
          payload: JSON.stringify({ id: `${entity}-${i}`, v: 1 }),
        })),
      )
      await store.sync.appendChanges(rows, 1)
      const authority = new Authority({
        store: store.sync,
        now: () => 2,
        transact: async (fn) => await store.transact(fn),
        postCommit: (step, label) => afterCommit(step, label),
        applyCommit: { spanOpen, onCommit: applyAfterCommit },
        visibility: new DeviceGradeUnscopedPolicy(),
        anchors: new DeviceGradeNoAnchors(),
        dedupFrom,
      })
      // The baseline arm reads every installed row once, at boot: not the commit's.
      await authority.snapshot('issueProjection')
      return { store, authority }
    },
    target: (f) => f.store,
    run: async (f) =>
      await f.authority.commit({
        write: async () => undefined,
        changes: () => [
          { entity: 'issueProjection', entityId: 'issueProjection-0', op: 'upsert', value: { id: 'issueProjection-0', v: 2 } },
          { entity: 'session', entityId: 'session-1', op: 'upsert', value: { id: 'session-1', v: 1 } },
          { entity: 'conversation', entityId: 'conversation-2', op: 'remove' },
        ] as StagedChangeSpec[],
      }),
    check: (result: unknown) => {
      const outcome = result as { outcome: string; changes: SequencedChange[] }
      expect(outcome.changes.map((c) => [c.entityId, c.op])).toEqual([
        ['issueProjection-0', 'upsert'],
        ['conversation-2', 'remove'],
      ])
    },
    teardown: async (f) => await f.store.close(),
  })

  it('reads the stored rows of a commit in one grouped read, whatever the data size', async () => {
    const baseline = await measureAtSizes(pinFor('baseline'))
    // The span, the change rows and the installed world's two row writes, plus
    // ONE grouped read of the three keys.
    await expectConstantStatements(pinFor('database'), baseline.small.statements + 1)
  })
})
