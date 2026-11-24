/**
 * A RECONNECT THAT COSTS A FRAME, NOT A WORLD (POD-2061).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ASSERT, AND WHY IT IS THE FRAMES AND NOT A FLAG
 * ---------------------------------------------------------------------------
 *
 * The finding this closes was measured on the wire: every admitted socket was
 * served the whole visible world, so a Wi-Fi flap on a client whose cache was
 * seconds old cost a full read and a full transfer. The fix is only real if the
 * frames stop arriving, so that is what every case here reads — what a peer
 * RECEIVED, from a real `FeedServing` over a real `Authority` and a real change
 * log. A test that asserted "resume was chosen" against an internal flag would
 * pass just as well against a server that then sent the world anyway.
 *
 * The refusing cases matter as much as the accepting one: a cursor honoured when
 * it should not be is a replica told it is caught up over a range nobody served,
 * which is the permanent invisible gap ADR 2 D5 exists to prevent. So each reason
 * a cursor can be refused — a foreign feed, a rolled epoch, a position past the
 * head, a position below the retained floor, a wire that cannot express the
 * answer — is exercised separately and must produce the world.
 */

import { asUserId } from '@podium/model'
import type { FeedCursorField, ServerMessage } from '@podium/protocol'
import { asCapabilityRef, asDeviceId, CLIENT_WIRE_VERSION, type Principal } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL, type VisibilityAnchorPort } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../store'
import { afterCommit } from '../store/executor/executor'
import { memberFacts } from '../store/fixtures/test-support'
import { type FeedTestPlumbing, feedTestPlumbing } from './feed-test-plumbing'
import type { EdgePeer } from './wire-feed-edge'

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  constructor(
    readonly id: string,
    readonly wireVersion: number = CLIENT_WIRE_VERSION,
    readonly acceptsDelta = true,
    readonly syncHttp = false,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
  types(): string[] {
    return this.received.map((m) => m.type)
  }
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[]
  }
}

/** Commit one row, and wait for its delivery pass (which records its access moves). */
const commit = async (p: Awaited<ReturnType<typeof feedTestPlumbing>>, id: string) => {
  const outcome = await testLedgerWriter(p.ledger).commit(
    p.ledger.modelOperation({
      write: async () => {},
      rows: () => [{ entity: 'session', id, op: 'upsert', value: { sessionId: id } }],
    }),
  )
  await p.authority.settled()
  return outcome
}

/** A populated server, and a peer already admitted the ordinary way — the state
 *  every one of these cases reconnects INTO. */
async function servedOnce(opts: Parameters<typeof feedTestPlumbing>[0] = {}) {
  const p = await feedTestPlumbing(opts)
  await commit(p, 's1')
  await commit(p, 's2')
  const cold = new Peer('cold')
  p.serving.attach(cold, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(cold.id))
  await p.serving.admissionSettled()
  const identity = await p.serving.identity()
  const held: FeedCursorField = {
    feedId: identity.feedId,
    epoch: identity.epoch,
    seq: await p.authority.cursor(),
  }
  return { p, cold, held }
}

/** Reconnect a NEW peer presenting `cursor`. A reconnect is a new socket and
 *  therefore a new peer id; reusing the old one would take the idempotent
 *  re-attach path and prove nothing. */
async function reconnect(
  ctx: Awaited<ReturnType<typeof servedOnce>>,
  cursor: FeedCursorField | undefined,
  wireVersion: number = CLIENT_WIRE_VERSION,
): Promise<Peer> {
  const peer = new Peer(`resumed-${wireVersion}-${cursor?.seq ?? 'none'}`, wireVersion)
  ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), cursor)
  // The admission is DEFERRED [POD-3523]: `renegotiate` is synchronous because its
  // production caller is, so an observer waits for it explicitly.
  await ctx.p.serving.admissionSettled()
  return peer
}

