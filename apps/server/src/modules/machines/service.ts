import { createHash, randomUUID } from 'node:crypto'
import type { ControlMessage, DaemonHandshake, MachineWire, ServerMessage } from '@podium/protocol'
import { LOCAL_MACHINE_ID, LOCAL_PLACEHOLDER } from '../../local-machine'
import type { Send } from '../sessions/session'
import type { MachineRecord, SessionStore } from '../../store'
import type { LiveServerMessage } from '../message-class'

/** sha-256 hex of a secret — matches the store's token-hash scheme. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * The pairing-code surface this core module consumes WITHOUT importing the hub
 * module that implements it (`hub/pairing.ts` — core never imports hub, see
 * `roles.ts`). The composition root injects a `PairingManager` when the server
 * runs the hub role; absent = inbound pairing is disabled (node role): minting
 * throws and `pair` handshakes are rejected, while `hello` auth is unaffected.
 */
export interface PairingCodes {
  mint(): string
  redeem(code: string): boolean
}

export interface MachinesDeps {
  store: SessionStore
  /** Hub-role inbound daemon pairing (injected from server assembly; see {@link PairingCodes}). */
  pairing?: PairingCodes
  /** Retarget in-memory sessions still on the `'__local__'` placeholder onto the
   *  adopting machine (the registry owns the sessions map). */
  retargetPlaceholderSessions(machineId: string): void
  broadcastSessions(): void
  /** Connected client fan-out (machinesChanged). */
  clients(): Iterable<{ send(msg: ServerMessage): void }>
}

/**
 * The daemon gateway (issue #13 Phase 2 — peeled off SessionRegistry): per-machine
 * daemon sockets + offline queueing, pairing/auth, the machines table admin, and
 * machine routing/selection (name cache, online set, repo affinity).
 */
export class MachinesService {
  // machineId -> control-message sender for that daemon. Replaces the single
  // socket: each connected machine has its own send, so a session's control
  // messages route to the daemon that actually runs it.
  private readonly daemons = new Map<string, Send<ControlMessage>>()
  // Per-machine queue for control messages produced while that daemon is briefly
  // offline (e.g. the local daemon during boot, or a survivor session's reattach
  // before its machine re-attaches). Flushed in order on attach (flushQueued).
  private readonly pendingByMachine = new Map<string, ControlMessage[]>()
  /**
   * In-memory mirror of the machines table. listSessions() resolves machineName
   * PER SESSION (and allWire() transitively per issue), so an uncached lookup is
   * a fresh SQLite prepare+all on the hottest path in the process — the profiled
   * boot-storm CPU sink. Machines change rarely: every method that writes the
   * machines table (and daemon attach/detach, defensively) calls
   * invalidateMachineCache(); the next read rebuilds lazily.
   */
  private machineRecordsCache: MachineRecord[] | null = null
  private machineNameCache = new Map<string, string>()

  constructor(private readonly deps: MachinesDeps) {}

  /** Register a machine's daemon socket (the bookkeeping half of attachDaemon —
   *  the registry orchestrates adoption/flush/reattach around this). */
  attach(machineId: string, send: Send<ControlMessage>): void {
    this.daemons.set(machineId, send)
    // The daemon may have (re-)registered/touched its machine row on the way in
    // (pair/hello, or a test upserting directly before attaching) — drop the cache.
    this.invalidateMachineCache()
  }

  /** Flush control messages buffered while this machine was offline (e.g. a boot
   *  session's spawn produced before the local daemon ws connected). Runs AFTER
   *  placeholder adoption so carried-over messages are included. */
  flushQueued(machineId: string): void {
    const send = this.daemons.get(machineId)
    if (!send) return
    const pending = this.pendingByMachine.get(machineId)
    if (pending && pending.length > 0) {
      this.pendingByMachine.delete(machineId)
      for (const m of pending) send(m)
    }
  }

  /** Drop a machine's daemon socket (the bookkeeping half of detachDaemon). */
  detach(machineId: string): void {
    this.daemons.delete(machineId)
    this.invalidateMachineCache()
  }

  /** True when `machineId` has a live daemon socket right now. */
  hasDaemon(machineId: string): boolean {
    return this.daemons.has(machineId)
  }

  /** Route a control message to the daemon that owns `machineId`; queue it if that
   *  machine is briefly offline (flushed in order on its next attach). */
  readonly toMachine = (machineId: string, msg: ControlMessage): void => {
    const send = this.daemons.get(machineId)
    if (send) {
      send(msg)
      return
    }
    const q = this.pendingByMachine.get(machineId)
    if (q) q.push(msg)
    else this.pendingByMachine.set(machineId, [msg])
  }

  // ---- machine admin + daemon pairing/auth ----

