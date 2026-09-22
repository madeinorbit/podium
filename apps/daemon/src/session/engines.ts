/**
 * THE SESSION LAYER'S ENGINE OWNERSHIP (spec §4.8 steps 2–4 and 6).
 *
 * The driver families compose argv/env and bind protocol; they never summon,
 * re-attach, probe or reap a process. Every process act — `spawnHeadless`,
 * `attachHeadless`, `has`, `kill` on the engine's durable process — happens
 * HERE, behind the `EngineProcessOwner` port the migrated families consume.
 *
 * THE ADDRESS AND THE JOURNAL ARE HERE TOO (POD-4611, layers §1b: the Driver
 * "uses the engine address it was given" and "must never … journal"). An
 * engine that listens on a Unix socket gets its address minted here: the
 * socket root is prepared, a stale file cleared, the path handed to the
 * family, and the file removed when the engine is destroyed. The binding
 * record is kept on the session's entry (`DaemonSession.engine`) with a
 * durable copy per family namespace; a family reports `bound` / `released`
 * through its owner VIEW ({@link SessionEngineScope.ownerFor}) and reads back
 * what was recorded. It never holds the store and never touches the socket
 * file.
 *
 * This scope IS the session layer's arm: one instance per daemon over the
 * daemon's engine durable, constructed by the composition root and handed to
 * the long-lived family singletons (one family serves many sessions;
 * per-session identity travels as the label/sessionId value in each call).
 * The per-session entry (`DaemonSession`) owns the per-session policy —
 * `bindFailed`, the kept-engine record, turn invalidation — not the process
 * acts. A forwarding delegate on the entry would add a hop and no decision,
 * so there is none: the entry holds no scope and exposes no engine verb.
 *
 * Refusal wording below is byte-identical to the supervision wiring's
 * (`runtime/host.ts`): a daemon without a host adapter cannot own an engine
 * at all, and a refused launch beats a child no restart could re-adopt.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EngineAttachment,
  EngineBindingRecord,
  EngineHold,
  EngineProcessOwner,
  EngineSpawnRequest,
  SessionEngineOwner,
} from '@podium/harness/driver/host'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import {
  scopeUnitName,
  type DurableAdapter,
  type DurableProcess,
  type HostDurableAttachment,
} from '@podium/process/durable'
import {
  ABDUCO_SUN_PATH_MAX,
  unixSocketPathBytes,
  unixSocketPathFits,
} from '@podium/runtime/abduco-socket'
import { noDurableBackendRefusal } from '../durable-backend'
import { createEngineJournal } from './journal.js'
import type { SessionRegistry } from './registry.js'

const log = createLogger('daemon:session-engines')

/** The session layer's durable binding store, one per family namespace. */
export interface EngineJournal<TEntry extends { sessionId: SessionId }> {
  read(sessionId: SessionId): TEntry | undefined
  write(entry: TEntry): void
  clear(sessionId: SessionId): void
}

const UNIX_SCHEME = 'unix://'

/**
 * An engine listener's path under the instance-private socket root. A short
 * basename preserves room under Unix's sockaddr limit: a session hash plus a
 * random incarnation suffix, so a stale pathname is never reused across two
 * engines of one session.
 */
export function engineSocketPath(
  socketRoot: string,
  key: string,
  nonce: string = randomUUID(),
): string {
  const session = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const incarnation = nonce.replaceAll('-', '').slice(0, 12)
  const path = join(socketRoot, `${session}-${incarnation}.sock`)
  if (!unixSocketPathFits(path)) {
    throw new Error(
      `engine socket path is ${unixSocketPathBytes(path)} bytes; ` +
        `Unix socket paths must be shorter than ${ABDUCO_SUN_PATH_MAX} bytes: ${path}`,
    )
  }
  return path
}

/** The filesystem path behind a minted `unix://` address, or undefined for
 *  any other address (the session layer only owns files it minted). */
export function engineSocketFile(address: string | undefined): string | undefined {
  return address?.startsWith(UNIX_SCHEME) ? address.slice(UNIX_SCHEME.length) : undefined
}

/** Where the session layer keeps engine listeners and binding records. */
export interface SessionEngineScopeOptions {
  /** The daemon's one session registry: engine bindings live on its entries. */
  sessions: SessionRegistry
  /** The instance-private socket root (0700) listeners are minted under.
   *  Absent = this scope cannot mint an address, and a request for one
   *  refuses loudly. */
  socketRoot?: () => string
  /** The durable store per family namespace. Defaults to the state-dir
   *  journal; tests hand an in-memory one. */
  journalFor?: (namespace: string) => EngineJournal<{ sessionId: SessionId }>
  /** Can this machine run podium-host? False = refuse every start with the
   *  one no-durable-host sentence terminal spawns use (POD-4617). Absent =
   *  assumed available. */
  hostAvailable?: () => boolean
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
 * the families drive, plus the journal store. One per daemon, constructed by
 * the composition root over the daemon's engine durable and handed to the
 * families directly.
 */
export class SessionEngineScope implements EngineProcessOwner {
  private readonly journals = new Map<string, EngineJournal<{ sessionId: SessionId }>>()

