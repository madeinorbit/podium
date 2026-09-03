/**
 * THE BOOTSTRAP MUST NOT BE QUADRATIC IN THE CORPUS (POD-1614).
 *
 * ---------------------------------------------------------------------------
 * WHAT BROKE, STATED AS A MECHANISM
 * ---------------------------------------------------------------------------
 *
 * `scopeBootstrap` (packages/sync/src/authority/scoping.ts) asks the visibility
 * policy about EVERY ROW of the principal's world, one call per row. The
 * `conversation` arm of the policy `relay.ts` builds answered by loading the
 * WHOLE sessions table and linear-scanning it for a matching `resumeValue`:
 *
 *     const row = this.store.sessions.loadSessions().find(c => c.resumeValue === id)
 *
 * So one bootstrap cost `conversation rows x sessions`. On the live corpus
 * (2019 conversation rows, 1115 sessions) that measured 15.9 s p50 / 21.1 s max
 * in the server's own `feedBootstrap.read` counter — 18.9 s of it accounted for
 * by 2019 calls to `loadSessions()` at 9.34 ms each.
 *
 * The read is SYNCHRONOUS, so that is the event loop blocked whole. Everything
 * the operator saw came off that one wall: `/auth/status` taking 18.5 s, the
 * client's 10 s heartbeat deadline firing and force-closing the socket mid-
 * bootstrap, the reconnect starting a fresh 16-21 s bootstrap, and the app
 * taking ~60 s and two dropped connections to become usable.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASSERTS A CALL COUNT AND NOT A DURATION
 * ---------------------------------------------------------------------------
 *
 * A wall-clock bound is the obvious test and the wrong one: this repo's lanes
 * run under load, so a duration assertion measures the host and flakes, and to
 * be reliable it would need a corpus big enough to be slow — which makes the
 * fixture itself expensive. The DEFECT is not "slow", it is "does per-row work
 * that scales with the table". A call count states exactly that and is
 * deterministic at any size.
 *
 * It can say NO: before the fix `loadSessions()` is called once per conversation
 * row, so this reads CONVERSATIONS (24) instead of 0, and the second case's two
 * corpus sizes differ instead of matching.
 */

import { asUserId, issueDepId, SOLE_USER_ID } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'

const OWNER = asUserId(SOLE_USER_ID)

/** The principal a real connection is served under — `relay.ts` builds this same
 *  shape from the authenticated transport, never from a payload. */
const feedPrincipal: Principal = {
  kind: 'user',
  user: OWNER,
  device: asDeviceId('dev:probe'),
  capability: asCapabilityRef('cap:probe'),
}

/** The registry's own `Ledger` and store — private, so the reach-in is named
 *  once here rather than cast at every call site (as `automation-removal-
 *  scoping.test.ts` does for the same reason). */
const internals = (reg: SessionRegistry) =>
  reg as unknown as { ledger: Ledger; store: SessionStore }

/**
 * Append `count` conversation rows to the change log, through the Ledger — the
 * same seam `MemoryService.reconcileConversations` writes them on. Their ids are
 * the `resumeValue`s the policy will be asked to resolve.
 */
function seedConversations(reg: SessionRegistry, count: number): number {
  const specs: EntityChangeSpec[] = Array.from({ length: count }, (_, i) => ({
    entity: 'conversation',
    id: `conv-${i}`,
    op: 'upsert',
    value: { id: `conv-${i}`, machineId: 'm1', nativeId: `conv-${i}` },
  }))
  return internals(reg).ledger.capture(specs).length
}

/** How many times a bootstrap loads the WHOLE sessions table. */
function loadSessionsCallsDuringBootstrap(reg: SessionRegistry): number {
  const { ledger, store } = internals(reg)
  const original = store.sessions.loadSessions.bind(store.sessions)
  let calls = 0
  store.sessions.loadSessions = () => {
    calls++
    return original()
  }
  try {
    ledger.authority.bootstrap(feedPrincipal)
  } finally {
    store.sessions.loadSessions = original
  }
  return calls
}

/**
 * How many times a bootstrap reaches the repository for issues and sessions,
 * split into BATCHED calls and POINT reads.
 *
 * The point-read counters are what state the defect: POD-1732 measured
 * ~3,400 `getIssue` and ~3,000 `findSessionByResumeValue` calls in a single
 * live bootstrap, which was 76% of `feedBootstrap.read` on its own. Counting
 * batches AND points separately is deliberate — a fix that merely memoized
 * would drive points down without ever producing a batch, and this has to tell
 * those two apart.
 */
