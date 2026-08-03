import { asIssueId, asSessionId, type EntityRef } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  asCorrelationId,
  assertCertified,
  ControlPlanePort,
  type PlaneTarget,
} from './control-port'
import {
  asCapabilityRef,
  asDeviceId,
  asUserId,
  type Principal,
  type VisibilityResolver,
} from './principal'
import {
  asSubscriberId,
  controlEntityDelivery,
  entityRoutingKey,
  PlaneRouter,
  SubscriptionRegistry,
  streamLiveDelivery,
} from './routing'

const issueRef = (id: string): EntityRef => ({ kind: 'issue', id: asIssueId(id) })
const sessionRef = (id: string): EntityRef => ({ kind: 'session', id: asSessionId(id) })
import { type FeedDeltaMessage, isFeedWatermark } from '../messages/feed'
import {
  CHANGE_OP_SEMANTICS,
  RESCOPE_PRESERVES_OUTBOX,
  type RescopeFrame,
  SCOPED_CHANGE_OPS,
} from './scoped-feed'

const user = (id: string): Principal => ({
  kind: 'user',
  user: asUserId(id),
  device: asDeviceId(`${id}-d`),
  capability: asCapabilityRef('cap'),
})

const target = (id: string, principal = user(id)): PlaneTarget => ({
  subscriberId: asSubscriberId(id),
  principal,
})

const allowAll: VisibilityResolver = { canSee: () => true }
const denyAll: VisibilityResolver = { canSee: () => false }

const setup = (visibility: VisibilityResolver = allowAll, live = true) => {
  const registry = new SubscriptionRegistry()
  const router = new PlaneRouter<FeedDeltaMessage | RescopeFrame>(
    registry,
    controlEntityDelivery(4),
  )
  const emit = vi.fn()
  const port = new ControlPlanePort(registry, router, {
    visibility,
    isLive: () => live,
    emit,
  })
  return { registry, router, port, emit }
}

const frame = (fromSeq: number, seq: number, changes: FeedDeltaMessage['changes'] = []) =>
  ({
    type: 'feedDelta',
    feedId: 'f',
    // An OPAQUE epoch (ADR 2 D1). It was `1` here, which the kernel's
    // `assertOpaqueEpoch` refuses outright as a counter — the port and the
    // minting boundary could never have met. POD-308 lands the wire, so they do.
    epoch: 'e-01J0',
    fromSeq,
    seq,
    minAvailableSeq: 0,
    changes,
  }) satisfies FeedDeltaMessage

describe('the control port carries three classes and no more', () => {
  it('declares control · entity, command and handshake', () => {
    const { port } = setup()
    expect([...port.planeClasses]).toEqual([
      'control.entity',
      'control.command',
      'control.handshake',
    ])
  })

  it('refuses a router that is not the one registry, or not control · entity', () => {
    const registry = new SubscriptionRegistry()
    const other = new SubscriptionRegistry()
    const foreign = new PlaneRouter<FeedDeltaMessage>(other, controlEntityDelivery(2))
    expect(
      () =>
        new ControlPlanePort(registry, foreign as never, {
          visibility: allowAll,
          isLive: () => true,
          emit: () => {},
        }),
    ).toThrow(/one subscription registry/)

    const streamRouter = new PlaneRouter<FeedDeltaMessage>(
      registry,
      streamLiveDelivery(2, () => 'k', 2),
    )
    expect(
      () =>
        new ControlPlanePort(registry, streamRouter as never, {
          visibility: allowAll,
          isLive: () => true,
          emit: () => {},
        }),
    ).toThrow(/control.entity/)
  })
})

