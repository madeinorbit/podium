/**
 * THE HANDSHAKE-ORDER REGRESSION CLASS at the gateway end, plus the framing
 * properties that are common to every role (version-before-auth, endpoint role
 * pinning, reserved caps inert, payload-inert at the framing level).
 */

import { describe, expect, it, vi } from 'vitest'
import { WIRE_VERSION } from '../version'
import { createHandshakeAcceptor } from './acceptor'
import type { PeerHello } from './envelope'
import { createAuthStrategyRegistry } from './strategies/registry'
import type { AuthOutcome, PeerAuthStrategy } from './strategies/types'
import { createDefaultAuthRegistry } from './strategies/default-registry'
import {
  createRecordingMinter,
  fakeMachines,
  helloFor,
  HOSTILE_CLAIMS,
  machineRecord,
  transportFacts,
} from './test-support'

const machine = machineRecord('mach-vps', { owner: 'usr-ada', name: 'vps' })

const registry = () =>
  createDefaultAuthRegistry({
    machines: fakeMachines({ tokens: { 'tok-ok': machine } }),
    mint: createRecordingMinter(),
  })

const acceptor = (over: Partial<Parameters<typeof createHandshakeAcceptor>[0]> = {}) =>
  createHandshakeAcceptor({
    registry: registry(),
    supportedCaps: ['metadataDelta'],
    transport: transportFacts({ endpoint: '/daemon' }),
    ...over,
  })

const goodHello = (over: Partial<PeerHello> = {}): string =>
  JSON.stringify(helloFor({ kind: 'machineToken', token: 'tok-ok' }, over))

const APP_FRAME = JSON.stringify({ type: 'inventoryRequest' })

describe('handshake order — the gateway end', () => {
  it('rule 1: the first frame must be a hello; application traffic closes the connection', () => {
    const a = acceptor()
    const step = a.receive(APP_FRAME)
    expect(step.action).toBe('reject')
    expect(step.action === 'reject' && step.reply.reason).toBe('unexpected-frame')
    expect(a.state).toBe('closed')
    expect(a.peer).toBeNull()
  })

  it('rule 1: unparseable bytes close the connection', () => {
    const a = acceptor()
    expect(a.receive('not json at all').action).toBe('reject')
    expect(a.state).toBe('closed')
  })

  it('rule 1: a hello-shaped frame that fails the schema is malformed, not unexpected', () => {
    const a = acceptor()
    const step = a.receive(JSON.stringify({ type: 'peerHello', v: 'one' }))
    expect(step.action === 'reject' && step.reply.reason).toBe('malformed-hello')
  })

  it('rule 2: version is refused BEFORE any credential is examined', () => {
    const authenticate = vi.fn((): AuthOutcome => ({ ok: false, reason: 'auth-failed' }))
    const spy: PeerAuthStrategy = {
      role: 'machine',
      credentialKind: 'machineToken',
      name: 'spy',
      authenticate,
    }
    const a = createHandshakeAcceptor({
      registry: createAuthStrategyRegistry([spy]),
      transport: transportFacts({ endpoint: '/daemon' }),
    })
    const step = a.receive(goodHello({ v: WIRE_VERSION + 5 }))
    expect(step.action === 'reject' && step.reply.reason).toBe('unsupported-version')
    expect(authenticate).not.toHaveBeenCalled()
    expect(a.state).toBe('closed')
  })

  it('rule 3: a second hello on a live connection is refused, not a re-auth', () => {
    const a = acceptor()
    expect(a.receive(goodHello()).action).toBe('establish')
    const step = a.receive(goodHello())
    expect(step.action === 'reject' && step.reply.reason).toBe('unexpected-frame')
    expect(a.state).toBe('closed')
  })

  it('rule 4: no frame is delivered before a principal exists, and every frame after carries one', () => {
    const a = acceptor()
    const first = a.receive(APP_FRAME)
    expect(first.action).not.toBe('deliver')

    const b = acceptor()
    expect(b.receive(goodHello()).action).toBe('establish')
    const delivered = b.receive(APP_FRAME)
    expect(delivered.action).toBe('deliver')
    expect(delivered.action === 'deliver' && delivered.peer.principal).toMatchObject({
      kind: 'machine',
      machine: 'mach-vps',
    })
  })

  it('a refused connection stays refused', () => {
    const a = acceptor()
    a.receive('garbage')
    const step = a.receive(goodHello())
    expect(step.action).toBe('reject')
    expect(a.peer).toBeNull()
  })
})

