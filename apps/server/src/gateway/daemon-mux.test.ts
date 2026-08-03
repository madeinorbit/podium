/**
 * THE MUX'S OWN CONTRACT (POD-389) — routing, machine scope, writer class and
 * the host-edge/agent-relay separation, driven through fake ports so a failure
 * names the mux and not a feature.
 */

import { asSessionId } from '@podium/model'
import {
  AGENT_RELAY_FRAMES,
  attributionOf,
  DAEMON_PLANE_CLASS,
  type DaemonMessage,
  edgeOf,
  HOST_EDGE_FRAMES,
  type MachinePrincipal,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  DAEMON_FRAME_PORTS,
  type DaemonPortId,
  daemonPortsFor,
  MACHINE_SCOPE_CARRIER,
  PRINCIPAL_SCOPED_FRAMES,
  REQUEST_CORRELATED_FRAMES,
} from './daemon-frame-routing'
import { DaemonMux, inProcessMachinePrincipal } from './daemon-mux'
import type { DaemonFeaturePorts } from './daemon-ports'

/** Records every port call as `port.method(...args)` in arrival order. */
function fakePorts() {
  const calls: { port: DaemonPortId; method: string; args: unknown[] }[] = []
  const rec =
    (port: DaemonPortId, method: string) =>
    (...args: unknown[]): undefined => {
      calls.push({ port, method, args })
      return undefined
    }
  const proxyFor = (port: DaemonPortId): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'detach') return rec(port, prop) as unknown as () => boolean
          return rec(port, prop)
        },
      },
    )
  const machines = new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === 'detach'
          ? (...args: unknown[]) => {
              calls.push({ port: 'machines', method: 'detach', args })
              return true
            }
          : rec('machines', prop),
    },
  )
  const conversations = proxyFor('conversations')
  const ports = {
    sessions: proxyFor('sessions'),
    machines,
    hosts: proxyFor('hosts'),
    conversations,
    rpc: proxyFor('rpc'),
    headless: proxyFor('headless'),
    approvals: proxyFor('approvals'),
    agentRelay: proxyFor('agentRelay'),
  } as unknown as DaemonFeaturePorts
  return { ports, calls }
}

const muxWith = (ports: DaemonFeaturePorts) =>
  new DaemonMux({ ports, bus: { emit: vi.fn() } as never })

/** A minimal frame of every daemon type, good enough to route (never to handle). */
const sampleFrame = (type: DaemonMessage['type']): DaemonMessage =>
  ({
    type,
    sessionId: asSessionId('s1'),
    requestId: 'r1',
    inventory: { os: 'linux', arch: 'x64', agents: [], tools: [] },
    conversations: [],
    diagnostics: [],
    removed: [],
  }) as unknown as DaemonMessage

const PRINCIPAL: MachinePrincipal = inProcessMachinePrincipal('m1')

describe('the routing table', () => {
  it('names an owning port for EVERY frame in the ADR 7 daemon inventory', () => {
    // The compile-time `satisfies` proves the table is total over the union; this
    // proves it is total over the INVENTORY too, so a frame classified in ADR 7
    // and forgotten here is caught even if the two ever drift.
    const unowned = Object.keys(DAEMON_PLANE_CLASS).filter((t) => daemonPortsFor(t) === null)
    expect(unowned).toEqual([])
  })

  it('refuses a frame it cannot classify rather than guessing an owner', () => {
    const { ports, calls } = fakePorts()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    muxWith(ports).routeDaemonFrame(PRINCIPAL, { type: 'notAFrame' } as unknown as DaemonMessage)
    expect(calls).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unclassified daemon frame'))
    warn.mockRestore()
  })

  it('routes every inventoried frame to exactly the ports the table names', () => {
    for (const type of Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      expect(
        calls.map((c) => c.port),
        `frame '${type}' reached the wrong ports`,
      ).toEqual([...DAEMON_FRAME_PORTS[type]])
    }
  })
})

