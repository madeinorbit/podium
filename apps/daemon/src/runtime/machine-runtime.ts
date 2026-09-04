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
  type DriverCapabilities,
  type DriverId,
  type MachineAgentRuntime,
  type RuntimeDriver,
  type SessionBinding,
  type SessionSpec,
} from '@podium/agent-runtime'
import type { AgentKind, SessionId } from '@podium/model'
import type { RuntimeContractRequest } from '@podium/protocol'
import type { DaemonMessage, RuntimeWatchLevel } from '@podium/protocol/daemon'
import type { DaemonClaudeSdkRuntime } from './claude-sdk-driver'
import type { DaemonCodexRuntime } from './codex-driver'
import type { DaemonGrokRuntime } from './grok-driver'
import type { DaemonOpencodeRuntime } from './opencode-driver'
import { type DriverResolution, resolveRuntimeDriver, terminalProfileFor } from './registry'
import type {
  TerminalHarnessProfile,
  TerminalRuntime,
  TerminalSessionRegistration,
} from './terminal-driver'
import { createRuntimeWatchLifecycle } from './watch'

export interface JournalledServerProcess {
  driver: 'opencode' | 'opencode2' | 'codex' | 'grok'
  identity: { key: string; pid?: number; scopeUnit?: string }
  probe?: { baseUrl: string; secret: string; username?: string; healthPath?: string }
  clearJournal(): void
}

export type JournalledAdoption =
  | { found: false }
  | {
      found: true
      what: string
      workdir: string
      handle?: AgentSessionHandle
      /** Why there is no handle, when there is none. The adopt is allowed to
       *  fail — a journal can name a conversation this machine can no longer
       *  reach — but the operator gets told which of the driver's refusals it
       *  was rather than a generic "could not be resumed" (POD-2775, review 1). */
      reason?: string
    }

export type DaemonDriverResolution =
  | Exclude<DriverResolution, { ok: true }>
  | { ok: true; driverId: DriverId; capabilities: DriverCapabilities }

export interface DaemonMachineRuntime extends MachineAgentRuntime {
  /** The live driver's declaration for one session, read off its BINDING — see
   *  `capabilitiesFor` below for why the binding and not a family guess. The
   *  configure handler reports `configure.effective` from it (POD-3081). */
  capabilitiesFor(sessionId: SessionId): DriverCapabilities | undefined
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
  /**
   * Reconcile one session's DESIRED watch level (POD-2293).
   *
   * Lives on the machine runtime rather than in the control handler because the
   * release function `watch()` returns must be held for the session's life and
   * dropped with it — and this is the object whose lifetime that is. Capability
   * gating happens inside: a coarse-only family takes no path at all.
   */
  setWatchLevel(sessionId: SessionId, level: RuntimeWatchLevel): void
  /** Drop any watch held for a session whose handle is gone or replaced. */
  forgetWatch(sessionId: SessionId): void
  journalledServerProcess(sessionId: SessionId): JournalledServerProcess | undefined
  dispose(): void
}

export function createDaemonMachineRuntime(input: {
  terminal: TerminalRuntime
  claude: DaemonClaudeSdkRuntime
  opencode: DaemonOpencodeRuntime
  opencode2: DaemonOpencodeRuntime
  codex: DaemonCodexRuntime
  grok: DaemonGrokRuntime
  inventory(): ReturnType<MachineAgentRuntime['inventory']>
}): DaemonMachineRuntime {
  const servers = [input.opencode, input.opencode2, input.codex, input.grok] as const

  const journalled = (sessionId: SessionId) => {
    const found = [
      [input.opencode, input.opencode.journal.read(sessionId), 'opencode serve'] as const,
      [input.opencode2, input.opencode2.journal.read(sessionId), 'opencode2 serve'] as const,
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

  const embeddedSource: AgentRuntimeDriverSource = {
    driverFor(harness, driver) {
      return input.claude.driver.harness === harness && input.claude.driver.id === driver
        ? input.claude.driver
        : undefined
    },
    handleFor: (sessionId) => input.claude.handleFor(sessionId),
    bindings: () => input.claude.bindings(),
    async createWithId(sessionId, spec) {
      return input.claude.launch(serverLaunchFor(sessionId, spec))
    },
    async resumeWithId(sessionId, ref, spec) {
      return input.claude.launch({ ...serverLaunchFor(sessionId, spec), resume: ref })
    },
    adopt(binding) {
      return input.claude.driver.adopt(binding)
    },
  }

  const serverSources: readonly AgentRuntimeDriverSource[] = [
    serverSource(input.opencode, (sessionId, spec) =>
      input.opencode.launch(serverLaunchFor(sessionId, spec)),
    ),
    serverSource(input.opencode2, (sessionId, spec) =>
      input.opencode2.launch(serverLaunchFor(sessionId, spec)),
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
    sources: () => [terminalSource, embeddedSource, ...serverSources],
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

  /**
   * The declaration for whoever owns this session.
   *
   * Read through `driverFor(harness, driver)` off the LIVE BINDING rather than
   * from a family guess: the binding is what says which driver actually holds
   * the session, and after a fine upgrade or an adopt it is the only thing that
   * still says it correctly.
   */
  const capabilitiesFor = (sessionId: SessionId): DriverCapabilities | undefined => {
    const binding = runtime.handleFor(sessionId)?.binding
    if (!binding) return undefined
    return runtime.driverFor(binding.harness, binding.driver)?.capabilities()
  }

  const watches = createRuntimeWatchLifecycle({
    handleFor: (sessionId) => runtime.handleFor(sessionId),
    capabilitiesFor,
  })

  return {
    ...runtime,
    capabilitiesFor,
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
      // The handle is going, and the release function this daemon holds belongs
      // to it. Dropping the watch here is what keeps a cleared session from
      // leaving a refcount on a driver nobody can reach any more.
      watches.forget(sessionId)
      input.terminal.clear(sessionId)
    },
    setWatchLevel(sessionId, level) {
      watches.want(sessionId, level)
    },
    forgetWatch(sessionId) {
      watches.forget(sessionId)
    },
    reportOomKill(sessionId, scopeUnit) {
      // Every family is asked; only the one holding the session emits. A
      // session cannot be in two runtimes at once, so this is a lookup, not a
      // broadcast — each `reportOomKill` returns immediately for a session it
      // does not have.
      input.terminal.reportOomKill(sessionId, scopeUnit)
      input.claude.processEvent(sessionId, { ev: 'oomKilled', ...(scopeUnit ? { scopeUnit } : {}) })
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
      let reason: string | undefined
      try {
        handle = await runtime.adopt(binding)
      } catch (error) {
        handle = undefined
        reason = error instanceof Error ? error.message : String(error)
      }
      return {
        found: true,
        what,
        workdir: entry.workdir,
        ...(handle ? { handle } : {}),
        ...(reason ? { reason } : {}),
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
      const opencode2 = input.opencode2.journal.read(sessionId)
      if (opencode2) {
        return {
          driver: 'opencode2',
          identity: opencode2.process,
          probe: {
            baseUrl: opencode2.baseUrl,
            secret: opencode2.secret,
            username: opencode2.username,
            healthPath: '/api/health',
          },
          clearJournal: () => input.opencode2.journal.clear(sessionId),
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
      watches.dispose()
      input.terminal.dispose()
      input.claude.dispose()
      input.opencode.dispose()
      input.opencode2.dispose()
      input.codex.dispose()
      input.grok.dispose()
    },
  }
}
