// A composed daemon generation for headless delivery tests
// (POD-4827): the real spawn/turn handlers over a composed headless runtime
// with a fake engine, so a server-side test can feed a session's ACTUAL spawn
// and turn bytes through the real daemon path and observe delivery.
//
// Lives in apps/daemon (not the server test) because composing the runtime
// imports the machine-host surface (`@podium/harness/driver/host`,
// `/testing`), which the harness manifest restricts to the machine host —
// apps/server may only reach it through the daemon, never directly. The
// server test drives this helper through the daemon's control handlers, the
// same seam the wire would take.
import {
  createHeadlessRuntime,
  type EngineProcessOwner,
  type HeadlessDriverHost,
  type HeadlessDriverRunners,
  type HeadlessRuntime,
} from '@podium/harness/driver/host'
import { createMemoryDriverSlots } from '@podium/harness/driver/testing'
import { asMachineId, type MachineId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { BindingStore } from '../binding-store.js'
import type { DaemonContext } from '../control/context.js'
import { createDaemonMachineRuntime } from '../runtime/machine-runtime.js'
import { SessionBinding } from '../session-binding.js'
import { testSessions } from '../session/testing.js'
import { testHarnessSnapshot } from './harness-snapshot.js'

/** The session layer's process owner, as the driver hands it on: never called
 *  by the fake runners, only passed through. */
const OWNER: EngineProcessOwner = {
  startEngine: () => Promise.reject(new Error('fake owner: no processes here')),
  reattachEngine: () => Promise.reject(new Error('fake owner: no processes here')),
  engineAlive: async () => false,
  destroyEngine: async () => {},
}

export interface DeliveredHeadlessTurn {
  turnId: string
  sessionId: SessionId
  resolve: (outcome: { harnessSessionId: string; output: string }) => void
}

export interface ComposedHeadlessDaemon {
  ctx: DaemonContext
  /** Every frame the daemon sent (bind/driverSelected/receipts/events). */
  sent: DaemonMessage[]
  /** Turns the fake engine received, in dispatch order. */
  turns: DeliveredHeadlessTurn[]
}

/**
 * Compose one daemon generation: the binding layer over the CALLER's store
 * (share one store across generations to model a restart — bindings persist,
 * handles do not), fresh session/runtime maps, the headless runtime with a
 * fake engine, and no server families. The harness login reads 'in' so
 * headless admission never depends on probe state.
 */
export function composeHeadlessDeliveryDaemon(input: {
  store: BindingStore
  machineId?: MachineId
}): ComposedHeadlessDaemon {
  const sent: DaemonMessage[] = []
  const turns: DeliveredHeadlessTurn[] = []
  const runners: HeadlessDriverRunners = {
    runTurn: (_deps, turn) => {
      let resolve!: DeliveredHeadlessTurn['resolve']
      const done = new Promise<{ harnessSessionId: string; output: string }>((res) => {
        resolve = res
      })
      turns.push({ turnId: turn.identity.turnId, sessionId: turn.identity.sessionId, resolve })
      return {
        done,
        interrupt: async () => {},
        answerPermission: async () => {},
      }
    },
    acknowledge: async () => {},
  }
  const durableLabel = (sessionId: SessionId): string => `podium-4827-${sessionId}`
  const host: HeadlessDriverHost = {
    send: (msg) => sent.push(msg),
    snapshot: async () => testHarnessSnapshot(),
    engines: () => OWNER,
    turnChildEnv: ({ specEnv, execEnv, envOverlay }) => ({
      env: { ...specEnv, ...execEnv, ...envOverlay },
      stripEnv: [],
    }),
    assertNativeAccount: () => {},
    sessionEnv: (session) => ({ HOME: '/tmp', PODIUM_RELAY: session.sessionId, AGENT: session.agent }),
    durableLabel,
    bindHeadlessSession: () => {},
    readHistory: async () => ({ items: [], hasMore: false }),
    archiveTranscript: async () => {
      throw new Error('no archive in the delivery composition')
    },
    readFileBytes: async () => new Uint8Array(),
    now: () => Date.now(),
  }
  const headless: HeadlessRuntime = createHeadlessRuntime(host, createMemoryDriverSlots(), runners)
  const agentRuntime = createDaemonMachineRuntime({
    terminal: {
      driverFor: () => undefined,
      handleFor: () => undefined,
      bindings: () => [],
      register: () => {},
      clear: () => {},
      dispose: () => {},
    },
    servers: [],
    headless,
    inventory: async () => ({ os: 'linux', arch: 'x64', agents: [], tools: [] }),
  } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    sessionBinding: new SessionBinding(input.store),
    machineId: input.machineId ?? asMachineId('delivery-machine'),
    durableLabelFor: (id: string) => durableLabel(id as SessionId),
    harnessLoginState: () => 'in',
    sessions: testSessions(),
    agentRuntime,
  } as unknown as DaemonContext
  return { ctx, sent, turns }
}
