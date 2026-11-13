import {
  harnessPortableCredential,
  harnessSupportsCredentialPropagation,
} from '@podium/harness/metadata'
import { createLogger, describeError } from '@podium/logger'
import type { AgentKind, HarnessAgent, Inventory, MachineId, UserId } from '@podium/model'
import { HOST_REPOS } from '@podium/model'
import { CAP_CREDENTIAL_IDENTITY_GUARD, type PortableCredentialBundle } from '@podium/protocol'
import { buildLoginCatalog, catalogEntriesForHarness } from '../../login-catalog'
import type { SessionStore } from '../../store'
import type { NativeLoginOptIn } from '../../store/accounts'
import type { DaemonRpcService } from './rpc'
import type { MachinesService } from './service'

const log = createLogger('server:machines')

export const LOGIN_PROPAGATION_MAX_ATTEMPTS = 3
export const LOGIN_PROPAGATION_INITIAL_BACKOFF_MS = 1_000
/**
 * How long exported login bytes may wait before they are installed. An older
 * transfer is stale and refused: the owner's choice, custody or the logins on
 * either machine may have changed since it was read.
 */
export const LOGIN_TRANSFER_MAX_AGE_MS = 30_000

/**
 * Static approximation of "may propagate". The RUNTIME guard
 * (`harnessSupportsCredentialPropagation`, read off the adapter registry)
 * decides — a harness whose credentials section declares no propagatable file
 * can never pass it, so the wider static member is unreachable, not
 * propagatable. Written as an `Extract` over the portable bundle kinds so this
 * module never names a harness of its own.
 */
type PropagatableHarness = Extract<PortableCredentialBundle['kind'], HarnessAgent>

export interface LoginPropagationTrigger {
  targetMachineId: MachineId
  agentKind: AgentKind
  /** The server principal that owns the target machine/session. */
  principalUserId?: UserId
  /** Copy without an observed logout: enrollment, a fresh tick, harness-error retry. */
  force?: boolean
  /** Refresh the same account already there (a harness-error retry). */
  refresh?: boolean
  /** Copy only this ticked login (the one just ticked). */
  fingerprint?: string
}

export type LoginPropagationResult =
  | { status: 'propagated'; donorMachineId: MachineId; fingerprint: string }
  /** The target holds a different login, which stays; nothing was copied. */
  | { status: 'preserved'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; upgradeRequired?: true }

interface AttemptState {
  attempts: number
  nextAttemptAt: number
  inFlight: boolean
}

interface LoginPropagationDeps {
  store: SessionStore
  machines: Pick<MachinesService, 'hasDaemon' | 'capabilityRejection' | 'daemonSupports'>
  rpc: Pick<DaemonRpcService, 'credentialExport' | 'credentialInstall'>
  now?: () => number
}

function propagationKey(input: LoginPropagationTrigger, ownerUserId: UserId): string {
  return ownerUserId + ':' + input.targetMachineId + ':' + input.agentKind
}

/**
 * Server-owned coordinator for native login bytes. The only raw bundle lifetime
 * here is the export → server-secret row → install turn; no client projection
 * or replicated settings path receives it.
 *
 * WHAT IS COPIED, AND WHERE (POD-6301; design §2.5, D11; September addendum
 * §4-5). Only a login its owner ticked ("use this connection on all machines I
 * hold custody of, now and in future"), only between machines in that owner's
 * custody, and only as that one account:
 *
 * - The target's custodian is the owner. Another member's machine, or one the
 *   owner only holds `use` on, never receives a copy.
 * - A target that keeps its own logins (`podiumManaged === false`) never
 *   receives a copy, even when its custodian ticked the donor login.
 * - Export and install each re-read custody and the owner's choice. Export asks
 *   the donor for that account by fingerprint, so a donor whose login changed
 *   since exports nothing; install asks the target to keep any login of a
 *   different or unknown identity, which is then reported as `preserved`.
 * - A transfer whose choice or target custody changed after export, or older
 *   than {@link LOGIN_TRANSFER_MAX_AGE_MS}, is stale and refused.
 * - Several ticked logins that fit one harness are not chosen between.
 */
export class LoginPropagationService {
  private readonly attempts = new Map<string, AttemptState>()
  private readonly now: () => number