describe('a cursor the log can serve is answered with a resume, not a world', () => {
  it('sends one feedResume and not one row of the world', async () => {
    const ctx = await servedOnce()
    // The counterfactual, in the same test: the cold peer that was admitted
    // WITHOUT a cursor received the world, so "no bootstrap" below is a property
    // of the cursor and not of an empty server.
    expect(ctx.cold.types()).toEqual(['feedResume'])

    const peer = await reconnect(ctx, ctx.held)

    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]).toEqual({
      type: 'feedResume',
      feedId: ctx.held.feedId,
      epoch: ctx.held.epoch,
      seq: ctx.held.seq,
    })
  })

  it('frames the next delta from the position it granted', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, ctx.held)

    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('the log could not serve from that cursor')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)

    // CHAINS ONTO WHAT THE REPLICA HOLDS. `fromSeq === cursor.seq` is the exact
    // acceptance rule (ADR 2 Am1 D13), so this frame applies without a heal —
    // the socket alone carries the replica forward, and the HTTP catch-up is the
    // shortcut for `(cursor, head]` rather than the only route.
    const delta = peer.of('feedDelta')
    expect(delta).toHaveLength(1)
    expect(delta[0]?.fromSeq).toBe(ctx.held.seq)
    expect(delta[0]?.changes.map((c) => c.entityId)).toEqual(['s3'])
  })

  it('leaves the gap to the client heal rather than streaming it', async () => {
    const ctx = await servedOnce()
    // The head moves BEFORE the reconnect: the replica's cursor is now behind.
    await commit(ctx.p, 's3')
    const peer = await reconnect(ctx, ctx.held)

    // Still nothing but the grant. `(cursor, head]` is `/sync/delta`'s
    // — the read this client performs on every reconnect anyway — and a server
    // that ALSO streamed it would be the duplicate transfer this issue removes,
    // arriving as a delta instead of a world.
    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
  })
})

