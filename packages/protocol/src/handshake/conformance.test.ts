/**
 * THE SHARED SUITE, RUN AGAINST BOTH ENDS — POD-388's acceptance criterion that
 * the shared protocol tests execute against the GATEWAY end and the DAEMON end,
 * not only the server. One scenario list (`./conformance.ts`), two probes.
 *
 * The daemon probe's "pending" state is `awaiting-ack`, which is the honest
 * mirror of the acceptor's `awaiting-hello`: both mean "this end has a peer and no
 * principal yet", and both must refuse everything that is not the handshake frame
 * they are waiting for. The daemon end's version of "traffic before the
 * handshake" is the documented production wedge — a `sessionPriority` frame
 * arriving ahead of `helloOk`, which used to make the daemon refuse and loop.
 */

import { describe, expect, it } from 'vitest'
import { WIRE_VERSION } from '../version'
import { createHandshakeAcceptor } from './acceptor'
import {
  type HandshakeEndProbe,
  type HandshakeEndSession,
  type HandshakeObservation,
  HANDSHAKE_CONFORMANCE_CASES,
  runHandshakeConformance,
} from './conformance'
import { createHandshakeDialer } from './dialer'
import { createAuthStrategyRegistry } from './strategies/registry'
import type { PeerAuthStrategy } from './strategies/types'
import {
  createRecordingMinter,
  fakeMachines,
  helloFor,
  machineRecord,
  transportFacts,
} from './test-support'
import { createMachineTokenStrategy } from './strategies/machine-token'

const APP_FRAME = JSON.stringify({ type: 'inventoryRequest' })

// --------------------------------------------------------------------------
// Gateway end
// --------------------------------------------------------------------------

const gatewayProbe = (): HandshakeEndProbe => {
  let consulted = false
  const inner = createMachineTokenStrategy({
    machines: fakeMachines({ tokens: { 'tok-ok': machineRecord('mach-vps', { owner: 'usr-ada' }) } }),
    mint: createRecordingMinter(),
  })
  const counting: PeerAuthStrategy = {
    role: inner.role,
    credentialKind: inner.credentialKind,
    name: inner.name,
    authenticate: (input) => {
      consulted = true
      // The registry is heterogeneous by design; the acceptor only ever routes a
      // machineToken credential to this entry.
      return inner.authenticate(
        input as Parameters<typeof inner.authenticate>[0],
      )
    },
  }
  const registry = createAuthStrategyRegistry([counting])

  return {
    end: 'gateway',
    name: 'wsServer acceptor (POD-317)',
    authWasConsulted: () => consulted,
    fresh(): HandshakeEndSession {
      consulted = false
      const acceptor = createHandshakeAcceptor({
        registry,
        supportedCaps: ['metadataDelta'],
        transport: transportFacts({ endpoint: '/daemon' }),
      })
      const observe = (raw: string): HandshakeObservation => {
        const step = acceptor.receive(raw)
        return step.action === 'establish'
          ? 'established'
          : step.action === 'deliver'
            ? 'delivered'
            : 'refused'
      }
      return {
        get state() {
          return acceptor.state === 'established'
            ? 'established'
            : acceptor.state === 'closed'
              ? 'closed'
              : 'pending'
        },
        handshake: () => observe(goodHello()),
        feed: observe,
        helloLike: goodHello,
        appTraffic: () => APP_FRAME,
        junk: () => 'not json at all',
        versionMismatch: () =>
          JSON.stringify(
            helloFor({ kind: 'machineToken', token: 'tok-ok' }, { v: WIRE_VERSION + 5 }),
          ),
      }
    },
  }
}

const goodHello = (): string =>
  JSON.stringify(helloFor({ kind: 'machineToken', token: 'tok-ok' }))

// --------------------------------------------------------------------------
// Daemon end
// --------------------------------------------------------------------------

const okReply = (): string =>
  JSON.stringify({ type: 'peerHelloOk', v: WIRE_VERSION, caps: [], name: 'vps' })

