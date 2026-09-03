// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import { type Declared, type DriverId, manifestFor, unsupported } from '@podium/harness'
import type { AgentKind, Inventory, ResumeRef, SessionId } from '@podium/model'
import type { SessionArchive, SessionBinding } from './binding.js'
import type { DriverCapabilities } from './capabilities.js'
import type { AgentSessionHandle, RuntimeDriver } from './driver.js'
import type { InteractionKind } from './interactions.js'
import type { SessionSpec } from './session-spec.js'

/**
 * THE RUNTIME-LEVEL SURFACE — per machine, not per session (spec §3, "Runtime
 * primitives" and "Accounts & login").
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE INTERFACE FROM `AgentSessionHandle`
 * ---------------------------------------------------------------------------
 *
 * These verbs are about the MACHINE: what is installed, what is running, which
 * accounts exist, what the plan limits are. None of them belongs on a session,
 * and the spec is explicit about the one that gets confused most often —
 * `quota` is "MACHINE-scoped, not per-session". Hanging it off a handle would
 * invite exactly the per-session quota read the spec rules out.
 *
 * `import` lives here rather than on the handle for the same reason and a
 * stronger one: it CREATES a session from an archive, so there is no handle to
 * call it on. Its absence is what would make `SessionArchive`'s guarantee
 * unkeepable — "an archive is sufficient for `runtime.import` → resume to
 * continue the conversation on any machine with the same harness" needs a verb
 * on this side of the boundary to honour it.
 *
 * ---------------------------------------------------------------------------
 * THE CONCRETE COMPOSITION
 * ---------------------------------------------------------------------------
 *
 * {@link createAgentRuntime} implements this surface once for the machine. A
 * host supplies driver sources plus the effects that necessarily know native
 * storage (archive landing and process inventory); selection, exact driver
 * lookup, capability reads, and handle ownership are composed here. Features
 * therefore never need to know how many family-specific registries the host uses internally.
 */
export interface AgentRuntime {
  // ---- Sessions (CORE) ----
  /**
   * Start a new session under the driver `spec.selection` resolves to.
   *
   * A host may supply an identity it already authenticated and persisted (the
   * daemon's spawn frame is that case). The source adapter must explicitly
   * support fixed identities; the root refuses instead of silently minting a
   * different id that no production caller can address.
   */
  create(spec: SessionSpec, sessionId?: SessionId): Promise<AgentSessionHandle>
  /** Continue a conversation the harness already has on disk. */
  resume(
    ref: ResumeRef,
    spec: SessionSpec,
    /** Optional host-owned identity to preserve across a daemon restart. */
    sessionId?: SessionId,
  ): Promise<AgentSessionHandle>
  /**
   * Land an archive's harness-native files on THIS machine, then resume from
   * them. The other half of `handle.export()`, and the verb the archive
   * guarantee is written against: cross-machine handoff, cloud migration and
   * disaster recovery are all this call.
   *
   * REFUSES an archive whose `formatVersion` this build does not speak, rather
   * than guessing at a layout — the same stance the server drivers take toward
   * an unpinned protocol version.
   */
  import(archive: SessionArchive, spec: SessionSpec): Promise<AgentSessionHandle>
  /** Rebind survivors after a supervisor restart. */
  adopt(binding: SessionBinding): Promise<AgentSessionHandle>
  /** What is ACTUALLY running, read from the process table — not what a
   *  database thinks is running. The difference between the two is where ghost
   *  sessions live. */
  list(): Promise<readonly SessionBinding[]>

  /** What this machine can run and which harness accounts are logged in. */
  inventory(): Promise<Inventory>

  // ---- Capability introspection (CORE) ----
  capabilities(harness: string, driver: DriverId): DriverCapabilities

  // ---- Accounting (EXTENDED) ----
  /**
   * Plan limits read through the harness's own credentials. MACHINE-SCOPED, and
   * the signature says so: there is no session parameter, because a quota is a
   * property of an account on a machine and reading it per session is how you
   * get N identical probes for one number.
   */
  quota: Declared<(harness: string) => Promise<QuotaSnapshot>>
  /** Token/cost harvest across the machine's native stores. */
  usage: Declared<(window: UsageWindow) => Promise<UsageBuckets>>

  // ---- Accounts and login (EXTENDED) ----
  /**
   * Accounts are per-machine-per-harness, NEVER per-session. Sessions touch them
   * in exactly two places: `SessionSpec.principal` selects one at spawn, and the
   * binding records which was chosen.
   */
  accounts: Declared<(harness: string) => Promise<readonly AccountRef[]>>
  /**
   * Sugar over a short-lived TERMINAL-FAMILY UTILITY SESSION running the
   * harness's own login command — attachable like any session, emitting
   * `login`-kind interactions. Deliberately not a parallel interactive
   * mechanism: a feature never drives a login flow except by answering its
   * interactions, and the browser-open relay stays behind that boundary as
   * transport for the interaction's payload rather than surface of its own.
   */
  login: Declared<(harness: string, method: string) => Promise<LoginFlow>>
}

