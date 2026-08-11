/**
 * WHICH USER A FEED IS SCOPED FOR — the wiring, not the function (POD-1497).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS WHEN SCOPING IS ALREADY TESTED
 * ---------------------------------------------------------------------------
 *
 * `authority.scoped.test.ts`, `modules/read-position/feed.test.ts` and
 * `modules/layout/feed.test.ts` all exercise the scoping DECISION, and they do it
 * well. Every one of them calls `authority.bootstrap(principalFor(ALICE))` — the
 * principal arrives as an ARGUMENT the test wrote. Such a suite passes with full
 * marks against a server that derives the scope from a frame payload, because the
 * derivation never runs in it: hand the function the wrong user and it will scope
 * correctly, for the wrong person, and report green.
 *
 * The other half was equally uncovered from the other side. `feed-serving.test.ts`
 * drives the real `FeedServing` over a real `Authority`, but every case in it uses
 * `DEVICE_GRADE_PRINCIPAL` — the single "everyone" principal — under `Ledger`'s
 * default `DeviceGradeUnscopedPolicy`, whose `mayDeliver` is `return true`. So the
 * serving path had real wiring and no scope, and the scoping suites had a real
 * scope and no wiring. Nothing crossed the two.
 *
 * This file crosses them. The chain under test is the one `relay.ts` builds and a
 * browser actually talks to:
 *
 *   authenticated socket  →  ClientMux.attachClient (mints the principal)
 *                         →  feedPrincipalOf(conn.principal)
 *                         →  FeedServing.attach / renegotiate
 *                         →  Authority + GrantEdgeVisibilityPolicy
 *                         →  frames on THAT socket
 *
 * Nothing in it is a stand-in for a decision: `ClientMux`, `ClientRegistry`,
 * `FeedServing`, `Ledger`/`Authority` and `GrantEdgeVisibilityPolicy` are the
 * shipped classes. What is injected is what `relay.ts` also injects — the
 * `VisibilityStatePort` holding the ownership tables — and the store.
 *
 * ---------------------------------------------------------------------------
 * A ROW YOU CANNOT SEE IS NOT DELETED, AND THE ASSERTIONS SAY SO
 * ---------------------------------------------------------------------------
 *
 * `changes.length === 0` cannot tell "Bob may not see Alice's issue" from "the
 * issue was deleted" from "the server never evaluated that seq". Those are three
 * different bugs and only the middle one is benign. So the assertions here are on
 * the DISCRIMINATED SHAPE:
 *
 *   present      a `feedDelta` carrying `{ op: 'upsert', entityId }`
 *   not-visible  a CERTIFIED frame whose `(fromSeq, seq]` COVERS that seq and
 *                whose `changes` name someone else's row — a watermark (D13)
 *   removed      a change row with `op: 'remove'`
 *
 * `a genuine removal still reaches its owner as op:'remove'` is the control that
 * makes the not-visible assertions mean something: it proves this harness CAN
 * produce the removed shape, so "Bob got no remove" is a fact about the product
 * rather than about an instrument that could never have said it.
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import {
  CAP_METADATA_DELTA,
  type ClientMessage,
  type ServerMessage,
  WIRE_VERSION,
} from '@podium/protocol'
import {
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
  type VisibilityStatePort,
} from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { attachTestClient } from '../test-support/client-transport'
import { ClientMux } from './client-mux'
import type { ClientFeaturePorts } from './client-ports'
import { feedPrincipalOf } from './client-principal'
import { type ClientConn, ClientRegistry } from './client-registry'
import { feedTestPlumbing } from './feed-test-plumbing'
import type { PresenceRouting } from './presence-routing'

const ALICE = asUserId('user-alice')
const BOB = asUserId('user-bob')

/**
 * `relay.ts`'s issue rule, over tables this test owns: owner, or an explicit read
 * grant. The CLASS is the shipped `GrantEdgeVisibilityPolicy`; only the tables it
 * reads are local, exactly as production injects its own reading the SQLite store.
 */
