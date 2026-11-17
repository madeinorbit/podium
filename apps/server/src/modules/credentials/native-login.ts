import type {
  HarnessAgent,
  MachineId,
  MachineProjection,
  SessionId,
  SessionMeta,
  UserId,
} from '@podium/model'
import { asMachineId } from '@podium/model'
import { asSystemWrite } from '../../plain-command-scope'
import { withReadScope } from '../../store/executor/read-scope'
import type { EventBus } from '../bus'
import type { MachinesService } from '../machines/service'
import type { SessionLifecycle } from '../sessions/lifecycle'

export type NativeLoginAttemptStatus = 'running' | 'refreshing' | 'succeeded' | 'failed'

export type NativeLoginAttempt = Pick<SessionMeta, 'sessionId'> &
  Required<Pick<SessionMeta, 'machineId'>> & {
    machineName: MachineProjection['name']
    status: NativeLoginAttemptStatus
    error?: string
  }

const attemptKey = (ownerUserId: UserId, harness: HarnessAgent): string =>
  `${ownerUserId}\u0000${harness}`

/** Coordinates native CLI authentication without ever seeing provider tokens.
 * The PTY and inventory remain the two sources of truth.
 *
 * PER MEMBER (POD-6300). A machine's native logins belong to the person who
 * looks after it, so a member logs in only on a machine in their own custody:
 * logging in on someone else's would replace that person's login. Attempts are
 * kept per (member, harness), so Alice's attempt is never Bob's answer. */
export class NativeLoginService {
  private readonly required = new Set<string>()
  /** Keyed by {@link attemptKey}: one attempt per (user, harness). */
  private readonly attempts = new Map<
    string,
    NativeLoginAttempt & { readonly harness: HarnessAgent }
  >()
  private readonly bySession = new Map<string, string>()

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
      /** The member who looks after the machine, or null when nobody does. */
      custodianOf(machineId: MachineId): Promise<UserId | null>
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

  /** A login is required for this harness on one of these machines (the
   *  viewer's own: another person's logins are not the viewer's to repair). */
  isRequired(harness: HarnessAgent, machineIds: ReadonlySet<MachineId>): boolean {
    return [...machineIds].some((machineId) => this.required.has(`${machineId}:${harness}`))
  }

  /** This user's latest attempt for this harness, if any. */
  attempt(ownerUserId: UserId, harness: HarnessAgent): NativeLoginAttempt | undefined {
    const found = this.attempts.get(attemptKey(ownerUserId, harness))
    if (!found) return undefined
    const { harness: _harness, ...attempt } = found
    return attempt
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
    const key = attemptKey(input.ownerUserId, input.harness)
    const existing = this.attempt(input.ownerUserId, input.harness)
    if (existing && (existing.status === 'running' || existing.status === 'refreshing'))
      return existing

    const candidates = (await this.deps.machines.listMachines()).filter(
      (machine) =>
        machine.online &&
        machine.inventory?.agents.some((agent) => agent.kind === input.harness && agent.installed),
    )
    // The owner row is read once for the scan (rule 18), while the grant
    // checks use the explicit read scope opened by start() (rule 46). Candidate
    // filtering and the selected-machine recheck therefore share one lease
    // snapshot; the next start() opens a new lease and re-reads.
    const authorize = await this.deps.authorizerFor(input.ownerUserId)
    const custodians = new Map(
      await Promise.all(
        candidates.map(
          async (candidate) => [candidate.id, await this.deps.custodianOf(candidate.id)] as const,
        ),
      ),
    )
    const own = (machineId: MachineId) => custodians.get(machineId) === input.ownerUserId
    const authorized = input.machineId
      ? candidates
      : candidates.filter((candidate) => own(candidate.id) && authorize(candidate.id) === undefined)
    const machine = input.machineId
      ? authorized.find((candidate) => candidate.id === input.machineId)
      : (authorized.find((candidate) =>
          candidate.inventory?.agents.some(
            (agent) => agent.kind === input.harness && agent.login.state !== 'in',
          ),
        ) ?? authorized[0])
    if (!machine) throw new Error(`no online machine of yours can run ${input.harness} login`)
    const refusal = authorize(machine.id)
    if (refusal) throw new Error(refusal)
    if (!own(machine.id)) {
      throw new Error(
        `${machine.name} is someone else's machine: its ${input.harness} login is theirs, and ` +
          'logging in there would replace it. Log in on a machine you look after, or send one ' +
          'of your connections to this machine.',
      )
    }

    // THE LOGIN TERMINAL IS A SYSTEM WRITE (ADR 12 D8; POD-6736). `accounts.login`
    // is a plain command, and its only synced write is this terminal's session
    // row. The server composes all of it (shell, folder, title, the machine it
    // checked above); the caller chose only the harness. Without the exit the
    // plain scope refused every sign-in from Settings, setup and the agent panel.
    const cwd = await this.deps.cwdForMachine(machine.id)
    const spawned = await asSystemWrite(
      async () =>
        await this.deps.sessions.createSession({
          agentKind: 'shell',
          loginHarness: input.harness,
          cwd,
          title: `${input.harness} login`,
          name: `${input.harness} login`,
          machineId: asMachineId(machine.id),
          ownerUserId: input.ownerUserId,
        }),
    )
    const attempt: NativeLoginAttempt = {
      sessionId: spawned.sessionId,
      machineId: machine.id,
      machineName: machine.name,
      status: 'running',
    }
    this.attempts.set(key, { ...attempt, harness: input.harness })
    this.bySession.set(spawned.sessionId, key)
    return attempt
  }

  private onExit(sessionId: SessionId, code: number): void {
    const key = this.bySession.get(sessionId)
    if (!key) return
    const attempt = this.attempts.get(key)
    if (!attempt) return
    this.bySession.delete(sessionId)
    if (code !== 0) {
      this.attempts.set(key, {
        ...attempt,
        status: 'failed',
        error: `login command exited ${code}`,
      })
      return
    }
    this.attempts.set(key, { ...attempt, status: 'refreshing' })
    this.deps.machines.toMachine(attempt.machineId, { type: 'inventoryRequest' })
  }

  private async onInventory(machineId: MachineId): Promise<void> {
    for (const [key, attempt] of this.attempts) {
      if (attempt.machineId !== machineId || attempt.status !== 'refreshing') continue
      const harness = attempt.harness
      const machine = (await this.deps.machines.listMachines()).find((row) => row.id === machineId)
      const login = machine?.inventory?.agents.find((agent) => agent.kind === harness)?.login
      if (login?.state === 'in') {
        this.attempts.set(key, { ...attempt, status: 'succeeded' })
        this.required.delete(`${machineId}:${harness}`)
      } else {
        this.attempts.set(key, {
          ...attempt,
          status: 'failed',
          error: 'login command finished but the refreshed inventory is still logged out',
        })
      }
    }
  }
}
