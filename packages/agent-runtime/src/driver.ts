// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { AgentRuntimeState, ResumeRef, TranscriptItem } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import type { AttachEndpoint, AttachRequest, SessionLease } from './attach.js'
import type { SessionArchive, SessionBinding, SessionSnapshot } from './binding.js'
import type {
  ConfigureRequest,
  DriverCapabilities,
  SessionHealth,
  UsageSnapshot,
} from './capabilities.js'
import type { TurnEvent } from './errors.js'
import type { EventStreamStart, RuntimeEvent, WatchLevel } from './events.js'
import type { DriverFamily, DriverId } from './families.js'
import type { InteractionAnswerOutcome, PendingInteraction } from './interactions.js'
import type { SessionSpec } from './session-spec.js'
import type {
  AnswerOptions,
  AttachmentSource,
  AttachmentStageResult,
  Refusal,
  SendOptions,
  TurnInput,
  TurnReceipt,
} from './turns.js'

// ---------------------------------------------------------------------------
// The session handle
// ---------------------------------------------------------------------------

/**
 * ONE LIVE SESSION, whatever drives it.
 *
 * Every verb here is either a WRITE that returns a receipt or a typed refusal
 * (rule 3), or a READ that is causally enveloped (rule 4). Nothing on this
 * interface exposes a mechanism: there is no `pty`, no `socket`, no `hooks`.
 */
export interface AgentSessionHandle {
  readonly binding: SessionBinding

  // ---- Lifecycle (CORE) ----
  /** Graceful shutdown; the survival table is unchanged from today. */
  stop(): Promise<void>
  /** REFUSES without a resume ref — hibernating a session we cannot bring back
   *  is data loss wearing a lifecycle verb's name. */
  hibernate(): Promise<Refusal | { ok: true }>
  kill(): Promise<void>
  health(): Promise<SessionHealth>

  // ---- Identity (CORE) ----
  snapshot(): Promise<SessionSnapshot>
  export(): Promise<SessionArchive>

  // ---- Turns and control (CORE) ----
  send(input: TurnInput, options: SendOptions): Promise<TurnReceipt>
  stageAttachment(source: AttachmentSource): Promise<AttachmentStageResult>
  /** REQUESTS a fence. The fence is emitted only on provider confirmation and is
   *  never manufactured — so this returns nothing to await. Watch the stream. */
  interrupt(): Promise<void>
  answer(
    interactionId: string,
    answer: unknown,
    options?: AnswerOptions,
  ): Promise<InteractionAnswerOutcome>

  // ---- Interactions (CORE) ----
  interactions(): Promise<readonly PendingInteraction[]>

  // ---- Observation (CORE) ----
  events(after: EventStreamStart): AsyncIterable<RuntimeEvent>
  /** Refcounted: the level is the MAX of what current watchers asked for.
   *  Returns a release function so a viewer disconnecting cannot leak a fine
   *  watch — an always-on token stream with nobody reading it is the exact cost
   *  the two levels exist to avoid. */
  watch(level: WatchLevel): Promise<() => void>
  /** Poll-free projection. `lastActivityAt` is EVENT-time, never observe-time. */
  state(): Promise<AgentRuntimeState>

  // ---- Transcript (CORE) ----
  readonly transcript: {
    history(range: { from?: ProviderCursor; limit: number }): Promise<readonly TranscriptItem[]>
  }

  // ---- Attach and lease (CORE) ----
  attach(req: AttachRequest): Promise<AttachEndpoint | Refusal>
  readonly lease: {
    acquire(holder: string, kind: SessionLease['kind']): Promise<SessionLease | Refusal>
    release(holder: string): Promise<void>
    state(): Promise<SessionLease | null>
  }

  // ---- EXTENDED ----
  readonly draft: {
    get(): Promise<string | Refusal>
    set(text: string): Promise<Refusal | { ok: true }>
  }
  configure(request: ConfigureRequest): Promise<Refusal | { ok: true }>
  usage(): Promise<UsageSnapshot | Refusal>
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * ONE OBJECT PER (harness × mechanism). The three constructors are the only ways
 * a handle comes into existence, and `adopt()` is FIRST-CLASS among them: the
 * supervisor restarting must find surviving session processes, rebind by exact
 * identity, emit one bootstrap snapshot and continue. That makes reattach the
 * same verb for every family instead of a PTY special case.
 */
export interface RuntimeDriver {
  readonly id: DriverId
  readonly harness: string
  readonly family: DriverFamily
  capabilities(): DriverCapabilities
  create(spec: SessionSpec): Promise<AgentSessionHandle>
  resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle>
  /** Rebind a SURVIVING process tree after a supervisor restart. Must match on
   *  exact process identity — a prefix or heuristic match here adopts the wrong
   *  process, which is worse than not adopting at all. */
  adopt(binding: SessionBinding): Promise<AgentSessionHandle>
  /** A driver MAY override a procedure when the harness has a native or atomic
   *  form. Absent = the generic composition in ./procedures.ts is used. */
  readonly procedures?: Partial<DriverProcedureOverrides>
}

/**
 * THE PROCEDURES LAYER — pure composition above drivers, below features.
 *
 * The rule for where an operation lives: PRIMITIVE if it needs driver-private
 * access or varies per harness in SEMANTICS; PROCEDURE if it is pure composition
 * whose variance is only mechanism or timing. Generic by default, declared
 * override when a harness needs one — the same house pattern as the manifests,
 * so peculiarities stay inside the driver that owns them.
 *
 * Note what is NOT here: interrupt-and-send. It is so common it folded into the
 * surface as `send({ delivery: 'interrupt' })` instead, implemented natively per
 * driver.
 */
export interface DriverProcedureOverrides {
  /** send + await the matching turn-completed. */
  askAndAwait(handle: AgentSessionHandle, input: TurnInput): Promise<TurnEvent>
  /** ephemeral create → send → await → kill. Drivers with a native one-shot form
   *  (`claude -p`, `codex exec --ephemeral`) override this rather than paying for
   *  a full session. */
  oneShot(spec: SessionSpec, prompt: string): Promise<readonly TranscriptItem[]>
}
