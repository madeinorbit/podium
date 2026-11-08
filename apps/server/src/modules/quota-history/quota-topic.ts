/**
 * `account.quota` and `account.usage` — server-produced value topics (ADR 7
 * Amendment 2 D26, POD-5798): one account's plan quota, and its token usage,
 * pushed instead of the clients' 60 s `quota.summary` and 90 s `usage.summary`
 * polls.
 *
 * WHO HOLDS WHAT. A client holds `account.quota` for as long as the app is
 * open (the header shows it). It holds `account.usage` only while a usage
 * reader is on screen (the usage sheet, the status strip's burn rate, the
 * phone's Pulse), because each usage read is a transcript harvest on a daemon.
 * With no holder of a key, its producer does nothing at all.
 *
 * WHERE THE NUMBERS COME FROM.
 * - Quota: the existing sampler (`QuotaSampler`), so there is still exactly
 *   one quota path to the daemons. With nobody holding a quota key, only the
 *   sampler's own 15-minute timer runs, as before. While one is held, a live
 *   pass runs every {@link ACCOUNT_LIVE_INTERVAL_MS}: one sampler pass (the
 *   fan-out, folded into the ledger), then each holder's custody filter.
 * - Usage: `readUsageSummary` for each holder, the same read `usage.summary`
 *   serves (and the same per-task cost fold), on the same cadence.
 * Both daemon reads are memoised on the daemon (quota for 120 s), which is
 * what bounds the cost to providers, as it bounded the polls this replaces.
 *
 * WHAT IS KEPT. Only the value last sent to each held account, so a second
 * subscriber gets a snapshot at once. That is the producer's current reading
 * (connection-like state, nothing a table holds) and it is dropped on the
 * key's last unsubscribe. A key nobody has been sent a value for yet answers
 * `unknown`, and the pass that `start` runs fills it.
 *
 * WHOSE QUOTA. A machine's plan quota belongs to its custodian (POD-6300): an
 * account is sent only the machines in its custody, as `quota.summary` does.
 */

import type { MachineQuotaWire, UserId } from '@podium/model'
import type { AccountQuotaPayload, AccountUsagePayload } from '@podium/protocol'

/** The holders' cadence: the old header poll's 60 s, bounded below by the daemons' memos. */
export const ACCOUNT_LIVE_INTERVAL_MS = 60_000

/**
 * The shared mechanism: accounts that hold the key, a live pass every
 * interval while any does, and the newest value per account (dropped with its
 * last holder). A subclass says how one pass reads its values.
 */
abstract class HeldAccountTopic<V> {
  private readonly held = new Set<UserId>()
  private readonly latest = new Map<UserId, { pass: number; value: V; json: string }>()
  private timer: ReturnType<typeof setInterval> | undefined
  /** Increases per pass; a slower, older pass never overwrites a newer one's value. */
  private passes = 0
  private disposed = false

  constructor(
    private readonly publish: (user: UserId, value: V) => void,
    private readonly intervalMs: number,
  ) {}

  /** Read this pass's values, one per account still listed; skip an account by leaving it out. */
  protected abstract read(users: readonly UserId[]): Promise<ReadonlyMap<UserId, V> | undefined>

  /** The value last sent to this account, or undefined (`unknown`) before the first. */
  snapshot(user: UserId): V | undefined {
    return this.latest.get(user)?.value
  }

  /** First subscriber for this account (the routing's 0 → 1). */
  start(user: UserId): void {
    if (this.disposed) return
    this.held.add(user)
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.pass(), this.intervalMs)
      this.timer.unref?.()
    }
    void this.pass([user])
  }

  /** Last subscriber gone (1 → 0): forget the value; with no holder left, stop the live passes. */
  stop(user: UserId): void {
    this.held.delete(user)
    this.latest.delete(user)
    if (this.held.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  get holders(): number {
    return this.held.size
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.held.clear()
    this.latest.clear()
  }

  /**
   * One live pass for these holders (all of them by default). Never throws: a
   * failed read leaves each holder's last value in place (the next pass or a
   * resubscribe repairs it).
   */
  async pass(users: readonly UserId[] = [...this.held]): Promise<void> {
    if (this.disposed || users.length === 0) return
    const pass = ++this.passes
    let values: ReadonlyMap<UserId, V> | undefined
    try {
      values = await this.read(users.filter((user) => this.held.has(user)))
    } catch {
      values = undefined
    }
    if (!values || this.disposed) return
    for (const [user, value] of values) {
      if (!this.held.has(user)) continue
      const held = this.latest.get(user)
      if (held && held.pass > pass) continue
      const json = JSON.stringify(value)
      // Value style: an identical reading is not news, and sending it would
      // spend a position and a redraw on every holder for nothing.
      if (held?.json === json) {
        held.pass = pass
        continue
      }
      this.latest.set(user, { pass, value, json })
      this.publish(user, value)
    }
  }
}

export interface AccountQuotaTopicDeps {
  /** One sampler pass (fan-out + ledger fold). Undefined when the read failed. */
  readonly sample: () => Promise<MachineQuotaWire[] | undefined>
  /** The machine's custodian, or null when nobody looks after it. */
  readonly custodian: (machineId: string) => Promise<UserId | null>
  /** Hand the newest value to the topic routing. */
  readonly publish: (user: UserId, value: AccountQuotaPayload) => void
  readonly liveIntervalMs?: number
}

export class AccountQuotaTopic extends HeldAccountTopic<AccountQuotaPayload> {
  constructor(private readonly deps: AccountQuotaTopicDeps) {
    super(deps.publish, deps.liveIntervalMs ?? ACCOUNT_LIVE_INTERVAL_MS)
  }

  protected async read(
    users: readonly UserId[],
  ): Promise<ReadonlyMap<UserId, AccountQuotaPayload> | undefined> {
    if (users.length === 0) return undefined
    const machines = await this.deps.sample()
    if (machines === undefined) return undefined
    const custodians = new Map<string, Promise<UserId | null>>()
    const owners = await Promise.all(
      machines.map((machine) => {
        let known = custodians.get(machine.machineId)
        if (!known) {
          known = this.deps.custodian(machine.machineId).catch(() => null)
          custodians.set(machine.machineId, known)
        }
        return known
      }),
    )
    return new Map(
      users.map((user) => [
        user,
        { machines: machines.filter((_, index) => owners[index] === user) },
      ]),
    )
  }
}

export interface AccountUsageTopicDeps {
  /** This account's usage; null when no machine may answer for it or the scan failed. */
  readonly readUsage: (user: UserId) => Promise<AccountUsagePayload>
  /** Hand the newest value to the topic routing. */
  readonly publish: (user: UserId, value: AccountUsagePayload) => void
  readonly liveIntervalMs?: number
}

export class AccountUsageTopic extends HeldAccountTopic<AccountUsagePayload> {
  constructor(private readonly deps: AccountUsageTopicDeps) {
    super(deps.publish, deps.liveIntervalMs ?? ACCOUNT_LIVE_INTERVAL_MS)
  }

  protected async read(
    users: readonly UserId[],
  ): Promise<ReadonlyMap<UserId, AccountUsagePayload>> {
    const values = await Promise.all(
      users.map(async (user) => [user, await this.deps.readUsage(user).catch(() => null)] as const),
    )
    return new Map(values)
  }
}
