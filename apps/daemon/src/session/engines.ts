/**
 * THE SESSION LAYER'S ENGINE OWNERSHIP (this issue, spec §4.8 steps 2–4 and 6).
 *
 * The driver families compose argv/env and bind protocol; they never summon,
 * re-attach, probe or reap a process. Every process act — `spawnHeadless`,
 * `attachHeadless`, `has`, `kill` on the engine's durable process — happens
 * HERE, behind the `EngineProcessOwner` port the migrated families consume,
 * and every binding-journal instance is created and held HERE (one per family
 * namespace), handed to the families as a read/write port.
 *
 * `DaemonSession` exposes the same verbs as delegate methods
 * (`spawnEngine` / `reattachEngine` / `engineAlive` / `killEngine` /
 * `journalFor`): the session object the spec names is the caller of record,
 * while this scope holds the daemon-wide durable and journal store the
 * delegates route through. The long-lived family instances hold the scope
 * itself (one family serves many sessions); per-session bind-failure policy
 * (`DaemonSession.bindFailed`, kept-engine record, turn invalidation) stays on
 * the session, exactly where POD-4490 put it.
 *
 * Refusal wording below is byte-identical to the supervision wiring's
 * (`runtime/host.ts`): a daemon without a host adapter cannot own an engine
 * at all, and a refused launch beats a child no restart could re-adopt.
 */

import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSpawnRequest,
} from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import {
  scopeUnitName,
  type DurableAdapter,
  type DurableProcess,
  type HostDurableAttachment,
} from '@podium/process/durable'
import { createEngineJournal } from '../runtime/host.js'

/** The binding-journal port, as the families consume it. Structurally the
 *  same store `createEngineJournal` builds; the instance lives here. */
export interface EngineJournal<TEntry extends { sessionId: SessionId }> {
  read(sessionId: SessionId): TEntry | undefined
  write(entry: TEntry): void
  clear(sessionId: SessionId): void
}

/**
 * Pick the host adapter out of the daemon's durable object. Engines are never
 * terminal sessions, so they never follow the terminal backend: abduco has no
 * pty-less mode, and a daemon without a host adapter cannot own an engine at
 * all. Loud — a refused launch beats a child no restart could re-adopt.
 */
function engineAdapter(durable: DurableProcess | undefined, what: string): DurableAdapter {
  const found = durable?.all.find((a) => a.kind === 'host') ?? durable?.primary
  if (!found || found.kind !== 'host') {
    throw new Error(
      `engine supervision for '${what}' requires the podium-host backend: this daemon runs ${
        durable ? `backend '${durable.backend}' with no host adapter` : 'with no durable backend'
      }`,
    )
  }
  return found
}

function toEngineAttachment(session: HostDurableAttachment): EngineAttachment {
  return {
    ready: session.ready.then((welcome) => ({
      lease: welcome.lease,
      ...(welcome.childPid !== undefined ? { childPid: welcome.childPid } : {}),
    })),
    connection: {
      onData: (cb) => session.connection.onData(cb),
      onExit: (cb) => session.connection.onExit(cb),
      signal: (signum) => session.connection.signal(signum),
      write: (data) => session.connection.write(data),
    },
    dispose: () => session.dispose(),
  }
}

/**
 * The session layer's hold on the engine durable: the `EngineProcessOwner`
 * the families drive, plus the journal store. One per daemon, bound onto the
 * `SessionRegistry` so every `DaemonSession` delegate routes through it.
 */
export class SessionEngineScope implements EngineProcessOwner {
  private readonly journals = new Map<string, EngineJournal<{ sessionId: SessionId }>>()

  constructor(private readonly durable: DurableProcess | undefined) {}

  /** Create-or-adopt the engine's process (spec §4.8 step 2). */
  async startEngine(req: EngineSpawnRequest): Promise<EngineAttachment> {
    const adapter = engineAdapter(this.durable, req.label)
    return toEngineAttachment(await adapter.spawnHeadless(req))
  }

  /** Re-attach to the surviving engine as the writer. */
  async reattachEngine(input: { label: string; fromSeq: 'tail' }): Promise<EngineAttachment> {
    const adapter = engineAdapter(this.durable, input.label)
    return toEngineAttachment(await adapter.attachHeadless(input))
  }

  /** A live host owns the label AND its program is still running. */
  async engineAlive(label: string): Promise<boolean> {
    return engineAdapter(this.durable, label).has(label)
  }

  /** Detach-or-terminate the engine's process (spec §4.8 step 6). */
  async destroyEngine(label: string): Promise<void> {
    await engineAdapter(this.durable, label).kill(label)
  }

  /**
   * The session's transient scope unit, where the platform has one. Absent on
   * macOS, honestly so: there is no transient scope there, and a fabricated
   * unit name would make health report a cgroup nothing owns.
   */
  scopeUnitFor(label: string): string | undefined {
    return process.platform === 'linux' ? scopeUnitName(label) : undefined
  }

  /**
   * The binding journal for one family namespace, created and held here.
   * Families receive the instance as a port; what the entries MEAN stays the
   * family's knowledge, where the bytes live is the session layer's.
   */
  journalFor<TEntry extends { sessionId: SessionId }>(namespace: string): EngineJournal<TEntry> {
    const existing = this.journals.get(namespace)
    if (existing) return existing as EngineJournal<TEntry>
    const journal = createEngineJournal<TEntry>({ namespace })
    this.journals.set(namespace, journal as EngineJournal<{ sessionId: SessionId }>)
    return journal
  }
}

/** Build the session layer's engine hold over the daemon's engine durable.
 *  `durable` undefined (never bound) = every verb refuses loudly rather than
 *  forking a child no restart could re-adopt. */
export function createSessionEngineScope(
  durable: DurableProcess | undefined,
): SessionEngineScope {
  return new SessionEngineScope(durable)
}