function bootstrapRepositoryCalls(reg: SessionRegistry): {
  batches: number
  pointReads: number
} {
  const { ledger, store } = internals(reg)
  const originals = {
    getIssue: store.issues.getIssue.bind(store.issues),
    getIssues: store.issues.getIssues.bind(store.issues),
    getSession: store.sessions.getSession.bind(store.sessions),
    getSessions: store.sessions.getSessions.bind(store.sessions),
    findOne: store.sessions.findSessionByResumeValue.bind(store.sessions),
    findMany: store.sessions.findSessionsByResumeValues.bind(store.sessions),
  }
  let batches = 0
  let pointReads = 0
  store.issues.getIssue = (id) => {
    pointReads++
    return originals.getIssue(id)
  }
  store.sessions.getSession = (id) => {
    pointReads++
    return originals.getSession(id)
  }
  store.sessions.findSessionByResumeValue = (v) => {
    pointReads++
    return originals.findOne(v)
  }
  store.issues.getIssues = (ids) => {
    batches++
    return originals.getIssues(ids)
  }
  store.sessions.getSessions = (ids) => {
    batches++
    return originals.getSessions(ids)
  }
  store.sessions.findSessionsByResumeValues = (vs) => {
    batches++
    return originals.findMany(vs)
  }
  try {
    ledger.authority.bootstrap(feedPrincipal)
  } finally {
    store.issues.getIssue = originals.getIssue
    store.issues.getIssues = originals.getIssues
    store.sessions.getSession = originals.getSession
    store.sessions.getSessions = originals.getSessions
    store.sessions.findSessionByResumeValue = originals.findOne
    store.sessions.findSessionsByResumeValues = originals.findMany
  }
  return { batches, pointReads }
}

describe('POD-1614 — a bootstrap does not re-read the sessions table per row', () => {
  it('never loads the whole sessions table while scoping conversation rows', () => {
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const CONVERSATIONS = 24

    // CONTROL: the rows really landed in the change log, so the bootstrap below
    // has 24 conversation rows to ask the policy about. Without this, a count of
    // 0 would pass just as well against a world that was empty — which is the
    // one way this assertion could be satisfied for the wrong reason.
    expect(seedConversations(reg, CONVERSATIONS)).toBe(CONVERSATIONS)

    // THE ASSERTION THAT WAS FAILING. Before the fix this was CONVERSATIONS: one
    // full 49-column load of every session, per conversation row.
    expect(loadSessionsCallsDuringBootstrap(reg)).toBe(0)
  })

  it('costs the same whether the corpus has 8 conversation rows or 64', () => {
    const small = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    seedConversations(small, 8)
    const large = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    seedConversations(large, 64)

    // The property, stated directly: growing the corpus 8x must not grow the
    // per-row table scans at all. Before the fix these read 8 and 64.
    expect(loadSessionsCallsDuringBootstrap(large)).toBe(loadSessionsCallsDuringBootstrap(small))
  })
  it('memoizes authorization snapshots across anchored issue refs and refreshes after append', () => {
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const { ledger, store } = internals(reg)
    for (const issueId of ['i1', 'i2']) {
      store.grants.upsert({
        resourceKind: 'issue',
        resourceId: issueId,
        grantee: OWNER,
        verb: 'read',
        owner: OWNER,
        visibility: 'personal',
        createdAt: '2026-01-01T00:00:00.000Z',
        actorKind: 'user',
        actorId: 'cache-test',
        onBehalfOf: OWNER,
      })
    }
    const latestStates = vi.spyOn(store.sync, 'latestChangeStates')
    // RE-POINTED, NOT RELAXED [POD-3261]. The conserved quantity this test names
    // is ONE SESSION READ per generation, however many anchored issue refs the
    // batch carries; only the read changed. It was `loadSessions()` — every live
    // row, 49 columns, filtered in memory — and it is now the indexed
    // `issue_id IN (…)` lookup, sized once from the issues that have a
    // visibility audience. `loadSessions` is asserted to be gone from this path
    // as well, so the count below cannot be satisfied by the old read coming
    // back beside the new one.
    const sessionLoads = vi.spyOn(store.sessions, 'findSessionsByIssueIds')
    const wholeTableLoads = vi.spyOn(store.sessions, 'loadSessions')
    const dependencyId = issueDepId('i1', 'i-target', 'blocks')
    store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issueDep', entityId: dependencyId, op: 'upsert', payload: '{"dep":true}' },
      ],
      1000,
    )
    const first = ledger.authority.changesSince(0, feedPrincipal)
    if (first === null || first.kind !== 'batch') {
      throw new Error('expected the first scoped delivery to be a batch')
    }
    // Before the fix, this fixture made 5 latest-state folds (one anchor scan
    // plus current values) and 2 full session loads. The conserved quantities
    // are now one fold and one session read.
    expect(latestStates).toHaveBeenCalledTimes(1)
    expect(sessionLoads).toHaveBeenCalledTimes(1)
    expect(wholeTableLoads).toHaveBeenCalledTimes(0)
    expect(
      first.changes.filter(
        (change) => change.entity === 'issue' && change.entityId === 'i1' && change.op === 'upsert',
      ),
    ).toHaveLength(2)
    expect(first.changes).toContainEqual(
      expect.objectContaining({
        entity: 'issue',
        entityId: 'i1',
        op: 'upsert',
        value: { v: 1 },
      }),
    )
    expect(first.changes).toContainEqual(
      expect.objectContaining({
        entity: 'issueDep',
        entityId: dependencyId,
        op: 'upsert',
        value: { dep: true },
      }),
    )

    const cursor = store.sync.maxChangeSeq()
    store.sync.appendChanges(
      [{ entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' }],
      2000,
    )
    const second = ledger.authority.changesSince(cursor, feedPrincipal)
    if (second === null || second.kind !== 'batch') {
      throw new Error('expected the refreshed scoped delivery to be a batch')
    }
    // A durable append changes the generation before evaluation, so current
    // values cannot come from the previous authorization snapshot.
    expect(latestStates).toHaveBeenCalledTimes(2)
    expect(sessionLoads).toHaveBeenCalledTimes(2)
    expect(second.changes).toContainEqual(
      expect.objectContaining({
        entity: 'issue',
        entityId: 'i1',
        op: 'upsert',
        value: { v: 2 },
      }),
    )
  })
})

