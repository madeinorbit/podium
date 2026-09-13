import type { HarnessAgent, MachineId, SessionId, SessionMeta, UserId } from '@podium/model'
import { asMachineId } from '@podium/model'
import type { EventBus } from '../bus'
import type { MachinesService } from '../machines/service'
import type { SessionLifecycle } from '../sessions/lifecycle'
import { withReadScope } from '../../store/executor/read-scope'

export type NativeLoginAttemptStatus = 'running' | 'refreshing' | 'succeeded' | 'failed'

export type NativeLoginAttempt = Pick<SessionMeta, 'sessionId'> &
  Required<Pick<SessionMeta, 'machineId' | 'machineName'>> & {
    status: NativeLoginAttemptStatus
    error?: string
  }

/**
 * An attempt together with the human it was started FOR (PDM-271).
 *
 * The owner is held BESIDE the wire shape rather than added to it. A
 * `NativeLoginAttempt` is returned to clients — `accounts.login` answers with one
 * and `accounts.list` embeds one — so a `ownerUserId` member on that type would
 * ship the owner's id to every viewer, which is the disclosure the scoping below
 * exists to prevent rather than a smaller version of it.
 */
interface TrackedAttempt {
  readonly harness: HarnessAgent
  readonly ownerUserId: UserId
  readonly attempt: NativeLoginAttempt
}

/**
 * The attempts map's key. Opaque by construction: composed by {@link attemptKey}
 * and never parsed back apart.
 */
type AttemptKey = string

/**
 * One in-flight attempt per harness PER HUMAN (PDM-281).
 *
 * Composed and never parsed, the same discipline `required` uses below, so a
 * user id containing a colon cannot split wrongly. The key may therefore be an
 * unbranded string: BOTH branded components are carried on the value as well,
 * which is what the lifecycle handlers read when they need the harness back.
 * That is the point the previous `Map<HarnessAgent, ...>` was making — a key
 * that has to be re-asserted at every iteration is a vocabulary that has quietly
 * stopped being checked — and carrying the harness on the row honours it
 * without making the key itself carry two brands.
 */
const attemptKey = (harness: HarnessAgent, ownerUserId: UserId): AttemptKey =>
  `${ownerUserId}:${harness}`

/** Has this attempt not settled yet? Reuse and the host conflict must agree
 *  about it, so they share one predicate rather than two spellings. */
const inFlight = (attempt: NativeLoginAttempt): boolean =>
  attempt.status === 'running' || attempt.status === 'refreshing'

/** Coordinates native CLI authentication without ever seeing provider tokens.
 * The PTY and inventory remain the two sources of truth. */
export class NativeLoginService {
  private readonly required = new Set<string>()
  // KEYED BY HARNESS AND OWNER (PDM-281) — see {@link attemptKey}. Keyed by the
  // harness alone, this map made two humans who share no machine collide and
  // handed the second one the first's running attempt.
  private readonly attempts = new Map<AttemptKey, TrackedAttempt>()
  private readonly bySession = new Map<string, AttemptKey>()

  constructor(
    private readonly deps: {
      machines: MachinesService
      sessions: SessionLifecycle
      bus: EventBus
      /** Refusal reason for using a machine, with the owner resolved once
       *  (rule 18) and grant checks bound to start()'s per-pass lease (rule 46). */
      authorizerFor(
        ownerUserId: UserId,
      ):
        | ((machineId: MachineId) => string | undefined)
        | Promise<(machineId: MachineId) => string | undefined>
      cwdForMachine(machineId: MachineId): string | Promise<string>
    },
  ) {
    deps.bus.on('session.exited', ({ sessionId, code }) => this.onExit(sessionId, code))
    deps.bus.on('machine.metadataChanged', async ({ machineId, inventory }) => {
      if (inventory) await this.onInventory(machineId)
    })
  }

  markRequired(machineId: MachineId, harness: HarnessAgent): void {
    this.required.add(`${machineId}:${harness}`)
  }

