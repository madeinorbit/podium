// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { Declared, DriverId } from '@podium/harness'
import type { ResumeRef } from '@podium/model'
import type { SessionArchive, SessionBinding } from './binding.js'
import type { DriverCapabilities } from './capabilities.js'
import type { AgentSessionHandle } from './driver.js'
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
 * WHAT W1 SHIPS AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * This is the TYPED SURFACE only — the same status as everything else in this
 * package. The daemon composes an implementation in W3; nothing implements it
 * today except in so far as the existing manifest inventory and discovery
 * already answer several of these questions, which is why those verbs are typed
 * in terms of the shapes `@podium/harness` already returns rather than inventing
 * parallel ones.
 */
export interface AgentRuntime {
  // ---- Sessions (CORE) ----
  /** Start a new session under the driver `spec.selection` resolves to. */
  create(spec: SessionSpec): Promise<AgentSessionHandle>
  /** Continue a conversation the harness already has on disk. */
  resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle>
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
