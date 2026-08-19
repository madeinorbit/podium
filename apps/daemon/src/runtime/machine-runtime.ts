/**
 * The daemon's ONE per-machine AgentRuntime composition root.
 *
 * Family runtimes retain only mechanism-private maps and journals. Every
 * cross-family question — driver selection, capability lookup, session lookup,
 * inventory, adoption, and teardown identity — enters through this object.
 */

import {
  type AgentRuntimeDriverSource,
  type AgentSessionHandle,
  createAgentRuntime,
  type DriverId,
  type MachineAgentRuntime,
  type RuntimeDriver,
} from '@podium/agent-runtime'
import type { AgentKind, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type {
  TerminalHarnessProfile,
  TerminalRuntime,
  TerminalSessionRegistration,
} from './terminal-driver'
import { terminalProfileFor } from './registry'
import type { DaemonCodexRuntime, CodexSessionLaunch } from './codex-driver'
import type { DaemonGrokRuntime, GrokSessionLaunch } from './grok-driver'
import type { DaemonOpencodeRuntime, OpencodeSessionLaunch } from './opencode-driver'

export type ServerDriverLaunch = OpencodeSessionLaunch | CodexSessionLaunch | GrokSessionLaunch

export interface JournalledServerProcess {
  driver: 'opencode' | 'codex' | 'grok'
  identity: { key: string; pid?: number; scopeUnit?: string }
  probe?: { baseUrl: string; secret: string }
  clearJournal(): void
}

export type JournalledAdoption =
  | { found: false }
  | {
      found: true
      what: string
      workdir: string
      handle?: AgentSessionHandle
    }

export interface DaemonMachineRuntime extends MachineAgentRuntime {
  observe(message: DaemonMessage): void
  onHookPayload(sessionId: SessionId, payload: unknown): void
  registerTerminal(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): AgentSessionHandle
  clearTerminal(sessionId: SessionId): void
  launchServer(driverId: DriverId, input: ServerDriverLaunch): Promise<void>
  adoptJournalled(sessionId: SessionId): Promise<JournalledAdoption>
  serverHandleFor(sessionId: SessionId): AgentSessionHandle | undefined
  journalledServerProcess(sessionId: SessionId): JournalledServerProcess | undefined
  dispose(): void
}

export function createDaemonMachineRuntime(input: {
  terminal: TerminalRuntime
  opencode: DaemonOpencodeRuntime
  codex: DaemonCodexRuntime
  grok: DaemonGrokRuntime
  inventory(): ReturnType<MachineAgentRuntime['inventory']>
}): DaemonMachineRuntime {
  const servers = [input.opencode, input.codex, input.grok] as const

  const terminalSource: AgentRuntimeDriverSource = {
    driverFor(harness, driver) {
      const profile = terminalProfileFor(harness as AgentKind)
      if (!profile || profile.driverId !== driver) return undefined
      return input.terminal.driverFor(harness as AgentKind, profile)
    },
    handleFor: (sessionId) => input.terminal.handleFor(sessionId),
    bindings: () => input.terminal.bindings(),
  }

  const serverSources: readonly AgentRuntimeDriverSource[] = servers.map((runtime) => ({
    driverFor(harness: string, driver: DriverId): RuntimeDriver | undefined {
      return runtime.driver.harness === harness && runtime.driver.id === driver
        ? runtime.driver
        : undefined
    },
    handleFor: (sessionId) => runtime.handleFor(sessionId),
    bindings: () => runtime.bindings(),
  }))

  let runtime!: MachineAgentRuntime
  runtime = createAgentRuntime({
    sources: () => [terminalSource, ...serverSources],
    async landArchive() {
      throw new Error('archive landing is not yet composed on this machine')
    },
    async list() {
      const bindings = runtime.registeredBindings()
      const alive = await Promise.all(
        bindings.map(async (binding) => {
          const handle = runtime.handleFor(binding.sessionId)
          if (!handle) return undefined
          try {
            return (await handle.health()).alive ? binding : undefined
          } catch {
            return undefined
          }
        }),
      )
      return alive.filter((binding): binding is NonNullable<typeof binding> => binding !== undefined)
    },
    inventory: input.inventory,
  })

  const serverFor = (driverId: DriverId) =>
    driverId === input.codex.driver.id
      ? input.codex
      : driverId === input.grok.driver.id
        ? input.grok
        : driverId === input.opencode.driver.id
          ? input.opencode
          : undefined

  const journalled = (sessionId: SessionId) => {
    const opencode = input.opencode.journal.read(sessionId)
    if (opencode) {
      return {
        runtime: input.opencode,
        what: 'opencode serve',
        entry: opencode,
      } as const
    }
    const codex = input.codex.journal.read(sessionId)
    if (codex) {
      return {
        runtime: input.codex,
        what: 'codex app-server',
        entry: codex,
      } as const
    }
    const grok = input.grok.journal.read(sessionId)
    if (grok) {
      return {
        runtime: input.grok,
        what: 'grok agent stdio',
        entry: grok,
      } as const
    }
    return undefined
  }

  return {
    ...runtime,
    observe(message) {
      input.terminal.observe(message)
    },
    onHookPayload(sessionId, payload) {
      input.terminal.onHookPayload(sessionId, payload)
    },
    registerTerminal(registration, profile) {
      return input.terminal.register(registration, profile)
    },
    clearTerminal(sessionId) {
      input.terminal.clear(sessionId)
    },
    async launchServer(driverId, launch) {
      const selected = serverFor(driverId)
      if (!selected) throw new Error("driver '" + driverId + "' is not wired on this daemon")
      await selected.launch(launch)
    },
    async adoptJournalled(sessionId) {
      const found = journalled(sessionId)
      if (!found) return { found: false }
      const handle = await found.runtime.adoptFromJournal(sessionId)
      return {
        found: true,
        what: found.what,
        workdir: found.entry.workdir,
        ...(handle ? { handle } : {}),
      }
    },
    serverHandleFor(sessionId) {
      for (const server of servers) {
        const handle = server.handleFor(sessionId)
        if (handle) return handle
      }
      return undefined
    },
    journalledServerProcess(sessionId) {
      const opencode = input.opencode.journal.read(sessionId)
      if (opencode) {
        return {
          driver: 'opencode',
          identity: opencode.process,
          probe: { baseUrl: opencode.baseUrl, secret: opencode.secret },
          clearJournal: () => input.opencode.journal.clear(sessionId),
        }
      }
      const codex = input.codex.journal.read(sessionId)
      if (codex) {
        return {
          driver: 'codex',
          identity: codex.process,
          clearJournal: () => input.codex.journal.clear(sessionId),
        }
      }
      const grok = input.grok.journal.read(sessionId)
      if (grok) {
        return {
          driver: 'grok',
          identity: grok.process,
          clearJournal: () => input.grok.journal.clear(sessionId),
        }
      }
      return undefined
    },
    dispose() {
      input.terminal.dispose()
      input.opencode.dispose()
      input.codex.dispose()
      input.grok.dispose()
    },
  }
}