describe('the host-edge / agent-relay separation (ADR 7 D2, ADR 5 D7)', () => {
  it('routes EXACTLY the two relay frames to the agent-relay port', () => {
    const reaching: string[] = []
    for (const type of Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      if (calls.some((c) => c.port === 'agentRelay')) reaching.push(type)
    }
    // `agentRelayResult` is server→daemon, so only the REQUEST half is inbound
    // here; the assertion is that nothing else is, which is the rule.
    expect(reaching).toEqual(['agentRelayRequest'])
    expect(AGENT_RELAY_FRAMES).toContain(reaching[0])
  })

  it('sends no host-edge frame to the agent-relay port', () => {
    // The counterfactual the rule needs: the fixture contains host-edge frames
    // that COULD have been merged onto the relay because they arrive on the same
    // socket. Each is checked, not assumed.
    const inbound = HOST_EDGE_FRAMES.filter((f) => daemonPortsFor(f) !== null)
    expect(inbound.length).toBeGreaterThan(10)
    for (const type of inbound) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type as DaemonMessage['type']))
      expect(
        calls.some((c) => c.port === 'agentRelay'),
        `host-edge frame '${type}' reached the agent relay`,
      ).toBe(false)
      expect(edgeOf(type)).toBe('host')
    }
  })
})

describe('machine scope and the writer class', () => {
  it('carries the machine principal on every session-owned frame', () => {
    const sessionFrames = (Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]).filter(
      (t) => DAEMON_FRAME_PORTS[t].length === 1 && DAEMON_FRAME_PORTS[t][0] === 'sessions',
    )
    // 21 since the catch-up merge, not 20: main's `agentContext` (POD-1262, the
    // exact harness-reported context-window reading) is session-owned like every
    // other frame in this set. Counted rather than derived so a frame that joins
    // the set has to be acknowledged HERE — which is how this one was noticed.
    expect(sessionFrames.length).toBe(21)
    for (const type of sessionFrames) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      expect(calls[0]?.method).toBe('onSessionDaemonFrame')
      expect(calls[0]?.args[0]).toBe(PRINCIPAL)
    }
  })

  it('delivers every PRINCIPAL-scoped machine-adjacent frame with its machine id', () => {
    // §3.1.1: a per-machine fact routed without its machine identity becomes an
    // unscopable projection downstream. Audited per frame, never assumed.
    expect(PRINCIPAL_SCOPED_FRAMES.length).toBeGreaterThan(0)
    for (const type of PRINCIPAL_SCOPED_FRAMES) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      expect(calls[0]?.args[0], `'${type}' lost its machine scope`).toBe(PRINCIPAL.machine)
    }
  })

  it('delivers every REQUEST-CORRELATED reply with the ANSWERING machine id (POD-1175)', () => {
    // The carrier table has always CLAIMED that a correlated reply's scope was
    // fixed when the request was sent. Nothing enforced it while the settle path
    // never learned who answered — precisely why POD-1175 existed. The
    // correlator can only compare answerer against target if the mux hands it
    // over, so every row is audited here rather than assumed.
    expect(REQUEST_CORRELATED_FRAMES.length).toBeGreaterThan(0)
    for (const type of REQUEST_CORRELATED_FRAMES) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      expect(calls[0]?.args[0], `'${type}' reached its port without its answerer`).toBe(
        PRINCIPAL.machine,
      )
    }
  })

  it('hands EVERY rpc-owned reply to the one correlator, answerer first', () => {
    // Twenty-three `onXResult(msg)` methods collapsed into one
    // `settleDaemonReply` (POD-318), plus `modelProbeResult` (POD-1466). This
    // pins that the collapse is total: no reply frame keeps a private door into
    // the rpc port, and none of them arrives anonymously. The count is the
    // ratchet — a new rpc reply must be added here DELIBERATELY, which is how
    // this test noticed POD-1466's frame rather than absorbing it silently.
    const rpcFrames = (Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]).filter((t) =>
      (DAEMON_FRAME_PORTS[t] as readonly DaemonPortId[]).includes('rpc'),
    )
    expect(rpcFrames.length).toBe(24)
    for (const type of rpcFrames) {
      const { ports, calls } = fakePorts()
      muxWith(ports).routeDaemonFrame(PRINCIPAL, sampleFrame(type))
      const rpcCall = calls.find((c) => c.port === 'rpc')
      expect(rpcCall?.method, `'${type}' did not reach the correlator`).toBe('settleDaemonReply')
      expect(rpcCall?.args[0]).toBe(PRINCIPAL.machine)
    }
  })

  it('audits the machine-adjacent set against the port rule rather than a hand list', () => {
    // Every frame the port rule calls an inventory/host probe or a repo-shaped
    // reply must appear in the scope audit with a named carrier. This is the
    // check that would fail if a new machine-adjacent frame were added and
    // routed without deciding how its scope travels.
    const audited = new Set(Object.keys(MACHINE_SCOPE_CARRIER))
    const machineAdjacent = [
      'inventoryReport',
      'hostMetrics',
      'memoryBreakdownResult',
      'scanResult',
      'scanReposResult',
      'conversationsChanged',
      'browseDirsResult',
      'repoOpResult',
    ]
    for (const type of machineAdjacent) expect(audited.has(type)).toBe(true)
    for (const carrier of Object.values(MACHINE_SCOPE_CARRIER)) {
      expect(['principal', 'request-correlated']).toContain(carrier)
    }
  })

  it('attributes a daemon observation to the MACHINE, with no on-behalf-of', () => {
    // ADR 1's daemon writer class / ADR 9's machine class: never a person, never
    // the system class, and `null` is a distinct representable "none" rather
    // than a defaulted operator.
    const attribution = attributionOf(PRINCIPAL)
    expect(attribution.actor).toBe('m1')
    expect(attribution.onBehalfOf).toBeNull()
  })

  it('cannot mint a non-machine principal for the daemon path', () => {
    // The one function that turns a bare machine id into a principal. If this
    // ever produced a user/agent/system kind, the daemon path would gain an
    // ambient identity — the multi-user hole this extraction had to avoid.
    for (const id of ['local', 'm1', 'operator', 'system']) {
      expect(inProcessMachinePrincipal(id).kind).toBe('machine')
      expect(attributionOf(inProcessMachinePrincipal(id)).onBehalfOf).toBeNull()
    }
  })

  it('ignores a machine id asserted in the frame body', () => {
    const { ports, calls } = fakePorts()
    muxWith(ports).routeDaemonFrame(PRINCIPAL, {
      ...sampleFrame('hostMetrics'),
      machineId: 'attacker',
    } as unknown as DaemonMessage)
    expect(calls[0]?.args[0]).toBe('m1')
    // And the claim is not silently forwarded inside the payload either.
    expect(JSON.stringify(calls[0]?.args[1])).toContain('attacker')
    expect(calls[0]?.args[0]).not.toBe('attacker')
  })
})

