/**
 * THE `/daemon` SOCKET — transport only (POD-389).
 *
 * This file holds the connection: the frames in, the handshake ordering, the
 * backpressure, the close. It holds NO routing table and NO feature logic — it
 * hands the resolved machine principal and the parsed frame to {@link DaemonMux}
 * and stops. Before this extraction the equivalent code called
 * `registry.modules.sessions.attachDaemon/onDaemonMessageFrom/detachDaemon`,
 * which made one feature the multiplexer for every other feature's traffic.
 *
 * THE PRINCIPAL IS AN OBJECT ON THIS PATH, and that is the point: `principal`
 * below is a `MachinePrincipal` produced by the handshake acceptor (POD-388's
 * strategy modules, ADR 5 D5), never a value read from a frame body. The mux's
 * bare-machine-id form exists for the in-process link and cannot be reached from
 * here — this file never constructs a principal.
 *
 * FAIL CLOSED. An unpaired, unrecognised or revoked daemon is REJECTED, not
 * admitted with reduced trust: the acceptor answers `rejected`, the reply goes
 * back, and the acceptor refuses every later frame on the socket rather than
 * letting a peer retry into a usable connection. A pre-auth frame that is not a
 * handshake is dropped on the floor — it never reaches a port and no principal
 * exists. The local daemon comes through this SAME path (`ensureHostMachine`
 * pre-registers it with a server-owned credential), so connecting over the local
 * socket confers exactly what a remote pairing confers and nothing more.
 */

import {
  type ControlMessage,
  type DaemonHandshakeReply,
  encode,
  type MachinePrincipal,
  type PeerHelloReply,
  type PortableCredentialBundle,
  parseDaemonMessage,
} from '@podium/protocol'
import type { PairingGrant } from '../modules/machines/service'
import type { SessionRegistry } from '../relay'
import { createDaemonAcceptor, receiveDaemonFrame } from './peer-handshake'
import { DAEMON_PLANE_LIVENESS } from './plane-liveness'
import { warnDroppedFrame } from './ws-send'

/** Freshly-attached daemons get polled this often (see the attach site) … */
const INVENTORY_SETTLE_INTERVAL_MS = 10_000
/** … for this long, which covers a turnkey enrollment installing all three CLIs. */
const INVENTORY_SETTLE_WINDOW_MS = 3 * 60_000

// The DEVICE half of a machine principal is the connection it arrived on (ADR 3
// Amendment 1 D14.1), so each daemon socket gets a process-local id. It is not
// persisted and not an identity — a reconnect is the same machine on a new
// binding, which is precisely what "device" means here.
let daemonConnectionSeq = 0
const nextDaemonConnectionId = (): number => {
  daemonConnectionSeq += 1
  return daemonConnectionSeq
}

/**
 * Per-daemon-socket lifecycle: hold the connection unauthenticated until the
 * FIRST frame proves identity, then route everything after through the gateway
 * mux under the principal that frame resolved.
 *
 * The first frame MUST parse as a handshake (pair/hello) — anything else (junk,
 * or a stray control frame from a buggy/hostile peer) is dropped on the floor.
 * One auth path for every daemon, local or remote:
 *  - `hello` (token in the store): the machine strategies verify it.
 *  - `pair` (one-time code): redeemed, and the minted token handed back once via
 *    `paired` (the daemon persists it).
 *
 * Outbound frames go through {@link safeSend} (backpressure + never-throws). The
 * caller (`attachWebSockets`) layers the heartbeat sweep on top — terminating a
 * wedged daemon fires this socket's `close` → `detachDaemon`, which re-queues
 * pending control messages and frees its sessions for the next daemon.
 *
 * Extracted from the connection handler so the auth logic is unit-testable
 * against a fake socket (see `wsServer.daemon.test.ts`).
 */
