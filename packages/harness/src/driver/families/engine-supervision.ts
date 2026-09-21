// packages/harness/src/driver/families/engine-supervision.ts
//
// THE SUPERVISION PORTS (1.5, spec §4.8 and §5).
//
// A driver family is handed its engine's address and never spawns, journals or
// kills the engine itself: process acts (start, re-attach, destroy) are the
// session layer's job, delivered as the injected `EngineProcessOwner` port,
// and the transient scope answer arrives as the injected `EngineSupervisor`
// port. The session layer implements both over its durable process owner
// (podium-host); the families compose argv/env, bind protocol, and own
// failure ownership — an engine that is up but will not bind is a bind
// failure with the process kept, never a silent orphan.
//
// Shared by the codex, opencode, grok-acp and claude-sdk engine hosts: all
// four hold the same kind of attachment (a host session with a writer lease,
// a merged output ring, an EXITED frame and — for stdio engines — a write
// channel). One port, not four near-identical ones, so a second speaker of
// any of these protocols reuses the same supervision seam without edits.

import type { Buffer } from 'node:buffer'
import type { SessionId } from '@podium/model'

/** One held engine attachment: the supervisor's handle on a live engine. */
export interface EngineAttachment {
  /**
   * The host's WELCOME: resolves when the host accepts the attach. `lease`
   * false means a stale supervisor still drives this engine — the new
   * generation must refuse loudly, never read along silently.
   */
  readonly ready: Promise<{ lease: boolean; childPid?: number }>
  readonly connection: {
    /** Merged stdout/stderr ring. Returns an unsubscribe. */
    onData(cb: (seq: bigint, data: Buffer) => void): () => void
    /** The host's EXITED frame — the real status, never a dead-pipe inference.
     *  Returns an unsubscribe. */
    onExit(cb: (code: number, signal: number) => void): () => void
    /** Deliver a signal to the engine's process group. */
    signal(signum: number): void
    /** Stdin for stdio engines (grok ACP). Absent where the transport owns
     *  its own channel (unix listener, loopback TCP). */
    write?(data: Uint8Array): Promise<unknown>
  }
  /** Drop this generation's hold on the engine. Does NOT end the engine. */
  dispose(): void
}

export interface EngineSpawnRequest {
  /** The durable label: what a restarted supervisor re-adopts by. */
  label: string
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Credential overrides that must not reach the child (stored-login precedence). */
  stripEnv: readonly string[]
}

/**
 * The session's transient scope answer, as the engine hosts need it.
 *
 * Process ownership lives on {@link EngineProcessOwner} beside this: the
 * family's `supervision` port carries no verb that summons, re-attaches,
 * probes or reaps a process — only where the session's scope unit is, so the
 * journal and health can name it. A family file naming `spawnHeadless`,
 * `attachHeadless`, `has` or `kill` after this lands is the lifecycle
 * decision sitting in the wrong place.
 */
export interface EngineSupervisor {
  /**
   * The session's transient scope unit, where the platform has one. Absent on
   * macOS, honestly so: there is no transient scope there, and a fabricated
   * unit name would make health report a cgroup nothing owns.
   */
  scopeUnitFor(label: string): string | undefined
}

/**
 * THE SESSION-OWNED PROCESS VERBS (spec §4.8 steps 2 and 6).
 *
 * The driver families compose argv/env and bind protocol; they never summon,
 * re-attach, probe or reap a process. Every process act happens in the daemon's
 * session layer (`apps/daemon/src/session/engines.ts`), delivered here as the
 * port the migrated families consume: the session object calls
 * `DurableProcess.spawnHeadless` / `attachHeadless` / `kill`, owns the binding
 * journals, and hands the family a live `EngineAttachment` the family only
 * binds. Method names are fresh on purpose: `spawnHeadless` / `attachHeadless`
 * / `has` / `kill` in a family file after this lands is the decision sitting
 * in the wrong place, and the grep in the issue's DONE WHEN says so.
 */
export interface EngineProcessOwner {
  /** Create-or-adopt the engine's process (spec §4.8 step 2). */
  startEngine(req: EngineSpawnRequest): Promise<EngineAttachment>
  /** Re-attach to the surviving engine as the writer. */
  reattachEngine(input: { label: string; fromSeq: 'tail' }): Promise<EngineAttachment>
  /** A live host owns the label AND its program is still running. */
  engineAlive(label: string): Promise<boolean>
  /** Detach-or-terminate the engine's process (spec §4.8 step 6). */
  destroyEngine(label: string): Promise<void>
}

/** Convenience for families: the label-derived scope unit with the platform
 *  honesty rule applied once, in one place. */
export function engineScopeUnit(
  supervision: Pick<EngineSupervisor, 'scopeUnitFor'>,
  label: string,
): string | undefined {
  return supervision.scopeUnitFor(label)
}

/** The immutable supervisor ownership stamp, for orphan attribution. */
export interface EngineOwnership {
  instanceUuid?: string
}

/** Build the supervision-facing error for a label no host adapter can own. */
export function engineBackendError(sessionId: SessionId, detail: string): Error {
  return new Error(
    `engine for ${sessionId} requires the podium-host backend: ${detail}`,
  )
}

/**
 * THE ENGINE IS UP BUT THE PROTOCOL WILL NOT BIND (§4.8).
 *
 * Thrown (never returned as `undefined`) when the supervisor holds a live
 * engine whose protocol channel cannot be established: a listener that never
 * answers, a health endpoint that never becomes ready. `undefined` stays
 * reserved for "nothing survived" — the case with a recovery fallback (fresh
 * engine plus resume). Conflating the two would let a wedged engine slip
 * into the fallback path silently, or strand a recoverable session behind a
 * refusal.
 *
 * FAILURE OWNERSHIP (spec §4.8 step 4): the process is KEPT, never silently
 * orphaned and never quietly reaped. The supervisor reports `spawnError`
 * (fresh) or `reattachFailed` (adopt) and keeps the engine for an operator
 * decision; DaemonSession (phase 2) owns invalidating pending turns and
 * journalling the kept engine. What is never kept quiet is the address: it
 * rides the message, so logs name where the live-but-undriveable engine is.
 * The secret (loopback transports) rides a field, never the message.
 */
export class EngineBindUnrecoverable extends Error {
  override readonly name = 'EngineBindUnrecoverable'

  constructor(
    readonly sessionId: SessionId,
    readonly during: 'launch' | 'adopt',
    readonly address: string | undefined,
    cause: unknown,
    /** Loopback credential, when the transport has one. Never logged. */
    readonly secret?: string,
  ) {
    super(
      `engine for ${sessionId} is up but its protocol did not bind during ${during}` +
        `${address ? ` at ${address}` : ''}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    )
  }
}
