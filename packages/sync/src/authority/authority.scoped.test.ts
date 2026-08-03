/**
 * READ-SIDE SCOPING IS BUILT — the positive form of `authority.unscoped.test.ts`
 * (POD-1077, landing the tripwire POD-305 left).
 *
 * ---------------------------------------------------------------------------
 * WHAT FLIPPED, ASSERTION BY ASSERTION
 * ---------------------------------------------------------------------------
 *
 *  1. *"every subscriber receives every change, whoever they stand for"* — three
 *     subscribers standing for three principals now receive three slices, and
 *     each is watermarked forward over what it did not see.
 *  2. *"`changesSince` serves the whole global range to any caller"* — it takes a
 *     principal and there is no unscoped overload, so a caller cannot get one.
 *  3. *"`subscribe()` takes NO principal — a scoped feed is unrepresentable"* —
 *     the arity the tripwire pinned at 1 is 2, and pinned again here.
 *  4. *"no `evict` op reaches a subscriber, because nothing produces one"* — a
 *     revoke now produces exactly one, DERIVED from the policy at the seq of the
 *     change that caused it (D14.1/D14.3), and `remove` is still never used for
 *     it (D14.5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REFUSING ARM OF EACH CASE DEPENDS ON
 * ---------------------------------------------------------------------------
 *
 * This run's dominant defect is a suite that cannot say NO — including POD-351's,
 * where every revocation test ran as an OPERATOR whose scope short-circuits
 * authorization before the owner is even read, so the whole suite would have
 * passed against an implementation with no ownership check at all.
 *
 * So the fixture here has NO privileged principal and no short-circuit: the
 * policy is the shipped `GrantEdgeVisibilityPolicy` over a grant table this file
 * controls row by row, and every "cannot see" case is a principal for whom that
 * table is genuinely empty. The environmental fact each refusal depends on is one
 * this file sets directly — a missing grant, a missing classification, a scope
 * that does not contain the key — and every one of them is reachable in a plain
 * unit test with no server, no socket and no clock.
 */

import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  asUserId,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type Principal } from '@podium/protocol'
import { Authority } from './authority'
import type { ChangeLogReadRow, StagedChangeSpec } from './change-lifecycle'
import type { ChangeLogStore } from '../change-log'
import {
  GrantEdgeVisibilityPolicy,
  type EntityRef,
  type VisibilityAnchorPort,
  type DelegatedScope,
  type DelegationScopePort,
  type VisibilityStatePort,
} from '../feed/visibility'
import type { VisibilityClass } from '@podium/model'

