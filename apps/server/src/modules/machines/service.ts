import { createHash, randomUUID } from 'node:crypto'
import {
  agentCapabilityRejection,
  type AgentKind,
  type Inventory,
  type MachineUseDecision,
  type MachineWire,
} from '@podium/model'
import type {
  ControlMessage,
  DaemonHandshake,
  LiveServerMessage,
  ServerMessage,
} from '@podium/protocol'
import { LOCAL_MACHINE_ID, LOCAL_PLACEHOLDER } from '@podium/runtime/local-machine'
import type { MachineRecord, SessionStore } from '../../store'
import type { Send } from '../sessions/session'

/**
 * One principal's `use` decision, per machine. Supplied by the command layer
 * (`apps/server/src/machine-access.ts`), which is where the principal lives;
 * this service stays principal-free and only carries the answer.
 */
export type MachineUseResolver = (machineId: string) => MachineUseDecision

/**
 * A machine row with the calling principal's `use` decision attached.
 *
 * NOT on `MachineWire` itself, and that is deliberate: `packages/model`'s
 * machine entity says in its own header that no `owner`, `visibility` or `grant`
 * field may land there yet — those are POD-1075's model types and POD-1071's
 * matrix columns, and adding one would break the byte-identical wire contract
 * that made the Phase-1 move provable. A per-principal decision is the same
 * class of field.
 *
 * So the decision is a SERVER-SIDE annotation today. It reaches every server
 * consumer that enforces it (`requireAgent`, `resolveMachineForAgent`, and
 * through them `agentCapabilityRejection`), and it does NOT survive the wire
 * until the schema carries it — which is POD-1079's, with the projection this
 * type already shapes.
 */
export type MachineListing = MachineWire & { use?: MachineUseDecision }

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
  mint(grant?: PairingGrant): string
  redeem(code: string): PairingGrant | undefined
}

export interface PairingGrant {
  copyAgentCredentials?: boolean
}

export interface MachinesDeps {
  store: SessionStore
  /** Hub-role inbound daemon pairing (injected from server assembly; see {@link PairingCodes}). */
  pairing?: PairingCodes
  /** Retarget in-memory sessions still on the `'__local__'` placeholder onto the
   *  adopting machine (the registry owns the sessions map). */
  retargetPlaceholderSessions(machineId: string): void
  sessionsChangedForMachine(machineId: string): void
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

