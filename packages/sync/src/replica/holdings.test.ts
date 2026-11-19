/**
 * WHAT THE DEVICE HOLDS, AS A PROPERTY (POD-7086, POD-7119).
 *
 * Random worlds of issues and sessions and random instances the device holds
 * complete (trees, single records, the sessions of an issue, what a record
 * comes with). The held index finds exactly the instances a record belongs
 * to. What memory keeps is the warm set's (`memory.test.ts`, POD-7161).
 */

import { COLLECTIONS, type Clause, type Collection, clausesOf, instanceParams, isParam } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  CollectionServer,
  issue,
  LONG_AGO,
  RECENTLY,
  session,
  WORLD_NOW,
  WORLD_POLICY,
} from '../conformance/collection-server'
import { InstanceMap, instanceKey } from './cache-state'
import {
  collectionComesWithSettled,
  comesWithOf,
  HeldIndex,
  type HeldRows,
  holds,
  policyArgs,
  resolveInstance,
  stubOfValue,
} from './holdings'
import type { EntityRecord, InstanceRecord, InstanceSpec } from './types'

const ISSUE = 'issueProjection'
const SESSION = 'session'
const CURSOR = { feedId: 'feed', epoch: 'epoch', seq: 1 }

/** mulberry32: a small seeded generator, so a failing case can be replayed by its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const rowKey = (entity: string, id: string) => `${entity}\u0000${id}`

interface Case {
  readonly server: CollectionServer
  readonly rows: Map<string, EntityRecord>
  readonly instances: Map<string, InstanceRecord>
}

function buildCase(seed: number): Case {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  const server = new CollectionServer()
  const issues: string[] = []
  const count = 4 + Math.floor(next() * 20)
  for (let i = 0; i < count; i += 1) {
    const id = `I${i}`
    const parentId = i > 0 && next() < 0.7 ? pick(issues) : null
    const stage = pick(['done', 'done', 'in_progress', 'proposed'])
    server.put(
      ISSUE,
      id,
      issue(id, {
        parentId,
        stage,
        closedReason: stage === 'done' ? 'completed' : null,
        updatedAt: next() < 0.3 ? RECENTLY : LONG_AGO,
      }),
    )
    issues.push(id)
  }
  const sessions: string[] = []
  for (let i = 0; i < Math.floor(next() * 10); i += 1) {
    const id = `S${i}`
    server.put(
      SESSION,
      id,
      session(id, {
        issueId: next() < 0.8 ? pick(issues) : null,
        status: pick(['live', 'ended', 'ended']),
        archived: next() < 0.3,
      }),
    )
    sessions.push(id)
  }

  const specs: InstanceSpec[] = []
  for (let i = 0; i < 1 + Math.floor(next() * 6); i += 1) {
    const kind = pick(['tree', 'one', 'ofIssue', 'sidebar'] as const)
    if (kind === 'tree')
      specs.push({ collection: 'issueProjection.tree', args: { root: pick(issues) }, part: 'main' })
    else if (kind === 'one')
      specs.push({ collection: 'issueProjection.one', args: { id: pick(issues) }, part: 'main' })
    else if (kind === 'ofIssue')
      specs.push({ collection: 'session.ofIssue', args: { issueId: pick(issues) }, part: 'main' })
    else specs.push({ collection: 'issueProjection.sidebar', part: 'main' })
  }

  // Whole rows: every member of a marked instance (so every marker is true
  // before the trim), what some of them come with, and a few strays.
  const rows = new Map<string, EntityRecord>()
  const whole = (entity: string, id: string, value: unknown) =>
    rows.set(rowKey(entity, id), { entity, entityId: id, value, provenance: { seq: 1 } })
  const instances = new Map<string, InstanceRecord>()
  const mark = (spec: InstanceSpec) => {
    const key = instanceKey(spec)
    if (instances.has(key)) return false
    for (const row of server.members(spec)) whole(row.entity, row.id, row.value)
    instances.set(key, {
      ...spec,
      key,
      completeAt: CURSOR,
      ...(spec.via === undefined ? { releasedAt: Math.floor(next() * 100) } : {}),
    })
    return true
  }
  for (const spec of specs) mark(spec)
  const currentValue = (entity: string, id: string) =>
    server.members(
      entity === ISSUE
        ? { collection: 'issueProjection.one', args: { id }, part: 'main' }
        : { collection: 'session.one', args: { id }, part: 'main' },
    )[0]?.value
  for (const id of [...issues, ...sessions].filter(() => next() < 0.15)) {
    const entity = id.startsWith('I') ? ISSUE : SESSION
    whole(entity, id, currentValue(entity, id))
  }
  // What whole rows come with, followed to a fixed point, each marked with some chance.
  for (let changed = true; changed; ) {
    changed = false
    const index = new HeldIndex(instances.values(), policyArgs(WORLD_POLICY))
    const store: HeldRows = { readRow: (entity, id) => rows.get(rowKey(entity, id)) }
    for (const row of [...rows.values()]) {
      const memberOf = index.matching(row.entity, row.value, store, WORLD_NOW)
      for (const spec of comesWithOf(row.entity, row.value, memberOf, WORLD_NOW)) {
        if (next() < 0.6 && mark(spec)) changed = true
      }
    }
  }
  // Every other issue is on the device as its stub.
  for (const id of issues) {
    if (rows.has(rowKey(ISSUE, id))) continue
    rows.set(rowKey(ISSUE, id), {
      entity: ISSUE,
      entityId: id,
      value: stubOfValue(ISSUE, currentValue(ISSUE, id)),
      provenance: { seq: 1 },
      part: 'stub',
    })
  }
  return { server, rows, instances }
}

/**
 * POD-7119 — the index before it looked instances up by key: it resolved
 * every marker and grouped keyed instances by their argument. Kept here as
 * the oracle `HeldIndex.matching` must still equal.
 */