function memoryStore(): ChangeLogStore {
  const rows: ChangeLogReadRow[] = []
  let nextSeq = 1
  return {
    appendChanges(batch) {
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
    // LATEST PER (entity, id), which is what the port says and what the sqlite
    // adapter's GROUP BY does. This fake returned the whole table, which was
    // invisible while the only consumer was the dedup baseline (a later row just
    // overwrites an earlier one in the fold) and became wrong the moment
    // `bootstrap` read it as a world: every historical write reappeared as its
    // own row, and a deleted entity came back alive under its stale upsert.
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  }
}

const upsert = (id: string, value: unknown): StagedChangeSpec => ({
  entity: 'session',
  entityId: id,
  op: 'upsert',
  value,
})

const key = (ref: EntityRef): string => `${ref.entity}:${ref.entityId}`

/**
 * The DATA half, under this file's control.
 *
 * A hand-built table and not a mock library, because every case's refusal has to
 * be traceable to a row that is present or absent HERE. `classes` starts with one
 * declared kind and nothing else: an entity kind this file never classifies is
 * refused as `unclassified`, which is a case rather than an accident.
 */
function state() {
  const grants = new Map<string, Set<string>>()
  const classes = new Map<string, VisibilityClass>([['session', 'personal']])
  const keyedUsers = new Map<string, string>()
  const values = new Map<string, unknown>()
  const edges = new Map<
    string,
    { audience: readonly string[]; subjects: readonly EntityRef[] }
  >()

  const scopes = new Map<string, DelegatedScope>()

  const port: VisibilityStatePort & VisibilityAnchorPort & DelegationScopePort = {
    classOf: (entity) => classes.get(entity) ?? null,
    mayRead: (user, ref) => grants.get(user)?.has(key(ref)) === true,
    keyedUserOf: (ref) => keyedUsers.get(key(ref)) ?? null,
    visibilityEdge: (ref) => edges.get(key(ref)) ?? null,
    currentValueOf: (ref) => values.get(key(ref)),
    // DEFAULT-CLOSED for a delegation nobody minted: an empty key set. `all`
    // here would make every A2 case pass without the scope doing any work.
    scopeOf: (delegation) => scopes.get(delegation) ?? { kind: 'entities', keys: new Set() },
  }

  return {
    port,
    /** Mint a delegation with what it was spawned for (ADR 9 D5 A2). */
    delegate(delegation: string, scope: DelegatedScope) {
      scopes.set(delegation, scope)
    },
    grant(user: string, ref: EntityRef) {
      const set = grants.get(user) ?? new Set<string>()
      set.add(key(ref))
      grants.set(user, set)
    },
    revoke(user: string, ref: EntityRef) {
      grants.get(user)?.delete(key(ref))
    },
    classify(entity: string, visibility: VisibilityClass) {
      classes.set(entity, visibility)
    },
    unclassify(entity: string) {
      classes.delete(entity)
    },
    keyTo(ref: EntityRef, user: string) {
      keyedUsers.set(key(ref), user)
    },
    value(ref: EntityRef, value: unknown) {
      values.set(key(ref), value)
    },
    /** Declare that a row, when it appears in the log, MOVES visibility. */
    edge(ref: EntityRef, audience: readonly string[], subjects: readonly EntityRef[]) {
      edges.set(key(ref), { audience, subjects })
    },
  }
}

function build(rescopeThreshold = 32) {
  const tables = state()
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1,
    transact: (fn) => fn(),
    visibility: new GrantEdgeVisibilityPolicy(tables.port, tables.port),
    anchors: tables.port,
    rescopeThreshold,
  })
  return { authority, tables }
}

const testUser = (id: string): Principal => ({
  kind: 'user',
  user: asUserId(id),
  device: asDeviceId(`dev:${id}`),
  capability: asCapabilityRef(`cap:${id}`),
})

const ADA: Principal = testUser('ada')
const GRACE: Principal = testUser('grace')
const ANON: Principal = testUser('anonymous')

const ref = (entityId: string): EntityRef => ({ entity: 'session', entityId })

/** Collect one principal's deliveries. Records the RANGE as well as the rows. */
function collect(authority: Authority, principal: Principal) {
  const seen: { throughSeq: number; ids: string[]; ops: string[]; kind: string }[] = []
  authority.subscribe(principal, (delivery) => {
    seen.push(
      delivery.kind === 'batch'
        ? {
            kind: 'batch',
            throughSeq: delivery.throughSeq,
            ids: delivery.changes.map((c) => c.entityId),
            ops: delivery.changes.map((c) => c.op),
          }
        : { kind: 'rescope', throughSeq: delivery.throughSeq, ids: [], ops: [] },
    )
  })
  return seen
}

