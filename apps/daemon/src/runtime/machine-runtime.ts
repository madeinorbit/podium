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
  type DriverCapabilities,
  type MachineAgentRuntime,
  type RuntimeDriver,
  type SessionBinding,
  type SessionSpec,
} from '@podium/agent-runtime'
import type { AgentKind, SessionId } from '@podium/model'
import type { RuntimeContractRequest } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type {
  TerminalHarnessProfile,
  TerminalRuntime,
  TerminalSessionRegistration,
} from './terminal-driver'
import { resolveRuntimeDriver, terminalProfileFor, type DriverResolution } from './registry'
import type { DaemonCodexRuntime } from './codex-driver'
import type { DaemonGrokRuntime } from './grok-driver'
import type { DaemonOpencodeRuntime } from './opencode-driver'

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

export type DaemonDriverResolution =
  | Exclude<DriverResolution, { ok: true }>
  | { ok: true; driverId: DriverId; capabilities: DriverCapabilities }

export interface DaemonMachineRuntime extends MachineAgentRuntime {
  observe(message: DaemonMessage): void
  onHookPayload(sessionId: SessionId, payload: unknown): void
  bindTerminal(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): Promise<AgentSessionHandle>
  clearTerminal(sessionId: SessionId): void
  /**
   * A kernel OOM kill the scope monitor observed, stated by whichever driver
   * owns the session (POD-2413). Family-blind on purpose: the supervisor reads
   * cgroups, not families, and the ONE session that matches gets the event.
   */
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void
  resolveDriver(input: {
    agentKind: AgentKind
    requested: RuntimeContractRequest | undefined
    machineDefault: string | undefined
    available: readonly DriverId[]
    platform: NodeJS.Platform
    auth?: Parameters<typeof resolveRuntimeDriver>[0]['auth']
  }): DaemonDriverResolution
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

  const journalled = (sessionId: SessionId) => {
    const found = [
      [input.opencode, input.opencode.journal.read(sessionId), 'opencode serve'] as const,
      [input.codex, input.codex.journal.read(sessionId), 'codex app-server'] as const,
      [input.grok, input.grok.journal.read(sessionId), 'grok agent stdio'] as const,
    ].filter((entry) => entry[1] !== undefined)
    return found
  }

  const terminalAdoptions = new Map<
    SessionId,
    { registration: TerminalSessionRegistration; profile: TerminalHarnessProfile }
  >()

  const terminalSource: AgentRuntimeDriverSource = {
    driverFor(harness, driver) {
      const profile = terminalProfileFor(harness as AgentKind)
      if (!profile || profile.driverId !== driver) return undefined
      return input.terminal.driverFor(harness as AgentKind, profile)
    },
    handleFor: (sessionId) => input.terminal.handleFor(sessionId),
    bindings: () => input.terminal.bindings(),
    createWithId(sessionId) {
      const pending = terminalAdoptions.get(sessionId)
      if (!pending) {
        throw new Error(`terminal session '${sessionId}' has no pending creation`)
      }
      return Promise.resolve(input.terminal.register(pending.registration, pending.profile))
    },
    adopt(binding) {
      const pending = terminalAdoptions.get(binding.sessionId)
      if (!pending) {
        throw new Error(`terminal session '${binding.sessionId}' has no pending adoption`)
      }
      return Promise.resolve(input.terminal.register(pending.registration, pending.profile))
    },
  }

  const serverLaunchFor = (sessionId: SessionId, spec: SessionSpec) => ({
    sessionId,
    cwd: spec.workdir,
    ...(spec.model.model ? { model: spec.model.model } : {}),
    ...(spec.model.effort ? { effort: spec.model.effort } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.initialPrompt ? { initialPrompt: spec.initialPrompt } : {}),
  })

  const serverSource = (
    server: DaemonOpencodeRuntime | DaemonCodexRuntime | DaemonGrokRuntime,
    launch: (sessionId: SessionId, spec: SessionSpec) => Promise<void>,
  ): AgentRuntimeDriverSource => ({
    driverFor(harness: string, driver: DriverId): RuntimeDriver | undefined {
      return server.driver.harness === harness && server.driver.id === driver
        ? server.driver
        : undefined
    },
    handleFor: (sessionId) => server.handleFor(sessionId),
    bindings: () => server.bindings(),
    async createWithId(sessionId, spec) {
      const existing = journalled(sessionId)
      if (existing.length > 0) {
        throw new Error(`session '${sessionId}' already has a persisted server journal`)
      }
      await launch(sessionId, spec)
      const handle = server.handleFor(sessionId)
      if (!handle) throw new Error(`server runtime did not index session '${sessionId}'`)
      return handle
    },
    async adopt(binding) {
      const handle = await server.adoptFromJournal(binding.sessionId)
      if (!handle) throw new Error(`server session '${binding.sessionId}' could not be rebound`)
      return handle
    },
  })