  constructor(
    private readonly durable: DurableProcess | undefined,
    private readonly options: SessionEngineScopeOptions,
  ) {}

  /** Create-or-adopt the engine's process (spec §4.8 step 2). A request that
   *  asks for a listener gets its address minted here and recorded on the
   *  session's entry before the engine starts. With no podium-host every
   *  start refuses first, before any address is minted (POD-4617). */
  async startEngine(req: EngineSpawnRequest): Promise<EngineHold> {
    if (!(this.options.hostAvailable?.() ?? true)) throw new Error(noDurableBackendRefusal())
    const adapter = engineAdapter(this.durable, req.label)
    const { retention, listen, sessionId, ...spawn } = req
    const address = listen ? this.mintAddress(req.label, sessionId) : undefined
    if (sessionId !== undefined) {
      // A fresh engine: whatever address an earlier one had is not this one's.
      const { address: _previous, ...engine } = this.options.sessions.ensure(sessionId).engine ?? {}
      this.options.sessions.ensure(sessionId).engine = {
        ...engine,
        label: req.label,
        ...(address !== undefined ? { address } : {}),
      }
    }
    const args = listen && address !== undefined ? [...spawn.args, ...listen.argv(address)] : spawn.args
    const attachment = toEngineAttachment(
      await adapter.spawnHeadless({ ...spawn, args, ...retention }),
    )
    return { attachment, ...(address !== undefined ? { address } : {}) }
  }

  /** Re-attach to the surviving engine as the writer (`'tail'`), or replay a
   *  one-shot turn's ring from a seq. */
  async reattachEngine(input: {
    label: string
    fromSeq: 'tail' | bigint
    sessionId?: SessionId
  }): Promise<EngineHold> {
    const adapter = engineAdapter(this.durable, input.label)
    const attachment = toEngineAttachment(
      await adapter.attachHeadless({ label: input.label, fromSeq: input.fromSeq }),
    )
    const address =
      input.sessionId !== undefined ? this.liveAddress(input.sessionId, input.label) : undefined
    return { attachment, ...(address !== undefined ? { address } : {}) }
  }

  /** A live host owns the label AND its program is still running. */
  async engineAlive(label: string): Promise<boolean> {
    return engineAdapter(this.durable, label).has(label)
  }

  /** Detach-or-terminate the engine's process (spec §4.8 step 6), then remove
   *  the listener this layer minted for it. */
  async destroyEngine(label: string, sessionId?: SessionId): Promise<void> {
    const address = sessionId !== undefined ? this.liveAddress(sessionId, label) : undefined
    await this.destroyAt(label, address)
  }

  /** Kill the engine, then remove the listener file at `address` — read
   *  BEFORE the kill, because a daemon close empties the entries while its
   *  engine reaps are still in flight. */
  async destroyAt(label: string, address: string | undefined): Promise<void> {
    await engineAdapter(this.durable, label).kill(label)
    const file = engineSocketFile(address)
    if (file) removeSocketFile(file)
  }