describe('the port carries a principal and evaluates no policy', () => {
  it('admits an entity only when the resolver says so, and never says why', () => {
    const denied = setup(denyAll)
    expect(denied.port.admitEntity(target('alice'), issueRef('i1'))).toBe(false)
    expect(denied.registry.keyCount).toBe(0)
    // A refusal emits nothing: there is no reason code to leak.
    expect(denied.emit).not.toHaveBeenCalled()

    const allowed = setup(allowAll)
    expect(allowed.port.admitEntity(target('alice'), issueRef('i1'))).toBe(true)
    expect(
      allowed.registry.has(entityRoutingKey(issueRef('i1')), asSubscriberId('alice')),
    ).toBe(true)
  })

  it('never reads the capability: only the resolver decides', () => {
    // A tripwire, not an inspection of the call args: `capability` is a getter
    // that records every read, so "the port evaluates no policy" is checked at
    // the one place a port could cheat — reading a scope out of the capability
    // instead of asking the policy layer.
    let capabilityReads = 0
    const principal = {
      kind: 'user' as const,
      user: asUserId('alice'),
      device: asDeviceId('d'),
      get capability() {
        capabilityReads++
        return asCapabilityRef('cap')
      },
    }
    const canSee = vi.fn(() => true)
    const { port } = setup({ canSee })
    const spied: PlaneTarget = { subscriberId: asSubscriberId('alice'), principal }
    const session = sessionRef('s1')

    port.admitEntity(spied, session)
    port.publishEntity(session, frame(0, 1))
    port.sendCommand(spied, { requestId: asCorrelationId('r'), type: 'kill', payload: {} })

    expect(capabilityReads).toBe(0)
    // And the resolver IS consulted, with the whole principal and the entity.
    expect(canSee).toHaveBeenCalledTimes(1)
    const [passed, entity] = canSee.mock.calls[0] as unknown as [Principal, unknown]
    expect(passed.kind).toBe('user')
    expect(entity).toEqual(session)
  })

  it('routes an entity frame to admitted principals only', () => {
    const { port, router } = setup({
      canSee: (p) => p.kind === 'user' && p.user === asUserId('alice'),
    })
    const ref = issueRef('i1')
    expect(port.admitEntity(target('alice'), ref)).toBe(true)
    expect(port.admitEntity(target('bob'), ref)).toBe(false)

    // An `evict` row: this test's subject is ROUTING, and evict carries no
    // payload (D14.1) so the fixture states nothing it does not mean. The v2
    // wire types `value` per entity arm, where v1's port row typed it `unknown`.
    const outcome = port.publishEntity(
      ref,
      frame(0, 5, [{ seq: 5, entity: 'issue', entityId: 'i1', op: 'evict' }]),
    )
    expect(outcome.delivered).toEqual([asSubscriberId('alice')])
    expect(router.queued(asSubscriberId('bob'))).toBe(0)
  })

  it('stops routing on revoke without telling the replica anything is deleted', () => {
    const { port, registry } = setup()
    const ref = issueRef('i1')
    port.admitEntity(target('alice'), ref)
    expect(port.revokeEntity(target('alice'), ref)).toBe(true)
    expect(registry.has(entityRoutingKey(ref), asSubscriberId('alice'))).toBe(false)
    expect(port.publishEntity(ref, frame(5, 6)).delivered).toEqual([])
  })
})

describe('watermarks — ADR 2 Amendment 1 D13 on the control port', () => {
  it('treats a certified frame with no visible changes as a watermark, on the same pipe', () => {
    const { port, router } = setup()
    const conn = target('alice')
    const outcome = port.sendCertified(conn, frame(10, 42))
    expect(outcome.delivered).toEqual([asSubscriberId('alice')])
    const [sent] = router.drain(asSubscriberId('alice')) as [FeedDeltaMessage]
    expect(isFeedWatermark(sent)).toBe(true)
    expect(sent.fromSeq).toBe(10)
    expect(sent.seq).toBe(42)
  })

  // THE CURSOR-ACCEPTANCE CASE MOVED, IT DID NOT VANISH (POD-1196).
  //
  // `acceptsAtCursor` lived here and is deleted. The rule it encoded — accept
  // iff `fromSeq === cursor` and feedId/epoch match — is the REPLICA's, not the
  // port's, and the replica both implements it (`@podium/sync`'s `replica.ts`)
  // and declares it as rows `D7-1-GAP` and the epoch-mismatch rung-4 row in
  // `replica/transition-table.ts`. That table's totality test requires every
  // declared row to be exercised by a real transition, so the rule is pinned
  // harder there than a helper assertion pinned it here.

  it('refuses to send a frame that does not certify a well-formed range', () => {
    expect(() => assertCertified(frame(10, 9))).toThrow(/below fromSeq/)
    expect(() =>
      assertCertified(frame(10, 20, [{ seq: 21, entity: 'issue', entityId: 'i', op: 'upsert' }])),
    ).toThrow(/outside covered range/)
    expect(() =>
      assertCertified(
        frame(10, 20, [
          { seq: 15, entity: 'issue', entityId: 'a', op: 'upsert' },
          { seq: 12, entity: 'issue', entityId: 'b', op: 'upsert' },
        ]),
      ),
    ).toThrow(/non-decreasing/)
  })

  it('allows anchored rows to share a seq (D14.3)', () => {
    expect(() =>
      assertCertified(
        frame(10, 20, [
          { seq: 12, entity: 'issue', entityId: 'a', op: 'evict' },
          { seq: 12, entity: 'issue', entityId: 'b', op: 'evict' },
        ]),
      ),
    ).not.toThrow()
  })

  // D13.2/D13.3 COALESCING MOVED TOO (POD-1196).
  //
  // `coalesceCertifiedRanges` merged two frames by range extension and guarded
  // against merging across visible changes. It is deleted because the shipped
  // path does it differently AND more strongly: `FeedPublisher` holds a single
  // per-connection `watermarkThrough` slot whose lower bound is always that
  // connection's `fromSeq`, so a non-contiguous merge is UNREPRESENTABLE rather
  // than returned as `null`. Covered by `publisher.scoped.test.ts`'s
  // "watermarks are free — D13.2 coalescing and D13.4 no-demotion".
})