  /** Issue a short-lived, single-use pairing code for a new daemon (UI shows it).
   *  Hub role only — without an injected pairing manager this server does not
   *  accept new machines, so minting is a caller error, surfaced loudly. */
  mintPairingCode(): string {
    if (!this.deps.pairing) throw new Error('inbound pairing is disabled on this server')
    return this.deps.pairing.mint()
  }

  /**
   * Authenticate a daemon's handshake frame (pre-Control/Daemon-union, parsed by
   * wsServer). `pair` redeems a one-time code and mints a fresh token, hashing it
   * for storage and returning the plaintext once (the daemon persists it). `hello`
   * verifies a returning daemon's token against the stored hash for its machineId,
   * then attaches as that machineId — the id always comes FROM the frame, never a
   * token lookup, so getMachineByToken returning a boolean is sufficient.
   */
  authenticateDaemon(
    frame: DaemonHandshake,
  ): { ok: true; machineId: string; name: string; token?: string } | { ok: false; reason: string } {
    if (frame.type === 'pair') {
      // No pairing manager = node role: this server is not a rendezvous point,
      // so new machines can't join it. Returning daemons (`hello`) still work.
      if (!this.deps.pairing) return { ok: false, reason: 'pairing is disabled on this server' }
      if (!this.deps.pairing.redeem(frame.code)) {
        return { ok: false, reason: 'invalid or expired code' }
      }
      const name = frame.name ?? frame.hostname
      const token = randomUUID()
      this.deps.store.machines.upsertMachine({
        id: frame.machineId,
        name,
        hostname: frame.hostname,
        tokenHash: sha256(token),
      })
      this.invalidateMachineCache()
      return { ok: true, machineId: frame.machineId, name, token }
    }
    if (this.deps.store.machines.getMachineByToken(frame.machineId, frame.token)) {
      this.deps.store.machines.touchMachine(frame.machineId, frame.hostname)
      this.invalidateMachineCache()
      const name =
        this.deps.store.machines.listMachines().find((m) => m.id === frame.machineId)?.name ?? frame.hostname
      return { ok: true, machineId: frame.machineId, name }
    }
    return { ok: false, reason: 'unknown machine — re-pair' }
  }

  private machineRecords(): MachineRecord[] {
    if (!this.machineRecordsCache) {
      this.machineRecordsCache = this.deps.store.machines.listMachines()
      this.machineNameCache = new Map(this.machineRecordsCache.map((m) => [m.id, m.name]))
    }
    return this.machineRecordsCache
  }

  invalidateMachineCache(): void {
    this.machineRecordsCache = null
  }

  /** Display name for a machineId (the machines table); falls back to the id.
   *  Served from the cache — ZERO SQL on the listSessions hot path. */
  machineName(id: string): string {
    if (!this.machineRecordsCache) this.machineRecords()
    return this.machineNameCache.get(id) ?? id
  }

  /** machineIds with a live daemon socket right now. Public for RepoRegistry fan-out. */
  onlineMachineIds(): string[] {
    return [...this.daemons.keys()]
  }

  /**
   * The machine a host-scoped request (scan/usage/repoOp/…) targets when the caller
   * has no machine context: the sole online machine, else the local placeholder.
   * For a single connected daemon this is that one machine — behavior is unchanged.
   * Multi-machine fan-out of these is a later task; for now they hit one machine.
   */
  defaultMachine(): string {
    const online = this.onlineMachineIds()
    return online.length >= 1 ? (online[0] as string) : LOCAL_PLACEHOLDER
  }

  /**
   * Resolve the machine a new session should spawn on. An explicitly requested
   * machine wins when it's online; otherwise pick by repo affinity, else the sole
   * online machine, else the local placeholder. For a single connected daemon this
   * always returns that one machine — single-machine behavior is unchanged.
   */
  resolveMachine(requested: string | undefined, cwd: string): string {
    if (requested && this.daemons.has(requested)) return requested
    return this.pickMachineForRepo(undefined, cwd)
  }

  /**
   * Guard an explicit machine pin BEFORE any work is routed to it. Without this,
   * an offline machine silently queues the request until the 35s daemonRequest
   * timeout ("no daemon answered…") — and the queued op may still run when the
   * machine reconnects; a machine without the repo fails later with raw git-speak.
   * Throwing here gives the caller an actionable message instead.
   */
  requireMachineForRepo(machineId: string, repoPath: string): void {
    const name = this.machineName(machineId)
    if (!this.daemons.has(machineId)) {
      throw new Error(
        `machine '${name}' is offline — bring its daemon online or clear the issue's machine pin`,
      )
    }
    const hasRepo = this.deps.store
      .repos.listRepos(machineId)
      .some((r) => repoPath === r.path || repoPath.startsWith(`${r.path}/`))
    if (!hasRepo) {
      throw new Error(
        `machine '${name}' has no repo registered at ${repoPath} — clone/register the repo on that machine or clear the issue's machine pin`,
      )
    }
  }

