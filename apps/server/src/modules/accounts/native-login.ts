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
  readonly ownerUserId: UserId
  readonly attempt: NativeLoginAttempt
}

/** Coordinates native CLI authentication without ever seeing provider tokens.
 * The PTY and inventory remain the two sources of truth. */
export class NativeLoginService {
  private readonly required = new Set<string>()
  // KEYED BY THE HARNESS TYPE, not by `string`. It was a `string` key while the
  // value was a bare attempt and nothing downstream needed the key back; `track`
  // does, so an unbranded key would have to be re-asserted at every iteration —
  // and a cast in a loop is how a vocabulary quietly stops being checked.
  private readonly attempts = new Map<HarnessAgent, TrackedAttempt>()
  private readonly bySession = new Map<string, HarnessAgent>()

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
   */
  attempt(harness: HarnessAgent, viewer: UserId): NativeLoginAttempt | undefined {
    const tracked = this.attempts.get(harness)
    return tracked?.ownerUserId === viewer ? tracked.attempt : undefined
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
    // REUSE IS STILL BY HARNESS ALONE, and deliberately unchanged by PDM-271.
    // `accounts.login`'s contract states the conflict rule as "one active login
    // attempt per harness is reused until it settles", and narrowing it to the
    // owner would change that rule rather than scope a read. That leaves start()
    // able to hand a second admin the running attempt of the first, which is a
    // disclosure through the WRITE surface; it is filed for the phase review
    // rather than absorbed here.
    const existing = this.attempts.get(input.harness)
    if (existing && (existing.attempt.status === 'running' || existing.attempt.status === 'refreshing'))
      return existing.attempt

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
      : candidates.filter((candidate) => authorize(candidate.id) === undefined)
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
    this.attempts.set(input.harness, { ownerUserId: input.ownerUserId, attempt })
    this.bySession.set(spawned.sessionId, input.harness)
    return attempt
  }

  private onExit(sessionId: SessionId, code: number): void {
    const harness = this.bySession.get(sessionId)
    if (!harness) return
    const tracked = this.attempts.get(harness)
    if (!tracked) return
    this.bySession.delete(sessionId)
    if (code !== 0) {
      this.track(harness, tracked, {
        status: 'failed',
        error: `login command exited ${code}`,
      })
      return
    }
    this.track(harness, tracked, { status: 'refreshing' })
    this.deps.machines.toMachine(tracked.attempt.machineId, { type: 'inventoryRequest' })
  }

  /** Re-record an attempt's progress WITHOUT re-deciding whose it is: the owner
   *  is carried through from the tracked row, never recomputed from a lifecycle
   *  event that has no human on it. */
  private track(
    harness: HarnessAgent,
    tracked: TrackedAttempt,
    change: Partial<NativeLoginAttempt>,
  ): void {
    this.attempts.set(harness, {
      ownerUserId: tracked.ownerUserId,
      attempt: { ...tracked.attempt, ...change },
    })
  }

  private async onInventory(machineId: MachineId): Promise<void> {
    for (const [harness, tracked] of this.attempts) {
      if (tracked.attempt.machineId !== machineId || tracked.attempt.status !== 'refreshing')
        continue
      const machine = (await this.deps.machines.listMachines()).find((row) => row.id === machineId)
      const login = machine?.inventory?.agents.find((agent) => agent.kind === harness)?.login
      if (login?.state === 'in') {
        this.track(harness, tracked, { status: 'succeeded' })
        this.required.delete(`${machineId}:${harness}`)
      } else {
        this.track(harness, tracked, {
          status: 'failed',
          error: 'login command finished but the refreshed inventory is still logged out',
        })
      }
    }
  }
}