describe('three subscribers, three principals, three slices', () => {
  it('each receives only what it may see', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('ada-private'))
    tables.grant('grace', ref('grace-private'))

    const ada = collect(authority, ADA)
    const grace = collect(authority, GRACE)
    const anonymous = collect(authority, ANON)

    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('grace-private', { owner: 'grace' })])

    expect(ada.flatMap((d) => d.ids)).toEqual(['ada-private'])
    expect(grace.flatMap((d) => d.ids)).toEqual(['grace-private'])
    // The one with no grants at all sees nothing — and this is the assertion that
    // would fail against an implementation with no ownership check, because there
    // is no privileged principal here whose scope short-circuits the check first.
    expect(anonymous.flatMap((d) => d.ids)).toEqual([])
  })

  it('a principal who sees NOTHING is still told how far the log was evaluated', () => {
    // THE watermark property, on the live path. Suppression without this is the
    // permanent invisible gap: the replica's `fromSeq === cursor` fails, it heals,
    // the heal returns the same filtered rows, forever.
    const { authority, tables } = build()
    tables.grant('ada', ref('ada-private'))
    const anonymous = collect(authority, ANON)

    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('another', { owner: 'ada' })])

    expect(anonymous.map((d) => [d.ids.length, d.throughSeq])).toEqual([
      [0, 1],
      [0, 2],
    ])
  })

  it('changesSince serves ONE principal its slice, certified to the log head', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('ada-private'))
    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('grace-private', { owner: 'grace' })])

    const mine = authority.changesSince(0, ADA)
    expect(mine?.kind === 'batch' && mine.changes.map((c) => c.entityId)).toEqual(['ada-private'])
    // Certified to the HEAD and not to the last visible row: seq 2 was evaluated
    // and suppressed, and a reply stopping at 1 would leave it uncertified — the
    // same gap, arriving on the heal path where a replica is least able to notice.
    expect(mine?.kind === 'batch' && mine.throughSeq).toBe(2)

    const theirs = authority.changesSince(0, ANON)
    expect(theirs?.kind === 'batch' && theirs.changes).toEqual([])
    expect(theirs?.kind === 'batch' && theirs.throughSeq).toBe(2)
  })

  it('the live path and the heal path agree over the same range', () => {
    // Not asserted against a literal on each side: a restatement of the scoping
    // rule in one path would be byte-identical in the common case and invisible to
    // a golden fixture. Diffing the two is what catches a second filtering site.
    const { authority, tables } = build()
    tables.grant('ada', ref('mine'))
    const live = collect(authority, ADA)

    authority.capture([upsert('mine', { n: 1 })])
    authority.capture([upsert('theirs', { n: 2 })])

    const healed = authority.changesSince(0, ADA)
    expect(healed?.kind === 'batch' && healed.changes.map((c) => c.entityId)).toEqual(
      live.flatMap((d) => d.ids),
    )
  })

  it('subscribe() takes a principal — the arity the tripwire pinned at 1', () => {
    expect(Authority.prototype.subscribe.length).toBe(2)
    expect(Authority.prototype.changesSince.length).toBe(2)
  })
})