function oldMatching(
  specs: readonly (InstanceSpec & { readonly range?: InstanceRecord['range'] })[],
  args: ReturnType<typeof policyArgs>,
  kind: string,
  value: unknown,
  rows: HeldRows,
  now: number,
  part: 'stub' | 'main',
): string[] {
  const record = (value ?? {}) as Readonly<Record<string, unknown>>
  const out = new Set<string>()
  for (const spec of specs) {
    const instance = resolveInstance(spec, args)
    if (instance === undefined || instance.of !== kind || spec.part !== part) continue
    const field = oldKeyField(instance.collection)
    if (field !== undefined) {
      const param = instanceParams(instance.collection)[0] as string
      if ((spec.args?.[param] ?? null) !== (record[field] ?? null)) continue
    }
    if (holds(instance, kind, value, rows, now)) out.add(instance.key)
  }
  return [...out].sort()
}

function oldKeyField(collection: Collection): string | undefined {
  const params = instanceParams(collection)
  if (params.length !== 1 || collection.where === undefined) return undefined
  const clauses = clausesOf(collection.where)
  if (clauses.length !== 1) return undefined
  for (const [field, test] of Object.entries(clauses[0] as Clause)) {
    if (
      test !== null &&
      typeof test === 'object' &&
      'eq' in test &&
      isParam(test.eq) &&
      test.eq.param === params[0]
    )
      return field
  }
  return undefined
}

describe('the held index by key (POD-7119)', () => {
  it('finds exactly the instances the index that resolved every marker found', () => {
    let found = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const c = buildCase(seed)
      const next = random(seed * 7919)
      const ids = [...c.rows.values()].filter((row) => row.entity === ISSUE).map((r) => r.entityId)
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
      const extra = (spec: InstanceSpec & { readonly range?: InstanceRecord['range'] }) => {
        const key = instanceKey(spec)
        return { ...spec, key, completeAt: CURSOR } as InstanceRecord
      }
      // Shapes the random worlds do not make: stubs, pages with a range, a
      // via, a via this build does not declare, an argument besides the key,
      // a missing key argument.
      const odd: InstanceRecord[] = [
        extra({ collection: 'issueProjection.stubs', part: 'stub' }),
        extra({ collection: 'issueProjection.recent', part: 'main' }),
        extra({
          collection: 'issueProjection.byStage',
          args: { stage: 'in_progress' },
          part: 'main',
          range: { through: [RECENTLY, 'I3'], end: false },
        }),
        extra({ collection: 'issueProjection.byStage', args: { stage: 'done' }, part: 'main' }),
        extra({
          collection: 'issueProjection.byStagePriority',
          args: { stage: 'in_progress', priority: 2 },
          part: 'main',
        }),
        extra({
          collection: 'session.ofIssue',
          args: { issueId: pick(ids) },
          part: 'main',
          via: 'issueProjection.sidebar',
        }),
        extra({
          collection: 'session.ofIssue',
          args: { issueId: pick(ids) },
          part: 'main',
          via: 'issueProjection.tree',
        }),
        extra({
          collection: 'issueProjection.one',
          args: { id: pick(ids) },
          part: 'main',
          via: 'issueProjection',
        }),
        extra({
          collection: 'issueProjection.one',
          args: { id: pick(ids) },
          part: 'main',
          via: 'gone',
        }),
        extra({
          collection: 'issueProjection.one',
          args: { id: pick(ids), also: 1 },
          part: 'main',
        }),
        extra({ collection: 'issueProjection.one', part: 'main' }),
        extra({ collection: 'issueProjection.one', args: { id: pick(ids) }, part: 'stub' }),
        extra({ collection: 'notDeclared.one', args: { id: pick(ids) }, part: 'main' }),
      ]
      const all = [...c.instances.values(), ...odd]
      // The markers as a store keeps them: a base, then one mutation at a
      // time over it, some dropping a marker, past a fold.
      const cut = Math.floor(all.length / 2)
      let markers: ReadonlyMap<string, InstanceRecord> = new Map(
        all.slice(0, cut).map((r) => [r.key, r]),
      )
      for (const record of all.slice(cut)) {
        const edit = InstanceMap.edit(markers)
        edit.set(record.key, record)
        if (next() < 0.2) edit.delete(pick(all).key)
        markers = edit.done()
      }
      const fetching: (InstanceSpec & { readonly range?: InstanceRecord['range'] })[] = [
        { collection: 'issueProjection.tree', args: { root: pick(ids) }, part: 'main' },
        { collection: 'issueProjection.one', args: { id: pick(ids) }, part: 'main' },
        // A reload of a held page: in flight, it has no range.
        { collection: 'issueProjection.byStage', args: { stage: 'in_progress' }, part: 'main' },
      ]
      const index = new HeldIndex(markers, policyArgs(WORLD_POLICY), fetching)
      const store: HeldRows = { readRow: (entity, id) => c.rows.get(rowKey(entity, id)) }
      const specs = [...markers.values(), ...fetching]
      for (const row of c.rows.values()) {
        for (const part of ['main', 'stub'] as const) {
          const got = index
            .matching(row.entity, row.value, store, WORLD_NOW, part)
            .map((instance) => instance.key)
            .sort()
          const want = oldMatching(
            specs,
            policyArgs(WORLD_POLICY),
            row.entity,
            row.value,
            store,
            WORLD_NOW,
            part,
          )
          expect(got, `seed ${seed} ${row.entityId} ${part}`).toEqual(want)
          found += got.length
        }
      }
    }
    // Not vacuous: many records belong to many instances.
    expect(found).toBeGreaterThan(1_000)
  })
})