describe('a cursor the log cannot serve is refused, and the refusal requests HTTP recovery', () => {
  it('refuses a cursor from a foreign feed', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, feedId: 'someone-elses-feed' })
    expect(peer.of('feedResyncRequired')[0]?.reason).toBe('feed-identity-mismatch')

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor presented against a rolled epoch', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, epoch: 'epoch-from-before-the-reset' })
    expect(peer.of('feedResyncRequired')[0]?.reason).toBe('feed-identity-mismatch')

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor from the future — the database was restored behind it', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, { ...ctx.held, seq: ctx.held.seq + 1 })
    expect(peer.of('feedResyncRequired')[0]?.reason).toBe('future-cursor')

    expect(peer.types()).not.toContain('feedResume')
    expect(peer.types()).toEqual(['feedResyncRequired'])
  })

  it('refuses a cursor below the retained floor, and serves it at the exact boundary', async () => {
    // `cursor + 1 >= minAvailableSeq` — change-log.ts's own spelling. At
    // `cursor === floor - 1` every row the client needs is still retained, so it
    // resumes; one lower and `(cursor, head]` has a hole no read can fill.
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    // Head above the floor, so the boundary being tested is the FLOOR and not
    // the "cursor from the future" refusal sitting in front of it.
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    expect(await compacted.p.authority.cursor()).toBe(6)

    const refused = await reconnect(compacted, { ...compacted.held, seq: 3 })
    expect(refused.types()).not.toContain('feedResume')
    expect(refused.of('feedResyncRequired')[0]?.reason).toBe('compacted-or-unknown')
    expect((await reconnect(compacted, { ...compacted.held, seq: 4 })).types()).toEqual([
      'feedResume',
    ])
  })

  // POD-7552: the rows that would show an access move in the gap are pruned, so
  // the refusal is a rescope when the access-move log says the viewer's moved.
  it("answers a refused cursor as a rescope when the viewer's access moved after it", async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    const human = String(DEVICE_GRADE_PRINCIPAL.kind === 'user' && DEVICE_GRADE_PRINCIPAL.user)
    await compacted.p.store.sync.recordAccessMoves(new Map([[human, 3]]))

    // A move AT the cursor is one the device already has.
    const before = await reconnect(compacted, { ...compacted.held, seq: 3 })
    expect(before.types()).toEqual(['feedResyncRequired'])
    compacted.p.serving.detach(before.id)

    // A move after it is not: a rescope, at the head the publisher frames from.
    await compacted.p.store.sync.recordAccessMoves(new Map([[human, 5]]))
    const moved = await reconnect(compacted, { ...compacted.held, seq: 2 })
    expect(moved.types()).toEqual(['feedRescope'])
    expect(moved.of('feedRescope')[0]).toMatchObject({
      seq: 6,
      cause: 'rights-changed',
      reason: 'access-moved-in-gap',
    })
    // Lowering is refused: the log keeps the later move.
    await compacted.p.store.sync.recordAccessMoves(new Map([[human, 1]]))
    expect((await reconnect(compacted, { ...compacted.held, seq: 3 })).types()).toEqual([
      'feedRescope',
    ])
    // A cursor the log can serve resumes, whatever moved: the heal shows it.
    expect((await reconnect(compacted, { ...compacted.held, seq: 5 })).types()).toEqual([
      'feedResume',
    ])
  })

  it('answers a refused cursor from before the access-move log as a rescope: it cannot tell', async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    // What the migration writes: recording started at head 3.
    await compacted.p.store.sync.recordAccessMoves(new Map([['', 3]]))
    expect((await reconnect(compacted, { ...compacted.held, seq: 2 })).types()).toEqual([
      'feedRescope',
    ])
    expect((await reconnect(compacted, { ...compacted.held, seq: 3 })).types()).toEqual([
      'feedResyncRequired',
    ])
  })

  // POD-7552 review F1: a role change carries no visibility edge; the member write records it.
  it("answers a demoted admin's refused reconnect as a rescope", async () => {
    let floor = 0
    const ctx = await servedOnce({ retention: { minAvailableSeq: () => floor } })
    const facts = memberFacts(ctx.p.store)
    // Member writes change synced rows, so they run inside a change-log commit.
    const inCommit = async (write: () => Promise<void>) => {
      await testLedgerWriter(ctx.p.ledger).commit({ write })
      await ctx.p.authority.settled()
    }
    const id = asUserId('u-demoted')
    await inCommit(() =>
      facts.create({
        id,
        displayName: 'Demoted',
        role: 'admin',
        createdAt: '2026-11-01T00:00:00.000Z',
        disabledAt: null,
      }),
    )
    await commit(ctx.p, 'before-demotion')
    const before = await ctx.p.authority.cursor()
    await inCommit(() => facts.setRole(id, 'member'))
    await commit(ctx.p, 'after-demotion')
    const after = await ctx.p.authority.cursor()
    // Past retention from here on: every cursor below the head is refused.
    floor = after + 10
    const principal: Principal = {
      kind: 'user',
      user: id,
      device: asDeviceId('dev:demoted'),
      capability: asCapabilityRef('cap:demoted'),
    }
    const at = async (seq: number): Promise<Peer> => {
      const peer = new Peer(`demoted-${seq}`)
      ctx.p.serving.renegotiate(peer, principal, ctx.p.routingPrincipal(peer.id, id, 'member'), {
        ...ctx.held,
        seq,
      })
      await ctx.p.serving.admissionSettled()
      return peer
    }
    expect((await at(before)).types()).toEqual(['feedRescope'])
    expect((await at(after)).types()).toEqual(['feedResyncRequired'])
  })

  // POD-7552 review F4: a failed read must not fail the admission; it answers as moved.
  it('answers a refused cursor as a rescope when the access-move log cannot be read', async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    vi.spyOn(compacted.p.store.sync, 'accessMovedAfter').mockRejectedValue(new Error('disk I/O'))
    const peer = await reconnect(compacted, { ...compacted.held, seq: 2 })
    expect(peer.types()).toEqual(['feedRescope'])
  })

  // POD-7585 (POD-7552 review F3, N1): a pass records its moves after its commit,
  // so the log is complete only through the recorded-through mark. No wait.
  it('answers as moved, at once and counted, while the recorded-through mark trails the head', async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    const authority = compacted.p.authority
    expect(authority.accessMovesRecordedThrough()).toBe(6)
    const read = vi.spyOn(compacted.p.store.sync, 'accessMovedAfter')
    // Each reconnect is a new socket: the earlier peer goes, or the same id re-attaches.
    const refusedAt = async (seq: number): Promise<string[]> => {
      const peer = await reconnect(compacted, { ...compacted.held, seq })
      compacted.p.serving.detach(peer.id)
      return peer.types()
    }
    expect(await refusedAt(2)).toEqual(['feedResyncRequired'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(compacted.p.serving.accessMovesTrailingAnswers).toBe(0)

    // A pass still queued behind the head, then a start-up replay not yet done.
    const mark = vi.spyOn(authority, 'accessMovesRecordedThrough').mockReturnValue(5)
    expect(await refusedAt(2)).toEqual(['feedRescope'])
    mark.mockReturnValue(null)
    expect(await refusedAt(1)).toEqual(['feedRescope'])
    // Answered without reading the log, and counted rather than warned each time.
    expect(read).toHaveBeenCalledTimes(1)
    expect(compacted.p.serving.accessMovesTrailingAnswers).toBe(2)
    // The bootstrap and delta routes read the head themselves.
    mark.mockReturnValue(6)
    expect(await compacted.p.serving.accessMovedAfter(DEVICE_GRADE_PRINCIPAL, 2)).toBe(false)
    await commit(compacted.p, 's7')
    expect(await compacted.p.serving.accessMovedAfter(DEVICE_GRADE_PRINCIPAL, 2)).toBe(true)
    expect(compacted.p.serving.accessMovesTrailingAnswers).toBe(3)
  })

  // POD-7585 review F6: a pass in flight is waited for briefly, on the mark itself.
  it('waits briefly for the mark of a pass still running, then answers from the log', async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    const authority = compacted.p.authority
    const mark = vi.spyOn(authority, 'accessMovesRecordedThrough').mockReturnValue(5)
    const answer = compacted.p.serving.accessMovedAfter(DEVICE_GRADE_PRINCIPAL, 2, 6)
    mark.mockRestore()
    // The next pass lands: the mark moves and wakes the refusal.
    await commit(compacted.p, 's7')
    expect(await answer).toBe(false)
    expect(compacted.p.serving.accessMovesTrailingAnswers).toBe(0)
  })

  // POD-7585 review F4: an Authority that cannot say how far it recorded fails closed.
  it('answers as moved when the authority cannot report its recorded-through mark', async () => {
    const compacted = await servedOnce({ retention: { minAvailableSeq: () => 5 } })
    for (let i = 3; i <= 6; i += 1) await commit(compacted.p, `s${i}`)
    Object.defineProperty(compacted.p.authority, 'whenAccessMovesRecordedThrough', {
      value: undefined,
    })
    expect(await compacted.p.serving.accessMovedAfter(DEVICE_GRADE_PRINCIPAL, 2)).toBe(true)
    expect(compacted.p.serving.accessMovesTrailingAnswers).toBe(1)
  })

  // POD-7585: the access moves of a commit whose delivery pass never ran.
  describe('a move committed just before a process exits or hands over is not lost', () => {
    const human = String(DEVICE_GRADE_PRINCIPAL.kind === 'user' && DEVICE_GRADE_PRINCIPAL.user)
    /** Anchors that name the viewer in the audience of every `revoke-*` row. */
    const revokes: VisibilityAnchorPort = {
      visibilityEdges: async (refs) =>
        refs.map((ref) =>
          ref.entityId.startsWith('revoke-') ? { audience: [asUserId(human)], subjects: [] } : null,
        ),
      currentValuesOf: async (refs) => refs.map(() => undefined),
    }
    /** A process whose delivery passes stop running once `exit()` is called. */
    async function processThatExits(store?: SessionStore) {
      let exited = false
      const p = await feedTestPlumbing({
        anchors: revokes,
        retention: { minAvailableSeq: () => 100 },
        postCommit: (step, label) => {
          if (!exited) afterCommit(step, label)
        },
        ...(store === undefined ? {} : { store }),
      })
      return {
        p,
        exit: () => {
          exited = true
        },
      }
    }
    async function refusedAt(p: FeedTestPlumbing, seq: number): Promise<Peer> {
      const identity = await p.serving.identity()
      const peer = new Peer(`refused-${seq}-${Math.random()}`)
      p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id), {
        feedId: identity.feedId,
        epoch: identity.epoch,
        seq,
      })
      await p.serving.admissionSettled()
      return peer
    }

    it('a kill between the commit and its pass: the next start replays the move', async () => {
      const a = await processThatExits()
      await commit(a.p, 's1')
      const before = await a.p.authority.cursor()
      a.exit()
      await commit(a.p, 'revoke-1')
      const revokedAt = await a.p.authority.cursor()
      // The pass never ran: nothing recorded the move.
      expect(await a.p.store.sync.accessMovedAfter(human, before)).toBe(false)

      // The next process over the same database replays the tail at start.
      const b = await processThatExits(a.p.store)
      expect(b.p.authority.accessMovesRecordedThrough()).toBe(revokedAt)
      expect(await b.p.store.sync.accessMovedAfter(human, before)).toBe(true)
      expect(await b.p.store.sync.readRecordedThrough()).toBe(revokedAt)
      expect((await refusedAt(b.p, before)).types()).toEqual(['feedRescope'])
      expect((await refusedAt(b.p, revokedAt)).types()).toEqual(['feedResyncRequired'])
      expect(b.p.serving.accessMovesTrailingAnswers).toBe(0)
    })

    it('a lease handover: the process taking over replays what the old one left', async () => {
      const a = await processThatExits()
      await commit(a.p, 's1')
      // The new process is up and caught up before the old one's last commit.
      const b = await processThatExits(a.p.store)
      const before = await a.p.authority.cursor()
      // The old writer commits, and loses the workspace before its pass runs.
      a.exit()
      await commit(a.p, 'revoke-1')
      const revokedAt = await a.p.authority.cursor()
      // The new writer: its mark trails the head until it takes over.
      expect((await refusedAt(b.p, before)).types()).toEqual(['feedRescope'])
      expect(b.p.serving.accessMovesTrailingAnswers).toBe(1)
      await b.p.authority.catchUpAccessMoves()
      expect(b.p.authority.accessMovesRecordedThrough()).toBe(revokedAt)
      expect(await b.p.store.sync.accessMovedAfter(human, before)).toBe(true)
      // Its own writes follow on; a refusal is answered from the log, exactly.
      await commit(b.p, 's2')
      expect(b.p.authority.accessMovesRecordedThrough()).toBe(revokedAt + 1)
      expect((await refusedAt(b.p, before)).types()).toEqual(['feedRescope'])
      expect((await refusedAt(b.p, revokedAt)).types()).toEqual(['feedResyncRequired'])
      expect(b.p.serving.accessMovesTrailingAnswers).toBe(1)
    })

    it("a writer that never took over still closes the old one's gap after its next pass", async () => {
      const a = await processThatExits()
      await commit(a.p, 's1')
      const b = await processThatExits(a.p.store)
      const before = await a.p.authority.cursor()
      a.exit()
      await commit(a.p, 'revoke-1')
      await commit(b.p, 's2')
      // The pass did not wait for the gap; a catch-up behind it closes it.
      const head = await b.p.authority.cursor()
      expect(await b.p.authority.whenAccessMovesRecordedThrough(head, 5_000)).toBe(head)
      expect(await b.p.store.sync.accessMovedAfter(human, before)).toBe(true)
    })

    // POD-7585 review F1: the maintenance prune runs while a replay reads the log.
    it('a prune during the start-up replay: recording starts after the tail, the move is not lost', async () => {
      const a = await processThatExits()
      await commit(a.p, 's1')
      const before = await a.p.authority.cursor()
      a.exit()
      await commit(a.p, 'revoke-1')
      await commit(a.p, 's2')
      const head = await a.p.authority.cursor()
      // The prune commits right after the replay's first page was read.
      const sync = a.p.store.sync
      const read = sync.changeRefsInRange.bind(sync)
      const pages = vi.spyOn(sync, 'changeRefsInRange').mockImplementation(async (...args) => {
        const page = await read(...args)
        await sync.pruneChangeBatch({ thresholdSeq: head - 1 }, 100)
        return page
      })
      const b = await processThatExits(a.p.store)
      expect(pages).toHaveBeenCalledTimes(1)
      expect(b.p.authority.accessMovesRecordedThrough()).toBe(head)
      // Recording starts after the tail: the cursor from before cannot be told.
      expect(await b.p.store.sync.accessMovedAfter(human, before)).toBe(true)
      expect((await refusedAt(b.p, before)).types()).toEqual(['feedRescope'])
      expect(b.p.serving.accessMovesTrailingAnswers).toBe(0)
    })
  })

  it('keeps the other refusals a resync, whatever the access-move log says', async () => {
    const ctx = await servedOnce()
    const human = String(DEVICE_GRADE_PRINCIPAL.kind === 'user' && DEVICE_GRADE_PRINCIPAL.user)
    await ctx.p.store.sync.recordAccessMoves(new Map([[human, ctx.held.seq]]))
    for (const cursor of [
      { ...ctx.held, seq: ctx.held.seq + 1 },
      { ...ctx.held, feedId: 'someone-elses-feed', seq: 0 },
    ]) {
      expect((await reconnect(ctx, cursor)).types()).toEqual(['feedResyncRequired'])
    }
  })

  it('grants the head to a cold HTTP hello that presents no cursor', async () => {
    const ctx = await servedOnce()
    const peer = await reconnect(ctx, undefined)

    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
  })
})

