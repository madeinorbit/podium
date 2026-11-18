/**
 * THE TRIM, AS A PROPERTY (POD-7086 acceptance 3 and 4).
 *
 * Random worlds of issues and sessions, random instances the device holds
 * complete (trees, single records, the sessions of an issue, what a record
 * comes with), random holders and a random cap. After the trim:
 *
 *  - no instance keeps its marker while a record of it is not whole;
 *  - no issue that was on the device is below its stub;
 *  - every instance a remaining whole record comes with, that was held, is still held;
 *  - nothing the policy or an open view holds is dropped.
 *
 * The world's membership is the server fixture's, evaluated over every record,
 * not over what the device holds, so a trim that trusted a stale device row
 * would be caught.
 */

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
import { instanceKey } from './cache-state'
import {
  comesWithOf,
  HeldIndex,
  type HeldRows,
  planTrim,
  policyArgs,
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
  readonly held: Set<string>
  readonly cap: number
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
  const held = new Set<string>()
  // Views hold instances they name; what a record comes with is held through that record.
  for (const [key, instance] of instances)
    if (instance.via === undefined && next() < 0.25) held.add(key)
  return { server, rows, instances, held, cap: Math.floor(next() * 12) }
}

describe('the trim, over random worlds', () => {
  it('keeps every marker true, every issue at least a stub, and what held records come with', () => {
    let dropped = 0
    let stubbed = 0
    let removed = 0
    for (let seed = 1; seed <= 300; seed += 1) {
      const c = buildCase(seed)
      const store: HeldRows = { readRow: (entity, id) => c.rows.get(rowKey(entity, id)) }
      const plan = planTrim({
        rows: [...c.rows.values()],
        instances: c.instances,
        held: c.held,
        policy: WORLD_POLICY,
        cap: c.cap,
        now: WORLD_NOW,
        store,
      })
      dropped += plan.dropInstances.length
      stubbed += plan.toStub.length
      removed += plan.remove.length

      // Apply the plan, as the Replica does.
      const after = new Map(c.rows)
      for (const row of plan.toStub)
        after.set(rowKey(row.entity, row.entityId), {
          ...row,
          value: stubOfValue(row.entity, row.value),
          part: 'stub',
        })
      for (const row of plan.remove) after.delete(rowKey(row.entity, row.entityId))
      const kept = new Map(c.instances)
      for (const key of plan.dropInstances) kept.delete(key)
      const label = `seed ${seed}`

      // Acceptance 3: no marker while a record of its instance is missing.
      for (const instance of kept.values()) {
        for (const member of c.server.members(instance)) {
          const row = after.get(rowKey(member.entity, member.id))
          expect(row, `${label}: ${instance.key} lost ${member.id}`).toBeDefined()
          expect(
            row?.part,
            `${label}: ${instance.key} took ${member.id} to its stub`,
          ).toBeUndefined()
        }
      }
      // Acceptance 4: an issue never goes below its stub.
      for (const row of c.rows.values()) {
        if (row.entity !== ISSUE) continue
        expect(after.has(rowKey(ISSUE, row.entityId)), `${label}: ${row.entityId} vanished`).toBe(
          true,
        )
      }
      // Acceptance 4: what a remaining whole record comes with stays held.
      const index = new HeldIndex(kept.values(), policyArgs(WORLD_POLICY))
      const afterStore: HeldRows = { readRow: (entity, id) => after.get(rowKey(entity, id)) }
      for (const row of after.values()) {
        if (row.part === 'stub') continue
        const memberOf = index.matching(row.entity, row.value, afterStore, WORLD_NOW)
        for (const spec of comesWithOf(row.entity, row.value, memberOf, WORLD_NOW)) {
          const key = instanceKey(spec)
          if (c.instances.has(key))
            expect(kept.has(key), `${label}: ${row.entityId} lost ${key}`).toBe(true)
        }
      }
      // The policy and open views hold what they hold.
      for (const key of c.held) expect(kept.has(key), `${label}: held ${key} dropped`).toBe(true)
      // The cap: what only cache instances keep is at most the cap.
      expect(plan.cacheRecords, label).toBeLessThanOrEqual(c.cap)
    }
    // The property is not vacuous: the worlds made the trim drop, stub and remove.
    expect(dropped).toBeGreaterThan(50)
    expect(stubbed).toBeGreaterThan(50)
    expect(removed).toBeGreaterThan(10)
  })

  it('a plan that kept a trimmed instance’s marker would be caught', () => {
    // The counterfactual: find a case whose trim drops an instance with a
    // member it takes back to a stub, and check that keeping its marker breaks
    // the first property above.
    for (let seed = 1; seed <= 300; seed += 1) {
      const c = buildCase(seed)
      const store: HeldRows = { readRow: (entity, id) => c.rows.get(rowKey(entity, id)) }
      const plan = planTrim({
        rows: [...c.rows.values()],
        instances: c.instances,
        held: c.held,
        policy: WORLD_POLICY,
        cap: c.cap,
        now: WORLD_NOW,
        store,
      })
      const stubbed = new Set(plan.toStub.map((row) => rowKey(row.entity, row.entityId)))
      const witness = plan.dropInstances.find((key) =>
        c.server
          .members(c.instances.get(key) as InstanceRecord)
          .some((member) => stubbed.has(rowKey(member.entity, member.id))),
      )
      if (witness !== undefined) return
    }
    throw new Error('no world dropped an instance with a member: the property test is vacuous')
  })
})
