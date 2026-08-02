import { createHash, randomUUID } from 'node:crypto'
import {
  type AgentKind,
  agentCapabilityRejection,
  asMachineId,
  type Inventory,
  type MachineId,
  type MachineUseDecision,
  type MachineWire,
} from '@podium/model'
import type {
  ControlMessage,
  DaemonHandshake,
  DaemonMessage,
  LiveServerMessage,
  MachineVerb,
  ServerMessage,
} from '@podium/protocol'
import { deviceGradeSoleOwner } from '../../device-grade-owner'
import {
  type EnrollmentLedger,
  mintPairingToken,
  newLedgerTxnId,
  type PairingTokenClaims,
  verdictForMissingRow,
  verifyPairingToken,
} from '../../enrollment-ledger'
import type { ClientPrincipal } from '../../gateway/client-principal'
import type { MachineRecord, SessionStore } from '../../store'
import type { EventBus } from '../bus'
import type { Send } from '../sessions/session'

/** Client-facing hello/pair refusal — identical for every denial (D19.4 / D20). */
const HELLO_DENIED_REASON = 'unknown machine — re-pair'

/**
 * One principal's `use` decision, per machine. Supplied by the command layer
 * (`apps/server/src/machine-access.ts`), which is where the principal lives;
 * this service stays principal-free and only carries the answer.
 */
export type MachineUseResolver = (machineId: string) => MachineUseDecision

/**
 * A machine row with the calling principal's `use` decision attached.
 *
 * `MachineWire.use` is optional because raw internal inventory has no principal
 * to evaluate. Ownership and grant rows remain server-only policy inputs.
 *
 * Authenticated list and live-update boundaries always supply the decision, so
 * consumers distinguish denial from reachability before reading inventory.
 */
export type MachineListing = MachineWire

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
  /**
   * WHO THE MACHINE WILL BELONG TO (POD-1079, ADR 9 D6 M3: "a newly paired
   * machine is private to its pairer").
   *
   * Stamped at MINT time from the minting principal, carried opaquely through
   * the code, and written onto the row at redeem. Ownership therefore flows from
   * the person who asked for the code, and the daemon — which supplies
   * everything else in the pair frame — has no say in it. A daemon-supplied
   * owner would be an identity claim from a payload, which ADR 3 D7 forbids.
   *
   * ABSENT MEANS UNOWNED, and an unowned machine grants `use` to NOBODY
   * (`machineUseAllowed`). That is the fail-closed direction: a pairing path that
   * forgets to name an owner produces a machine nobody can run code on, which is
   * visible and fixable, rather than one everybody can.
   */
  ownerUserId?: string
  copyAgentCredentials?: boolean
}

export interface MachinesDeps {
  /** Deployment configuration only; never an owner or grant input. */
  instanceId: string
  store: SessionStore
  /**
   * THIS HOST'S machine id — the UUID in `<stateDir>/machine.id`, read once by the
   * composition root (`readOrCreateLocalMachineId`) and handed down.
   *
   * It is a dependency, not a constant, because the server is one machine among
   * equals: the id it answers to is minted material owned by the host, exactly like
   * a remote daemon's. Routing that has no other machine to name (`defaultMachine`,
   * boot-before-daemon spawns) names THIS one, and it is a real id with a real row,
   * so nothing downstream has to know it is "the local one".
   */
  hostMachineId: MachineId
  /** Hub-role inbound daemon pairing (injected from server assembly; see {@link PairingCodes}). */
  pairing?: PairingCodes
  /**
   * Enrollment ledger (POD-1114, D19.4) — pairing root, enrollment serials,
   * recorded owners, revocation entries. State-root tier, outside the DB.
   * Absent only in pure socket-bookkeeping fixtures that never pair/hello.
   */
  enrollment?: EnrollmentLedger
  /**
   * Whether a recorded owner still resolves to a live account. Used on re-enrol
   * and owner reconcile: an unresolvable owner lands the machine in quarantine
   * (D19.4b), never auto-assigned to the first admin.
   */
  userExists?(userId: string): boolean
  /** Production reaction transport for derived session fields. */
  bus?: EventBus
  /** Compatibility-only for isolated fixtures without a bus. */
  sessionsChangedForMachine?(machineId: string): void
  /** Connected client fan-out (machinesChanged). */
  clients(): Iterable<{ principal: ClientPrincipal; send(msg: ServerMessage): void }>
  /** Principal-scoped projection supplied by the command-policy composition boundary. */
  machinesForPrincipal(principal: ClientPrincipal, machines: MachinesService): MachineListing[]
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
  //
  // NOT the daemon-RPC correlator (POD-318), judged deliberately: this is an
  // OFFLINE SEND QUEUE keyed by machine, not correlation state keyed by request.
  // Nothing here is waiting for an answer — a queued message may be a fire-and-
  // forget spawn — and it is the layer BELOW the broker, which sends through
  // `toMachine` and never learns whether a message went out or was parked.
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

