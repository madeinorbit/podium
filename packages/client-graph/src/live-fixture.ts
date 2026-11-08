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
import type { HostMetricsWire } from '@podium/model'
import type { AccountQuotaPayload, AccountUsagePayload } from '@podium/protocol'
import { runInAction } from 'mobx'
import type { MobxPool } from './pool'

export interface LiveFixture {
  readonly live: LiveStore
  /** A machine's host sample (undefined: no reading). */
  metric(machineId: string, sample: HostMetricsWire | undefined): void
  /** A machine's online condition (undefined: unknown). */
  online(machineId: string, online: boolean | undefined, since?: string | null): void
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
