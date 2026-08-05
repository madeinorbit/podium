import { declaredValue, manifestFor } from '@podium/harness'
import type { AgentKind, HarnessAgent } from '@podium/model'
import type { PortableCredentialBundle } from '@podium/protocol'
import { buildLoginCatalog, catalogEntriesForHarness } from '../../login-catalog'
import type { SessionStore } from '../../store'
import type { DaemonRpcService } from './rpc'
import type { MachinesService } from './service'

export const LOGIN_PROPAGATION_MAX_ATTEMPTS = 3
export const LOGIN_PROPAGATION_INITIAL_BACKOFF_MS = 1_000

type PropagatableHarness = Extract<HarnessAgent, 'claude-code' | 'codex'>

export interface LoginPropagationTrigger {
  targetMachineId: string
  agentKind: AgentKind
  /** The server principal that owns the target machine/session. */
  principalUserId?: string
  /** Used only for the explicit enrollment relay and harness-error retry. */
  force?: boolean
}

export type LoginPropagationResult =
  | { status: 'propagated'; donorMachineId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

interface AttemptState {
  attempts: number
  nextAttemptAt: number
  inFlight: boolean
}

interface LoginPropagationDeps {
  store: SessionStore
  machines: Pick<MachinesService, 'hasDaemon'>
  rpc: Pick<DaemonRpcService, 'credentialExport' | 'credentialInstall'>
  now?: () => number
}

function propagatableHarness(agentKind: AgentKind): PropagatableHarness | undefined {
  return agentKind === 'claude-code' || agentKind === 'codex' ? agentKind : undefined
}

function propagationKey(input: LoginPropagationTrigger, ownerUserId: string): string {
  return ownerUserId + ':' + input.targetMachineId + ':' + input.agentKind
}

/**
 * Server-owned coordinator for native login bytes. The only raw bundle lifetime
 * here is the export → server-secret row → install turn; no client projection
 * or replicated settings path receives it.
 */
export class LoginPropagationService {
  private readonly attempts = new Map<string, AttemptState>()
  private readonly now: () => number

  constructor(private readonly deps: LoginPropagationDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Fire-and-forget trigger used by spawn, harness failure, and enrollment. */
  trigger(input: LoginPropagationTrigger): void {
    void this.propagate(input).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[podium] login propagation failed for ${input.targetMachineId}/${input.agentKind}: ${message}`,
      )
    })
  }

  /** Public for focused tests and for callers that need the settled outcome. */
  async propagate(input: LoginPropagationTrigger): Promise<LoginPropagationResult> {
    const harness = propagatableHarness(input.agentKind)
    if (!harness) return { status: 'skipped', reason: 'harness does not support propagation' }

    const target = this.deps.store.machines.getMachine(input.targetMachineId)
    const ownerUserId = target?.ownerUserId ?? undefined
    if (!target || !ownerUserId) return { status: 'skipped', reason: 'target has no owner' }
    if (input.principalUserId && input.principalUserId !== ownerUserId) {
      return { status: 'skipped', reason: 'target owner does not match principal' }
    }

    const key = propagationKey(input, ownerUserId)
    const state = this.attempts.get(key)
    const now = this.now()
    if (state?.inFlight) return { status: 'skipped', reason: 'propagation already running' }
    if (state && state.attempts >= LOGIN_PROPAGATION_MAX_ATTEMPTS) {
      return { status: 'skipped', reason: 'propagation attempt cap reached' }
    }
    if (state && state.nextAttemptAt > now) {
      return { status: 'skipped', reason: 'propagation backoff active' }
    }
    this.attempts.set(key, {
      attempts: state?.attempts ?? 0,
      nextAttemptAt: now,
      inFlight: true,
    })

    let result: LoginPropagationResult
    try {
      result = await this.run({
        input,
        harness,
        ownerUserId,
        targetInventory: target.inventory,
      })
    } catch (error: unknown) {
      result = {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    const current = this.attempts.get(key)
    if (result.status === 'propagated' || result.status === 'skipped') {
      this.attempts.delete(key)
    } else if (current) {
      const attempts = current.attempts + 1
      this.attempts.set(key, {
        attempts,
        nextAttemptAt:
          this.now() + LOGIN_PROPAGATION_INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
        inFlight: false,
      })
    }
    return result
  }

  private async run(input: {
    input: LoginPropagationTrigger
    harness: PropagatableHarness
    ownerUserId: string
    targetInventory: import('@podium/model').Inventory | undefined
  }): Promise<LoginPropagationResult> {
    const manifest = manifestFor(input.harness)
    const portable = manifest?.inventory.portableCredential
    if (!portable || !declaredValue(portable)) {
      return { status: 'skipped', reason: 'harness has no portable credential declaration' }
    }
    if (!this.deps.machines.hasDaemon(input.input.targetMachineId)) {
      return { status: 'skipped', reason: 'target is offline' }
    }

    const targetAgent = input.targetInventory?.agents.find(
      (agent) => agent.kind === input.harness,
    )
    if (!input.input.force && targetAgent?.login.state !== 'out') {
      return { status: 'skipped', reason: 'target is not observed logged out' }
    }

    const catalog = buildLoginCatalog(this.deps.store.machines.listMachines())
    const entry = catalogEntriesForHarness(catalog, input.harness).find((candidate) =>
      candidate.machines.some(
        (machine) =>
          machine.harness === input.harness &&
          machine.machineId !== input.input.targetMachineId &&
          this.deps.machines.hasDaemon(machine.machineId) &&
          this.deps.store.machines.getMachine(machine.machineId)?.ownerUserId ===
            input.ownerUserId,
      ),
    )
    if (!entry) return { status: 'failed', reason: 'no online donor login found' }

    const donor = entry.machines.find(
      (machine) =>
        machine.harness === input.harness &&
        machine.machineId !== input.input.targetMachineId &&
        this.deps.machines.hasDaemon(machine.machineId) &&
        this.deps.store.machines.getMachine(machine.machineId)?.ownerUserId ===
          input.ownerUserId,
    )
    if (!donor) return { status: 'failed', reason: 'no online donor login found' }

    const kind = input.harness as PortableCredentialBundle['kind']
    const exported = await this.deps.rpc.credentialExport([kind], donor.machineId, {
      propagation: true,
    })
    const bundle = exported.bundles.find((candidate) => candidate.kind === kind)
    if (!bundle) return { status: 'failed', reason: 'donor credential unavailable' }

    const transferId = this.deps.store.secrets.putNativeLoginTransfer(
      input.ownerUserId,
      bundle,
      new Date(this.now()).toISOString(),
    )
    try {
      const serverBundle = this.deps.store.secrets.getNativeLoginTransfer(
        input.ownerUserId,
        transferId,
      )
      if (!serverBundle) return { status: 'failed', reason: 'transfer secret unavailable' }
      const installed = await this.deps.rpc.credentialInstall(
        [serverBundle],
        input.input.targetMachineId,
        { propagation: true },
      )
      if (!installed.installed.includes(kind)) {
        return { status: 'failed', reason: 'target refused credential propagation' }
      }
      return { status: 'propagated', donorMachineId: donor.machineId }
    } finally {
      this.deps.store.secrets.clearNativeLoginTransfer(input.ownerUserId, transferId)
    }
  }
}
