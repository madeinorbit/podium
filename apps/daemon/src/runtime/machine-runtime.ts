/**
 * The daemon's ONE per-machine AgentRuntime composition root.
 *
 * Family runtimes retain only mechanism-private maps and journals. Every
 * cross-family question — driver selection, capability lookup, session lookup,
 * inventory, adoption, and teardown identity — enters through this object.
 *
 * (1.5: the server families arrive as `ServerFamilyRuntime` — one uniform
 * shape per family, built by the families' session modules. No branch here
 * names a harness; driver ids are the only identities that cross this
 * boundary.)
 */

import {
  type AgentRuntimeDriverSource,
  type AgentSessionHandle,
  createAgentRuntime,
  type DriverCapabilities,
  type DriverId,
  EngineBindUnrecoverable,
  type MachineAgentRuntime,
  type RuntimeDriver,
  type SessionBinding,
  type SessionSpec,
} from '@podium/harness/driver/host'
import type { AcceptedDriverId } from '@podium/harness'
import type { AgentKind, ResumeRef, SessionId } from '@podium/model'
import type { DaemonMessage, RuntimeWatchLevel } from '@podium/protocol/daemon'
import {
  HEADLESS_DRIVER_ID,
  type HeadlessRuntime,
  type HostedTurnIdentity,
  type ServerFamilyRuntime,
} from '@podium/harness/driver/host'
import { type DriverResolution, resolveRuntimeDriver, terminalProfileFor } from './registry'
import type {
  TerminalHarnessProfile,
  TerminalRuntime,
  TerminalSessionRegistration,
} from './terminal-driver'
import { createRuntimeWatchLifecycle } from './watch'

export interface JournalledServerProcess {
  driver: DriverId
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
      /**
       * THE TYPED §4.8 SIGNAL, when the adopt failed that way (POD-4490).
       *
       * The engine is up, its protocol is dead, and the family KEPT the
       * process with the journal untouched. Carried beside `reason` (which
       * stays the human sentence) so the lifecycle owner can tell "kept,
       * invalidate pending turns and record the survivor" apart from every
       * other refusal — which keeps its existing reap-and-report path. Absent
       * for every non-bind failure, exactly as before.
       */
      bindFailure?: EngineBindUnrecoverable
      /**
       * THE JOURNAL NAMES A DIFFERENT CONVERSATION than the caller asked for
       * (POD-4612). Nothing was adopted, and nothing may be reaped: the engine
       * is still the one its journal describes, and it is the REQUEST that is
       * wrong. Set only when both sides name a conversation.
       */
      conversationMismatch?: string
    }

export type DaemonDriverResolution =
  | Exclude<DriverResolution, { ok: true }>
  | { ok: true; driverId: DriverId; capabilities: DriverCapabilities }

export interface DaemonMachineRuntime extends MachineAgentRuntime {
  createTerminal: TerminalRuntime['createWithId']
  recoverTerminal: TerminalRuntime['recoverWithId']
  /** The live driver's declaration for one session, read off its BINDING — see
   *  `capabilitiesFor` below for why the binding and not a family guess. The
   *  configure handler reports `configure.effective` from it (POD-3081). */
  capabilitiesFor(sessionId: SessionId): DriverCapabilities | undefined
  observe(message: DaemonMessage): boolean
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
    requested: string | undefined
    available: readonly AcceptedDriverId[]
    platform: NodeJS.Platform
    auth?: Parameters<typeof resolveRuntimeDriver>[0]['auth']
  }): DaemonDriverResolution
  /**
   * Adopt the session a server family journals. `expect.resume` is the
   * conversation the caller's row names; a journal naming a different one is
   * refused before any adopt (see `conversationMismatch`).
   */
  adoptJournalled(
    sessionId: SessionId,
    expect?: { resume?: ResumeRef },
  ): Promise<JournalledAdoption>
  /**
   * Can this driver start a session that continues an existing conversation
   * under a host-minted id? True where its source offers `resumeWithId` — the
   * headless driver and the server families that declare `launchResumed`.
   * Asked of the source, never of a harness name, so the spawn path's resume
   * branch follows the declaration (POD-4612).
   */
  resumesAtLaunch(harness: AgentKind, driverId: DriverId): boolean
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
  /**
   * The server durably committed a headless turn's result: release the host
   * that kept it (POD-4614). Rejects on an identity mismatch and releases
   * nothing. Rides the legacy `headlessTurnAck` frame until the relay grows
   * an ack verb.
   */
  acknowledgeHeadlessTurn(identity: HostedTurnIdentity): Promise<void>
  dispose(): void
}