describe('the CLASS rules refuse, and each refusal is distinguishable', () => {
  it('an UNCLASSIFIED entity kind is invisible — and says so, not "personal"', () => {
    // Tonight's defect elsewhere in this run: a default-closed backstop that
    // returns the same answer for "deliberately personal" and "never classified"
    // cannot tell a decision from an omission. Here they are different reasons.
    const { authority, tables } = build()
    const policy = new GrantEdgeVisibilityPolicy(tables.port, tables.port)
    tables.grant('ada', { entity: 'conversation', entityId: 'c1' })

    // Granted, and STILL refused, because the kind carries no declaration.
    expect(policy.decide(ADA, { entity: 'conversation', entityId: 'c1' })).toEqual({
      visible: false,
      reason: 'unclassified',
    })
    // Classify it, and the same grant now admits it — so the refusal above was
    // the missing declaration and not a broken grant table.
    tables.classify('conversation', 'personal')
    expect(policy.decide(ADA, { entity: 'conversation', entityId: 'c1' })).toEqual({
      visible: true,
      reason: 'granted',
    })
    expect(authority.changesSince(0, ADA)?.kind).toBe('batch')
  })

  it('a SECRET never replicates, grant or no grant (ADR 1 D6)', () => {
    const { tables } = build()
    const policy = new GrantEdgeVisibilityPolicy(tables.port, tables.port)
    tables.classify('session', 'secret')
    tables.grant('ada', ref('s1'))

    expect(policy.decide(ADA, ref('s1'))).toEqual({
      visible: false,
      reason: 'secret-never-replicates',
    })
  })

  it('PER-USER STATE is visible only to the user in its key, and a grant cannot widen it', () => {
    const { tables } = build()
    const policy = new GrantEdgeVisibilityPolicy(tables.port, tables.port)
    tables.classify('session', 'per-user-state')
    tables.keyTo(ref('readAt'), 'ada')
    // Grace holds an explicit grant and still may not see it: per-user state is
    // never shared and never grantable (ADR 9 D3).
    tables.grant('grace', ref('readAt'))

    expect(policy.decide(ADA, ref('readAt')).visible).toBe(true)
    expect(policy.decide(GRACE, ref('readAt'))).toEqual({
      visible: false,
      reason: 'per-user-state-not-yours',
    })
  })

  it('SUBSTRATE is tenant-visible without a grant — the positive arm', () => {
    // Without this, "everything is refused" would satisfy every case above, and a
    // policy that refused unconditionally would look correct.
    const { tables } = build()
    const policy = new GrantEdgeVisibilityPolicy(tables.port, tables.port)
    tables.classify('session', 'deployment-substrate')

    expect(policy.decide(ANON, ref('lock-1'))).toEqual({ visible: true, reason: 'substrate' })
  })

  it("an agent sees its human's grants INTERSECTED with its own scope, never unioned", () => {
    const { tables } = build()
    const policy = new GrantEdgeVisibilityPolicy(tables.port, tables.port)
    tables.grant('ada', ref('in-scope'))
    tables.grant('ada', ref('out-of-scope'))
    // The scope lives on the PORT now, keyed by the ref the principal carries.
    tables.delegate('del-sess-1', { kind: 'entities', keys: new Set(['session:in-scope']) })
    const agent: Principal = {
      kind: 'agent',
      agentIdentity: asAgentIdentityId('sess-1'),
      onBehalfOf: asUserId('ada'),
      device: asDeviceId('dev:sess-1'),
      capability: asCapabilityRef('cap:sess-1'),
      delegation: asDelegationRef('del-sess-1'),
    }

    expect(policy.decide(agent, ref('in-scope')).visible).toBe(true)
    expect(policy.decide(agent, ref('out-of-scope'))).toEqual({
      visible: false,
      reason: 'outside-delegated-scope',
    })
    // And the ceiling is the human's CURRENT rights, resolved live: revoke the
    // human and the in-scope answer flips, with no agent-side state to go stale.
    tables.revoke('ada', ref('in-scope'))
    expect(policy.decide(agent, ref('in-scope')).visible).toBe(false)
  })
})

