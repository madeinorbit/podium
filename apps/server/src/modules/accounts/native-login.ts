import type { HarnessAgent, MachineId, SessionId, UserId } from '@podium/model'
import { asMachineId } from '@podium/model'
import type { EventBus } from '../bus'
import type { MachinesService } from '../machines/service'
import type { SessionLifecycle } from '../sessions/lifecycle'

export type NativeLoginAttemptStatus = 'running' | 'refreshing' | 'succeeded' | 'failed'

export interface NativeLoginAttempt {
  sessionId: SessionId
  machineId: MachineId
  machineName: string
  status: NativeLoginAttemptStatus
  error?: string
}

/** Coordinates native CLI authentication without ever seeing provider tokens.
 * The PTY and inventory remain the two sources of truth. */
export class NativeLoginService {
  private readonly required = new Set<string>()
  private readonly attempts = new Map<string, NativeLoginAttempt>()
  private readonly bySession = new Map<string, HarnessAgent>()

  constructor(
    private readonly deps: {
      machines: MachinesService
      sessions: SessionLifecycle
      bus: EventBus
      authorize(ownerUserId: UserId, machineId: MachineId): string | undefined
      cwdForMachine(machineId: MachineId): string
    },
  ) {
    deps.bus.on('session.exited', ({ sessionId, code }) => this.onExit(sessionId, code))
    deps.bus.on('machine.metadataChanged', ({ machineId, inventory }) => {
      if (inventory) this.onInventory(machineId)
    })
  }

  markRequired(machineId: string, harness: HarnessAgent): void {
    this.required.add(`${machineId}:${harness}`)
  }

  isRequired(harness: HarnessAgent): boolean {
    return [...this.required].some((key) => key.endsWith(`:${harness}`))
  }

  attempt(harness: HarnessAgent): NativeLoginAttempt | undefined {
    return this.attempts.get(harness)
  }

  start(input: {
    harness: HarnessAgent
    machineId?: MachineId
    ownerUserId: UserId
  }): NativeLoginAttempt {
    const existing = this.attempts.get(input.harness)
    if (existing && (existing.status === 'running' || existing.status === 'refreshing'))
      return existing

    const candidates = this.deps.machines
      .listMachines()
      .filter(
        (machine) =>
          machine.online &&
          machine.inventory?.agents.some(
            (agent) => agent.kind === input.harness && agent.installed,
          ),
      )
    const authorized = input.machineId
      ? candidates
      : candidates.filter(
          (candidate) => this.deps.authorize(input.ownerUserId, candidate.id) === undefined,
        )
    const machine = input.machineId
      ? authorized.find((candidate) => candidate.id === input.machineId)
      : (authorized.find((candidate) =>
          candidate.inventory?.agents.some(
            (agent) => agent.kind === input.harness && agent.login.state !== 'in',
          ),
        ) ?? authorized[0])
    if (!machine) throw new Error(`no online machine can run ${input.harness} login`)
    const refusal = this.deps.authorize(input.ownerUserId, machine.id)
    if (refusal) throw new Error(refusal)

    const spawned = this.deps.sessions.createSession({
      agentKind: 'shell',
      loginHarness: input.harness,
      cwd: this.deps.cwdForMachine(machine.id),
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
    this.attempts.set(input.harness, attempt)
    this.bySession.set(spawned.sessionId, input.harness)
    return attempt
  }

  private onExit(sessionId: SessionId, code: number): void {
    const harness = this.bySession.get(sessionId)
    if (!harness) return
    const attempt = this.attempts.get(harness)
    if (!attempt) return
    this.bySession.delete(sessionId)
    if (code !== 0) {
      this.attempts.set(harness, {
        ...attempt,
        status: 'failed',
        error: `login command exited ${code}`,
      })
      return
    }
    this.attempts.set(harness, { ...attempt, status: 'refreshing' })
    this.deps.machines.toMachine(attempt.machineId, { type: 'inventoryRequest' })
  }

  private onInventory(machineId: string): void {
    for (const [harness, attempt] of this.attempts) {
      if (attempt.machineId !== machineId || attempt.status !== 'refreshing') continue
      const machine = this.deps.machines.listMachines().find((row) => row.id === machineId)
      const login = machine?.inventory?.agents.find((agent) => agent.kind === harness)?.login
      if (login?.state === 'in') {
        this.attempts.set(harness, { ...attempt, status: 'succeeded' })
        this.required.delete(`${machineId}:${harness}`)
      } else {
        this.attempts.set(harness, {
          ...attempt,
          status: 'failed',
          error: 'login command finished but the refreshed inventory is still logged out',
        })
      }
    }
  }
}