  /** Drop a machine's daemon socket (the bookkeeping half of detachDaemon).
   *
   *  `send` identifies the socket that closed. A daemon that reconnects before its
   *  previous socket's `close` fires (the keepalive sweep terminates a wedged socket
   *  a beat AFTER the new one has attached) would otherwise have its FRESH
   *  registration deleted by the dead socket's close — leaving the machine
   *  permanently unroutable while its daemon sits happily connected: every control
   *  message queues in `pendingByMachine` and every daemon-routed tRPC call dies on
   *  the 35s "no daemon answered" timeout.
   *
   *  Returns false when the closing socket is already superseded (nothing to do). */
  detach(machineId: string, send?: Send<ControlMessage>): boolean {
    if (send !== undefined && this.daemons.get(machineId) !== send) return false
    this.daemons.delete(machineId)
    this.invalidateMachineCache()
    return true
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
  mintPairingCode(grant: PairingGrant = {}): string {
    if (!this.deps.pairing) throw new Error('inbound pairing is disabled on this server')
    return this.deps.pairing.mint(grant)
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
  ):
    | { ok: true; machineId: string; name: string; token?: string; pairingGrant?: PairingGrant }
    | { ok: false; reason: string } {
    if (frame.type === 'pair') {
      // No pairing manager = node role: this server is not a rendezvous point,
      // so new machines can't join it. Returning daemons (`hello`) still work.
      if (!this.deps.pairing) return { ok: false, reason: 'pairing is disabled on this server' }
      const pairingGrant = this.deps.pairing.redeem(frame.code)
      if (!pairingGrant) {
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
      return { ok: true, machineId: frame.machineId, name, token, pairingGrant }
    }
    if (this.deps.store.machines.getMachineByToken(frame.machineId, frame.token)) {
      this.deps.store.machines.touchMachine(frame.machineId, frame.hostname)
      this.invalidateMachineCache()
      const name =
        this.deps.store.machines.listMachines().find((m) => m.id === frame.machineId)?.name ??
        frame.hostname
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
   * Resolve a session target and enforce the daemon-reported harness/login
   * capability before any durable session or spawn side effect is created.
   * Legacy boot-before-daemon routing through `__local__` remains queueable.
   */
  resolveMachineForAgent(
    requested: string | undefined,
    cwd: string,
    agentKind: AgentKind,
    use?: MachineUseResolver,
  ): string {
    if (requested) {
      this.requireAgent(requested, agentKind, use)
      return requested
    }

    const legacy = this.resolveMachine(undefined, cwd)
    if (legacy === LOCAL_PLACEHOLDER) return legacy
    // IMPLICIT placement is a surface too: readiness §3.1.4 M5 says the spawn
    // path must not OFFER a machine the principal cannot use, and an implicit
    // pick offers one without asking. Decorated rows make the existing
    // capability predicate refuse them for us, in the same branch as offline.
    const machines = this.listMachines(use)
    const selected = machines.find((machine) => machine.id === legacy)
    if (selected && agentCapabilityRejection(selected, agentKind) === undefined) return legacy

    // Prefer another capable ONLINE machine that actually owns this cwd. This
    // keeps implicit routing useful without ever launching against a foreign path.
    const byRepo = machines.find(
      (machine) =>
        agentCapabilityRejection(machine, agentKind) === undefined &&
        this.deps.store.repos
          .listRepos(machine.id)
          .some((repo) => cwd === repo.path || cwd.startsWith(`${repo.path}/`)),
    )
    if (byRepo) return byRepo.id

    // During old/single-machine boot no inventory may have arrived yet; preserve
    // the existing queue-and-attach behavior. Once ANY online daemon reports an
    // inventory, lack of the requested harness is authoritative and actionable.
    if (!machines.some((machine) => machine.online && machine.inventory !== undefined))
      return legacy
    this.requireAgent(legacy, agentKind, use)
    return legacy
  }

  /** Throw a human-readable reason when a machine cannot run an agent. */
  requireAgent(machineId: string, agentKind: AgentKind, use?: MachineUseResolver): void {
    const machine = this.listMachines(use).find((candidate) => candidate.id === machineId)
    if (!machine) throw new Error(`unknown machine '${machineId}'`)
    const rejection = agentCapabilityRejection(machine, agentKind)
    // Exhaustive rather than a chain of ifs: a rejection reason nobody handled
    // used to fall through and THROW NOTHING, i.e. a new refusal would fail OPEN
    // and route work to a machine that just refused it. The `never` arm makes
    // adding a reason a compile error at this gate.
    switch (rejection) {
      case undefined:
        return
      case 'unauthorized':
        throw new Error(`you do not have access to run agents on machine '${machine.name}'`)
      case 'offline':
        throw new Error(`machine '${machine.name}' is offline`)
      case 'harness-missing':
        throw new Error(`${agentKind} is not installed on machine '${machine.name}'`)
      case 'logged-out':
        throw new Error(`${agentKind} is not logged in on machine '${machine.name}'`)
      default: {
        const exhaustive: never = rejection
        throw new Error(`machine '${machine.name}' cannot run ${agentKind}: ${String(exhaustive)}`)
      }
    }
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
    const hasRepo = this.deps.store.repos
      .listRepos(machineId)
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
      this.deps.store.repos
        .listRepos(id)
        .some((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)),
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

  /**
   * All known machines with live online status (a daemon socket is attached).
   *
   * `use` is the CALLING PRINCIPAL's execute decision (ADR 3 Amendment 1 D18 /
   * ADR 9 D6 M5). It is a parameter rather than service state because it is a
   * fact about the caller, not about the fleet: two principals looking at the
   * same machine must get two different answers in the same process.
   *
   * OMITTING IT MEANS NOT EVALUATED, exactly as `MachineUseDecision`'s home in
   * `@podium/model` documents — never "granted". Every consumer downstream
   * (`agentCapabilityRejection`, `machinesForAgent`, `handoffTargets`) already
   * reads the field and already denies FIRST when it says `'denied'`, so
   * supplying it here is what turns the whole placement surface on.
   */
  listMachines(use?: MachineUseResolver): MachineListing[] {
    return this.machineRecords().map((m) => ({
      ...(use ? { use: use(m.id) } : {}),
      id: m.id,
      name: m.name,
      hostname: m.hostname,
      online: this.daemons.has(m.id),
      lastSeenAt: m.lastSeenAt,
      ...(m.inventory ? { inventory: m.inventory } : {}),
    }))
  }

  /** Persist a daemon's inventoryReport (#222) on its machine row. */
  recordInventory(machineId: string, inventory: Inventory): void {
    this.deps.store.machines.setMachineInventory(machineId, JSON.stringify(inventory))
    this.invalidateMachineCache()
    this.broadcastMachines()
  }

  renameMachine(id: string, name: string): void {
    this.deps.store.machines.renameMachine(id, name)
    this.invalidateMachineCache()
    this.deps.sessionsChangedForMachine(id) // sessions show machineName — recapture + refresh
    this.broadcastMachines()
  }

  revokeMachine(id: string): void {
    this.deps.store.machines.deleteMachine(id)
    this.invalidateMachineCache()
    this.daemons.delete(id)
    this.deps.sessionsChangedForMachine(id)
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
    this.deps.sessionsChangedForMachine(machineId)
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
    // Classified live-only (@podium/protocol message-class): re-served in full on attach.
    const msg: LiveServerMessage = { type: 'machinesChanged', machines: this.listMachines() }
    for (const c of this.deps.clients()) c.send(msg)
  }
}
