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
import {
  acceptsAtCursor,
  CHANGE_OP_SEMANTICS,
  coalesceCertifiedRanges,
  isWatermarkFrame,
  RESCOPE_PRESERVES_OUTBOX,
  type RescopeFrame,
  SCOPED_CHANGE_OPS,
  type ScopedDeltaFrame,
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
  const router = new PlaneRouter<ScopedDeltaFrame | RescopeFrame>(
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

const frame = (fromSeq: number, seq: number, changes: ScopedDeltaFrame['changes'] = []) =>
  ({ feedId: 'f', epoch: 1, fromSeq, seq, changes }) satisfies ScopedDeltaFrame

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
    const foreign = new PlaneRouter<ScopedDeltaFrame>(other, controlEntityDelivery(2))
    expect(
      () =>
        new ControlPlanePort(registry, foreign as never, {
          visibility: allowAll,
          isLive: () => true,
          emit: () => {},
        }),
    ).toThrow(/one subscription registry/)

    const streamRouter = new PlaneRouter<ScopedDeltaFrame>(
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
    expect(denied.port.admitEntity(target('alice'), { kind: 'issue', id: 'i1' })).toBe(false)
    expect(denied.registry.keyCount).toBe(0)
    // A refusal emits nothing: there is no reason code to leak.
    expect(denied.emit).not.toHaveBeenCalled()

    const allowed = setup(allowAll)
    expect(allowed.port.admitEntity(target('alice'), { kind: 'issue', id: 'i1' })).toBe(true)
    expect(
      allowed.registry.has(entityRoutingKey({ kind: 'issue', id: 'i1' }), asSubscriberId('alice')),
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

    port.admitEntity(spied, { kind: 'session', id: 's1' })
    port.publishEntity({ kind: 'session', id: 's1' }, frame(0, 1))
    port.sendCommand(spied, { requestId: asCorrelationId('r'), type: 'kill', payload: {} })

    expect(capabilityReads).toBe(0)
    // And the resolver IS consulted, with the whole principal and the entity.
    expect(canSee).toHaveBeenCalledTimes(1)
    const [passed, entity] = canSee.mock.calls[0] as unknown as [Principal, unknown]
    expect(passed.kind).toBe('user')
    expect(entity).toEqual({ kind: 'session', id: 's1' })
  })

  it('routes an entity frame to admitted principals only', () => {
    const { port, router } = setup({
      canSee: (p) => p.kind === 'user' && p.user === asUserId('alice'),
    })
    const ref = { kind: 'issue', id: 'i1' }
    expect(port.admitEntity(target('alice'), ref)).toBe(true)
    expect(port.admitEntity(target('bob'), ref)).toBe(false)

    const outcome = port.publishEntity(
      ref,
      frame(0, 5, [{ seq: 5, entity: 'issue', id: 'i1', op: 'upsert', value: {} }]),
    )
    expect(outcome.delivered).toEqual([asSubscriberId('alice')])
    expect(router.queued(asSubscriberId('bob'))).toBe(0)
  })

  it('stops routing on revoke without telling the replica anything is deleted', () => {
    const { port, registry } = setup()
    const ref = { kind: 'issue', id: 'i1' }
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
    const [sent] = router.drain(asSubscriberId('alice')) as [ScopedDeltaFrame]
    expect(isWatermarkFrame(sent)).toBe(true)
    expect(sent.fromSeq).toBe(10)
    expect(sent.seq).toBe(42)
  })

  it('advances the cursor over a suppressed range, and rejects a gap', () => {
    const cursor = { feedId: 'f', epoch: 1, seq: 10 }
    expect(acceptsAtCursor(cursor, frame(10, 42))).toBe(true)
    // A lost frame is caught by the explicit lower bound — the whole point.
    expect(acceptsAtCursor(cursor, frame(11, 42))).toBe(false)
    expect(acceptsAtCursor({ ...cursor, epoch: 2 }, frame(10, 42))).toBe(false)
  })

  it('refuses to send a frame that does not certify a well-formed range', () => {
    expect(() => assertCertified(frame(10, 9))).toThrow(/below fromSeq/)
    expect(() =>
      assertCertified(frame(10, 20, [{ seq: 21, entity: 'issue', id: 'i', op: 'upsert' }])),
    ).toThrow(/outside covered range/)
    expect(() =>
      assertCertified(
        frame(10, 20, [
          { seq: 15, entity: 'issue', id: 'a', op: 'upsert' },
          { seq: 12, entity: 'issue', id: 'b', op: 'upsert' },
        ]),
      ),
    ).toThrow(/non-decreasing/)
  })

  it('allows anchored rows to share a seq (D14.3)', () => {
    expect(() =>
      assertCertified(
        frame(10, 20, [
          { seq: 12, entity: 'issue', id: 'a', op: 'evict' },
          { seq: 12, entity: 'issue', id: 'b', op: 'evict' },
        ]),
      ),
    ).not.toThrow()
  })

  it('coalesces watermark runs by range extension only (D13.2/D13.3)', () => {
    const merged = coalesceCertifiedRanges(frame(0, 5), frame(5, 9))
    expect(merged).toEqual(frame(0, 9))
    // Non-adjacent ranges must not merge — that would invent contiguity.
    expect(coalesceCertifiedRanges(frame(0, 5), frame(6, 9))).toBeNull()
    // Two frames that both carry visible changes must never merge.
    const withChange = frame(0, 5, [{ seq: 3, entity: 'issue', id: 'a', op: 'upsert' }])
    const nextChange = frame(5, 9, [{ seq: 7, entity: 'issue', id: 'b', op: 'upsert' }])
    expect(coalesceCertifiedRanges(withChange, nextChange)).toBeNull()
    // A watermark may still extend a frame that carries changes.
    expect(coalesceCertifiedRanges(withChange, frame(5, 9))?.seq).toBe(9)
  })
})

describe('rescope and evict — and the prohibition on reusing remove', () => {
  it('sends rescope on the ordered control pipe, distinguishable from resync', () => {
    const { port, router } = setup()
    const rescope: RescopeFrame = {
      type: 'rescope',
      feedId: 'f',
      epoch: 1,
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
    const ref = { kind: 'issue', id: 'i1' }
    port.admitEntity(target('alice'), ref)
    const readmit = frame(9, 10, [
      { seq: 10, entity: 'issue', id: 'i1', op: 'upsert', value: { id: 'i1' } },
    ])
    expect(port.publishEntity(ref, readmit).delivered).toEqual([asSubscriberId('alice')])
    const [sent] = router.drain(asSubscriberId('alice')) as [ScopedDeltaFrame]
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
      payload: { sessionId: 's1' },
    })
    expect(disposition).toEqual({ status: 'sent', requestId: 'r3' })
    expect(emit).toHaveBeenCalledTimes(1)
    // Nothing entered the durable fan-out queue: a command has nothing to heal.
    expect(router.queued(asSubscriberId('alice'))).toBe(0)
  })
})
