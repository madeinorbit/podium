/**
 * TESTS AND HARNESSES ONLY: a LiveStore bound to a pool, with setters for its
 * readings (POD-5798). Production readings come from the live feed; a fixture
 * writes them directly, through the same `applyTopic` the feed uses.
 */
import {
  type ConnectionCondition,
  knownReading,
  LiveStore,
  type OutboxCondition,
  unknownReading,
} from '@podium/client-core/live'
import type { HostMetricsWire, MachineFacts } from '@podium/model'
import type {
  AccountQuotaPayload,
  AccountUsagePayload,
  MachineConditionPayload,
} from '@podium/protocol'
import { runInAction } from 'mobx'
import type { MobxPool } from './pool'

export interface LiveFixture {
  readonly live: LiveStore
  /** A machine's host sample (undefined: no reading). */
  metric(machineId: string, sample: HostMetricsWire | undefined): void
  /** A machine's online condition (undefined: unknown). */
  online(machineId: string, online: boolean | undefined, since?: string | null): void
  /** A machine's whole condition: online and its presence facts (undefined: unknown). */
  condition(machineId: string, value: MachineConditionPayload | undefined): void
  quota(value: AccountQuotaPayload | undefined): void
  /** This account's usage (null: the server answered without usage; undefined: unknown). */
  usage(value: AccountUsagePayload | undefined): void
  outbox(next: OutboxCondition): void
  connection(next: ConnectionCondition): void
}

export function liveFixture(pool: MobxPool, now: () => number = () => Date.now()): LiveFixture {
  const live = pool.live ?? new LiveStore({ now })
  if (!pool.live) pool.bindLive(live)
  return {
    live,
    metric: (machineId, sample) =>
      runInAction(() =>
        live.applyTopic(
          'machine.metrics',
          machineId,
          sample ? knownReading(sample, now()) : undefined,
        ),
      ),
    online: (machineId, online, since = null) =>
      runInAction(() =>
        live.applyTopic(
          'machine.condition',
          machineId,
          online === undefined ? unknownReading(now()) : knownReading({ online, since }, now()),
        ),
      ),
    condition: (machineId, value) =>
      runInAction(() =>
        live.applyTopic(
          'machine.condition',
          machineId,
          value === undefined ? unknownReading(now()) : knownReading(value, now()),
        ),
      ),
    quota: (value) =>
      runInAction(() =>
        live.applyTopic(
          'account.quota',
          'me',
          value ? knownReading(value, now()) : unknownReading(now()),
        ),
      ),
    usage: (value) =>
      runInAction(() =>
        live.applyTopic(
          'account.usage',
          'me',
          value === undefined ? unknownReading(now()) : knownReading(value, now()),
        ),
      ),
    outbox: (next) => live.setOutbox(next),
    connection: (next) => live.setConnection(next),
  }
}

/**
 * TESTS ONLY: seed machines given in the shape a test writes them (a listing
 * with `online` and presence facts) as the app now receives them (POD-6644):
 * a record row the pool holds (the machine joined with my access row; `use`
 * defaults to granted, so it is in my fleet) and the live condition beside it.
 * Answers the rows, for a fixture that installs them itself.
 */
export function seedFixtureMachines(
  pool: MobxPool,
  machines: readonly MachineFacts[],
): { kind: 'machine'; id: string; value: Record<string, unknown> }[] {
  const live = liveFixture(pool)
  return machines.map((machine) => {
    const {
      online,
      lastSeenAt,
      presenceSource,
      availability,
      daemonReadiness,
      serverMoveEligibility: _eligibility,
      ...record
    } = machine as MachineFacts & Record<string, unknown>
    live.condition(String(machine.id), {
      online,
      since: null,
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      ...(presenceSource !== undefined ? { presenceSource } : {}),
      ...(availability !== undefined ? { availability } : {}),
      ...(daemonReadiness !== undefined ? { daemonReadiness } : {}),
    } as MachineConditionPayload)
    return {
      kind: 'machine' as const,
      id: String(machine.id),
      value: { loggedOutHarnesses: [], use: 'granted', ...record },
    }
  })
}
