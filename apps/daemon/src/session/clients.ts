/**
 * THE SESSION LAYER'S CLIENT-TERMINAL OWNERSHIP (spec §5).
 *
 * The native-client relay (`runtime/opencode-attach.ts`) composes argv/env and
 * owns client policy — warm TTL, watched state, replay-redraw suppression,
 * label derivation — but never summons, probes or reaps a process. Every
 * process act on a client master — `spawnClient`, `reclaimClient`,
 * `hasClientMaster` on the client's durable — happens HERE, behind the
 * `ClientProcessOwner` port the relay consumes.
 *
 * This scope IS the session layer's arm: one instance per daemon over the
 * daemon's client durable, constructed by the composition root and handed to
 * the relay directly. The per-session entry (`DaemonSession`) owns the
 * per-session policy — the `client` record, the watched flag, the client
 * label — not the process acts. A forwarding delegate on the entry would add
 * a hop and no decision, so there is none: the entry holds no scope and
 * exposes no client verb (the same argument POD-4510 made for the engines).
 */

import type {
  AbducoSpawnOptions,
  DurableAttachment,
  DurableProcess,
} from '@podium/process/durable'

/**
 * THE SESSION-OWNED CLIENT PROCESS VERBS (spec §5).
 *
 * The relay composes the client launch and owns the warm-park policy; it
 * never summons, probes or reaps a process. Every process act happens in the
 * daemon's session layer (this file), delivered here as the port the relay
 * consumes: the session object calls `DurableProcess.spawn` / `kill` /
 * `hasMasterSync` and hands the relay a live `DurableAttachment` the relay
 * only renders. Method names are fresh on purpose: `spawn` / `kill` /
 * `hasMasterSync` in the relay after this lands is the decision sitting in
 * the wrong place, and the grep in the issue's DONE WHEN says so.
 */
export interface ClientProcessOwner {
  /** Create-or-adopt the session's client master (spec §5). */
  spawnClient(opts: AbducoSpawnOptions): Promise<DurableAttachment>
  /** Reclaim the client master holding this label (spec §5). */
  reclaimClient(label: string): Promise<void>
  /**
   * Is a durable master still holding this label? A socket-dir read, not a
   * process fork — this runs on the session teardown path.
   *
   * ONLY FOR THE CALLERS THAT HOLD NO SESSION: `close()`, which reclaims a
   * parked master nothing is attached to, and `adopt()`, which takes one that
   * outlived the daemon back under a deadline.
   */
  hasClientMaster(label: string): boolean
}

/**
 * The session layer's hold on the client durable: the `ClientProcessOwner`
 * the relay drives. One per daemon, constructed by the composition root over
 * the daemon's client durable and handed to the relay directly.
 */
export class SessionClientScope implements ClientProcessOwner {
  constructor(
    private readonly durable: DurableProcess,
    private readonly homeDir?: string,
  ) {}

  /** Create-or-adopt the session's client master (spec §5). */
  async spawnClient(opts: AbducoSpawnOptions): Promise<DurableAttachment> {
    return this.durable.spawn(opts)
  }

  /** Reclaim the client master holding this label (spec §5). */
  async reclaimClient(label: string): Promise<void> {
    await this.durable.kill(label)
  }

  /**
   * THE PROBE MUST LOOK WHERE THE SPAWN PUT IT (POD-2761).
   *
   * `abducoSocketDirs` falls back to `$HOME/.abduco` when `ABDUCO_SOCKET_DIR`
   * is unset, and the master is created against the CLIENT's environment —
   * whose `HOME` is the instance agent home, not the daemon's. A default probe
   * on `process.env` therefore reads a different directory and answers "no
   * master" for one that is running.
   *
   * `process.env` is read PER CALL rather than captured, because the instance
   * env is applied to it during boot and this scope is built on that path.
   */
  hasClientMaster(label: string): boolean {
    return this.durable.hasMasterSync(
      label,
      this.homeDir ? { ...process.env, HOME: this.homeDir } : process.env,
    )
  }
}

/**
 * Build the session layer's client hold over the daemon's client durable.
 * `durable` undefined (never bound) = no hold at all: a `backend=none` daemon
 * builds no client owner, the caller leaves its client terminals unset, and
 * the server-family drivers refuse a Native attach with their per-machine
 * wording (POD-3917). `undefined` is the honest answer; abduco is not this
 * daemon's to give.
 */
export function createSessionClientScope(
  durable: DurableProcess | undefined,
  opts?: { homeDir?: string },
): SessionClientScope | undefined {
  if (durable === undefined) return undefined
  return new SessionClientScope(durable, opts?.homeDir)
}