  constructor(private readonly deps: MachinesDeps) {
    // Ledger-wins owner projection before any use/manage decision can run (D19.4d).
    if (this.deps.enrollment) this.reconcileOwnersFromLedger()
  }

  /** Deployment label supplied by the composition root. */
  get instanceId(): string {
    return this.deps.instanceId
  }

  /** The enrollment ledger, when the composition root supplied one. */
  get enrollment(): EnrollmentLedger | undefined {
    return this.deps.enrollment
  }

  /** This host's machine id — see {@link MachinesDeps.hostMachineId}. Exposed because
   *  the handshake's machine directory has to name the machine the loopback bootstrap
   *  secret belongs to, and taking it from here keeps ONE answer in the process. */
  get hostMachineId(): MachineId {
    return this.deps.hostMachineId
  }

  /** Register a machine's daemon socket (the bookkeeping half of attachDaemon —
   *  the registry orchestrates adoption/flush/reattach around this). */
  attach(machineId: string, send: Send<ControlMessage>): void {
    this.daemons.set(machineId, send)
    // The daemon may have (re-)registered/touched its machine row on the way in
    // (pair/hello, or a test upserting directly before attaching) — drop the cache.
    this.invalidateMachineCache()
  }

  /** Flush control messages buffered while this machine was offline (e.g. a boot
   *  session's spawn produced before the host daemon's ws connected). Every queue is
   *  keyed by a real machine id, so there is nothing to carry over on attach. */
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
   * wsServer). `pair` redeems a one-time code and mints a fresh **pairing-root-
   * verifiable** token (POD-1114), records enrollment in the ledger, hashes the
   * token for the row, and returns the plaintext once (the daemon persists it).
   * `hello` verifies a returning daemon's token against the stored hash; when
   * the row is absent, the D19.4 verdict algorithm re-enrols unattended or
   * denies permanently — client reason is always byte-identical.
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
      const ownerUserId = pairingGrant.ownerUserId ?? null
      const token = this.mintEnrolledToken(frame.machineId, ownerUserId)
      this.deps.store.machines.upsertMachine({
        id: frame.machineId,
        name,
        hostname: frame.hostname,
        tokenHash: sha256(token),
        // The pairer, carried from mint. `?? null` is the fail-closed arm, not a
        // default: a code with no owner produces an unowned machine.
        ownerUserId,
      })
      // Force the owner projection: upsert COALESCE would keep a stale owner after
      // a deliberate re-pair with a new pairer. The ledger enroll is the commit.
      this.deps.store.machines.setMachineOwner(frame.machineId, ownerUserId)
      this.invalidateMachineCache()
      return { ok: true, machineId: frame.machineId, name, token, pairingGrant }
    }
    if (this.deps.store.machines.getMachineByToken(frame.machineId, frame.token)) {
      // Even with a live row, a ledger revoke that outranks the token must win
      // (crash-after-append / DB rollback of the tombstone — D19.4a / D19.4d).
      if (this.isTokenRevoked(frame.machineId, frame.token)) {
        this.logVerdict('revoked', frame.machineId)
        return { ok: false, reason: HELLO_DENIED_REASON }
      }
      this.deps.store.machines.touchMachine(frame.machineId, frame.hostname)
      this.invalidateMachineCache()
      const name =
        this.deps.store.machines.listMachines().find((m) => m.id === frame.machineId)?.name ??
        frame.hostname
      return { ok: true, machineId: frame.machineId, name }
    }
    // Row missing — D19.4 verdict algorithm (pairing root → revoke serial → re-enrol).
    return this.helloMissingRow(frame)
  }

  /**
   * Mint a root-verifiable token and record enrollment in the ledger. Without an
   * enrollment ledger (socket-only fixtures), falls back to a random UUID so
   * existing unit tests that never open a state root keep working.
   */
  private mintEnrolledToken(machineId: string, ownerUserId: string | null): string {
    const ledger = this.deps.enrollment
    if (!ledger) return randomUUID()
    const serial = ledger.nextSerial(machineId)
    const token = mintPairingToken(ledger.pairingRoot, { machineId, serial })
    // Ledger append is the enrollment commit point (D19.4d). Failure aborts pair.
    const ok = ledger.appendEnroll({
      id: newLedgerTxnId(),
      machineId,
      serial,
      ownerUserId,
      at: new Date().toISOString(),
    })
    if (!ok) throw new Error('enrollment ledger refused the enroll append')
    return token
  }

  private isTokenRevoked(machineId: string, token: string): boolean {
    const ledger = this.deps.enrollment
    if (!ledger) return false
    const claims = verifyPairingToken(ledger.pairingRoot, token)
    // Non-root tokens (host bootstrap secret, pre-upgrade UUID) have no serial
    // in this ledger; they cannot be re-enrolled and are not ledger-revoked here.
    if (!claims || claims.machineId !== machineId) return false
    const revokedAt = ledger.revokeSerial(machineId)
    return revokedAt !== undefined && revokedAt >= claims.serial
  }

  /**
   * Hello path when the machines row is gone. Verdict order is fixed by D19.4:
   * unverifiable → deny; revoked → deny permanently; else re-enrol per D19.4b.
   * The client-facing reason never carries the verdict (existence/deployment oracle).
   */
  private helloMissingRow(
    frame: Extract<DaemonHandshake, { type: 'hello' }>,
  ):
    | { ok: true; machineId: string; name: string }
    | { ok: false; reason: string } {
    const ledger = this.deps.enrollment
    if (!ledger) return { ok: false, reason: HELLO_DENIED_REASON }
    const result = verdictForMissingRow(ledger, frame.token)
    if (result.verdict !== 're-enroll') {
      this.logVerdict(result.verdict, frame.machineId)
      return { ok: false, reason: HELLO_DENIED_REASON }
    }
    // Frame machineId must match the token's claims — a forged id with a stolen
    // token for a different machine must not re-enrol under the wrong name.
    if (result.claims.machineId !== frame.machineId) {
      this.logVerdict('unverifiable', frame.machineId)
      return { ok: false, reason: HELLO_DENIED_REASON }
    }
    const name = frame.hostname
    this.reEnrolMachine({
      claims: result.claims,
      ownerUserId: result.ownerUserId,
      token: frame.token,
      name,
      hostname: frame.hostname,
    })
    this.logVerdict('re-enrolled', frame.machineId)
    return { ok: true, machineId: frame.machineId, name }
  }

  /**
   * Recreate a machines row from a pairing-root-verifiable token (D19.4b).
   * MachineId preserved; owner from ledger (or quarantine); grants never restored.
   */
  private reEnrolMachine(input: {
    claims: PairingTokenClaims
    ownerUserId: string | null
    token: string
    name: string
    hostname: string
  }): void {
    const resolvedOwner = this.resolveOwnerForRecovery(input.ownerUserId)
    this.deps.store.machines.upsertMachine({
      id: input.claims.machineId,
      name: input.name,
      hostname: input.hostname,
      tokenHash: sha256(input.token),
      ownerUserId: resolvedOwner,
    })
    // upsert COALESCE keeps a prior owner; recovery must apply the ledger owner.
    this.deps.store.machines.setMachineOwner(input.claims.machineId, resolvedOwner)
    // Grants are always dropped on recovery — the row was gone, so edge rows
    // referencing it should already be gone; belt-and-braces clear.
    this.deps.store.grants.removeAllForResource('machine', input.claims.machineId)
    this.invalidateMachineCache()
  }

  /**
   * Ledger owner → row owner. Unresolvable account → quarantine (`null`), never
   * first-admin auto-assign (D19.4b).
   */
  private resolveOwnerForRecovery(recorded: string | null): string | null {
    if (recorded === null) return null
    if (this.deps.userExists && !this.deps.userExists(recorded)) return null
    return recorded
  }

  private logVerdict(
    verdict: 're-enrolled' | 'revoked' | 'unverifiable',
    machineId: string,
  ): void {
    // Diagnostics follow the decision (D19.4): log the verdict + instance id +
    // state root the check ran against. Client-facing reason stays opaque.
    const root = this.deps.enrollment?.path ?? '(no-ledger)'
    console.info(
      `[podium] machine hello verdict=${verdict} machineId=${machineId} instanceId=${this.deps.instanceId} ledger=${root}`,
    )
  }

  /**
   * Project ledger owners (and revocations) onto the machines table.
   * Ledger-first commit point (D19.4d): after a crash between append and row
   * update, boot repair makes the NEW owner effective with no manual step.
   * Also drops rows whose enrollment has been revoked at a serial that covers
   * the stored credential when we can tell — projection of the revoke append.
   */
  reconcileOwnersFromLedger(): void {
    const ledger = this.deps.enrollment
    if (!ledger) return
    for (const machineId of ledger.enrolledMachineIds()) {
      const row = this.deps.store.machines.getMachine(machineId)
      const revokedAt = ledger.revokeSerial(machineId)
      const lastSerial = ledger.nextSerial(machineId) - 1
      // A revoke at serial S covers every token with serial <= S. If the latest
      // enroll serial is still covered, the machine is revoked and the row is a
      // stale projection — remove it (grants die with it).
      if (revokedAt !== undefined && lastSerial > 0 && revokedAt >= lastSerial) {
        if (row) {
          this.deps.store.grants.removeAllForResource('machine', machineId)
          this.deps.store.machines.deleteMachine(machineId)
        }
        continue
      }
      if (!row) continue
      const recorded = ledger.recordedOwner(machineId)
      if (recorded === undefined) continue
      const resolved = this.resolveOwnerForRecovery(recorded)
      if (row.ownerUserId !== resolved) {
        this.deps.store.machines.setMachineOwner(machineId, resolved)
      }
    }
    this.invalidateMachineCache()
  }

  /**
   * Ownership transfer — ledger append is the commit point (D19.4d).
   *
   * Ordering: append first; only then project onto `machines.owner`. Failure of
   * the append leaves the old owner effective and throws. Crash after append,
   * before the row write, is repaired by {@link reconcileOwnersFromLedger} on
   * the next boot (and the NEW owner is already effective for any check that
   * re-reads the ledger first — see {@link effectiveOwner}).
   *
   * `opts.skipRowUpdate` is the crash-injection seam for the required
   * regression sequence #5; production callers never pass it.
   */
  transferOwnership(
    machineId: string,
    newOwnerUserId: string,
    opts: { skipRowUpdate?: boolean; txnId?: string } = {},
  ): void {
    const ledger = this.deps.enrollment
    if (!ledger) throw new Error('ownership transfer requires the enrollment ledger')
    const row = this.deps.store.machines.getMachine(machineId)
    if (!row) throw new Error(`unknown machine '${machineId}'`)
    const txnId = opts.txnId ?? newLedgerTxnId()
    const appended = ledger.appendOwner({
      id: txnId,
      machineId,
      ownerUserId: newOwnerUserId,
      at: new Date().toISOString(),
    })
    // Idempotent retry: a re-append of the same id is a no-op but the row may
    // still need projecting.
    if (!appended && ledger.recordedOwner(machineId) !== newOwnerUserId) {
      throw new Error('ownership transfer ledger append failed')
    }
    if (opts.skipRowUpdate) return
    this.deps.store.machines.setMachineOwner(machineId, newOwnerUserId)
    this.invalidateMachineCache()
    this.broadcastMachines()
  }

  /**
   * Effective owner for authorization: ledger wins over the row (D19.4d rule 4).
   * Callers that authorize `use`/`manage` should prefer this over the raw row
   * when a ledger is present; {@link reconcileOwnersFromLedger} keeps the row
   * in sync, but a concurrent transfer can land between reconcile and check.
   */
  effectiveOwner(machineId: string): string | null | undefined {
    const ledger = this.deps.enrollment
    if (ledger) {
      const recorded = ledger.recordedOwner(machineId)
      if (recorded !== undefined) return this.resolveOwnerForRecovery(recorded)
    }
    return this.deps.store.machines.getMachine(machineId)?.ownerUserId
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
  onlineMachineIds(): MachineId[] {
    // The keys came from authenticated machine principals; the Map is keyed by the
    // plain string only because that is what a Map key is.
    return [...this.daemons.keys()] as MachineId[]
  }

  /**
   * The machine a host-scoped request (scan/usage/repoOp/…) targets when the caller
   * has no machine context: the sole online machine, else THIS HOST.
   *
   * The offline arm used to be the placeholder, and that was the load-bearing lie —
   * a request with no machine context was routed to a name no daemon ever answers
   * to, so it sat in a queue keyed by nothing until the 35s timeout, and any row it
   * created was created machine-less. Answering with the host id makes the offline
   * case a NORMAL offline machine: the message queues under a real id, the host
   * daemon flushes it on attach, and every caller that checks liveness or `use`
   * before routing (`requireAgent`, `requireMachineForRepo`, the fleet authz layer)
   * gets to make that decision against a machine that actually exists.
   */
  defaultMachine(): MachineId {
    const online = this.onlineMachineIds()
    return online[0] ?? this.deps.hostMachineId
  }

  /**
   * Resolve the machine a new session should spawn on. An explicitly requested
   * machine wins when it's online; otherwise pick by repo affinity, else the sole
   * online machine, else this host. For a single connected daemon this always
   * returns that one machine — single-machine behavior is unchanged.
   */
  resolveMachine(requested: string | undefined, cwd: string): MachineId {
    if (requested && this.daemons.has(requested)) return asMachineId(requested)
    return this.pickMachineForRepo(undefined, cwd)
  }

  /**
   * Resolve a session target and enforce the daemon-reported harness/login
   * capability before any durable session or spawn side effect is created.
   *
   * Boot-before-daemon still QUEUES rather than refusing: the host machine's row
   * exists from `ensureHostMachine`, so the pick resolves to it, the capability
   * check sees an offline machine with no inventory yet, and the last branch below
   * lets it through to `toMachine`'s offline queue — which flushes when the host
   * daemon attaches under that same id. What is gone is the branch that let the
   * PLACEHOLDER through unchecked.
   */
  resolveMachineForAgent(
    requested: string | undefined,
    cwd: string,
    agentKind: AgentKind,
    use?: MachineUseResolver,
  ): MachineId {
    if (requested) {
      this.requireAgent(requested, agentKind, use)
      return asMachineId(requested)
    }

    const legacy = this.resolveMachine(undefined, cwd)
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
   * repo path, else `defaultMachine()` — the sole/first online machine, or this
   * host when nothing is online.
   *
   * This used to be three branches ending in the placeholder, and the third one
   * carried a warning that queueing under `'__local__'` "would dead-queue forever
   * because no daemon ever attaches as `'__local__'` after adoption". There is
   * nothing left to warn about: every arm now names a machine with a row, and the
   * boot-before-daemon arm names the host whose daemon is precisely the one about
   * to attach and drain the queue.
   */
  pickMachineForRepo(_originUrl: string | undefined, cwd: string): MachineId {
    const byRepo = this.onlineMachineIds().find((id) =>
      this.deps.store.repos
        .listRepos(id)
        .some((r) => cwd === r.path || cwd.startsWith(`${r.path}/`)),
    )
    return byRepo ?? this.defaultMachine()
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

  /**
   * The ownership facts for every machine row — `machine-access.ts`'s
   * `MachineRowSource` (POD-1079).
   *
   * Separate from {@link listMachines} because that one builds the WIRE
   * projection: a client sees a machine's name, liveness and inventory, and does
   * not need to be told who owns it in order to be refused. Served from the same
   * cache, which every write to the table invalidates.
   */
  ownershipRows(): { id: string; name: string; ownerUserId: string | null }[] {
    // Ledger-wins for owner (D19.4d rule 4): authorization never serves a stale
    // row when the durable append has already committed a transition.
    return this.machineRecords().map((m) => ({
      id: m.id,
      name: m.name,
      ownerUserId: this.effectiveOwner(m.id) ?? m.ownerUserId,
    }))
  }

  /**
   * The grant edges on one machine, read STRAIGHT FROM THE TABLE (POD-1079).
   *
   * Deliberately NOT served from `machineRecordsCache`. That cache exists because
   * `listSessions` resolves a machine NAME per session on the hottest path; a
   * grant is consulted once per access decision, and caching it would reintroduce
   * the exact failure ADR 9 D2 rule 4 forbids — a revoked share that keeps
   * working until somebody remembers to invalidate.
   */
  grantsForMachine(machineId: string): { grantee: string; verb: string }[] {
    return this.deps.store.grants.listForResource('machine', machineId)
  }

  /** Persist a daemon's inventoryReport (#222) on its machine row. */
  recordInventory(machineId: string, inventory: Inventory): void {
    this.deps.store.machines.setMachineInventory(machineId, JSON.stringify(inventory))
    this.invalidateMachineCache()
    this.broadcastMachines()
  }

  /** Route a daemon-local warning with machine scope supplied by the transport. */
  recordDiagnostic(
    machineId: string,
    diagnostic: Extract<DaemonMessage, { type: 'machineDiagnostic' }>,
  ): void {
    const { type: _type, ...detail } = diagnostic
    this.deps.bus?.emit('machine.diagnostic', { machineId, ...detail })
  }

  renameMachine(id: string, name: string): void {
    this.deps.store.machines.renameMachine(id, name)
    this.invalidateMachineCache()
    if (this.deps.bus) this.deps.bus.emit('machine.metadataChanged', { machineId: id })
    else this.deps.sessionsChangedForMachine?.(id)
    this.broadcastMachines()
  }

  shareMachine(
    id: string,
    grantee: string,
    verb: MachineVerb,
    attribution: { actor: string; onBehalfOf: string },
  ): void {
    const machine = this.deps.store.machines.getMachine(id)
    if (!machine?.ownerUserId || machine.ownerUserId !== attribution.onBehalfOf) {
      throw new Error('only the machine owner may change sharing')
    }
    const actorKind = attribution.actor.startsWith('session:')
      ? 'agent'
      : attribution.actor.startsWith('system:')
        ? 'system'
        : 'user'
    const actorId = attribution.actor.includes(':')
      ? attribution.actor.slice(attribution.actor.indexOf(':') + 1)
      : attribution.actor
    this.deps.store.grants.upsert({
      resourceKind: 'machine',
      resourceId: id,
      grantee,
      verb,
      owner: machine.ownerUserId,
      visibility: 'owned-compute',
      createdAt: new Date().toISOString(),
      actorKind,
      actorId,
      onBehalfOf: attribution.onBehalfOf,
    })
    this.broadcastMachines()
  }

  unshareMachine(id: string, grantee: string, verb: MachineVerb, owner: string): void {
    const machine = this.deps.store.machines.getMachine(id)
    if (!machine?.ownerUserId || machine.ownerUserId !== owner) {
      throw new Error('only the machine owner may change sharing')
    }
    this.deps.store.grants.remove('machine', id, grantee, verb)
    this.broadcastMachines()
  }

  /**
   * Revoke a machine. The ledger append is the revocation (D19.4d); the row
   * delete is a projection of it. Without a durable revoke entry, a later DB
   * restore would let the old token re-enrol automatically (the hole D19.4a closes).
   *
   * `opts.skipRowDelete` is the crash-injection seam mirroring transfer's
   * `skipRowUpdate`; production callers never pass it.
   */
  revokeMachine(
    id: string,
    opts: { by?: string | null; skipRowDelete?: boolean; txnId?: string } = {},
  ): void {
    const ledger = this.deps.enrollment
    if (ledger) {
      // Serial at revoke: cover the latest enrollment serial so that token is denied.
      // nextSerial-1 is the last enrolled serial; if never enrolled, use 1 so a
      // future token with serial 1 is still covered once we have no better number.
      const serial = Math.max(1, ledger.nextSerial(id) - 1)
      ledger.appendRevoke({
        id: opts.txnId ?? newLedgerTxnId(),
        machineId: id,
        serial,
        by: opts.by ?? null,
        at: new Date().toISOString(),
      })
    }
    if (opts.skipRowDelete) return
    // The grant edges die WITH the machine (POD-1079). A daemon keeps its
    // machineId across a revoke/re-pair, so an edge that outlived the row would
    // silently re-share a machine its owner had already un-shared.
    this.deps.store.grants.removeAllForResource('machine', id)
    this.deps.store.machines.deleteMachine(id)
    this.invalidateMachineCache()
    this.daemons.delete(id)
    if (this.deps.bus) this.deps.bus.emit('machine.metadataChanged', { machineId: id })
    else this.deps.sessionsChangedForMachine?.(id)
    this.broadcastMachines()
  }

  /**
   * Provision THIS HOST as a machine at SERVER STARTUP, under the id minted in
   * `<stateDir>/machine.id`.
   *
   * The host is just a normally registered machine: the server owns its credential
   * (`tokenHash = sha256(secret)`, where `secret` is the value it wrote to the
   * state-dir file for the same-host daemon to read), so the local daemon
   * authenticates through the regular hello path — exactly like a paired remote,
   * with no bootstrap special case. Its id is minted material for the same reason.
   *
   * IT RUNS BEFORE ANY ROW IS WRITTEN, and that ordering is the whole design: with
   * the host's row in place at boot, a session created a millisecond later has a
   * real machine to belong to whether or not the daemon has connected. Nothing
   * adopts anything afterwards.
   *
   * The legacy `'local'` machines row is NOT dealt with here: the store folded it
   * onto this id (`migrateLegacyMachineIdentity`) when it opened, before anything
   * could read it, so by the time this runs the row is already the host's — and the
   * upsert below therefore UPDATES it, carrying its credential, owner and grant
   * edges forward rather than inserting a rival. Idempotent. Tests omit `secret`
   * (a random throwaway — they attach via the registry without authenticating).
   */
  ensureHostMachine(hostname: string, secret: string = randomUUID()): string {
    const id = this.deps.hostMachineId
    this.deps.store.machines.upsertMachine({
      id,
      name: hostname,
      hostname,
      tokenHash: sha256(secret),
      // NOBODY PAIRED THIS ONE. It is provisioned at boot by the server process,
      // with no principal in scope to attribute it to, so its owner is the
      // honestly-named placeholder — see `device-grade-owner.ts`. The COALESCE in
      // `upsertMachine` means a later real owner is never overwritten by this
      // boot-time write.
      ownerUserId: deviceGradeSoleOwner(),
    })
    this.invalidateMachineCache()
    // The row's NAME is derived onto every session's `machineName`, and this write is
    // where it first becomes known (before it, the projection falls back to the raw
    // id). Same seam a rename uses — the derived field has one way to be refreshed,
    // not one for boot and one for later.
    if (this.deps.bus) this.deps.bus.emit('machine.metadataChanged', { machineId: id })
    else this.deps.sessionsChangedForMachine?.(id)
    return id
  }

  broadcastMachines(): void {
    // Classified live-only (@podium/protocol message-class): re-served in full on attach.
    for (const c of this.deps.clients()) {
      const msg: LiveServerMessage = {
        type: 'machinesChanged',
        machines: this.deps.machinesForPrincipal(c.principal, this),
      }
      c.send(msg)
    }
  }
}
