import { existsSync } from 'node:fs'
import type { Geometry } from '@podium/model'
import type { DurableAttachment } from './session.js'
import {
  abducoHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  killAbducoSession,
  listLiveAbducoLabels,
  reapStaleAbducoBindTemps,
  waitForAbducoSocket,
} from './abduco.js'
import type { DurableSpawnOptions } from './scope.js'
import {
  type HostDurableAttachment,
  type HostRetention,
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
 * adapters below are the only code that knows which host it is talking to.
 *
 * ONE BACKEND SPAWNS (POD-4986). podium-host is the only durable host a new
 * session starts on, on Linux and macOS. What already runs is adopted:
 *  - a C host (spawned by an older daemon) is located and attached like any
 *    other host: both hosts speak the one protocol in `./host.js`, and only a
 *    NEW spawn selects a binary;
 *  - an abduco master (every Podium release before POD-4986 ran its sessions
 *    on abduco) is located, attached, listed and killed through the
 *    ADOPTION-ONLY {@link abducoAdoptionAdapter}, which refuses to create
 *    anything. Its native socket client needs no abduco binary. Delete this
 *    compatibility adapter once no running legacy session can remain.
 * So {@link DurableProcess.locate} probes the host's directory first and
 * abduco's second, and the census lists both.
 *
 * Harness-agnostic by construction: this file names no SessionId, no protocol
 * frame and no daemon context — only labels, socket paths and geometry.
 */

export type DurableBackend = 'host' | 'none'

export type DurableKind = Exclude<DurableBackend, 'none'>

/** What an adapter talks to: the host, or an abduco master it only adopts. */
export type DurableAdapterKind = DurableKind | 'abduco'

export interface DurableAttachOptions {
  label: string
  socketPath: string
  /**
   * Refuse when the host grants no writer lease (POD-4434): the attach throws
   * {@link WriterLeaseRefusedError} instead of holding a silent reader. The
   * daemon passes this on every headed attach; headless reattach leaves it off
   * and judges the lease itself (POD-4433).
   */
  requireLease?: boolean
  /** The server's last-known size — a belief, not an observation. */
  lastKnownGeometry: Geometry
  /**
   * The seq after the last DATA byte this daemon saw for the session, when it
   * knows one. A reattach with a seq replays exactly what was missed
   * and needs no repaint; without one it attaches at the tail.
   */
  lastSeq?: bigint
}

/**
 * What locating a live master and attaching to it returns (POD-4434): the new
 * attachment over the surviving process, plus the display command. The kernel
 * size, where the backend can read it, is the attachment's own `size()`.
 * Formerly `DurableAttachment`; that
 * name is the attachment handle itself (`DurableAttachment` in `./session.js`),
 * and this struct is the reattach result that carries one.
 */
export interface DurableReattach {
  attachment: DurableAttachment
  /** The display command the bind reports for the attach. */
  cmd: string
}

/** The adapter over the durable host. */
export interface DurableAdapter {
  readonly kind: DurableAdapterKind
  spawn(opts: DurableSpawnOptions): Promise<DurableAttachment>
  /**
   * Spawn a HEADLESS engine (POD-4433): no pty, pipes instead, stdout+stderr
   * merged into the host's sequence-numbered ring. Same label/scope discipline
   * as `spawn` — the label is what a restarted daemon re-adopts.
   */
  spawnHeadless(opts: HeadlessSpawnOptions): Promise<HostDurableAttachment>
  /**
   * Re-attach to a headless engine after a daemon restart, as the writer. The
   * caller checks the lease on `ready`: a stale daemon still holding it means
   * this generation must refuse loudly, not read along silently.
   */
  attachHeadless(opts: HeadlessAttachOptions): Promise<HostDurableAttachment>
  attach(opts: DurableAttachOptions): Promise<DurableReattach>
  /**
   * Deliberate takeover (POD-4434): take the writer lease for `label` even
   * when it is held, and return the leased reattach. The daemon calls this
   * only on an explicit operator verb — never as a retry.
   */
  steal(opts: DurableAttachOptions): Promise<DurableReattach>
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
 * What a headless engine spawn carries: everything a pty spawn does except the
 * geometry. The engine's address (socket path, port+secret) travels beside the
 * label in the session layer's binding record, never here — this stays
 * harness-agnostic.
 */
export type HeadlessSpawnOptions = Omit<DurableSpawnOptions, 'cols' | 'rows' | 'noPty'> &
  HostRetention

export interface HeadlessAttachOptions {
  label: string
  /** Existing socket path; resolved from the label when absent. */
  socketPath?: string
  /**
   * Resume point: `'tail'` for new output only — the right default for a
   * protocol channel whose pre-restart correlation ids died with the old
   * daemon — or a seq to replay exactly what was missed.
   */
  fromSeq?: bigint | 'tail'
}

/**
 * What the daemon holds: the host adapter, through which every spawn,
 * reattach, liveness check, kill and census goes.
 */
export interface DurableProcess {
  readonly backend: DurableKind
  readonly primary: DurableAdapter
  readonly all: readonly DurableAdapter[]
  spawn(opts: DurableSpawnOptions): Promise<DurableAttachment>
  spawnHeadless(opts: HeadlessSpawnOptions): Promise<HostDurableAttachment>
  attachHeadless(opts: HeadlessAttachOptions): Promise<HostDurableAttachment>
  /** The adapter and socket that currently hold `label`. */
  locate(
    label: string,
    env: NodeJS.ProcessEnv,
    opts?: { waitMs?: number },
  ): Promise<{ adapter: DurableAdapter; socketPath: string } | undefined>
  has(label: string): Promise<boolean>
  kill(label: string): Promise<void>
  list(): Promise<string[]>
  /** Sync teardown probe (see {@link DurableAdapter.hasMasterSync}). */
  hasMasterSync(label: string, env: NodeJS.ProcessEnv): boolean
}

/** Backwards-compatible alias: the daemon predates the `DurableProcess` name. */
export type Durable = DurableProcess

const ABDUCO_ADOPTS_ONLY = 'abduco sessions are adopted, never created (POD-4986): podium-host is the only host a spawn uses'

/**
 * RUNNING abduco sessions, adopted — nothing here creates one (POD-4986). Every
 * create verb refuses loudly; locate, attach, liveness, kill and the census
 * work as they did, so a customer who upgrades keeps every session an older
 * Podium started on abduco until it exits.
 */
export function abducoAdoptionAdapter(): DurableAdapter {
  const refuse = (label: string): Promise<never> =>
    Promise.reject(new Error(`${ABDUCO_ADOPTS_ONLY} (label '${label}')`))
  return {
    kind: 'abduco',
    spawn: (opts) => refuse(opts.label),
    spawnHeadless: (opts) => refuse(opts.label),
    attachHeadless: (opts) => refuse(opts.label),
    async attach(opts) {
      // The agent has been running all along at a size of its own, and
      // `lastKnownGeometry` is only what the server last KNEW. A reattach is not
      // a viewer asking for a size, so it neither resizes nor signals the agent
      // (size-neutral `-N`); the first viewport request after reconnect is what
      // moves it [spec:SP-6144].
      const attachment = attachAbducoAgent({
        label: opts.label,
        socketPath: opts.socketPath,
        sizeNeutral: true,
      })
      await attachment.ready
      return { attachment, cmd: `abduco -a ${opts.socketPath}` }
    },
    async steal(opts) {
      throw new Error(
        `abduco has no writer lease to steal (label '${opts.label}'): every attach client already writes`,
      )
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
    spawnHeadless: (opts) => spawnHostAgent({ ...opts, noPty: true }),
    attachHeadless: (opts) =>
      Promise.resolve(
        attachHostAgent({
          label: opts.label,
          ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
          fromSeq: opts.fromSeq ?? 'tail',
        }),
      ),
    async attach(opts) {
      const attachment: HostDurableAttachment = attachHostAgent({
        label: opts.label,
        socketPath: opts.socketPath,
        fromSeq: opts.lastSeq ?? 'tail',
        ...(opts.requireLease ? { requireLease: true as const } : {}),
      })
      await attachment.ready
      return {
        attachment,
        cmd: `podium-host attach ${opts.socketPath}`,
      }
    },
    async steal(opts) {
      // Deliberate takeover (POD-4434): attach first WITHOUT the lease — the
      // refusal above would detach the very connection the steal needs — then
      // take the lease over that connection. The revoked holder hears
      // LEASE_LOST; this connection is the writer from here on.
      const attachment: HostDurableAttachment = attachHostAgent({
        label: opts.label,
        socketPath: opts.socketPath,
        fromSeq: opts.lastSeq ?? 'tail',
      })
      await attachment.ready
      await attachment.connection.steal()
      return {
        attachment,
        cmd: `podium-host attach ${opts.socketPath}`,
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
 * Compose the daemon's durable object. Every spawn goes to the host (there is
 * one backend, POD-4986); locate, has, kill and the census also reach running
 * abduco sessions through the adoption-only adapter.
 */
export function createDurableProcess(): DurableProcess {
  const primary = hostDurableAdapter()
  const all = [primary, abducoAdoptionAdapter()] as const
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  return {
    backend: 'host',
    primary,
    all,
    spawn: (opts) => primary.spawn(opts),
    spawnHeadless: (opts) => primary.spawnHeadless(opts),
    attachHeadless: (opts) => primary.attachHeadless(opts),
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
      // Probe only the matching legacy socket; a host kill needs no legacy probe.
      const abduco = all[1]
      await Promise.all([
        primary.kill(label),
        abduco.hasMasterSync(label, process.env) ? abduco.kill(label) : undefined,
      ])
    },
    async list() {
      const labels = new Set<string>()
      for (const adapter of all) for (const l of await adapter.list()) labels.add(l)
      return [...labels]
    },
    hasMasterSync: (label, env) => all.some((adapter) => adapter.hasMasterSync(label, env)),
  }
}

/**
 * Sweep leftover `.abduco-<pid>` bind probes through the durable door: a
 * killed create left them, and they inflate every socket readdir the adoption
 * path does. The daemon sweeps once before the reattach storm.
 */
export function sweepStaleDurableBindTemps(env: NodeJS.ProcessEnv = process.env): string[] {
  return reapStaleAbducoBindTemps(env)
}

/**
 * The durable object for a holder. Built once at boot and stored on the
 * holder; a holder that carries only a backend (older tests build them by
 * hand) gets one derived from it.
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
  return createDurableProcess()
}