/**
 * One family registry behind the machine runtime.
 *
 * A source may own one driver (the server-family runtimes) or resolve several
 * harness-specific drivers (the terminal runtime). `bindings()` deliberately
 * returns only a candidate set for {@link AgentRuntime.list}: registered handles
 * are not proof that their processes still exist. The host's `list` effect owns
 * process truth.
 */
export interface AgentRuntimeDriverSource {
  driverFor(harness: string, driver: DriverId): RuntimeDriver | undefined
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly SessionBinding[]
  /** Host adapter for a server-authenticated, already-minted session identity. */
  createWithId?(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  /** Host adapter for resuming a conversation under its existing session id. */
  resumeWithId?(
    sessionId: SessionId,
    ref: ResumeRef,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle>
  /** Host adapter for adoption bookkeeping around the driver's core verb. */
  adopt?(binding: SessionBinding): Promise<AgentSessionHandle>
}

export interface RuntimePrimitiveSupport {
  /** Archive landing is a separate storage adapter; a root must not imply it exists. */
  readonly import: Declared<true>
  /** `registered-only` is the foundation scope; process-table discovery lands in POD-2415. */
  readonly list: {
    scope: 'process-table' | 'registered-only'
  }
}

export interface AgentRuntimeComposition {
  /** Read lazily so a daemon can close its bootstrap wiring cycle once. */
  sources(): readonly AgentRuntimeDriverSource[]
  /** Honest support declaration for primitives whose mechanics live in host adapters. */
  primitiveSupport: RuntimePrimitiveSupport
  /** Land harness-native bytes and return the resume ref to continue from. */
  landArchive(archive: SessionArchive, spec: SessionSpec): Promise<ResumeRef>
  /** Authoritative process-table inventory, never a projection of handle maps. */
  list(): Promise<readonly SessionBinding[]>
  inventory(): Promise<Inventory>
  quota?: Declared<(harness: string) => Promise<QuotaSnapshot>>
  usage?: Declared<(window: UsageWindow) => Promise<UsageBuckets>>
  accounts?: Declared<(harness: string) => Promise<readonly AccountRef[]>>
  login?: Declared<(harness: string, method: string) => Promise<LoginFlow>>
}

/** The host-facing superset used by daemon command routing. */
export interface MachineAgentRuntime extends AgentRuntime {
  /** Typed truth for partial host composition; callers need not discover it by throwing. */
  readonly primitiveSupport: RuntimePrimitiveSupport
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  has(sessionId: SessionId): boolean
  driverFor(harness: string, driver: DriverId): RuntimeDriver | undefined
  /** Every binding currently indexed by a family registry (not process truth). */
  registeredBindings(): readonly SessionBinding[]
}

const unsupportedQuota = unsupported('this machine does not expose harness plan accounting')
const unsupportedUsage = unsupported('this machine does not expose native-store usage accounting')
const unsupportedAccounts = unsupported('this machine does not expose multi-account enumeration')
const unsupportedLogin = unsupported('this machine does not expose runtime-managed login flows')

/**
 * Build the ONE runtime for a machine.
 *
 * The returned object owns every cross-family decision. Driver sources remain
 * private mechanism adapters: they may keep the maps and journals their process
 * protocols require, but callers resolve neither a driver nor a session by
 * walking those registries themselves.
 */
export function createAgentRuntime(composition: AgentRuntimeComposition): MachineAgentRuntime {
  const sources = (): readonly AgentRuntimeDriverSource[] => composition.sources()

  const driverMatchFor = (
    harness: string,
    driver: DriverId,
  ): { source: AgentRuntimeDriverSource; driver: RuntimeDriver } | undefined => {
    let found: { source: AgentRuntimeDriverSource; driver: RuntimeDriver } | undefined
    for (const source of sources()) {
      const candidate = source.driverFor(harness, driver)
      if (!candidate) continue
      if (found) {
        throw new Error(
          "runtime driver '" + driver + "' is wired more than once for '" + harness + "'",
        )
      }
      found = { source, driver: candidate }
    }
    return found
  }

  const driverFor = (harness: string, driver: DriverId): RuntimeDriver | undefined =>
    driverMatchFor(harness, driver)?.driver

  const selectedDriver = (
    spec: SessionSpec,
  ): { source: AgentRuntimeDriverSource; driver: RuntimeDriver } => {
    const manifest = manifestFor(spec.harness as AgentKind)
    if (!manifest) throw new Error("no runtime manifest for harness '" + spec.harness + "'")
    const driverId = manifest.runtime.select(spec.selection)
    const match = driverMatchFor(spec.harness, driverId)
    if (!match) {
      throw new Error(
        "runtime driver '" + driverId + "' is not wired for harness '" + spec.harness + "'",
      )
    }
    return match
  }

  const remember = (handle: AgentSessionHandle): AgentSessionHandle => {
    const indexed = handleFor(handle.binding.sessionId)
    if (indexed !== handle) {
      throw new Error(
        "session '" + handle.binding.sessionId + "' was not indexed by its runtime driver",
      )
    }
    return handle
  }

  const handleFor = (sessionId: SessionId): AgentSessionHandle | undefined => {
    let found: AgentSessionHandle | undefined
    for (const source of sources()) {
      const candidate = source.handleFor(sessionId)
      if (!candidate) continue
      if (found) {
        throw new Error("session '" + sessionId + "' is indexed by more than one runtime driver")
      }
      found = candidate
    }
    return found
  }

  const registeredBindings = (): readonly SessionBinding[] => {
    const bySession = new Map<SessionId, SessionBinding>()
    for (const source of sources()) {
      for (const binding of source.bindings()) {
        const existing = bySession.get(binding.sessionId)
        if (existing) {
          throw new Error(
            "session '" + binding.sessionId + "' is indexed by more than one runtime driver",
          )
        }
        bySession.set(binding.sessionId, binding)
      }
    }
    return [...bySession.values()]
  }

  return {
    primitiveSupport: composition.primitiveSupport,
    async create(spec, sessionId) {
      const selected = selectedDriver(spec)
      if (sessionId === undefined) return remember(await selected.driver.create(spec))
      if (!selected.source.createWithId) {
        throw new Error(
          "runtime driver '" + selected.driver.id + "' cannot adopt a host-minted session id",
        )
      }
      const handle = await selected.source.createWithId(sessionId, spec)
      if (handle.binding.sessionId !== sessionId) {
        throw new Error(
          "runtime driver '" + selected.driver.id + "' indexed the wrong session identity",
        )
      }
      return remember(handle)
    },
    async resume(ref, spec, sessionId) {
      const selected = selectedDriver(spec)
      if (sessionId === undefined) return remember(await selected.driver.resume(ref, spec))
      if (!selected.source.resumeWithId) {
        throw new Error(
          "runtime driver '" + selected.driver.id + "' cannot resume a host-minted session id",
        )
      }
      const handle = await selected.source.resumeWithId(sessionId, ref, spec)
      if (handle.binding.sessionId !== sessionId) {
        throw new Error(
          "runtime driver '" + selected.driver.id + "' indexed the wrong session identity",
        )
      }
      return remember(handle)
    },
    async import(archive, spec) {
      if (archive.harness !== spec.harness) {
        throw new Error(
          "archive harness '" + archive.harness + "' cannot be imported as '" + spec.harness + "'",
        )
      }
      const ref = await composition.landArchive(archive, spec)
      return remember(await selectedDriver(spec).driver.resume(ref, spec))
    },
    async adopt(binding) {
      const match = driverMatchFor(binding.harness, binding.driver)
      if (!match) {
        throw new Error(
          "runtime driver '" +
            binding.driver +
            "' is not wired for harness '" +
            binding.harness +
            "'",
        )
      }
      return remember(await (match.source.adopt?.(binding) ?? match.driver.adopt(binding)))
    },
    list: () => composition.list(),
    inventory: () => composition.inventory(),
    capabilities(harness, driver) {
      const selected = driverFor(harness, driver)
      if (!selected) {
        throw new Error(
          "runtime driver '" + driver + "' is not wired for harness '" + harness + "'",
        )
      }
      return selected.capabilities()
    },
    quota: composition.quota ?? unsupportedQuota,
    usage: composition.usage ?? unsupportedUsage,
    accounts: composition.accounts ?? unsupportedAccounts,
    login: composition.login ?? unsupportedLogin,
    handleFor,
    has: (sessionId) => handleFor(sessionId) !== undefined,
    driverFor,
    registeredBindings,
  }
}

/** An opaque harness account name — see `SessionSpec.principal` for why this
 *  layer never names an authorization principal. */
export interface AccountRef {
  id: string
  harness: string
  loginState: 'logged-in' | 'logged-out' | 'expired' | 'unknown'
  label?: string
}

export interface LoginFlow {
  /** The utility session driving the harness's own login command. */
  sessionId: string
  /** The interaction kind the caller should expect to answer. */
  expects: Extract<InteractionKind, 'login'>
}

export interface QuotaSnapshot {
  harness: string
  /** Fraction of the plan window consumed, where the harness reports one. */
  usedFraction?: number
  resetsAt?: string
}

export interface UsageWindow {
  from: string
  to: string
}

/** Hour × model buckets, as the spec's `UsageBuckets` sketch has them. */
export interface UsageBuckets {
  buckets: readonly {
    hour: string
    model: string
    inputTokens: number
    outputTokens: number
    costUsd?: number
  }[]
}