function issueOwnershipPolicy(owners: Map<string, UserId>, grants: Map<string, UserId[]>) {
  const port: VisibilityStatePort = {
    classOf: (entity) => (entity === 'issue' ? 'personal' : null),
    mayRead: (user, ref) => {
      if (ref.entity !== 'issue') return false
      if (owners.get(ref.entityId) === user) return true
      return (grants.get(ref.entityId) ?? []).includes(user as UserId)
    },
    keyedUserOf: () => null,
  }
  return new GrantEdgeVisibilityPolicy(port, new NoDelegationsGranted())
}

interface Socket {
  readonly id: string
  readonly received: ServerMessage[]
}

/**
 * The gateway as the server assembles it, with per-connection sockets so a frame
 * that reached the WRONG person is observable rather than merely absent.
 */
function gateway(owners: Map<string, UserId>, grants: Map<string, UserId[]> = new Map()) {
  const registry = new ClientRegistry()
  let authorizationRevision = 0
  const plumbing = feedTestPlumbing({
    visibility: issueOwnershipPolicy(owners, grants),
    authorizationRevision: () => authorizationRevision,
  })
  const ports: ClientFeaturePorts = {
    sessions: {
      onClientAttached: vi.fn(),
      onClientReclaim: vi.fn(),
      onClientDetached: vi.fn(),
      onRoomJoined: vi.fn(),
      // The ONE line of `modules/sessions/client-control.ts`'s hello arm that the
      // gateway's own renegotiation reads back (`conn.caps.has(CAP_METADATA_DELTA)`).
      // Applying caps is a transport fact, not the thing under test; without it
      // every peer here would stay pre-hello and never reach the v2 frames.
      onSessionClientFrame: (_principal, conn: ClientConn, msg) => {
        if (msg.type === 'hello' && msg.caps) conn.caps = new Set(msg.caps)
      },
    },
  }
  const mux = new ClientMux({
    registry,
    ports,
    feed: plumbing.serving,
    presence: {
      route: vi.fn(),
      setVisible: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as PresenceRouting,
    bootstrap: vi.fn(),
  })

  /** Authenticate a socket AS someone and take it to the current wire. */
  const signIn = (user: UserId): Socket => {
    const received: ServerMessage[] = []
    const id = attachTestClient(mux, {
      send: (msg) => received.push(msg),
      userId: user,
      userRole: 'admin',
    })
    mux.routeClientFrame(id, helloFrom(id))
    return { id, received }
  }

  return {
    mux,
    plumbing,
    registry,
    signIn,
    changeVisibility: (change: () => void) => {
      change()
      authorizationRevision += 1
    },
  }
}

const helloFrom = (clientId: string, caps: string[] = [CAP_METADATA_DELTA]): ClientMessage => ({
  type: 'hello',
  clientId,
  viewport: { cols: 80, rows: 24, dpr: 1 },
  caps,
  wireVersion: WIRE_VERSION,
})

const commitIssue = (
  plumbing: ReturnType<typeof feedTestPlumbing>,
  id: string,
  value: unknown,
  op: 'upsert' | 'remove' = 'upsert',
) =>
  plumbing.ledger.commit({
    write: () => {},
    changes: () => [{ entity: 'issue', id, op, ...(op === 'upsert' ? { value } : {}) }],
  })

/**
 * Drain the flush `FeedServing.queue` scheduled. A `queueMicrotask` callback
 * enqueued by the synchronous commit above runs BEFORE this continuation, so this
 * is ordering, not a timed wait — a `setTimeout` here would be the flake the unit
 * lane forbids.
 */
const settle = () => Promise.resolve()

/** Every change row this socket was ever sent, across bootstrap and delta frames. */
function changesOn(socket: Socket): { seq: number; entityId: string; op: string }[] {
  return socket.received.flatMap((msg) =>
    msg.type === 'feedBootstrap' || msg.type === 'feedDelta'
      ? (msg.changes as { seq: number; entityId: string; op: string }[])
      : [],
  )
}

/**
 * Did this entity reach this socket in ANY shape at all?
 *
 * `changesOn` reads the v2 frame family only, and that blindness was a real hole:
 * a peer that never reaches wire 2 is served the SAME feed folded into v1
 * `issuesChanged` full lists (`legacy-wire-v1-adapter.ts`), so a leak into a
 * legacy list is invisible to a v2-only reader. A mutation that stopped a peer
 * renegotiating went undetected until this helper existed — the test was passing
 * because it had stopped looking, which is the failure mode a negative assertion
 * is most prone to.
 */
const leakedTo = (socket: Socket, entityId: string): boolean =>
  socket.received.some((msg) => JSON.stringify(msg).includes(entityId))

/** Certified frames only — the shapes that carry a `(fromSeq, seq]` claim. */
function certifiedFrames(socket: Socket) {
  return socket.received.filter(
    (msg): msg is Extract<ServerMessage, { type: 'feedDelta' }> => msg.type === 'feedDelta',
  )
}

/** Did this socket receive a CERTIFIED range covering `seq` that stayed silent
 *  about `entityId`? That is "evaluated, and not yours" — D13's watermark. */
const coveredButUnnamed = (socket: Socket, seq: number, entityId: string): boolean =>
  certifiedFrames(socket).some(
    (frame) =>
      frame.fromSeq < seq &&
      seq <= frame.seq &&
      !frame.changes.some((change) => change.entityId === entityId),
  )

describe("a connection's feed is scoped to the user its TRANSPORT authenticated", () => {
  it("Alice's issue reaches Alice as an upsert and Bob as a covered silence, not a removal", async () => {
    const owners = new Map([['issue-alice', ALICE]])
    const g = gateway(owners)
    const alice = g.signIn(ALICE)
    const bob = g.signIn(BOB)

    commitIssue(g.plumbing, 'issue-alice', { id: 'issue-alice', title: 'private' })
    await settle()
    const seq = g.plumbing.authority.cursor()

    // PRESENT — the positive control. Without it every assertion below is
    // satisfied by a server that publishes nothing to anyone.
    const aliceRows = changesOn(alice).filter((c) => c.entityId === 'issue-alice')
    expect(aliceRows.map((c) => c.op)).toEqual(['upsert'])

    // NOT-VISIBLE, and the discrimination is the point: Bob's socket must carry
    // NO row for that entity in ANY op — a `remove` here would tell Bob the issue
    // was deleted, which is a different (and false) statement about the world.
    expect(changesOn(bob).filter((c) => c.entityId === 'issue-alice')).toEqual([])
    // ...in any WIRE SHAPE, including a v1 list. See `leakedTo`.
    expect(leakedTo(bob, 'issue-alice')).toBe(false)

    // ...and it is a SILENCE OVER AN EVALUATED RANGE, not a gap. Bob's cursor must
    // have advanced across Alice's seq; a range never certified is the invisible
    // permanent gap ADR 2 D2 names, and it is indistinguishable from this one if
    // the only assertion is a count.
    expect(coveredButUnnamed(bob, seq, 'issue-alice')).toBe(true)
  })

  it("a genuine removal still reaches its owner as op:'remove' — the shape is reachable", async () => {
    const owners = new Map([['issue-bob', BOB]])
    const g = gateway(owners)
    const bob = g.signIn(BOB)

    commitIssue(g.plumbing, 'issue-bob', { id: 'issue-bob', title: 'mine' })
    await settle()
    commitIssue(g.plumbing, 'issue-bob', undefined, 'remove')
    await settle()

    // The instrument CAN say "removed". So the previous case's "no remove reached
    // Bob" is a property of the product, not of a harness that cannot express one.
    expect(changesOn(bob).map((c) => c.op)).toEqual(['upsert', 'remove'])
  })

  it('a grant admits the second user — the filter is a filter, not a blanket refusal', async () => {
    const owners = new Map([['issue-shared', ALICE]])
    const grants = new Map([['issue-shared', [BOB]]])
    const g = gateway(owners, grants)
    const alice = g.signIn(ALICE)
    const bob = g.signIn(BOB)

    commitIssue(g.plumbing, 'issue-shared', { id: 'issue-shared', title: 'ours' })
    await settle()

    // Both, this time. A suite whose every scoped assertion is negative passes
    // against a server that delivers nothing at all to a second connection.
    expect(
      changesOn(alice)
        .filter((c) => c.entityId === 'issue-shared')
        .map((c) => c.op),
    ).toEqual(['upsert'])
    expect(
      changesOn(bob)
        .filter((c) => c.entityId === 'issue-shared')
        .map((c) => c.op),
    ).toEqual(['upsert'])
  })

  it('invalidates a cached world when grant visibility changes without moving the feed head', () => {
    const owners = new Map([['issue-shared', ALICE]])
    const grants = new Map([['issue-shared', [BOB]]])
    const g = gateway(owners, grants)
    commitIssue(g.plumbing, 'issue-shared', { id: 'issue-shared', title: 'ours' })
    const head = g.plumbing.authority.cursor()
    const bootstrap = vi.spyOn(g.plumbing.authority, 'bootstrap')

    const first = g.signIn(BOB)
    expect(leakedTo(first, 'issue-shared')).toBe(true)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    g.mux.detachClient(first.id)

    // AUTHORITY CHANGES, FEED HEAD DOES NOT. This is the same-timestamp
    // persistWith shape: the issue upsert can deduplicate while the grant delete
    // still changes who may see the row.
    g.changeVisibility(() => grants.set('issue-shared', []))
    expect(g.plumbing.authority.cursor()).toBe(head)

    const afterRevoke = g.signIn(BOB)
    expect(bootstrap).toHaveBeenCalledTimes(2)
    expect(leakedTo(afterRevoke, 'issue-shared')).toBe(false)

    const principal = g.mux.principalOf(afterRevoke.id)
    expect(principal).toBeDefined()
    if (principal === undefined) throw new Error('Bob connection lost its authenticated principal')
    const uncached = g.plumbing.authority.bootstrap(feedPrincipalOf(principal))
    const served = afterRevoke.received.find(
      (message): message is Extract<ServerMessage, { type: 'feedBootstrap' }> =>
        message.type === 'feedBootstrap',
    )
    expect(served?.changes.map((change) => [change.entity, change.entityId])).toEqual(
      uncached.changes.map((change) => [change.entity, change.entityId]),
    )

    g.mux.detachClient(afterRevoke.id)
    g.changeVisibility(() => grants.set('issue-shared', [BOB]))
    expect(g.plumbing.authority.cursor()).toBe(head)
    const afterGrant = g.signIn(BOB)
    expect(bootstrap).toHaveBeenCalledTimes(4) // includes the direct uncached comparison
    expect(leakedTo(afterGrant, 'issue-shared')).toBe(true)
  })

  it("a forged hello.clientId naming another user's connection does not move the scope", async () => {
    const owners = new Map([
      ['issue-alice', ALICE],
      ['issue-alice2', ALICE],
    ])
    const g = gateway(owners)
    const alice = g.signIn(ALICE)
    const bob = g.signIn(BOB)

    // ALICE'S ROW EXISTS BEFORE THE FORGERY. Ordering matters and it is the whole
    // difference between a real attack and a decorative one: renegotiation
    // RE-SERVES THE WORLD, so a scope taken from the payload hands over everything
    // already committed, in the bootstrap, before any delta is published. A test
    // that only commits afterwards can never observe that theft.
    commitIssue(g.plumbing, 'issue-alice', { id: 'issue-alice', title: 'private' })
    await settle()

    // THE FORGERY. `hello.clientId` is a real payload field and it names Alice's
    // server-minted connection id. The pre-existing reclaim guard does not cover
    // this: a rescope is not a reclaim.
    g.mux.routeClientFrame(bob.id, helloFrom(alice.id))
    await settle()

    // ...and again afterwards, so the delta path is covered as well as the
    // bootstrap one.
    commitIssue(g.plumbing, 'issue-alice2', { id: 'issue-alice2', title: 'also private' })
    await settle()

    // THE DATA QUESTION FIRST. Ordered deliberately: the identity assertion below
    // is the cheaper signal and would short-circuit this one, and then a mutation
    // run could only ever report "the principal was wrong" — never whether rows
    // actually crossed. Those are different severities and the suite must be able
    // to tell them apart.
    for (const stolen of ['issue-alice', 'issue-alice2']) {
      expect(changesOn(bob).filter((c) => c.entityId === stolen)).toEqual([])
      expect(leakedTo(bob, stolen)).toBe(false)
    }

    // THE CONNECTION THE FORGED FRAME ACTED ON IS STILL BOB'S. Also asserted,
    // because a mutant that leaves Bob un-negotiated at wire 1 gives a v2-only
    // reader nothing on Bob's socket and that reads as privacy: "Bob was served a
    // certified range" and "Bob was served nothing" must not look alike.
    expect(g.mux.principalOf(bob.id)?.user).toBe(BOB)
    expect(certifiedFrames(bob).length).toBeGreaterThan(0)
    // Alice is unharmed by Bob's frame — the forgery must not detach her either.
    expect(
      changesOn(alice)
        .filter((c) => c.entityId === 'issue-alice')
        .map((c) => c.op),
    ).toEqual(['upsert'])
    expect(
      changesOn(alice)
        .filter((c) => c.entityId === 'issue-alice2')
        .map((c) => c.op),
    ).toEqual(['upsert'])
  })

  it('two devices of ONE person share the slice; a second person never joins it', async () => {
    const owners = new Map([['issue-alice', ALICE]])
    const g = gateway(owners)
    const laptop = g.signIn(ALICE)
    const phone = g.signIn(ALICE)
    const bob = g.signIn(BOB)

    commitIssue(g.plumbing, 'issue-alice', { id: 'issue-alice', title: 'private' })
    await settle()

    // One authority subscription, two connections — `feedPrincipalOf` keys on the
    // user and deliberately drops the device half.
    expect(
      changesOn(laptop)
        .filter((c) => c.entityId === 'issue-alice')
        .map((c) => c.op),
    ).toEqual(['upsert'])
    expect(
      changesOn(phone)
        .filter((c) => c.entityId === 'issue-alice')
        .map((c) => c.op),
    ).toEqual(['upsert'])
    expect(changesOn(bob).filter((c) => c.entityId === 'issue-alice')).toEqual([])
    expect(leakedTo(bob, 'issue-alice')).toBe(false)
  })
})

describe('the single-user deployment is not tightened into an empty screen', () => {
  it('the only signed-in person still receives their own rows under the scoping policy', async () => {
    // TODAY'S DEPLOYMENT SHAPE. Almost every install has one account, and the
    // adjacent regression this guards against is the one POD-1497's brief names:
    // a tightening that reads an unevaluated permission as a denial blanks the
    // whole screen for the person who owns everything on it.
    const owners = new Map([['issue-only', FIRST_ADMIN_USER_ID]])
    const g = gateway(owners)
    const solo = g.signIn(FIRST_ADMIN_USER_ID)

    commitIssue(g.plumbing, 'issue-only', { id: 'issue-only', title: 'the only issue' })
    await settle()

    expect(
      changesOn(solo)
        .filter((c) => c.entityId === 'issue-only')
        .map((c) => c.op),
    ).toEqual(['upsert'])
  })
})
