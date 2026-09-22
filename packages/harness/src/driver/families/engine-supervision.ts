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
  /**
   * The session this engine serves, when it serves one. The session layer
   * keeps the engine's address on that session's entry, so a later
   * re-attach or destroy of the same session finds it. Absent for a one-shot
   * turn, which has no address to keep.
   */
  sessionId?: SessionId
  /**
   * Ask the session layer for a private Unix listener address (layers §1b:
   * the Driver "uses the engine address it was given"). The session layer
   * mints the address under its instance-private socket root, prepares that
   * root, clears a stale socket file, appends `argv(address)` to `args` and
   * returns the address with the attachment. It removes the socket file when
   * the engine is destroyed. The family only says how its engine is TOLD the
   * address — the flag is the harness's knowledge, the path is not.
   */
  listen?: { argv(address: string): readonly string[] }
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Credential overrides that must not reach the child (stored-login precedence). */
  stripEnv: readonly string[]
  /**
   * Keep the output after the child exits (POD-4614). A long-lived engine
   * leaves this off: a live supervisor always sees its exit. A ONE-SHOT turn
   * sets it, because its output is its result and the supervisor that
   * started it may be restarting when it ends — the host's ring is then the
   * only record, held `lingerSecs` for the next generation to collect.
   */
  retention?: { lingerSecs: number; ringBytes: number }
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
  /** Create-or-adopt the engine's process (spec §4.8 step 2). `address` is the
   *  listener the session layer minted, when the request asked for one. */
  startEngine(req: EngineSpawnRequest): Promise<EngineHold>
  /**
   * Re-attach to the surviving engine as the writer. `'tail'` for a protocol
   * channel whose pre-restart correlation died with the old supervisor; a
   * seq (`0n`: everything the ring holds) for a one-shot turn whose output is
   * its result and must be replayed, not rerun. With a `sessionId`, `address`
   * is the listener the session layer recorded for that session's engine —
   * the family dials what it is handed, never a path it kept.
   */
  reattachEngine(input: {
    label: string
    fromSeq: 'tail' | bigint
    sessionId?: SessionId
  }): Promise<EngineHold>
  /** A live host owns the label AND its program is still running. */
  engineAlive(label: string): Promise<boolean>
  /** Detach-or-terminate the engine's process (spec §4.8 step 6). With a
   *  `sessionId`, the session layer also removes the listener it minted. */
  destroyEngine(label: string, sessionId?: SessionId): Promise<void>
}

/** What the session layer hands a family for one engine: the attachment it
 *  binds, and the address it dials when the engine listens on one. */
export interface EngineHold {
  attachment: EngineAttachment
  address?: string
}

/**
 * THE SESSION'S BINDING RECORD, AS A FAMILY REPORTS INTO IT (spec §4.8,
 * layers §1b: the Driver "must never … journal").
 *
 * The session layer keeps one binding record per session — on the session's
 * entry, with a durable copy under the daemon's state dir that a restarted
 * daemon adopts from. Where the bytes live, when they are removed and which
 * address the engine listens on are the session layer's. What the facts MEAN
 * (a thread id, a stream high-water mark, a model policy) stays the family's:
 * it reports them and reads them back, and never holds the store.
 *
 * A per-family VIEW, like `SessionDriverSlots`: each family's records live in
 * its own namespace, so one family never reads another's facts.
 */
export interface EngineBindingRecords<TFacts extends { sessionId: SessionId }> {
  /** Report: the session is bound, and these are the facts a restart needs.
   *  The session layer adds the address it minted; the family never
   *  supplies one it did not report as part of its own protocol facts. */
  bound(facts: TFacts): void
  /** Report: the session is retired — nothing is left to adopt. */
  released(sessionId: SessionId): void
  /** What the session layer recorded for the session: the family's last
   *  reported facts plus the engine address the session minted, if any. */
  recorded(sessionId: SessionId): EngineBindingRecord<TFacts> | undefined
}

/** A recorded binding: the family's facts, and the session-minted address. */
export type EngineBindingRecord<TFacts> = TFacts & { readonly address?: string }

/**
 * The per-family port a session-served engine family is handed: the process
 * verbs plus that family's binding records. One view per family namespace,
 * built by the session layer.
 */
export interface SessionEngineOwner<TFacts extends { sessionId: SessionId }>
  extends EngineProcessOwner,
    EngineBindingRecords<TFacts> {}

/**
 * The binding records a family reads and reports through, or an inert set
 * when the family was built with no session owner (tests that never
 * launch): with no owner there is no engine and nothing to record.
 */
export function bindingRecordsOf<TFacts extends { sessionId: SessionId }>(
  owner: EngineBindingRecords<TFacts> | undefined,
): EngineBindingRecords<TFacts> {
  if (owner) return owner
  return { bound: () => {}, released: () => {}, recorded: () => undefined }
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