describe('attach / detach orchestration', () => {
  it('runs the attach steps in the order the old inline body ran them', () => {
    const { ports, calls } = fakePorts()
    const bus = { emit: vi.fn() }
    new DaemonMux({ ports, bus: bus as never }).attachDaemon('local', () => {})
    expect(calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'machines.attach',
      // No adoption step: POD-318 writes every row under a real machine id from
      // boot, so an attaching daemon has nothing to claim — it becomes reachable.
      'machines.flushQueued',
      'sessions.onMachineAttached',
      'machines.broadcastMachines',
    ])
    expect(bus.emit).toHaveBeenCalledWith('machine.connected', { machineId: 'local' })
  })

  it('claims nothing on attach — no machine is special any more', () => {
    // The step used to fire for the hard-coded local machine and for nothing else.
    // Both halves of that are gone; an attach is an attach.
    const { ports, calls } = fakePorts()
    muxWith(ports).attachDaemon('m2', () => {})
    expect(calls.map((c) => c.method)).not.toContain('adoptPlaceholderRows')
  })

  it('emits machine.disconnected BEFORE the session sweep', () => {
    const order: string[] = []
    const { ports, calls } = fakePorts()
    const bus = { emit: (e: string) => order.push(`bus.${e}`) }
    const mux = new DaemonMux({ ports, bus: bus as never })
    const send = (): void => {}
    mux.detachDaemon('m1', send)
    // Interleave the recorded port calls with the bus emit by position: the port
    // recorder and `order` are appended to in the same synchronous run.
    expect(calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'machines.detach',
      'sessions.onMachineDetached',
      'machines.broadcastMachines',
    ])
    expect(order).toEqual(['bus.machine.disconnected'])
  })

  it('does nothing when a superseded socket closes', () => {
    // machines.detach returning false means this close belongs to a socket the
    // daemon already replaced; sweeping its sessions would knock a HEALTHY
    // daemon's sessions to 'reconnecting' behind its back.
    const calls: string[] = []
    const ports = {
      machines: {
        detach: () => {
          calls.push('detach')
          return false
        },
        broadcastMachines: () => calls.push('broadcastMachines'),
      },
      sessions: { onMachineDetached: () => calls.push('onMachineDetached') },
    } as unknown as DaemonFeaturePorts
    const bus = { emit: () => calls.push('emit') }
    new DaemonMux({ ports, bus: bus as never }).detachDaemon('m1', () => {})
    expect(calls).toEqual(['detach'])
  })
})
