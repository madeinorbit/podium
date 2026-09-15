import { existsSync } from 'node:fs'
import type { Geometry } from '@podium/model'
import type { AgentSession } from './session.js'
import {
  type AbducoSpawnOptions,
  abducoHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  killAbducoSession,
  listLiveAbducoLabels,
  reapStaleAbducoBindTemps,
  spawnAbducoAgent,
  waitForAbducoSocket,
} from './abduco.js'
import {
  type HostAgentSession,
  attachHostAgent,
  hostHasSession,
  hostSocketPath,
  killHostSession,
  listLiveHostLabels,
  liveHostSocket,
  spawnHostAgent,
  waitForHostSocket,
} from './host.js'

/**
 * ONE OBJECT BETWEEN THE DAEMON AND ITS DURABLE HOST (SPEC-6, stage 6 of POD-3190).
 *
 * This is `@podium/process/durable`'s sole entry for reaching a process: every
 * spawn, locate, kill, list and liveness check goes through a
 * {@link DurableProcess}, chosen once at boot from the backend, and the two
 * adapters below are the only code that knows which host it is talking to. A
 * REATTACH IS THE EXCEPTION THAT PROBES BOTH: a session created under abduco
 * before the switch lives in abduco until it exits, so
 * {@link DurableProcess.locate} tries the host's directory first and abduco's
 * second regardless of the selected backend, and the census lists both.
 *
 * Harness-agnostic by construction: this file names no SessionId, no protocol
 * frame and no daemon context — only labels, socket paths and geometry.
 */

export type DurableBackend = 'host' | 'abduco' | 'none'

export type DurableKind = Exclude<DurableBackend, 'none'>

export interface DurableAttachOptions {
  label: string
  socketPath: string
  /** Reattaching a shell: `redraw()` defaults to the hard Ctrl-L repaint. */
  hardRepaint: boolean
  /** The server's last-known size — a belief, not an observation (abduco's downgrade fallback). */
  lastKnownGeometry: Geometry
  /**
   * The seq after the last DATA byte this daemon saw for the session, when it
   * knows one (host only). A reattach with a seq replays exactly what was missed
   * and needs no repaint; without one it attaches at the tail.
   */
  lastSeq?: bigint
}

export interface DurableAttachment {
  session: AgentSession
  /** The display command the bind reports for the attach. */
  cmd: string
  /**
   * Whether the reattach path should nudge a repaint after binding. abduco keeps
   * no output history, so a reattach must ask the program to repaint. The host
   * never does (SPEC-6): with a known seq its ring replays exactly what was
   * missed; without one it attaches at the tail and the server's own byte log
   * is what a viewer renders until it asks for a size.
   */
  redrawOnReattach: boolean
  /**
   * The kernel-reported size of the running program, when the host can say
   * (the host's WELCOME). abduco's size-neutral attach reports nothing.
   */
  readGeometry: Geometry | undefined
}

/** One adapter per host implementation. */
export interface DurableAdapter {
  readonly kind: DurableKind
  spawn(opts: AbducoSpawnOptions): Promise<AgentSession>
  attach(opts: DurableAttachOptions): Promise<DurableAttachment>
  /** A live host owns the label AND its program is still running. */
  has(label: string): Promise<boolean>
  kill(label: string): Promise<void>
  list(): Promise<string[]>
  /** The label's live socket path, or undefined. */
  socketPath(label: string, env: NodeJS.ProcessEnv): Promise<string | undefined>
  waitForSocket(label: string, env: NodeJS.ProcessEnv, opts: { timeoutMs: number }): Promise<string>
  /** Synchronous "does a master seem to hold this label" for teardown paths that cannot await. */
  hasMasterSync(label: string, env: NodeJS.ProcessEnv): boolean
  attachCommand(target: string): string
}

/**
 * What the daemon holds: the primary adapter (spawns go there) plus every
 * adapter a session might still live under (reattach, has, kill, census).
 */
export interface DurableProcess {
  readonly backend: DurableKind
  readonly primary: DurableAdapter
  /** Host first, then abduco — the order a reattach probes. */
  readonly all: readonly DurableAdapter[]
  spawn(opts: AbducoSpawnOptions): Promise<AgentSession>
  /** The adapter and socket that currently hold `label`, probing host then abduco. */
  locate(
    label: string,
    env: NodeJS.ProcessEnv,
    opts?: { waitMs?: number },
  ): Promise<{ adapter: DurableAdapter; socketPath: string } | undefined>
  has(label: string): Promise<boolean>
  kill(label: string): Promise<void>
  list(): Promise<string[]>
  /** Sync teardown probe across every adapter (see {@link DurableAdapter.hasMasterSync}). */
  hasMasterSync(label: string, env: NodeJS.ProcessEnv): boolean
}

/** Backwards-compatible alias: the daemon predates the `DurableProcess` name. */
export type Durable = DurableProcess