describe('a visibility change is DERIVED, and it is never a remove (D14)', () => {
  it('a revoke anchors an EVICT at the seq of the change that caused it', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('shared'))
    authority.capture([upsert('shared', { n: 1 })])
    const ada = collect(authority, ADA)

    // The grant row: a durable change that MOVES visibility. The policy is
    // updated first — the authority reads the world as it is after the write.
    tables.revoke('ada', ref('shared'))
    tables.edge(ref('grant-row'), ['ada'], [ref('shared')])
    authority.capture([upsert('grant-row', { revoked: 'shared' })])

    const [delivery] = ada
    expect(delivery?.ops).toEqual(['evict'])
    expect(delivery?.ids).toEqual(['shared'])
    // D14.5, asserted directly: `remove` would make the replica render a revoked
    // share as a deletion, and a later re-grant as a resurrection.
    expect(delivery?.ops).not.toContain('remove')
    // D14.3 — anchored at the causing seq, inside the frame whose range contains it.
    expect(delivery?.throughSeq).toBe(2)
  })

  it('a grant anchors a RE-ADMITTING UPSERT carrying the current value', () => {
    const { authority, tables } = build()
    authority.capture([upsert('shared', { n: 1 })])
    tables.value(ref('shared'), { n: 1 })
    const ada = collect(authority, ADA)

    tables.grant('ada', ref('shared'))
    tables.edge(ref('grant-row'), ['ada'], [ref('shared')])
    authority.capture([upsert('grant-row', { granted: 'shared' })])

    expect(ada[0]?.ops).toEqual(['upsert'])
    expect(ada[0]?.ids).toEqual(['shared'])
  })

  it('THE OP FOLLOWS THE POLICY: the same input yields evict or upsert', () => {
    // The steer this issue was given, as a test rather than as a property of the
    // current code. The two runs below differ in ONE thing — whether the grant
    // table admits the subject — and the op flips. No input names it, and there is
    // no parameter by which one could.
    const run = (granted: boolean) => {
      const { authority, tables } = build()
      authority.capture([upsert('subject', { n: 1 })])
      tables.value(ref('subject'), { n: 1 })
      if (granted) tables.grant('ada', ref('subject'))
      const ada = collect(authority, ADA)
      tables.edge(ref('grant-row'), ['ada'], [ref('subject')])
      authority.capture([upsert('grant-row', { touched: 'subject' })])
      return ada[0]?.ops ?? []
    }

    expect(run(true)).toEqual(['upsert'])
    expect(run(false)).toEqual(['evict'])
  })

  it('a principal NOT in the audience sees the grant seq as a watermark, not an evict', () => {
    // Existence leak (`docs/multi-user-readiness.md` §3.1.2): telling Grace that
    // `shared` was evicted would tell her it exists. She gets the range and
    // nothing in it.
    const { authority, tables } = build()
    tables.grant('ada', ref('shared'))
    authority.capture([upsert('shared', { n: 1 })])
    const grace = collect(authority, GRACE)

    tables.revoke('ada', ref('shared'))
    tables.edge(ref('grant-row'), ['ada'], [ref('shared')])
    authority.capture([upsert('grant-row', { revoked: 'shared' })])

    expect(grace).toEqual([{ kind: 'batch', throughSeq: 2, ids: [], ops: [] }])
  })

  it('a re-grant re-admits the same entity — eviction is REVERSIBLE (D14.2)', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('shared'))
    authority.capture([upsert('shared', { n: 1 })])
    tables.value(ref('shared'), { n: 1 })
    const ada = collect(authority, ADA)
    tables.edge(ref('grant-row'), ['ada'], [ref('shared')])

    tables.revoke('ada', ref('shared'))
    authority.capture([upsert('grant-row', { revoked: 'shared' })])
    tables.grant('ada', ref('shared'))
    authority.capture([upsert('grant-row', { granted: 'shared' })])

    expect(ada.map((d) => d.ops)).toEqual([['evict'], ['upsert']])
  })
})

describe('rescope is derived from the SIZE of the derived set (D14.4)', () => {
  it('a visibility change over the threshold takes the terminal path', () => {
    const { authority, tables } = build(2)
    const subjects = ['a', 'b', 'c', 'd'].map(ref)
    for (const s of subjects) tables.grant('ada', s)
    const ada = collect(authority, ADA)

    tables.edge(ref('role-change'), ['ada'], subjects)
    authority.capture([upsert('role-change', { role: 'member' })])

    expect(ada[0]?.kind).toBe('rescope')
    // Still carries the range, so the rescope cannot be mistaken for silence.
    expect(ada[0]?.throughSeq).toBe(1)
  })

  it('the SAME shape under the threshold enumerates instead — the paired half', () => {
    // Without this, "it rescopes" is equally consistent with an implementation
    // that rescopes on every visibility change, which would make the cheap
    // incremental path (D14.1/D14.2) dead code.
    const { authority, tables } = build(8)
    const subjects = ['a', 'b', 'c', 'd'].map(ref)
    for (const s of subjects) {
      tables.grant('ada', s)
      tables.value(s, { id: s.entityId })
    }
    const ada = collect(authority, ADA)

    tables.edge(ref('role-change'), ['ada'], subjects)
    authority.capture([upsert('role-change', { role: 'member' })])

    expect(ada[0]?.kind).toBe('batch')
    expect(ada[0]?.ids).toEqual(['a', 'b', 'c', 'd'])
  })
})