describe('HTTP bootstrap capability', () => {
  it('grants the head to a cold peer and resumes three reconnects without a world', async () => {
    const ctx = await servedOnce()
    for (let i = 0; i < 4; i++) {
      const peer = new Peer(`http-${i}`, CLIENT_WIRE_VERSION, true, true)
      ctx.p.serving.renegotiate(
        peer,
        DEVICE_GRADE_PRINCIPAL,
        ctx.p.routingPrincipal(peer.id),
        i === 0 ? undefined : ctx.held,
      )
      await ctx.p.serving.admissionSettled()
      expect(peer.types()).toEqual(['feedResume'])
      expect(peer.of('feedResume')[0]?.seq).toBe(ctx.held.seq)
      ctx.p.serving.detach(peer.id)
    }
  })

  it('uses the HTTP rule when an already admitted peer changes wire version', async () => {
    const ctx = await servedOnce()
    const peer = new Peer('version-http', 1)
    ctx.p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id))
    await ctx.p.serving.admissionSettled()
    const upgraded = new Peer(peer.id, CLIENT_WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(upgraded, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id))
    await ctx.p.serving.admissionSettled()
    expect(upgraded.types()).toEqual(['feedResume'])
  })

  it('keeps live delivery after epoch demotion without another socket or world', async () => {
    const ctx = await servedOnce()
    const peer = new Peer('http-epoch', CLIENT_WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(
      peer,
      DEVICE_GRADE_PRINCIPAL,
      ctx.p.routingPrincipal(peer.id),
      ctx.held,
    )
    await ctx.p.serving.admissionSettled()
    await ctx.p.serving.bumpEpoch('restore')
    expect(peer.types()).toEqual(['feedResume', 'feedResyncRequired'])
    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('missing range')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
    expect(peer.of('feedDelta')[0]?.seq).toBe(ctx.held.seq + 1)
    expect(peer.types().filter((type) => type === 'feedBootstrap')).toHaveLength(0)
  })

  it.each([
    'feed',
    'epoch',
    'future',
    'retention',
  ])('refuses a %s cursor with resync and retains live delivery', async (reason) => {
    const ctx = await servedOnce({ retention: { minAvailableSeq: async () => 2 } })
    const cursor = { ...ctx.held }
    if (reason === 'feed') cursor.feedId = 'foreign'
    if (reason === 'epoch') cursor.epoch = 'foreign'
    if (reason === 'future') cursor.seq += 100
    if (reason === 'retention') cursor.seq = 0
    const peer = new Peer('http-refused', CLIENT_WIRE_VERSION, true, true)
    ctx.p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, ctx.p.routingPrincipal(peer.id), cursor)
    await ctx.p.serving.admissionSettled()
    expect(peer.types()).toEqual(['feedResyncRequired'])
    await commit(ctx.p, 's3')
    const delivery = await ctx.p.authority.changesSince(ctx.held.seq, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('missing range')
    await ctx.p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
    expect(peer.of('feedDelta')[0]?.fromSeq).toBe(ctx.held.seq)
    expect(peer.types().filter((type) => type === 'feedBootstrap')).toHaveLength(0)
  })
})
