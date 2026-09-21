// packages/harness/src/driver/families/engine-supervision.ts
//
// THE SUPERVISION PORT (1.5, spec §4.8 and §5).
//
// A driver family is handed its engine's address and never spawns, journals or
// kills the engine itself: process supervision (spawn, re-attach, kill) is the
// supervisor's job, delivered here as an injected port. The supervisor
// implements this over its durable process owner (podium-host); the families
// compose argv/env, bind protocol, and own failure ownership — an engine that
// is up but will not bind is a bind failure with the process kept, never a
// silent orphan.
//
// Shared by the codex, opencode and grok-acp engine hosts: all three hold the
// same kind of attachment (a host session with a writer lease, a merged
// output ring, an EXITED frame and — for stdio engines — a write channel).
// One port, not three near-identical ones, so a second speaker of any of
// these protocols reuses the same supervision seam without edits.

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
 * The supervisor's process ownership, as the engine hosts need it.
 *
 * Spawn adopts when the label already owns a live host (that IS the
 * daemon-restart case); attach rebinds to a survivor; kill sweeps the label's
 * scope. What the supervisor never does here is decide anything about the
 * harness: argv, env and labels arrive composed, and the engine's address
 * (socket path, port+secret) travels beside the label in the family's own
 * journal, never here — this stays harness-agnostic.
 */
export interface EngineSupervisor {
  spawnHeadless(req: EngineSpawnRequest): Promise<EngineAttachment>
  attachHeadless(input: { label: string; fromSeq: 'tail' }): Promise<EngineAttachment>
  /** A live host owns the label AND its program is still running. */
  has(label: string): Promise<boolean>
  kill(label: string): Promise<void>
  /**
   * The session's transient scope unit, where the platform has one. Absent on
   * macOS, honestly so: there is no transient scope there, and a fabricated
   * unit name would make health report a cgroup nothing owns.
   */
  scopeUnitFor(label: string): string | undefined
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