/**
 * BOOTSTRAP IS THE SAME FEED, READ AS A WORLD (POD-1203).
 *
 * The serving-path cutover deletes the full-list snapshot fan-out, so "what is
 * there?" has to be answerable from the log itself. Every case below drives
 * `bootstrap` and NOTHING else — there is no list-rebuilding collaborator in this
 * fixture for an answer to come from, which is the property that makes these
 * assertions about the feed rather than about a fake.
 *
 * WHAT EACH REFUSING ARM DEPENDS ON: a missing grant row in the table this file
 * owns. `ANON` holds none, ever, and there is no privileged principal here whose
 * scope could short-circuit the check — the POD-351 shape this suite was built
 * against in the first place.
 */
describe('bootstrap — the installed world for ONE principal', () => {
  it('serves the current value of every row the principal may see', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('a'))
    authority.capture([upsert('a', { v: 1 })])
    authority.capture([upsert('a', { v: 2 })])

    const world = authority.bootstrap(ADA)
    // ONE row per entity, carrying the LATEST value — not a replay of both writes.
    expect(world.changes.map((c) => [c.entityId, c.op])).toEqual([['a', 'upsert']])
    expect(world.changes[0]?.op === 'upsert' && world.changes[0].value).toEqual({ v: 2 })
  })

  it('is read at the head, so the delta stream resumes with no gap', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('a'))
    authority.capture([upsert('a', { v: 1 })])
    authority.capture([upsert('grace-only', { v: 1 })])

    // The head, NOT the last visible row's seq. A bootstrap certified at seq 1
    // would leave seq 2 uncertified for Ada forever: she was evaluated for it and
    // suppressed, and a feed attached at 1 would re-ask and be suppressed again.
    expect(authority.bootstrap(ADA).throughSeq).toBe(2)
  })

  it('suppresses a row the principal may not see', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('ada-private'))
    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('grace-private', { owner: 'grace' })])

    expect(authority.bootstrap(ADA).changes.map((c) => c.entityId)).toEqual(['ada-private'])
    // The paired half. Without it, "Ada sees hers" passes against an
    // implementation that hands everyone everything.
    expect(authority.bootstrap(ANON).changes).toEqual([])
    // ...and it still says how far the world was read, so an empty world is
    // positionable rather than indistinguishable from "not read yet".
    expect(authority.bootstrap(ANON).throughSeq).toBe(2)
  })

  it('installs POSITIVE STATE ONLY — a removed entity is absent, not a tombstone', () => {
    const { authority, tables } = build()
    tables.grant('ada', ref('a'))
    tables.grant('ada', ref('b'))
    authority.capture([upsert('a', { v: 1 })])
    authority.capture([upsert('b', { v: 1 })])
    authority.capture([{ entity: 'session', entityId: 'a', op: 'remove' }])

    const world = authority.bootstrap(ADA)
    expect(world.changes.map((c) => c.entityId)).toEqual(['b'])
    // A `remove` in a bootstrap would have the replica write a tombstone for an
    // entity it was never told about (ADR 2 D15 — positive state only).
    expect(world.changes.every((c) => c.op === 'upsert')).toBe(true)
  })

  it('does not derive evicts or take the rescope path — a bootstrap has no "before"', () => {
    // The anchor half of `scopeBatch` is deliberately absent here. Run over a
    // whole world it would trip the threshold on any instance with grant edges,
    // and a `rescope` mid-bootstrap tells a replica to re-bootstrap while it is
    // bootstrapping. The threshold is 2 and there are 4 anchored subjects, so the
    // live path WOULD rescope over exactly this data — which is what makes this a
    // test of the difference and not a restatement of the case above.
    const { authority, tables } = build(2)
    const subjects = ['a', 'b', 'c', 'd'].map(ref)
    for (const s of subjects) {
      tables.grant('ada', s)
      authority.capture([upsert(s.entityId, { id: s.entityId })])
    }
    tables.edge(ref('role-change'), ['ada'], subjects)
    tables.grant('ada', ref('role-change'))
    authority.capture([upsert('role-change', { role: 'member' })])

    const world = authority.bootstrap(ADA)
    expect(world.changes.map((c) => c.entityId)).toEqual(['a', 'b', 'c', 'd', 'role-change'])
    expect(world.changes.some((c) => c.op === 'evict')).toBe(false)
  })
})