  constructor(private readonly deps: LoginPropagationDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Fire-and-forget trigger used by spawn, harness failure, enrollment and a tick. */
  async trigger(input: LoginPropagationTrigger): Promise<void> {
    void this.propagate(input)
      .then((result) => {
        if (result.status === 'failed')
          log.warn('login propagation refused', {
            reason: result.reason,
            targetMachineId: input.targetMachineId,
            agentKind: input.agentKind,
          })
      })
      .catch((error: unknown) => {
        log.warn('login propagation failed', {
          err: error,
          targetMachineId: input.targetMachineId,
          agentKind: input.agentKind,
        })
      })
  }

  /** Public for focused tests and for callers that need the settled outcome. */
  async propagate(input: LoginPropagationTrigger): Promise<LoginPropagationResult> {
    const harness = harnessSupportsCredentialPropagation(input.agentKind)
      ? input.agentKind
      : undefined
    if (!harness) return { status: 'skipped', reason: 'harness does not support propagation' }

    const target = await this.deps.store.machines.getMachine(input.targetMachineId)
    const ownerUserId =
      (await this.deps.store.machines.custodian(input.targetMachineId)) ?? undefined
    if (!target || target.revokedAt || !ownerUserId) {
      return { status: 'skipped', reason: 'target has no owner' }
    }
    if (target.podiumManaged === false) {
      return { status: 'skipped', reason: 'target keeps its own logins' }
    }
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
        reason: describeError(error),
      }
    }