  const serverSources: readonly AgentRuntimeDriverSource[] = [
    serverSource(input.opencode, (sessionId, spec) =>
      input.opencode.launch(serverLaunchFor(sessionId, spec)),
    ),
    serverSource(input.codex, (sessionId, spec) =>
      input.codex.launch(serverLaunchFor(sessionId, spec)),
    ),
    serverSource(input.grok, (sessionId, spec) =>
      input.grok.launch(serverLaunchFor(sessionId, spec)),
    ),
  ]

  let runtime!: MachineAgentRuntime
  runtime = createAgentRuntime({
    sources: () => [terminalSource, ...serverSources],
    primitiveSupport: {
      import: {
        supported: false,
        reason: 'archive import requires the daemon archive storage adapter (POD-2415)',
      },
      list: { scope: 'registered-only' },
    },
    async landArchive() {
      throw new Error(
        'unsupported: archive import requires the daemon archive storage adapter (POD-2415)',
      )
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
      return alive.filter(
        (binding): binding is NonNullable<typeof binding> => binding !== undefined,
      )
    },
    inventory: input.inventory,
  })

  return {
    ...runtime,
    observe(message) {
      input.terminal.observe(message)
    },
    onHookPayload(sessionId, payload) {
      input.terminal.onHookPayload(sessionId, payload)
    },
    async bindTerminal(registration, profile) {
      terminalAdoptions.set(registration.sessionId, { registration, profile })
      try {
        if (!registration.rebind) {
          const spec: SessionSpec = {
            harness: registration.agentKind,
            selection: {
              auth: 'unknown',
              platform: process.platform,
              available: [profile.driverId],
              preference: profile.driverId,
              role: 'interactive',
            },
            workdir: registration.cwd,
            model: {},
            instructions: { supported: false, reason: 'terminal process is already launched' },
            mcpServers: { supported: false, reason: 'terminal harness owns its native config' },
          }
          return await runtime.create(spec, registration.sessionId)
        }

        const binding: SessionBinding = {
          sessionId: registration.sessionId,
          driver: profile.driverId,
          family: 'terminal',
          harness: registration.agentKind,
          workdir: registration.cwd,
          resume: registration.resume,
          process: { key: registration.sessionId },
          bindingVersion: Math.max(0, (registration.bindingVersion ?? 1) - 1),
        }
        return await runtime.adopt(binding)
      } finally {
        terminalAdoptions.delete(registration.sessionId)
      }
    },
    clearTerminal(sessionId) {
      input.terminal.clear(sessionId)
    },
    reportOomKill(sessionId, scopeUnit) {
      // Every family is asked; only the one holding the session emits. A
      // session cannot be in two runtimes at once, so this is a lookup, not a
      // broadcast — each `reportOomKill` returns immediately for a session it
      // does not have.
      input.terminal.reportOomKill(sessionId, scopeUnit)
      for (const server of servers) server.reportOomKill(sessionId, scopeUnit)
    },
    resolveDriver(selection) {
      const resolution = resolveRuntimeDriver(selection)
      if (!resolution.ok) return resolution
      try {
        return {
          ...resolution,
          capabilities: runtime.capabilities(selection.agentKind, resolution.driverId),
        }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async adoptJournalled(sessionId) {
      const found = journalled(sessionId)
      if (found.length === 0) return { found: false }
      if (found.length > 1) throw new Error(`session '${sessionId}' has duplicate server journals`)
      const match = found[0]
      if (!match) return { found: false }
      const [server, entry, what] = match
      if (!entry) return { found: false }
      const binding: SessionBinding = {
        sessionId,
        driver: server.driver.id,
        family: server.driver.family,
        harness: server.driver.harness,
        workdir: entry.workdir,
        resume: null,
        process: entry.process,
        bindingVersion: entry.bindingVersion,
      }
      let handle: AgentSessionHandle | undefined
      try {
        handle = await runtime.adopt(binding)
      } catch {
        handle = undefined
      }
      return { found: true, what, workdir: entry.workdir, ...(handle ? { handle } : {}) }
    },
    serverHandleFor(sessionId) {
      for (const server of servers) {
        const handle = server.handleFor(sessionId)
        if (handle) return handle
      }
      return undefined
    },
    journalledServerProcess(sessionId) {
      const matches = journalled(sessionId)
      if (matches.length > 1)
        throw new Error(`session '${sessionId}' has duplicate server journals`)
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