describe('framing is common; role resolution is not payload-controlled', () => {
  it('infers the role from the endpoint when the peer declares none (ADR 5 D4.3)', () => {
    const step = acceptor().receive(goodHello())
    expect(step.action === 'establish' && step.peer.role).toBe('machine')
  })

  it('refuses a peerRole that contradicts the endpoint', () => {
    const a = createHandshakeAcceptor({
      registry: registry(),
      transport: transportFacts({ endpoint: '/client' }),
    })
    const step = a.receive(goodHello({ peerRole: 'machine' }))
    expect(step.action === 'reject' && step.reply.reason).toBe('unknown-role')
  })

  it('refuses a credential the endpoint-implied role does not claim', () => {
    const a = createHandshakeAcceptor({
      registry: registry(),
      transport: transportFacts({ endpoint: '/client' }),
    })
    const step = a.receive(JSON.stringify(helloFor({ kind: 'machineToken', token: 'tok-ok' })))
    // /client implies console, and console does not claim a machine token.
    expect(step.action === 'reject' && step.reply.reason).toBe('unsupported-credential')
  })

  it('a pinned non-peer ingress cannot be reached from the wire', () => {
    // `peerRole` is a closed enum of PEER roles, so `agent-relay` is unspellable
    // by a peer; only the composition root can pin it.
    const parsed = JSON.parse(goodHello()) as Record<string, unknown>
    const step = acceptor().receive(JSON.stringify({ ...parsed, peerRole: 'agent-relay' }))
    expect(step.action === 'reject' && step.reply.reason).toBe('malformed-hello')
  })

  it('refuses the reserved node role without crashing (ADR 5 D4.4)', () => {
    const a = createHandshakeAcceptor({
      registry: registry(),
      // An endpoint with no implied role, so the declared peerRole is used.
      transport: transportFacts({ endpoint: '/peer' }),
    })
    const step = a.receive(
      JSON.stringify(helloFor({ kind: 'nodeCredential' }, { peerRole: 'node', feedId: 'feed-1' })),
    )
    expect(step.action === 'reject' && step.reply.reason).toBe('role-not-implemented')
  })
})

describe('capability negotiation at the framing level', () => {
  it('accepts only the intersection and never echoes reserved tokens back', () => {
    const step = acceptor().receive(
      goodHello({ caps: ['metadataDelta', 'peerRole:node', 'feed.f1', 'unknownThing'] }),
    )
    expect(step.action).toBe('establish')
    if (step.action !== 'establish') return
    expect(step.reply.caps).toEqual(['metadataDelta'])
    expect(step.peer.caps.reserved).toEqual(['peerRole:node', 'feed.f1'])
    expect(step.peer.caps.ignored).toEqual(['unknownThing'])
  })

  it('a reserved cap grants no rights: the principal is identical with and without it', () => {
    const withReserved = acceptor().receive(goodHello({ caps: ['peerRole:node'] }))
    const without = acceptor().receive(goodHello())
    expect(withReserved.action === 'establish' && withReserved.peer.principal).toEqual(
      without.action === 'establish' ? without.peer.principal : null,
    )
  })

  it('an unauthenticated peer learns nothing about supported caps', () => {
    const a = acceptor()
    const step = a.receive(
      JSON.stringify(
        helloFor({ kind: 'machineToken', token: 'tok-wrong' }, { caps: ['metadataDelta'] }),
      ),
    )
    expect(step.action).toBe('reject')
    expect(step.action === 'reject' && 'caps' in step.reply).toBe(false)
  })
})

describe('payload identity is inert at the framing level too', () => {
  it('the hostile claims bag changes nothing about the established peer', () => {
    const honest = acceptor().receive(goodHello({ claims: {} }))
    const forged = acceptor().receive(goodHello({ claims: HOSTILE_CLAIMS }))
    expect(honest.action === 'establish' && honest.peer.principal).toEqual(
      forged.action === 'establish' ? forged.peer.principal : null,
    )
  })

  it('the acceptor tells the peer which identity IT resolved', () => {
    const step = acceptor().receive(goodHello())
    expect(step.action === 'establish' && step.reply.assignedId).toBe('mach-vps')
  })
})
