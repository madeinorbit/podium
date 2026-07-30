/**
 * THE GATEWAY'S HANDSHAKE COMPOSITION ROOT — where `wsServer` meets the shared
 * framing of ADR 5 D3 and the strategy modules of D5.
 *
 * `wsServer` keeps the socket, the heartbeat and the backpressure; this file owns
 * "who is this peer", and it owns it for every role through ONE acceptor. The
 * legacy `pair`/`hello` frames are translated in at the door
 * (`helloFromLegacyDaemonFrame`) and translated back out on the way home, so a
 * shipped daemon reaches the same strategies and the same principal as an
 * envelope peer without a second auth path (POD-308).
 */

import {
  type AcceptorStep,
  type CapabilityRef,
  createDefaultAuthRegistry,
  createHandshakeAcceptor,
  type DaemonHandshake,
  type DaemonHandshakeReply,
  type DeviceId,
  type HandshakeAcceptor,
  helloFromLegacyDaemonFrame,
  isLegacyDaemonFrame,
  legacyReplyFor,
  type MachineId,
  type PeerHelloReply,
  type UserId,
} from '@podium/protocol'
import { createMachineDirectory, type MachineAuthenticator } from './machine-directory'

/**
 * Capability minting. Today's capabilities are minted per call by the existing
 * policy layer (`capabilityForSession`, `OPERATOR`); what the handshake needs is a
 * stable REFERENCE it can hand the command layer, so the reference names the
 * subject and the command layer resolves rights live (ADR 3 D8 / D16).
 *
 * A reference — not a scope. There is deliberately no path here through which a
 * scope could be embedded and then go stale.
 */
export const gatewayCapabilityMinter = {
  forUser: (user: UserId, device: DeviceId): CapabilityRef =>
    `cap:user:${user}:${device}` as CapabilityRef,
  forMachine: (machine: MachineId): CapabilityRef => `cap:machine:${machine}` as CapabilityRef,
  forDelegation: (delegation: string): CapabilityRef =>
    `cap:delegation:${delegation}` as CapabilityRef,
}

export interface DaemonAcceptorDeps {
  readonly machines: MachineAuthenticator
  readonly connectionId: string
  readonly instanceId?: string
}

/**
 * The `/daemon` acceptor. `preAuthNonHandshake: 'ignore'` preserves the semantics
 * this socket has shipped with — a pre-auth non-handshake frame is dropped on the
 * floor (never delivered, no principal) and the socket keeps waiting for a real
 * handshake, which `wsServer.daemon.test.ts` pins.
 *
 * NOTE ON THE CONSOLE ROLE: no `clientSessions` port is passed, because per-user
 * client sessions do not exist yet (POD-1075). The registry therefore holds an
 * explicit REFUSAL for the console role rather than a gap, and `/client` keeps its
 * existing cookie gate until POD-1075 lands the (user, device) resolution this
 * strategy needs. Wiring the console strategy to today's single instance password
 * would resolve every cookie to one ambient operator — the exact hole this work
 * removes.
 */
export const createDaemonAcceptor = (deps: DaemonAcceptorDeps): HandshakeAcceptor =>
  createHandshakeAcceptor({
    registry: createDefaultAuthRegistry({
      machines: createMachineDirectory(deps.machines),
      mint: gatewayCapabilityMinter,
    }),
    // No negotiated capabilities on the daemon link today; the mechanism is here
    // and additive (ADR 5 D3.3), so adding one is adding a token to this list.
    supportedCaps: [],
    transport: {
      endpoint: '/daemon',
      connectionId: deps.connectionId,
      ...(deps.instanceId === undefined ? {} : { instanceId: deps.instanceId }),
    },
    preAuthNonHandshake: 'ignore',
  })

export type DaemonFrameOutcome =
  | { readonly kind: 'ignored' }
  | {
      readonly kind: 'established'
      readonly machineId: string
      readonly name: string
      /** The legacy reply to send BEFORE attaching (see `wireDaemonSocket`). */
      readonly reply: DaemonHandshakeReply | PeerHelloReply
      readonly pairingGrant: unknown
    }
  | { readonly kind: 'rejected'; readonly reply: DaemonHandshakeReply | PeerHelloReply }
  | { readonly kind: 'deliver'; readonly machineId: string; readonly raw: string }

/**
 * Feed one pre- or post-handshake frame to the acceptor and translate the step
 * into what the socket must do, including the legacy reply shape when the peer
 * spoke legacy frames.
 */
export const receiveDaemonFrame = (
  acceptor: HandshakeAcceptor,
  raw: string,
): DaemonFrameOutcome => {
  const legacy = asLegacyFrame(raw)
  const step: AcceptorStep = acceptor.receive(
    legacy === null ? raw : JSON.stringify(helloFromLegacyDaemonFrame(legacy)),
  )
  const reply = (envelope: PeerHelloReply): DaemonHandshakeReply | PeerHelloReply =>
    legacy === null ? envelope : legacyReplyFor(legacy, envelope)

  switch (step.action) {
    case 'ignore':
      return { kind: 'ignored' }
    case 'reject':
      return { kind: 'rejected', reply: reply(step.reply) }
    case 'establish': {
      const principal = step.peer.principal
      // The `/daemon` endpoint resolves the `machine` role, so a non-machine
      // principal here would mean the registry was mis-wired. Fail closed.
      if (principal.kind !== 'machine')
        return {
          kind: 'rejected',
          reply: reply({ type: 'peerHelloRejected', reason: 'unknown-role' }),
        }
      return {
        kind: 'established',
        machineId: principal.machine,
        name: step.peer.name ?? principal.machine,
        reply: reply(step.reply),
        pairingGrant: step.peer.directoryContext,
      }
    }
    case 'deliver': {
      const principal = step.peer.principal
      return {
        kind: 'deliver',
        // Every delivered frame is stamped with the authenticated machine — the
        // transport principal, never anything in the frame.
        machineId: principal.kind === 'machine' ? principal.machine : '',
        raw: step.raw,
      }
    }
  }
}

const asLegacyFrame = (raw: string): DaemonHandshake | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isLegacyDaemonFrame(parsed) ? (parsed as DaemonHandshake) : null
}