  /**
   * One family's owner VIEW: the process verbs plus that family's binding
   * records, in its own namespace. The family reports `bound` / `released`
   * and reads `recorded`; the store and the address stay here.
   */
  ownerFor<TFacts extends { sessionId: SessionId }>(namespace: string): SessionEngineOwner<TFacts> {
    const journal = this.journalIn(namespace)
    const sessions = this.options.sessions
    const scope = this
    const recorded = (sessionId: SessionId): EngineBindingRecord<TFacts> | undefined => {
      const engine = sessions.get(sessionId)?.engine
      if (engine?.namespace === namespace && engine.facts) {
        return {
          ...(engine.facts as TFacts),
          ...(engine.address !== undefined ? { address: engine.address } : {}),
        }
      }
      return journal.read(sessionId) as EngineBindingRecord<TFacts> | undefined
    }
    return {
      startEngine: (req) => scope.startEngine(req),
      async reattachEngine(input) {
        const hold = await scope.reattachEngine(input)
        if (hold.address !== undefined || input.sessionId === undefined) return hold
        // After a restart the entry is new: the address is the recorded one.
        const address = recorded(input.sessionId)?.address
        if (address === undefined) return hold
        const entry = sessions.ensure(input.sessionId)
        entry.engine = { ...entry.engine, label: input.label, address }
        return { ...hold, address }
      },
      engineAlive: (label) => scope.engineAlive(label),
      destroyEngine: (label, sessionId) =>
        scope.destroyAt(
          label,
          sessionId !== undefined
            ? (scope.liveAddress(sessionId, label) ?? recorded(sessionId)?.address)
            : undefined,
        ),
      bound(facts) {
        const entry = sessions.ensure(facts.sessionId)
        const address = entry.engine?.address ?? recorded(facts.sessionId)?.address
        entry.engine = {
          ...entry.engine,
          ...(address !== undefined ? { address } : {}),
          namespace,
          facts,
        }
        journal.write({ ...facts, ...(address !== undefined ? { address } : {}) })
      },
      released(sessionId) {
        const entry = sessions.get(sessionId)
        // Another family's record on the same entry is not this view's to drop.
        if (entry?.engine && (entry.engine.namespace ?? namespace) === namespace) {
          entry.engine = undefined
        }
        journal.clear(sessionId)
      },
      recorded,
    }
  }

  /** The address minted for this session's engine, while its entry holds it. */
  liveAddress(sessionId: SessionId, label: string): string | undefined {
    const engine = this.options.sessions.get(sessionId)?.engine
    return engine?.label === label ? engine.address : undefined
  }

  /**
   * Mint a private Unix listener address: prepare the 0700 root, clear any
   * stale file at the path, hand back `unix://<path>`. The random incarnation
   * suffix means the path is never a live engine's; the clear is for a crashed
   * incarnation that happened to collide.
   */
  private mintAddress(label: string, sessionId: SessionId | undefined): string {
    const rootOf = this.options.socketRoot
    if (!rootOf) {
      throw new Error(
        `engine '${label}' asked for a listener address, but this session layer has no socket root`,
      )
    }
    const root = rootOf()
    const path = engineSocketPath(root, sessionId ?? label)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    removeSocketFile(path)
    return `${UNIX_SCHEME}${path}`
  }

  /**
   * Dial an engine by the address this layer handed its family, and seal the
   * socket file to its owner (0600) once the listener answers — before the
   * endpoint is exposed to anything else. The socket library stays the
   * caller's; this layer owns the file.
   */
  dialerFor<TSocket extends { once(event: 'open', cb: () => void): void }>(
    dial: (path: string) => Promise<TSocket>,
  ): (address: string) => Promise<TSocket> {
    return async (address) => {
      const file = engineSocketFile(address)
      if (!file) throw new Error(`not an engine listener address this layer minted: ${address}`)
      const socket = await dial(file)
      socket.once('open', () => {
        try {
          chmodSync(file, 0o600)
        } catch (err) {
          log.warn('could not seal an engine listener to its owner', { err, path: file })
        }
      })
      return socket
    }
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
   * The durable store for one family namespace, created and held here and
   * never handed to a family: families report through {@link ownerFor}.
   */
  private journalIn(namespace: string): EngineJournal<{ sessionId: SessionId }> {
    const existing = this.journals.get(namespace)
    if (existing) return existing
    const journal = this.options.journalFor?.(namespace) ?? readingLegacyAddress(
      createEngineJournal<{ sessionId: SessionId }>({ namespace }),
    )
    this.journals.set(namespace, journal)
    return journal
  }
}

/**
 * Records written before the session layer minted addresses carry the
 * listener as the family's own `clientAddress`. Normalised here, where the
 * value enters from disk, so a daemon upgraded under a live engine still
 * finds the address it adopts by.
 */
function readingLegacyAddress(
  journal: EngineJournal<{ sessionId: SessionId }>,
): EngineJournal<{ sessionId: SessionId }> {
  return {
    ...journal,
    read(sessionId) {
      const entry = journal.read(sessionId) as
        | { sessionId: SessionId; address?: unknown; clientAddress?: unknown }
        | undefined
      if (!entry || entry.address !== undefined || typeof entry.clientAddress !== 'string') {
        return entry
      }
      return { ...entry, address: entry.clientAddress }
    },
  }
}

function removeSocketFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (err) {
    log.warn('could not remove an engine listener file', { err, path })
  }
}

/** Build the session layer's engine hold over the daemon's engine durable.
 *  `durable` undefined (never bound) = every verb refuses loudly rather than
 *  forking a child no restart could re-adopt. */
export function createSessionEngineScope(
  durable: DurableProcess | undefined,
  options: SessionEngineScopeOptions,
): SessionEngineScope {
  return new SessionEngineScope(durable, options)
}