  /**
   * Is a login required for this harness on any machine the VIEWER may execute
   * on (PDM-271)?
   *
   * `required` is keyed `${machineId}:${harness}` and used to be asked with the
   * harness alone, so a suffix match answered yes for a colleague's machine —
   * "somebody's host needs a provider login" is a fact about their execution.
   * The machine set is supplied by the caller rather than resolved here because
   * the read that asks this resolves it ONCE and applies the same answer to the
   * rows, the login targets and the attempt; a second resolution here is how two
   * halves of one response come to disagree.
   *
   * Membership rather than parsing: the key is composed the same way it was
   * written, so a machine id containing a colon cannot split wrongly.
   */
  isRequired(harness: HarnessAgent, machineIds: ReadonlySet<MachineId>): boolean {
    for (const machineId of machineIds) {
      if (this.required.has(`${machineId}:${harness}`)) return true
    }
    return false
  }

  /**
   * The in-flight attempt for this harness, to the human it belongs to (PDM-271).
   *
   * An attempt names a session id and the machine it is running on, so handing
   * one to anybody but its owner reports where another person is authenticating
   * right now. A non-owner gets `undefined` — the same answer as "no attempt" —
   * so the absence does not confirm that somebody else's login is under way.
   *
   * It is now a LOOKUP rather than a fetch-then-compare (PDM-281): the owner is
   * half the key, so there is no arm in which somebody else's row is in hand and
   * a comparison is what stops it being returned.
   */
  attempt(harness: HarnessAgent, viewer: UserId): NativeLoginAttempt | undefined {
    return this.attempts.get(attemptKey(harness, viewer))?.attempt
  }

  async start(input: {
    harness: HarnessAgent
    machineId?: MachineId
    ownerUserId: UserId
  }): Promise<NativeLoginAttempt> {
    return await withReadScope(async () => await this.startInScope(input))
  }

  private async startInScope(input: {
    harness: HarnessAgent
    machineId?: MachineId
    ownerUserId: UserId
  }): Promise<NativeLoginAttempt> {
    // REUSE IS PER HARNESS PER HUMAN (PDM-281). PDM-271 scoped the READ here and
    // left this early return keyed by harness alone, so a second human asking for
    // the same harness was handed the first human's attempt — its session id and
    // the host that person is authenticating on, the same disclosure, through the
    // WRITE surface. It was also an AUTHORIZATION bypass, and that half is not
    // bounded by `accounts.login`'s admin floor at all: the return happened before
    // the machine-use recheck below, so a reused attempt skipped a gate a fresh
    // one passes and could name a host the second caller holds no `use` on.
    //
    // Putting the owner in the key closes both, because a stranger's attempt is
    // now unreachable rather than returned and every other caller falls through
    // to the real path. What it does NOT decide is whether two humans may run one
    // harness's login at once — that is a question about a HOST, settled below.
    const key = attemptKey(input.harness, input.ownerUserId)
    const existing = this.attempts.get(key)
    if (existing && inFlight(existing.attempt)) return existing.attempt

    const candidates = (await this.deps.machines
      .listMachines())
      .filter(
        (machine) =>
          machine.online &&
          machine.inventory?.agents.some(
            (agent) => agent.kind === input.harness && agent.installed,
          ),
      )
    // The owner row is read once for the scan (rule 18), while the grant
    // checks use the explicit read scope opened by start() (rule 46). Candidate
    // filtering and the selected-machine recheck therefore share one lease
    // snapshot; the next start() opens a new lease and re-reads.
    const authorize = await this.deps.authorizerFor(input.ownerUserId)
    const authorized = input.machineId
      ? candidates
      : candidates.filter(
          (candidate) =>
            authorize(candidate.id) === undefined &&
            this.foreignAttemptOn(input.harness, candidate.id, input.ownerUserId) === undefined,
        )
    const machine = input.machineId
      ? authorized.find((candidate) => candidate.id === input.machineId)
      : (authorized.find((candidate) =>
          candidate.inventory?.agents.some(
            (agent) => agent.kind === input.harness && agent.login.state !== 'in',
          ),
        ) ?? authorized[0])
    if (!machine) throw new Error(`no online machine can run ${input.harness} login`)
    const refusal = authorize(machine.id)
    if (refusal) throw new Error(refusal)
    // THE HOST CONFLICT, CHECKED AFTER THE GATE (PDM-281), and the order is the
    // load-bearing part: the caller has already proved they may USE this machine,
    // so the refusal reports nothing they did not already hold and cannot serve
    // as an oracle over a host they cannot see. It names the harness and the
    // machine and no human — whose login it is stays as unreadable here as it is
    // through `attempt()`. Auto-select filtered these hosts out above, so this
    // only ever meets a caller who named one explicitly.
    if (this.foreignAttemptOn(input.harness, machine.id, input.ownerUserId))
      throw new Error(`a ${input.harness} login is already running on '${machine.name}'`)

    const spawned = await this.deps.sessions.createSession({
      agentKind: 'shell',
      loginHarness: input.harness,
      cwd: await this.deps.cwdForMachine(machine.id),
      title: `${input.harness} login`,
      name: `${input.harness} login`,
      machineId: asMachineId(machine.id),
      ownerUserId: input.ownerUserId,
    })
    const attempt: NativeLoginAttempt = {
      sessionId: spawned.sessionId,
      machineId: machine.id,
      machineName: machine.name,
      status: 'running',
    }
    this.attempts.set(key, { harness: input.harness, ownerUserId: input.ownerUserId, attempt })
    this.bySession.set(spawned.sessionId, key)
    return attempt
  }