export function abducoDurableAdapter(): DurableAdapter {
  return {
    kind: 'abduco',
    spawn: (opts) => spawnAbducoAgent(opts),
    async attach(opts) {
      // The agent has been running all along at a size of its own, and
      // `lastKnownGeometry` is only what the server last KNEW — after a daemon
      // restart it can be stale. A reattach is not a viewer asking for a size,
      // so it neither resizes nor signals the agent; the first viewport request
      // after reconnect is what moves it [spec:SP-6144].
      const session = attachAbducoAgent({
        label: opts.label,
        socketPath: opts.socketPath,
        hardRepaint: opts.hardRepaint,
        sizeNeutral: true,
        // Read ONLY if this machine has no `-N` abduco build and the attach
        // downgrades to one that does announce a size. Last-known is then the
        // only size that keeps the agent and every viewer's render agreeing;
        // the session reports it back as `appliedGeometry`.
        fallbackGeometry: opts.lastKnownGeometry,
      })
      return {
        session,
        cmd: `abduco -a ${opts.socketPath}`,
        redrawOnReattach: true,
        readGeometry: undefined,
      }
    },
    has: (label) => abducoHasSession(label),
    kill: (label) => killAbducoSession(label),
    list: async () => listLiveAbducoLabels(),
    async socketPath(label, env) {
      reapStaleAbducoBindTemps(env)
      return abducoSocketPath(label, env)
    },
    waitForSocket: (label, env, opts) => waitForAbducoSocket(label, env, opts),
    hasMasterSync: (label, env) => abducoSocketPath(label, env) !== undefined,
    attachCommand: (target) => `abduco -a ${target}`,
  }
}

export function hostDurableAdapter(): DurableAdapter {
  return {
    kind: 'host',
    spawn: (opts) => spawnHostAgent(opts),
    async attach(opts) {
      const session: HostAgentSession = attachHostAgent({
        label: opts.label,
        socketPath: opts.socketPath,
        hardRepaint: opts.hardRepaint,
        fromSeq: opts.lastSeq ?? 'tail',
      })
      const welcome = await session.ready
      return {
        session,
        cmd: `podium-host attach ${opts.socketPath}`,
        redrawOnReattach: false,
        readGeometry: welcome.hasPty ? { cols: welcome.cols, rows: welcome.rows } : undefined,
      }
    },
    has: (label) => hostHasSession(label),
    kill: (label) => killHostSession(label),
    list: () => listLiveHostLabels(),
    socketPath: (label, env) => liveHostSocket(label, env),
    waitForSocket: (label, env, opts) => waitForHostSocket(label, env, opts),
    // A file check, not a STATUS: this runs where nothing can await. A stale file
    // only costs a harmless reclaim of a host that is already gone.
    hasMasterSync: (label, env) => existsSync(hostSocketPath(label, env)),
    attachCommand: (target) => `podium-host attach ${target}`,
  }
}

/**
 * Compose the daemon's durable object for a backend. `available` says which
 * adapters may hold sessions on this machine; the selected backend is always
 * included so an explicit choice is honoured even when the probe said no.
 */
export function createDurableProcess(
  backend: DurableKind,
  available: { host: boolean; abduco: boolean },
): DurableProcess {
  const adapters: DurableAdapter[] = []
  if (available.host || backend === 'host') adapters.push(hostDurableAdapter())
  if (available.abduco || backend === 'abduco') adapters.push(abducoDurableAdapter())
  const primary = adapters.find((a) => a.kind === backend) as DurableAdapter
  const all = adapters
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  return {
    backend,
    primary,
    all,
    spawn: (opts) => primary.spawn(opts),
    async locate(label, env, opts) {
      const deadline = Date.now() + (opts?.waitMs ?? 0)
      for (;;) {
        for (const adapter of all) {
          const socketPath = await adapter.socketPath(label, env)
          if (socketPath) return { adapter, socketPath }
        }
        if (Date.now() >= deadline) return undefined
        await wait(25)
      }
    },
    async has(label) {
      for (const adapter of all) if (await adapter.has(label)) return true
      return false
    },
    async kill(label) {
      await Promise.all(all.map((adapter) => adapter.kill(label)))
    },
    async list() {
      const labels = new Set<string>()
      for (const adapter of all) for (const l of await adapter.list()) labels.add(l)
      return [...labels]
    },
    hasMasterSync: (label, env) => all.some((adapter) => adapter.hasMasterSync(label, env)),
  }
}

/** Backwards-compatible alias for `createDurableProcess`. */
export const createDurable = createDurableProcess

/**
 * Sweep leftover `.abduco-<pid>` bind probes through the durable door.
 *
 * A killed spawn or crashed runner leaves a temp the socket readdir keeps
 * inflating; the daemon sweeps once before the reattach storm. Routing it here
 * keeps `reapStaleAbducoBindTemps` from being a second door around
 * `DurableProcess`.
 */
export function sweepStaleDurableBindTemps(env: NodeJS.ProcessEnv = process.env): string[] {
  return reapStaleAbducoBindTemps(env)
}

/**
 * The durable object for a holder. Built once at boot and stored on the
 * holder; a holder that carries only a backend (older tests build them by
 * hand) gets an adapter derived from it.
 *
 * The parameter is deliberately `{ backend, durable? }` — the smallest shape
 * that can answer — so this helper names no SessionId, no protocol frame and
 * no daemon context.
 */
export function durableProcessFor(holder: {
  backend: DurableBackend
  durable?: DurableProcess | undefined
}): DurableProcess | undefined {
  if (holder.durable) return holder.durable
  if (holder.backend === 'none') return undefined
  return createDurableProcess(holder.backend, {
    host: holder.backend === 'host',
    abduco: holder.backend === 'abduco',
  })
}

/** Backwards-compatible alias for `durableProcessFor`. */
export const durableFor = durableProcessFor