describe('a record whose collection comes-with is settled (POD-7181)', () => {
  const closed = issue('c1', { stage: 'done', closedReason: 'completed', parentId: 'r1' })
  const open = issue('o1', { stage: 'in_progress', parentId: 'r1' })
  it('needs no instance lookup when every collection that brings things is complete or cannot hold it', () => {
    // No session collection declares comes-with: membership adds nothing.
    expect(collectionComesWithSettled('session', session('s1'), undefined, WORLD_NOW)).toBe(true)
    // A tree takes an argument, so only its complete bit settles it.
    expect(collectionComesWithSettled('issueProjection', closed, [], WORLD_NOW)).toBe(false)
    // The sidebar's rule reads no argument: a closed issue is no member.
    expect(
      collectionComesWithSettled('issueProjection', closed, ['issueProjection.tree'], WORLD_NOW),
    ).toBe(true)
    // An open issue is one, so the sidebar's comes-with must be complete too.
    expect(
      collectionComesWithSettled('issueProjection', open, ['issueProjection.tree'], WORLD_NOW),
    ).toBe(false)
    expect(
      collectionComesWithSettled(
        'issueProjection',
        open,
        ['issueProjection.tree', 'issueProjection.sidebar'],
        WORLD_NOW,
      ),
    ).toBe(true)
  })

  it('is exact: what the instances of a settled record add, its complete bits already cover', () => {
    const rows: HeldRows = { readRow: () => undefined }
    for (const [kind, value, cw] of [
      ['session', session('s1', { issueId: 'o1' }), []],
      ['issueProjection', closed, ['issueProjection.tree']],
      ['issueProjection', open, ['issueProjection.tree', 'issueProjection.sidebar']],
    ] as const) {
      expect(collectionComesWithSettled(kind, value, cw, WORLD_NOW)).toBe(true)
      // Every instance of the kind's collections the record belongs to (a tree under its parent).
      const memberOf = [...COLLECTIONS.values()]
        .filter((collection) => collection.of === kind)
        .flatMap((collection) => {
          const args = Object.fromEntries(instanceParams(collection).map((name) => [name, 'r1']))
          const resolved = resolveInstance(
            { collection: collection.id, args, part: collection.part ?? 'main' },
            policyArgs(WORLD_POLICY),
          )
          return resolved !== undefined && holds(resolved, kind, value, rows, WORLD_NOW) ? [resolved] : []
        })
      const own = new Set(comesWithOf(kind, value, [], WORLD_NOW).map((spec) => instanceKey(spec)))
      const added = comesWithOf(kind, value, memberOf, WORLD_NOW).filter(
        (spec) => !own.has(instanceKey(spec)),
      )
      if (kind === 'issueProjection') expect(added.length).toBeGreaterThan(0)
      for (const spec of added) expect(cw).toContain(spec.via)
    }
  })
})