const daemonProbe = (): HandshakeEndProbe => ({
  end: 'daemon',
  name: 'daemon dialer (POD-327)',
  // The daemon end has no auth strategies — it PRESENTS a credential.
  authWasConsulted: () => null,
  fresh(): HandshakeEndSession {
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'machineToken', token: 'tok-ok' },
    })
    // "Pending" at this end means the hello is out and the ack has not arrived.
    dialer.hello()
    const observe = (raw: string): HandshakeObservation => {
      const step = dialer.receive(raw)
      return step.action === 'established'
        ? 'established'
        : step.action === 'deliver'
          ? 'delivered'
          : step.action === 'rejected'
            ? 'refused'
            : 'protocol-error'
    }
    return {
      get state() {
        return dialer.state === 'established'
          ? 'established'
          : dialer.state === 'failed'
            ? 'closed'
            : 'pending'
      },
      handshake: () => observe(okReply()),
      feed: observe,
      helloLike: okReply,
      appTraffic: () => APP_FRAME,
      junk: () => 'not json at all',
      versionMismatch: () =>
        JSON.stringify({
          type: 'peerHelloRejected',
          reason: 'unsupported-version',
          support: { wire: WIRE_VERSION, min: WIRE_VERSION },
        }),
    }
  },
})

// --------------------------------------------------------------------------

describe.each([gatewayProbe(), daemonProbe()])(
  'shared handshake conformance — $end end ($name)',
  (probe) => {
    for (const scenario of HANDSHAKE_CONFORMANCE_CASES) {
      it(scenario.name, () => {
        const result = scenario.run(probe)
        expect(result.detail ?? 'ok').toBe('ok')
        expect(result.ok).toBe(true)
      })
    }
  },
)

describe('the suite covers both ends and every case', () => {
  it('runs every case at each end', () => {
    for (const probe of [gatewayProbe(), daemonProbe()]) {
      const results = runHandshakeConformance(probe)
      expect(results).toHaveLength(HANDSHAKE_CONFORMANCE_CASES.length)
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => r.end))).toEqual(new Set([probe.end]))
    }
  })
})

describe('the two ends agree end to end', () => {
  it('a dialer hello authenticates at the acceptor, and the reply establishes the dialer', () => {
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'machineToken', token: 'tok-ok' },
      caps: ['metadataDelta', 'peerRole:node'],
      // Hostile claims on the real dialer path: still inert.
      claims: { machineId: 'mach-attacker', user: 'usr-root' },
    })
    const acceptor = createHandshakeAcceptor({
      registry: createAuthStrategyRegistry([
        createMachineTokenStrategy({
          machines: fakeMachines({
            tokens: { 'tok-ok': machineRecord('mach-vps', { owner: 'usr-ada', name: 'vps' }) },
          }),
          mint: createRecordingMinter(),
        }),
      ]),
      supportedCaps: ['metadataDelta'],
      transport: transportFacts({ endpoint: '/daemon' }),
    })
    const step = acceptor.receive(JSON.stringify(dialer.hello()))
    expect(step.action).toBe('establish')
    if (step.action !== 'establish') return
    expect(step.peer.principal).toMatchObject({ kind: 'machine', machine: 'mach-vps' })

    const dialerStep = dialer.receive(JSON.stringify(step.reply))
    expect(dialerStep).toMatchObject({
      action: 'established',
      agreedVersion: WIRE_VERSION,
      name: 'vps',
    })
    // The reserved token the dialer offered was neither accepted nor echoed.
    expect(dialerStep.action === 'established' && dialerStep.caps.accepted).toEqual([
      'metadataDelta',
    ])
  })

  it('a rejection at the acceptor becomes a rejection at the dialer, not a retry loop', () => {
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'machineToken', token: 'tok-wrong' },
    })
    const acceptor = createHandshakeAcceptor({
      registry: createAuthStrategyRegistry([
        createMachineTokenStrategy({
          machines: fakeMachines({ tokens: {} }),
          mint: createRecordingMinter(),
        }),
      ]),
      transport: transportFacts({ endpoint: '/daemon' }),
    })
    const step = acceptor.receive(JSON.stringify(dialer.hello()))
    expect(step.action).toBe('reject')
    if (step.action !== 'reject') return
    // The server-side diagnostic exists and does NOT travel.
    expect(step.diagnostic).toBeDefined()
    expect(JSON.stringify(step.reply)).not.toContain('did not verify')
    expect(dialer.receive(JSON.stringify(step.reply))).toMatchObject({ action: 'rejected' })
    expect(dialer.state).toBe('failed')
  })
})