describe('POD-1732 — a bootstrap resolves visibility in batches, not per row', () => {
  it('grows its corpus without growing its point-read count', () => {
    const small = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const large = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })

    // CONTROL, same reason as the POD-1614 case above: prove the rows landed,
    // or a count of 0 passes against an empty world for the wrong reason.
    expect(seedConversations(small, 8)).toBe(8)
    expect(seedConversations(large, 64)).toBe(64)

    const a = bootstrapRepositoryCalls(small)
    const b = bootstrapRepositoryCalls(large)

    // THE CONSERVED QUANTITY. An 8x corpus must not multiply the reads. Before
    // POD-1732 the point reads scaled with the row count — the live bootstrap
    // did ~3,400 getIssue and ~3,000 findSessionByResumeValue calls — so this
    // read 8-vs-64 instead of matching.
    expect(b.pointReads).toBe(a.pointReads)

    // AND IT MUST BE A BATCH, not a memo. A memoizing fix also flattens the
    // point-read count, so without this a cache would pass a batching test.
    // The prefetch runs once per non-empty set, so the count is bounded and
    // identical at both sizes rather than proportional to either.
    expect(b.batches).toBe(a.batches)
    expect(b.batches).toBeLessThanOrEqual(3)
  })
})

/**
 * THE GRANT READ IS THE ONE THAT WAS LEFT [POD-3261].
 *
 * POD-1614 and POD-1732 above batched the ROW reads a bootstrap makes — the
 * issue, the session, the conversation. What they left per row is the read that
 * happens when the OWNER CHECK MISSES: `grants.listForResource(kind, id)`, once
 * per subject, and on a shared corpus that is every row. On bun:sqlite it is a
 * cheap indexed lookup; on the hosted Turso backend this epic is preparing for,
 * it is a network round trip at ~95 ms, so a 400-row shared world is 38 seconds
 * of nothing but permission lookups.
 *
 * The prefetch reads them for the whole pass in one statement. Two conserved
 * quantities are asserted here because the mechanism can fail in two different
 * directions and each has its own arm:
 *
 *   PER PASS, NOT PER ROW — the bootstrap case. Growing the shared corpus must
 *   not grow the count.
 *
 *   PER BATCH, NOT PER PRINCIPAL — the phase-3 case. `Authority.broadcast`
 *   evaluates one appended batch for every subscriber in turn, so a prefetch
 *   built inside the per-principal call would be rebuilt N times and would look
 *   perfect in the bootstrap test above while doing nothing for the fan-out that
 *   actually runs on every commit.
 *
 * And both count `listForResource` (the point read) SEPARATELY from
 * `listForResources` (the batch), for POD-1732's reason: a fix that merely
 * memoized would drive the point reads down without ever issuing a batch, and
 * these have to be able to tell those apart.
 */