export function wireDaemonSocket(ws: import('ws').WebSocket, registry: SessionRegistry): void {
  // The AUTHENTICATED principal for this socket. Typed as the principal object,
  // not a machine id, so nothing on this path can substitute a payload value.
  let principal: MachinePrincipal | undefined
  // The send fn registered for THIS socket — the identity `close` detaches against.
  let send: ((msg: ControlMessage) => void) | undefined
  // Reply helper. The reply `type` literals (helloOk/paired/…) collide with members
  // of other encode() unions, so annotate the value as a DaemonHandshakeReply to
  // pin it to the handshake schema.
  const reply = (msg: DaemonHandshakeReply | PeerHelloReply): void =>
    ws.send(encode(msg as DaemonHandshakeReply))
  // The shared framing (ADR 5 D3) does the version negotiation, the role
  // resolution, the ORDER enforcement and the strategy selection; this socket
  // supplies the transport facts and does what the step says.
  const acceptor = createDaemonAcceptor({
    machines: registry.modules.machines,
    connectionId: `daemon-${nextDaemonConnectionId()}`,
  })
  ws.on('message', (raw: import('ws').RawData) => {
    if (principal === undefined) {
      const outcome = receiveDaemonFrame(acceptor, raw.toString())
      // A pre-auth frame that is not a handshake is dropped on the floor: it never
      // reaches a port and no principal exists (unchanged behaviour).
      if (outcome.kind === 'ignored') return
      if (outcome.kind === 'rejected') {
        // Terminal at the daemon (`daemon.ts` treats helloRejected / pairRejected as
        // blocked, with no reconnect loop), and terminal here: the acceptor refuses
        // every later frame on this socket rather than letting a peer retry into a
        // usable connection.
        reply(outcome.reply)
        return
      }
      if (outcome.kind !== 'established') return
      principal = outcome.principal
      // A fresh pair hands the minted token back exactly once (the daemon persists
      // it). `paired` is itself the successful handshake reply; sending a second
      // `helloOk` would arrive after the daemon has entered its control-message loop.
      reply(outcome.reply)
      // Send the handshake reply BEFORE attaching. attachDaemon synchronously flushes
      // any buffered control frames and pushes priorities, which would otherwise
      // reach the daemon ahead of helloOk — on a server with live sessions to prioritize
      // the daemon's first-frame handshake parse then sees a sessionPriority frame, fails
      // ("malformed reply"), and refuses, looping forever. The successful `paired` or
      // `helloOk` reply must be the first frame. (The daemon end now NAMES that
      // failure — `traffic-before-ack` in the shared dialer — instead of looping.)
      // The plane applies its own budget (POD-391): this file never names a byte
      // count, so it cannot name the client plane's.
      send = DAEMON_PLANE_LIVENESS.sink(ws).send
      registry.gateway.attachDaemon(principal, send)
      // A machine that just paired reports an EMPTY agent list: `install.sh` pairs
      // FIRST and installs Codex/Claude/Grok after, while the daemon's own inventory
      // loop only re-reports once a minute. Everything that gates on capability reads
      // that stale list — the handoff picker says "no Claude" for up to a minute after
      // the CLI is already installed and logged in. Poll the fresh daemon briefly so
      // it fills in seconds after each install lands, then fall back to its own loop.
      const settle = setInterval(
        () => send?.({ type: 'inventoryRequest' }),
        INVENTORY_SETTLE_INTERVAL_MS,
      )
      settle.unref?.()
      const stopSettle = setTimeout(() => clearInterval(settle), INVENTORY_SETTLE_WINDOW_MS)
      stopSettle.unref?.()
      ws.on('close', () => {
        clearInterval(settle)
        clearTimeout(stopSettle)
      })
      // The pairing grant rides back as the directory's opaque context: the
      // handshake carries it and never interprets it (see `directoryContext`).
      if ((outcome.pairingGrant as PairingGrant | undefined)?.copyAgentCredentials) {
        void relayAgentCredentials(registry, outcome.principal.machine)
      }
      return
    }
    // Post-handshake: the acceptor is asked FIRST, so a hello arriving on a live
    // connection is refused as an ordering violation rather than being parsed as
    // application traffic (a re-handshake would be a principal-swap primitive).
    const routed = receiveDaemonFrame(acceptor, raw.toString())
    if (routed.kind === 'rejected') {
      reply(routed.reply)
      return
    }
    try {
      // The frame is parsed here and CLASSIFIED in the mux. The principal passed
      // is this socket's authenticated one — a machine id in the payload (there
      // is no such field today, and an injected one is inert) can never become
      // the routing identity.
      registry.gateway.routeDaemonFrame(principal, parseDaemonMessage(raw.toString()))
    } catch (err) {
      // Drop the malformed frame (don't let it tear down the connection) — but
      // never silently: a silent drop here hides protocol drift / poison frames.
      warnDroppedFrame('daemon', err)
    }
  })
  ws.on('close', () => {
    // Pass THIS socket's send fn: if the daemon already reconnected, the registry
    // holds the new socket and this close must not evict it.
    if (principal && send) registry.gateway.detachDaemon(principal, send)
  })
}

/**
 * Pair-granted, memory-only secret relay. Each agent login is read from an
 * already-authenticated owned daemon and written directly to the new daemon;
 * no credential content enters SQLite or logs.
 */
async function relayAgentCredentials(
  registry: SessionRegistry,
  targetMachineId: string,
): Promise<void> {
  const agents = [
    { agentKind: 'claude-code', credentialKinds: ['claude-code', 'claude-code-state'] as const },
    { agentKind: 'codex', credentialKinds: ['codex'] as const },
    { agentKind: 'grok', credentialKinds: ['grok'] as const },
  ] as const
  const machines = registry.modules.machines.listMachines()
  const bundles: PortableCredentialBundle[] = []
  for (const agent of agents) {
    const source = machines.find(
      (machine) =>
        machine.id !== targetMachineId &&
        machine.online &&
        machine.inventory?.agents.some(
          (inventoryAgent) =>
            inventoryAgent.kind === agent.agentKind &&
            inventoryAgent.installed &&
            inventoryAgent.login.state === 'in',
        ),
    )
    if (!source) continue
    const exported = await registry.modules.rpc.credentialExport(
      [...agent.credentialKinds],
      source.id,
    )
    bundles.push(...exported.bundles)
  }
  if (bundles.length === 0) return
  const result = await registry.modules.rpc.credentialInstall(bundles, targetMachineId)
  if (result.failed.length > 0) {
    console.warn(`[podium] credential provisioning failed for: ${result.failed.join(', ')}`)
  }
}