  /**
   * Pick the best online machine for a repo: one that has the cwd registered as a
   * repo path, else the sole online machine, else (for 2+ online machines) any
   * online machine via defaultMachine(). Only falls through to LOCAL_PLACEHOLDER
   * when NO daemon is online — that is the deliberate boot-time queue: a session
   * created before the local daemon connects is queued under __local__ and flushed
   * once ensureLocalMachine/attach runs. With at least one daemon online, queuing
   * under __local__ would dead-queue forever because no daemon ever attaches as
   * '__local__' after adoption.
   *
   * Single-machine behavior is unchanged: online.length === 1 returns that machine
   * before the multi-machine branch is reached.
   */
  pickMachineForRepo(_originUrl: string | undefined, cwd: string): string {
    const online = this.onlineMachineIds()
    const byRepo = online.find((id) =>
      this.deps.store.repos.listRepos(id).some((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)),
    )
    if (byRepo) return byRepo
    if (online.length === 1) return online[0] as string
    // 2+ daemons online but no repo match: route to the default online machine
    // rather than dead-queueing under __local__ (no daemon attaches as '__local__'
    // after adoption). Boot-before-connect (online.length === 0) still falls through
    // to LOCAL_PLACEHOLDER so the spawn is queued and flushed on first attach.
    if (online.length > 1) return this.defaultMachine()
    return LOCAL_PLACEHOLDER
  }

  /** All known machines with live online status (a daemon socket is attached). */
  listMachines(): MachineWire[] {
    return this.machineRecords().map((m) => ({
      id: m.id,
      name: m.name,
      hostname: m.hostname,
      online: this.daemons.has(m.id),
      lastSeenAt: m.lastSeenAt,
    }))
  }

  renameMachine(id: string, name: string): void {
    this.deps.store.machines.renameMachine(id, name)
    this.invalidateMachineCache()
    this.deps.broadcastSessions() // sessions show machineName — refresh it
    this.broadcastMachines()
  }

  revokeMachine(id: string): void {
    this.deps.store.machines.deleteMachine(id)
    this.invalidateMachineCache()
    this.daemons.delete(id)
    this.broadcastMachines()
  }

  /**
   * Rewrite the store's `'__local__'` placeholder rows (sessions/repos/conversations)
   * onto `machineId`, retarget in-memory sessions still on the placeholder, carry over
   * any queued control messages, and broadcast the updated session list. Idempotent.
   */
  adoptPlaceholderRows(machineId: string): void {
    this.deps.store.adoptLocalRows(machineId)
    this.deps.retargetPlaceholderSessions(machineId)
    // Carry over any control messages queued under the placeholder (e.g. a boot
    // session's spawn produced before adoption) so they reach the adopting machine.
    const queued = this.pendingByMachine.get(LOCAL_PLACEHOLDER)
    if (queued && queued.length > 0) {
      this.pendingByMachine.delete(LOCAL_PLACEHOLDER)
      const dest = this.pendingByMachine.get(machineId)
      if (dest) dest.unshift(...queued)
      else this.pendingByMachine.set(machineId, queued)
    }
    // Parked (hibernated/exited) sessions aren't touched by the reattach loop, so
    // push the updated list now — this is what makes pre-existing sessions
    // reappear on upgrade.
    this.deps.broadcastSessions()
  }

  /**
   * Provision the local machine at SERVER STARTUP. The local machine is just a normally
   * registered machine: the server owns its credential (`tokenHash = sha256(secret)`,
   * where `secret` is the value it wrote to the state-dir file for the same-host daemon
   * to read), so the local daemon authenticates through the regular hello path — exactly
   * like a paired remote, with no special bootstrap case. Adoption of pre-existing
   * `'__local__'` rows happens HERE, independent of the daemon, so a single-machine
   * install's sessions/repos are attributed and visible even if the daemon never connects
   * (the regression that lost everyone's data). The daemon presents this id + the secret,
   * attaches, and re-binds its sessions. Idempotent. Tests omit `secret` (a random
   * throwaway — they attach via the registry without authenticating).
   */
  ensureLocalMachine(hostname: string = LOCAL_MACHINE_ID, secret: string = randomUUID()): string {
    this.deps.store.machines.upsertMachine({
      id: LOCAL_MACHINE_ID,
      name: hostname,
      hostname,
      tokenHash: sha256(secret),
    })
    this.invalidateMachineCache()
    this.adoptPlaceholderRows(LOCAL_MACHINE_ID)
    return LOCAL_MACHINE_ID
  }

  broadcastMachines(): void {
    // Classified live-only (modules/message-class): re-served in full on attach.
    const msg: LiveServerMessage = { type: 'machinesChanged', machines: this.listMachines() }
    for (const c of this.deps.clients()) c.send(msg)
  }
}
