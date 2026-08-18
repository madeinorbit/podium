/**
 * SEEDING THE SUPERAGENT'S BACKEND FOR SOMEONE WHO HAS NEVER CHOSEN ONE
 * (POD-1313).
 *
 * `roles.superagent` resolves to `native:claude-code` when nobody has set it,
 * because `DEFAULT_ACCOUNT` has to name something. On a fleet without Claude
 * Code that default costs a new person their FIRST superagent turn: the spawn
 * refuses for a harness the machine does not carry, and nothing about the
 * failure points at Settings. This module replaces the guess with the fleet's
 * own answer as soon as an inventory says what the fleet carries.
 *
 * IT WRITES, RATHER THAN RESOLVING AT READ TIME. The alternative — teaching
 * `resolveRole` to fall back to an available harness — was rejected for the
 * reason `SuperagentService` records against its own model fall-through: a
 * silent resolution makes Settings display one backend while every turn runs
 * another, with no way for the person to tell which is real. A seeded value is
 * visible in Settings, editable like any other, and never applied twice.
 *
 * ONLY INTO EMPTINESS, AND LEAF BY LEAF. The seed runs when the person's
 * superagent account and harness are both unset — the documented "no opinion"
 * state — and even then it leaves a model or effort they have set. A choice that
 * happens to equal what we would have picked is still a choice, and the second
 * inventory report must not restate it.
 *
 * THE AVAILABILITY IT READS IS THE SPAWN PATH'S. `machinesForAgent` /
 * `harnessRejection` are the same predicates `resolveMachineForAgent` uses to
 * place a session, so a harness this seeds is a harness that path would accept.
 * A second, looser reading of `AgentInventory` here is exactly how a default
 * comes to name a harness the spawn then refuses.
 */
import { createLogger } from '@podium/logger'
import { type HandoffMachine, harnessRejection, machinesForAgent, type UserId } from '@podium/model'
import {
  type HarnessCandidate,
  type PodiumSettings,
  pickSuperagentDefault,
  SUPERAGENT_HARNESS_PRIORITY,
  superagentBackendIsUnset,
} from '@podium/runtime'

const log = createLogger('server:settings:superagent-default')

/**
 * What the fleet can run, per harness Podium is willing to pick.
 *
 * `installed` is the weaker reading (`harnessRejection` alone: the binary is
 * there, on any machine, online or not) and `loggedIn` the stronger one
 * (`machinesForAgent`: online, authorized, installed, and not reporting a
 * logged-out CLI). Both are computed because {@link pickSuperagentDefault}
 * prefers a demonstrably-ready harness but will still settle — see its own note
 * on why "installed but logged out" is not the same claim as "unusable".
 */
export function harnessCandidates(machines: HandoffMachine[]): HarnessCandidate[] {
  return SUPERAGENT_HARNESS_PRIORITY.map((harness) => ({
    harness,
    installed: machines.some((machine) => harnessRejection(machine, harness) === undefined),
    loggedIn: machinesForAgent(machines, harness).length > 0,
  }))
}

/** The narrow ports the seed needs, so it depends on neither store nor transport. */
export interface SuperagentDefaultSeederDeps {
  /** Everyone with an account row; each is seeded independently. */
  users(): UserId[]
  /** One person's resolved settings (their preference rows over the blob). */
  settingsFor(userId: UserId): PodiumSettings
  /** The machines to read availability from, already scoped to what may be used. */
  machines(): HandoffMachine[]
  /** `SettingsService.updatePreferences` — routes each leaf by tier and emits
   *  `settings.changed`, so a client with Settings open sees the seed land. */
  updatePreferences(userId: UserId, values: Record<string, unknown>): void
}

export class SuperagentDefaultSeeder {
  constructor(private readonly deps: SuperagentDefaultSeederDeps) {}

  /**
   * Seed everyone who has not chosen. Idempotent by construction: the write
   * fills the very fields the guard reads, so a second call is a no-op.
   *
   * Called on boot and again whenever a machine reports an inventory — a daemon
   * that connects after the server started is the ordinary case, and the whole
   * point is that the person does not have to be present for it.
   */
  seed(): void {
    const machines = this.deps.machines()
    if (machines.length === 0) return
    const pick = pickSuperagentDefault(harnessCandidates(machines))
    if (!pick) return
    for (const userId of this.deps.users()) {
      const backend = this.deps.settingsFor(userId).roles.superagent
      if (!superagentBackendIsUnset(backend)) continue
      const values: Record<string, unknown> = {
        'roles.superagent.accountId': pick.accountId,
        'roles.superagent.harness': pick.harness,
        // A model or effort set without an account is unusual but it is still
        // theirs; only the untouched sentinel is replaced.
        ...(backend.model === 'auto' ? { 'roles.superagent.model': pick.model } : {}),
        ...(backend.effort === 'auto' ? { 'roles.superagent.effort': pick.effort } : {}),
      }
      try {
        this.deps.updatePreferences(userId, values)
        log.info('seeded superagent default', { userId, harness: pick.harness, model: pick.model })
      } catch (err) {
        // A seed is a convenience; it must never take down the inventory report
        // (or the boot) that triggered it.
        log.warn('could not seed superagent default', { err, userId })
      }
    }
  }
}