describe('rescope and evict — and the prohibition on reusing remove', () => {
  it('sends rescope on the ordered control pipe, distinguishable from resync', () => {
    const { port, router } = setup()
    const rescope: RescopeFrame = {
      type: 'rescope',
      feedId: 'f',
      epoch: 'e-01J0',
      seq: 77,
      cause: 'rights-changed',
    }
    expect(port.rescope(target('alice'), rescope).delivered).toEqual([asSubscriberId('alice')])
    const [sent] = router.drain(asSubscriberId('alice')) as [RescopeFrame]
    expect(sent.type).toBe('rescope')
    // Rights changed; the authority did not shed load. Telemetry must not collapse them.
    expect(sent.cause).toBe('rights-changed')
    expect(RESCOPE_PRESERVES_OUTBOX).toBe(true)
  })

  it('models evict as a THIRD member of the delete family, never as remove', () => {
    expect([...SCOPED_CHANGE_OPS]).toEqual(['upsert', 'remove', 'evict'])
    const evict = CHANGE_OP_SEMANTICS.evict
    const remove = CHANGE_OP_SEMANTICS.remove
    expect(evict.scope).toBe('per-principal')
    expect(remove.scope).toBe('global')
    expect(evict.reversible).toBe(true)
    expect(remove.reversible).toBe(false)
    // The replica must NOT render an eviction as a deletion.
    expect(evict.tombstone).toBe(false)
    expect(evict.deletedEvent).toBe(false)
    expect(remove.tombstone).toBe(true)
    expect(remove.deletedEvent).toBe(true)
    expect(evict.means).not.toBe(remove.means)
  })

  it('re-admits with an ordinary upsert — no new op needed (D14.2)', () => {
    const { port, router } = setup()
    const ref = issueRef('i1')
    port.admitEntity(target('alice'), ref)
    // The OP is this test's subject (D14.2: re-admission needs no new op), and
    // `value` is `.optional()` on the arm because "present iff upsert" is a
    // cross-field rule zod cannot state inside a discriminated union — it is
    // enforced by `validateFeedDelta` and covered in `messages/feed.test.ts`.
    // Omitted here rather than filled with a fake IssueWire the port never reads.
    const readmit = frame(9, 10, [
      { seq: 10, entity: 'issue', entityId: 'i1', op: 'upsert' },
    ])
    expect(port.publishEntity(ref, readmit).delivered).toEqual([asSubscriberId('alice')])
    const [sent] = router.drain(asSubscriberId('alice')) as [FeedDeltaMessage]
    expect(sent.changes[0]?.op).toBe('upsert')
  })
})

describe('the command class lives inside the control port', () => {
  it('is correlated, point-to-point, and never oplogged', () => {
    const { port } = setup()
    const semantics = port.commandSemantics({
      requestId: asCorrelationId('r1'),
      type: 'spawn',
      payload: {},
    })
    expect(semantics).toEqual({
      correlated: true,
      requiresLivePeer: true,
      fanOut: false,
      oplogged: false,
    })
  })

  it('requires a live peer unless the command is offline-class (ADR 3 D4)', () => {
    const offline = setup(allowAll, false)
    expect(
      offline.port.sendCommand(target('alice'), {
        requestId: asCorrelationId('r1'),
        type: 'spawn',
        payload: {},
      }),
    ).toEqual({ status: 'no-live-peer', requestId: 'r1' })

    expect(
      offline.port.sendCommand(target('alice'), {
        requestId: asCorrelationId('r2'),
        type: 'issues.close',
        payload: {},
        offlineClass: true,
      }),
    ).toEqual({ status: 'queued', requestId: 'r2' })
    expect(offline.emit).not.toHaveBeenCalled()
  })

  it('emits a live command point-to-point, not through the entity router', () => {
    const { port, emit, router } = setup()
    const disposition = port.sendCommand(target('alice'), {
      requestId: asCorrelationId('r3'),
      type: 'kill',
      payload: { sessionId: asSessionId('s1') },
    })
    expect(disposition).toEqual({ status: 'sent', requestId: 'r3' })
    expect(emit).toHaveBeenCalledTimes(1)
    // Nothing entered the durable fan-out queue: a command has nothing to heal.
    expect(router.queued(asSubscriberId('alice'))).toBe(0)
  })
})