  /**
   * Somebody else's unsettled attempt for this harness on this host.
   *
   * THE UNIT OF CONFLICT IS THE HOST, not the harness. Two humans authenticating
   * one harness contend for that harness's credential store on ONE machine —
   * `required` above is keyed `${machineId}:${harness}` for exactly that reason —
   * so two humans who share no machine never conflict and two who share a host
   * always do. Note that both are reachable: a machine's owner holds `use` and a
   * grantee can hold it too, so one host really can have two humans behind it.
   *
   * The caller's own attempt cannot appear here — the reuse return above already
   * answered for it — but the owner comparison is written anyway, so the
   * predicate says what it means on its own and stays right if that return moves.
   */
  private foreignAttemptOn(
    harness: HarnessAgent,
    machineId: MachineId,
    viewer: UserId,
  ): TrackedAttempt | undefined {
    for (const tracked of this.attempts.values()) {
      if (tracked.harness !== harness || tracked.ownerUserId === viewer) continue
      if (tracked.attempt.machineId === machineId && inFlight(tracked.attempt)) return tracked
    }
    return undefined
  }

  private onExit(sessionId: SessionId, code: number): void {
    const key = this.bySession.get(sessionId)
    if (!key) return
    const tracked = this.attempts.get(key)
    if (!tracked) return
    this.bySession.delete(sessionId)
    if (code !== 0) {
      this.track(key, tracked, {
        status: 'failed',
        error: `login command exited ${code}`,
      })
      return
    }
    this.track(key, tracked, { status: 'refreshing' })
    this.deps.machines.toMachine(tracked.attempt.machineId, { type: 'inventoryRequest' })
  }

  /** Re-record an attempt's progress WITHOUT re-deciding whose it is: the owner
   *  is carried through from the tracked row, never recomputed from a lifecycle
   *  event that has no human on it. */
  private track(
    key: AttemptKey,
    tracked: TrackedAttempt,
    change: Partial<NativeLoginAttempt>,
  ): void {
    this.attempts.set(key, { ...tracked, attempt: { ...tracked.attempt, ...change } })
  }

  private async onInventory(machineId: MachineId): Promise<void> {
    for (const [key, tracked] of this.attempts) {
      if (tracked.attempt.machineId !== machineId || tracked.attempt.status !== 'refreshing')
        continue
      const machine = (await this.deps.machines.listMachines()).find((row) => row.id === machineId)
      const login = machine?.inventory?.agents.find(
        (agent) => agent.kind === tracked.harness,
      )?.login
      if (login?.state === 'in') {
        this.track(key, tracked, { status: 'succeeded' })
        this.required.delete(`${machineId}:${tracked.harness}`)
      } else {
        this.track(key, tracked, {
          status: 'failed',
          error: 'login command finished but the refreshed inventory is still logged out',
        })
      }
    }
  }
}