export function createDaemonMachineRuntime(input: {
  terminal: TerminalRuntime
  servers: readonly ServerFamilyRuntime[]
  headless: HeadlessRuntime
  inventory(): ReturnType<MachineAgentRuntime['inventory']>
}): DaemonMachineRuntime {
  const servers = input.servers

  const journalled = (sessionId: SessionId) => {
    const found: Array<{
      server: ServerFamilyRuntime
      entry: NonNullable<ReturnType<ServerFamilyRuntime['journalEntry']>>
    }> = []
    for (const server of servers) {
      const entry = server.journalEntry(sessionId)
      if (entry !== undefined) found.push({ server, entry })
    }
    return found
  }

  const terminalCreations = new Map<
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
      const pending = terminalCreations.get(sessionId)
      if (!pending) {
        throw new Error(`terminal session '${sessionId}' has no pending creation`)
      }
      return Promise.resolve(input.terminal.register(pending.registration, pending.profile))
    },
    adopt(binding) {
      const profile = terminalProfileFor(binding.harness as AgentKind)
      if (!profile || profile.driverId !== binding.driver) {
        throw new Error(`terminal session '${binding.sessionId}' has an incompatible driver`)
      }
      return input.terminal.driverFor(binding.harness as AgentKind, profile).adopt(binding)
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

  const serverSource = (server: ServerFamilyRuntime): AgentRuntimeDriverSource => ({
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
      await server.launch(serverLaunchFor(sessionId, spec))
      const handle = server.handleFor(sessionId)
      if (!handle) throw new Error(`server runtime did not index session '${sessionId}'`)
      return handle
    },
    async adopt(binding) {
      const handle = await server.adoptFromJournal(binding.sessionId)
      if (!handle) throw new Error(`server session '${binding.sessionId}' could not be rebound`)
      return handle
    },
    // Only a family that can continue a conversation from its ref alone
    // declares this; the rest resume from their own journal.
    ...(server.launchResumed
      ? {
          async resumeWithId(sessionId: SessionId, ref: ResumeRef, spec: SessionSpec) {
            if (journalled(sessionId).length > 0) {
              throw new Error(`session '${sessionId}' already has a persisted server journal`)
            }
            await server.launchResumed?.(serverLaunchFor(sessionId, spec), ref)
            const handle = server.handleFor(sessionId)
            if (!handle) throw new Error(`server runtime did not index session '${sessionId}'`)
            return handle
          },
        }
      : {}),
  })

  /**
   * THE HEADLESS SOURCE (POD-4392): process-per-turn harness sessions behind
   * the contract. No manifest `select()` ever returns the headless id — heads
   * never spawn it by policy — but an explicit `selection.preference:
   * 'headless'` bypasses the policy in `runtime.create`/`resume` (and
   * `resolveRuntimeDriver` for the spawn path), so `spawn`/`reattach` carrying
   * `requestedDriverId: 'headless'` establishes these sessions over the existing
   * WS relay with no dedicated create/resume/adopt verb. Once established the
   * handle answers every relay verb (`handleFor`), capabilities resolve
   * (`driverFor`), and a surviving binding re-adopts (`adopt`). The legacy
   * `headlessTurnRequest` frame is refused (control/registry.ts).
   */
  const headlessSource: AgentRuntimeDriverSource = {
    driverFor(harness: string, driver: DriverId): RuntimeDriver | undefined {
      return driver === HEADLESS_DRIVER_ID ? input.headless.driverFor(harness) : undefined
    },
    handleFor: (sessionId) => input.headless.handleFor(sessionId),
    bindings: () => input.headless.bindings(),
    async createWithId(sessionId, spec) {
      return input.headless.createWithId(sessionId, spec)
    },
    async resumeWithId(sessionId, ref, spec) {
      return input.headless.resumeWithId(sessionId, ref, spec)
    },
    adopt(binding) {
      return input.headless.adopt(binding)
    },
  }

  const serverSources: readonly AgentRuntimeDriverSource[] = servers.map(serverSource)

  let runtime!: MachineAgentRuntime
  runtime = createAgentRuntime({
    sources: () => [terminalSource, ...serverSources, headlessSource],
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
    createTerminal: (...args) => input.terminal.createWithId(...args),
    recoverTerminal: (...args) => input.terminal.recoverWithId(...args),
    capabilitiesFor,
    observe(message) {
      const ownsReceipt = message.type === 'sessionResumeRef' && input.terminal.has(message.sessionId)
      input.terminal.observe(message)
      return ownsReceipt
    },
    onHookPayload(sessionId, payload) {
      input.terminal.onHookPayload(sessionId, payload)
    },
    async bindTerminal(registration, profile) {
      terminalCreations.set(registration.sessionId, { registration, profile })
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

        throw new Error('terminal rebind requires recoverTerminal host composition')
      } finally {
        terminalCreations.delete(registration.sessionId)
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
      // session has one driver slot on its entry (POD-4610), so it cannot be
      // in two runtimes at once: this is a lookup, not a broadcast — each
      // `reportOomKill` returns immediately for a session it does not have.
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
    async adoptJournalled(sessionId, expect) {
      const found = journalled(sessionId)
      if (found.length === 0) return { found: false }
      if (found.length > 1) throw new Error(`session '${sessionId}' has duplicate server journals`)
      const match = found[0]
      if (!match) return { found: false }
      const { server, entry } = match
      const what = server.describe
      const asked = expect?.resume
      if (
        asked &&
        entry.resume &&
        (entry.resume.kind !== asked.kind || entry.resume.value !== asked.value)
      ) {
        return {
          found: true,
          what,
          workdir: entry.workdir,
          conversationMismatch: `the ${what} session recorded in the binding journal continues a different conversation than this session names`,
        }
      }
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
      let bindFailure: EngineBindUnrecoverable | undefined
      try {
        handle = await runtime.adopt(binding)
      } catch (error) {
        handle = undefined
        reason = error instanceof Error ? error.message : String(error)
        if (error instanceof EngineBindUnrecoverable) bindFailure = error
      }
      return {
        found: true,
        what,
        workdir: entry.workdir,
        ...(handle ? { handle } : {}),
        ...(reason ? { reason } : {}),
        ...(bindFailure ? { bindFailure } : {}),
      }
    },
    resumesAtLaunch(harness, driverId) {
      if (driverId === HEADLESS_DRIVER_ID) return true
      return servers.some(
        (server) =>
          server.driver.harness === harness &&
          server.driver.id === driverId &&
          server.launchResumed !== undefined,
      )
    },
    serverHandleFor(sessionId) {
      for (const server of servers) {
        const handle = server.handleFor(sessionId)
        if (handle) return handle
      }
      return undefined
    },
    acknowledgeHeadlessTurn: (identity) => input.headless.acknowledge(identity),
    journalledServerProcess(sessionId) {
      const matches = journalled(sessionId)
      if (matches.length > 1)
        throw new Error(`session '${sessionId}' has duplicate server journals`)
      const match = matches[0]
      if (!match) return undefined
      const { server, entry } = match
      return {
        driver: server.driver.id,
        identity: entry.process,
        ...(entry.probe ? { probe: entry.probe } : {}),
        clearJournal: () => server.clearJournal(sessionId),
      }
    },
    dispose() {
      watches.dispose()
      input.terminal.dispose()
      for (const server of servers) server.dispose()
    },
  }
}