const OTHER_OWNER = asUserId('usr_someone_else')

/** Issue ids in the change log, owned by somebody else and read-granted to
 *  OWNER — so every one of them reaches the grant check rather than stopping at
 *  the owner check. No durable issue row is written on purpose: an absent row is
 *  the same miss a row owned by another user produces, by the same line. */
function seedGrantedIssues(reg: SessionRegistry, count: number): number {
  const { ledger, store } = internals(reg)
  const ids = Array.from({ length: count }, (_, i) => `iss_shared_${i}`)
  for (const id of ids) {
    store.grants.upsert({
      resourceKind: 'issue',
      resourceId: id,
      grantee: OWNER,
      verb: 'read',
      owner: OTHER_OWNER,
      visibility: 'personal',
      createdAt: '2026-01-01T00:00:00.000Z',
      actorKind: 'user',
      actorId: 'grant-batching-probe',
      onBehalfOf: OTHER_OWNER,
    })
  }
  return ledger.capture(
    ids.map((id) => ({ entity: 'issue', id, op: 'upsert', value: { id } }) as EntityChangeSpec),
  ).length
}

/** Point reads and batched reads of the `grants` table during `run`. */
function grantReadsDuring(reg: SessionRegistry, run: () => void): {
  points: number
  batches: number
} {
  const { store } = internals(reg)
  const one = store.grants.listForResource.bind(store.grants)
  const many = store.grants.listForResources.bind(store.grants)
  let points = 0
  let batches = 0
  store.grants.listForResource = (kind, id) => {
    points++
    return one(kind, id)
  }
  store.grants.listForResources = (kind, ids) => {
    batches++
    return many(kind, ids)
  }
  try {
    run()
  } finally {
    store.grants.listForResource = one
    store.grants.listForResources = many
  }
  return { points, batches }
}

describe('POD-3261 — a pass reads grants once, not once per row or once per principal', () => {
  it('reads the shared corpus grants in one statement, however large the corpus', () => {
    const small = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const large = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })

    // CONTROL. Without it a count of 0 passes just as well against a world with
    // no shared rows in it, which is the one way this could be satisfied for the
    // wrong reason.
    expect(seedGrantedIssues(small, 4)).toBe(4)
    expect(seedGrantedIssues(large, 32)).toBe(32)

    const a = grantReadsDuring(small, () => {
      internals(small).ledger.authority.bootstrap(feedPrincipal)
    })
    const b = grantReadsDuring(large, () => {
      internals(large).ledger.authority.bootstrap(feedPrincipal)
    })

    // THE CONSERVED QUANTITY. Before the prefetch these read 4 and 32.
    expect(a.points).toBe(0)
    expect(b.points).toBe(0)
    expect(a.batches).toBe(1)
    expect(b.batches).toBe(1)

    // AND THE ANSWER IS UNCHANGED — the rows the grant admits are still in the
    // world. A prefetch that returned nothing would satisfy every count above.
    const world = internals(large).ledger.authority.bootstrap(feedPrincipal)
    expect(world.changes.filter((change) => change.entity === 'issue')).toHaveLength(32)
  })

  it('reads them once for a batch, not once per subscribed principal', () => {
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const { ledger } = internals(reg)
    expect(seedGrantedIssues(reg, 6)).toBe(6)

    // Two principals on the same feed. `broadcast` walks them in one drain.
    const second: Principal = {
      kind: 'user',
      user: OWNER,
      device: asDeviceId('dev:probe-2'),
      capability: asCapabilityRef('cap:probe-2'),
    }
    const delivered: number[] = []
    const off1 = ledger.authority.subscribe(feedPrincipal, () => delivered.push(1))
    const off2 = ledger.authority.subscribe(second, () => delivered.push(2))
    try {
      const reads = grantReadsDuring(reg, () => {
        ledger.capture([
          { entity: 'issue', id: 'iss_shared_0', op: 'upsert', value: { id: 'iss_shared_0', v: 2 } },
        ] as EntityChangeSpec[])
      })
      // CONTROL: both subscribers really were evaluated, so a count of 1 below
      // is one read shared by two passes and not one pass that happened.
      expect(delivered).toEqual([1, 2])
      expect(reads.points).toBe(0)
      // ONE, NOT TWO. Preparing inside the per-principal call reads 2 here, and
      // N for N connected clients — on every commit.
      expect(reads.batches).toBe(1)
    } finally {
      off1()
      off2()
    }
  })
})