    const current = this.attempts.get(key)
    // Feature refusal makes no transfer attempt. A newly upgraded live peer
    // must work on the next trigger, without an old refusal's retry budget.
    if (result.status !== 'failed' || result.upgradeRequired) {
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

  /** Is the owner's choice for this login still the ticked one read earlier? */
  private async stillTicked(ownerUserId: UserId, chosen: NativeLoginOptIn): Promise<boolean> {
    const fresh = await this.deps.store.accounts.optInFor(
      ownerUserId,
      chosen.harness,
      chosen.fingerprint,
    )
    return fresh?.enabled === true && fresh.revision === chosen.revision
  }

  private async record(
    ownerUserId: UserId,
    chosen: NativeLoginOptIn,
    machineId: MachineId,
    outcome: 'installed' | 'preserved',
  ): Promise<void> {
    await this.deps.store.accounts.recordTransfer(ownerUserId, {
      harness: chosen.harness,
      fingerprint: chosen.fingerprint,
      machineId,
      outcome,
      revision: chosen.revision,
      at: new Date(this.now()).toISOString(),
    })
  }

  private async run(input: {
    input: LoginPropagationTrigger
    harness: PropagatableHarness
    ownerUserId: UserId
    targetInventory: Inventory | undefined
  }): Promise<LoginPropagationResult> {
    const portable = harnessPortableCredential(input.harness)
    if (!portable) {
      return { status: 'skipped', reason: 'harness has no portable credential declaration' }
    }
    const targetId = input.input.targetMachineId
    if (!this.deps.machines.hasDaemon(targetId)) {
      // POD-2700: the live check below is already the STRONGER one (a live socket
      // implies an enrolled daemon), so nothing about who is eligible changes
      // here. What changes is the WORD: a machine that runs no daemon was being
      // reported as "offline", which reads as "try again later" for a state that
      // never resolves. The `use` and liveness axes stay exactly where they are.
      return {
        status: 'skipped',
        reason:
          (await this.deps.machines.capabilityRejection(targetId, HOST_REPOS)) === 'no-daemon'
            ? 'target runs no Podium daemon'
            : 'target is offline',
      }
    }

    // THE OWNER'S TICKED LOGINS for this harness. Nothing ticked, nothing copied.
    const ticked = (await this.deps.store.accounts.optInsFor(input.ownerUserId)).filter(
      (choice) =>
        choice.enabled &&
        choice.harness === input.harness &&
        (input.input.fingerprint === undefined || choice.fingerprint === input.input.fingerprint),
    )
    if (ticked.length === 0) {
      return { status: 'skipped', reason: 'no login is ticked for use on all your machines' }
    }

    // WHAT THE TARGET HOLDS NOW. A login of another or unknown identity stays.
    const targetLogin = input.targetInventory?.agents.find(
      (agent) => agent.kind === input.harness,
    )?.login
    let wanted = ticked
    if (targetLogin?.state === 'in') {
      const targetFingerprint = targetLogin.identity?.fingerprint
      const same = ticked.filter((choice) => choice.fingerprint === targetFingerprint)
      if (same.length === 0) {
        for (const choice of ticked) {
          await this.record(input.ownerUserId, choice, targetId, 'preserved')
        }
        return {
          status: 'preserved',
          reason: targetFingerprint
            ? 'the target is signed in to a different account, which was kept'
            : 'the target is signed in to an account Podium cannot identify, which was kept',
        }
      }
      // The same account is already there: reuse it, or refresh it on a retry.
      if (!input.input.refresh) {
        return { status: 'skipped', reason: 'the same account is already installed' }
      }
      wanted = same
    } else if (!input.input.force && targetLogin?.state !== 'out') {
      return { status: 'skipped', reason: 'target is not observed logged out' }
    }

    // DONORS: the owner's other custody machines, online, holding a ticked login.
    const custody = await this.deps.store.machines.custodyMachineIds(input.ownerUserId)
    if (!custody.includes(targetId)) return { status: 'skipped', reason: 'target owner changed' }
    const donorIds = new Set(
      custody.filter((id) => id !== targetId && this.deps.machines.hasDaemon(id)),
    )
    const catalog = buildLoginCatalog([
      ...(await this.deps.store.machines.getMachines([...donorIds])).values(),
    ])
    const entries = catalogEntriesForHarness(catalog, input.harness)
    const donorFor = (fingerprint: string): MachineId | undefined =>
      entries
        .find((entry) => entry.fingerprint === fingerprint)
        ?.machines.find(
          (machine) => machine.harness === input.harness && donorIds.has(machine.machineId),
        )?.machineId
    const fits = wanted.flatMap((choice) => {
      const donor = donorFor(choice.fingerprint)
      return donor ? [{ choice, donor }] : []
    })
    const [fit, ...more] = fits
    if (!fit) return { status: 'failed', reason: 'no online donor login found' }
    if (more.length > 0) {
      return {
        status: 'skipped',
        reason: 'several ticked logins fit this machine; Podium does not choose between accounts',
      }
    }
    const { choice, donor } = fit

    // EXPORT, after re-reading the donor's custody and the owner's choice. The
    // donor exports only if its login is still that account.
    if ((await this.deps.store.machines.custodian(donor)) !== input.ownerUserId) {
      return { status: 'skipped', reason: 'donor owner changed' }
    }
    if (!(await this.stillTicked(input.ownerUserId, choice))) {
      return { status: 'skipped', reason: 'the login was unticked' }
    }
    const kind = input.harness
    if (!this.deps.machines.daemonSupports(donor, CAP_CREDENTIAL_IDENTITY_GUARD)) {
      return {
        status: 'failed',
        reason: `Upgrade the donor daemon on ${donor} before copying a login: it cannot verify the selected account.`,
        upgradeRequired: true,
      }
    }
    if (!this.deps.machines.daemonSupports(targetId, CAP_CREDENTIAL_IDENTITY_GUARD)) {
      return {
        status: 'failed',
        reason: `Upgrade the target daemon on ${targetId} before copying a login: it cannot preserve a different installed account.`,
        upgradeRequired: true,
      }
    }
    // The transfer's age counts from the choice it was read under.
    const readAt = this.now()
    const exported = await this.deps.rpc.credentialExport([kind], donor, {
      propagation: true,
      expectedFingerprint: choice.fingerprint,
    })
    const bundle = exported.bundles.find((candidate) => candidate.kind === kind)
    if (!bundle) return { status: 'failed', reason: 'donor credential unavailable' }

    const transferId = await this.deps.store.secrets.putNativeLoginTransfer(
      input.ownerUserId,
      bundle,
      new Date(this.now()).toISOString(),
    )
    try {
      // INSTALL, after re-reading the owner's choice and the target's custody.
      // A transfer that outlived either, or its age limit, is stale.
      if (this.now() - readAt > LOGIN_TRANSFER_MAX_AGE_MS) {
        return { status: 'skipped', reason: 'stale transfer refused: it waited too long' }
      }
      if (!(await this.stillTicked(input.ownerUserId, choice))) {
        return { status: 'skipped', reason: 'stale transfer refused: the choice changed' }
      }
      if ((await this.deps.store.machines.custodian(targetId)) !== input.ownerUserId) {
        return { status: 'skipped', reason: 'stale transfer refused: the target owner changed' }
      }
      if ((await this.deps.store.machines.getMachine(targetId))?.podiumManaged === false) {
        return { status: 'skipped', reason: 'stale transfer refused: target keeps its own logins' }
      }
      const serverBundle = await this.deps.store.secrets.getNativeLoginTransfer(
        input.ownerUserId,
        transferId,
      )
      if (!serverBundle) return { status: 'failed', reason: 'transfer secret unavailable' }
      // A reconnect during export may have replaced the capable target with an
      // older daemon. Recheck the live socket immediately before installation.
      if (!this.deps.machines.daemonSupports(targetId, CAP_CREDENTIAL_IDENTITY_GUARD)) {
        return {
          status: 'failed',
          reason: `Upgrade the target daemon on ${targetId} before copying a login: it cannot preserve a different installed account.`,
          upgradeRequired: true,
        }
      }
      const installed = await this.deps.rpc.credentialInstall([serverBundle], targetId, {
        propagation: true,
        expectedFingerprint: choice.fingerprint,
      })
      if (installed.preserved?.includes(kind)) {
        await this.record(input.ownerUserId, choice, targetId, 'preserved')
        return { status: 'preserved', reason: 'the target holds a different login, which was kept' }
      }
      if (!installed.installed.includes(kind)) {
        return { status: 'failed', reason: 'target refused credential propagation' }
      }
      await this.record(input.ownerUserId, choice, targetId, 'installed')
      return { status: 'propagated', donorMachineId: donor, fingerprint: choice.fingerprint }
    } finally {
      await this.deps.store.secrets.clearNativeLoginTransfer(input.ownerUserId, transferId)
    }
  }
}
