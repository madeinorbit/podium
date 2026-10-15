/**
 * Grant reads answer exactly what the writes say (POD-6155 step 2).
 *
 * Before the world index's grants copy was deleted, this test compared the
 * copy (`WorldIndex.reader.grantsFor` and the `grant-reader` helpers) with the
 * repository's indexed queries over the benchmark corpus (POD-6146: cell h1a1,
 * seed 4443) and these fixtures, at the commit that adds this file. What stays
 * is the fixture part, as a regression test: `loadForResource` (unscoped and
 * batched in one read scope) and `listForResources` against an independent
 * model of the writes, for every verb, custody, agent-delegated shares,
 * re-shares, revocations, whole-resource and whole-grantee removal, created-at
 * ties, unknown ids, and reads inside a rolled-back write span.
 */

import { GRANT_VERBS, type GrantVerb } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { withReadScope } from './executor/read-scope'
import type { GrantRow } from './grants'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

type Kind = 'issue' | 'session' | 'machine'
const users = ['user:p0', 'user:p1', 'user:p2', 'user:p3', 'user:p4', 'user:p5']
const key = (kind: string, id: string) => `${kind}\u0000${id}`
const edgeKey = (row: Pick<GrantRow, 'grantee' | 'verb'>) => `${row.grantee}\u0000${row.verb}`

/** The writes, applied to plain maps: what every reader must answer. */
class Model {
  readonly byResource = new Map<string, Map<string, GrantRow>>()
  upsert(row: GrantRow) {
    const edges = this.byResource.get(key(row.resourceKind, row.resourceId)) ?? new Map<string, GrantRow>()
    const previous = edges.get(edgeKey(row))
    const custody = row.custody === undefined ? previous?.custody : row.custody
    const { custody: _, ...rest } = row
    edges.set(edgeKey(row), { ...rest, ...(custody ? { custody: true } : {}) })
    this.byResource.set(key(row.resourceKind, row.resourceId), edges)
  }
  remove(kind: string, id: string, grantee: string, verb: GrantVerb) {
    this.byResource.get(key(kind, id))?.delete(`${grantee}\u0000${verb}`)
  }
  removeResource(kind: string, id: string) {
    this.byResource.delete(key(kind, id))
  }
  removeGrantee(grantee: string) {
    for (const edges of this.byResource.values()) {
      for (const [k, row] of edges) if (row.grantee === grantee) edges.delete(k)
    }
  }
  edges(kind: string, id: string): GrantRow[] {
    return [...(this.byResource.get(key(kind, id))?.values() ?? [])]
  }
}

/** Order inside one resource is created-at only; ties have no defined order. */
const normal = (rows: readonly GrantRow[]) =>
  [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || edgeKey(a).localeCompare(edgeKey(b)))

function share(kind: Kind, id: string, grantee: string, verb: GrantVerb, n: number): GrantRow {
  const agent = n % 5 === 0
  return {
    resourceKind: kind,
    resourceId: id,
    grantee,
    verb,
    owner: users[n % users.length]!,
    visibility: 'personal',
    // Every fourth share ties with its neighbour, so tie order is exercised.
    createdAt: `2026-10-15T00:00:${String(Math.floor(n / 4) % 60).padStart(2, '0')}.${String(n % 1000).padStart(3, '0')}Z`,
    // Agent-delegated shares: the actor is the agent's session, on behalf of a user.
    actorKind: agent ? 'agent' : 'user',
    actorId: agent ? `session-actor-${n}` : users[n % users.length]!,
    onBehalfOf: agent ? users[(n + 1) % users.length]! : null,
  }
}

async function expectAnswers(store: SessionStore, ids: Record<Kind, string[]>, model: Model) {
  for (const kind of ['issue', 'session', 'machine'] as const) {
    const asked = [...ids[kind], `${kind}-never-granted`]
    const many = await store.grants.listForResources(kind, asked)
    const scoped = await withReadScope(async () =>
      await Promise.all(asked.map(async (id) => await store.grants.loadForResource(kind, id))),
    )
    for (const [i, id] of asked.entries()) {
      const want = normal(model.edges(kind, id))
      // Unscoped, batched in one scope, and grouped.
      expect(normal(await store.grants.loadForResource(kind, id)), `${kind} ${id} one`).toEqual(want)
      expect(normal(scoped[i]!), `${kind} ${id} scoped`).toEqual(want)
      expect(normal(many.get(id) ?? []), `${kind} ${id} many`).toEqual(want)
      expect(many.has(id), `${kind} ${id} absent means no edges`).toBe(want.length > 0)
    }
  }
}

describe('grant reads answer what the writes say', () => {
  it('over the edge-case fixtures, inside and outside a write span', async () => {
    const store = await openTestStore(':memory:')
    stores.push(store)
    const model = new Model()
    const ids: Record<Kind, string[]> = { issue: ['iss_edge'], session: ['session-edge'], machine: ['machine-edge'] }
    // Every verb on every kind, for the same grantee; ties on created-at.
    let n = 0
    for (const kind of ['issue', 'session', 'machine'] as const) {
      for (const verb of GRANT_VERBS) {
        const row = share(kind, ids[kind][0]!, users[1]!, verb, (n += 4))
        await store.grants.upsert(row)
        model.upsert(row)
      }
    }
    const custody = { ...share('machine', 'machine-edge', users[0]!, 'manage', 1), custody: true }
    await store.grants.upsert(custody)
    model.upsert(custody)
    // A re-share without a custody marker keeps the stored marker.
    const reshare = { ...custody, custody: undefined, owner: users[2]!, createdAt: '2026-10-16T00:00:00.000Z' }
    await store.grants.upsert(reshare)
    model.upsert(reshare)
    // An agent-delegated share, then its revocation.
    const delegated = share('issue', 'iss_edge', users[4]!, 'read', 5)
    await store.grants.upsert(delegated)
    model.upsert(delegated)
    await expectAnswers(store, ids, model)
    expect(await store.grants.remove('issue', 'iss_edge', users[4]!, 'read')).toBe(true)
    model.remove('issue', 'iss_edge', users[4]!, 'read')
    await expectAnswers(store, ids, model)

    // Inside a write span reads are live: the revocation denies at once, and
    // the rollback leaves nothing behind in any reader.
    await expect(
      store.transact(async () => {
        await store.grants.remove('issue', 'iss_edge', users[1]!, 'read')
        const without = model.edges('issue', 'iss_edge')
          .filter((row) => !(row.grantee === users[1] && row.verb === 'read'))
        expect(normal(await store.grants.loadForResource('issue', 'iss_edge'))).toEqual(normal(without))
        expect(normal((await store.grants.listForResources('issue', ['iss_edge'])).get('iss_edge') ?? [])).toEqual(normal(without))
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    await expectAnswers(store, ids, model)

    // A read scope that spans a write sees the write (the loader is invalidated).
    await withReadScope(async () => {
      expect(normal(await store.grants.loadForResource('session', 'session-edge'))).toEqual(normal(model.edges('session', 'session-edge')))
      await store.grants.removeAllForResource('session', 'session-edge')
      model.removeResource('session', 'session-edge')
      expect(await store.grants.loadForResource('session', 'session-edge')).toEqual([])
    })
    await expectAnswers(store, ids, model)

    // A member removal revokes every incoming share at once.
    await store.grants.removeAllForGrantee(users[1]!)
    model.removeGrantee(users[1]!)
    await expectAnswers(store, ids, model)
  })
})
