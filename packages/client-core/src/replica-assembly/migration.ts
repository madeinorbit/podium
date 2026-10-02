import {
  LEGACY_OUTBOX_AWAITING_KEY,
  LEGACY_OUTBOX_KEY,
  LEGACY_QUARANTINE_SUFFIX,
  type LegacyKeyValueStore,
  type LegacyMigrationOutcome,
} from '@podium/sync/adapters/legacy-replica'
import type { StorageApi } from '../replica/contract'

/** What the app is owed about a migration that ran — see `summarizeMigrations`. */
export interface OutboxMigrationSummary {
  readonly adopted: number
  readonly parked: number
  readonly quarantined: readonly string[]
  readonly rejected: number
  /** Absent when nothing happened; a sentence for the user when it did. */
  readonly notice?: string
}

/**
 * The two migration passes, as ONE thing to tell the user.
 *
 * ADR 6 D4.4's posture is that a degradation is explained, never silent, and
 * "some of your unsent work could not be carried across" is the sharpest form of
 * that. The three outcomes read differently on purpose: adopted work is now
 * drainable and needs no sentence of its own beyond the count; PARKED work is
 * visible in the dead-letter recovery surface; QUARANTINED work is neither — it
 * is on disk under `<key>.unmigrated` and no build reads it, so the sentence has
 * to say that rather than imply a queue will get to it.
 */
export function summarizeMigrations(
  outcomes: readonly LegacyMigrationOutcome[],
): OutboxMigrationSummary {
  const adopted = outcomes.reduce((n, o) => n + o.adopted, 0)
  const parked = outcomes.reduce((n, o) => n + o.parked, 0)
  const rejected = outcomes.reduce((n, o) => n + o.rejected.length, 0)
  const quarantined = outcomes.flatMap((o) => [...o.quarantined])
  const parts: string[] = []
  if (adopted > 0) parts.push(`${adopted} queued ${plural(adopted)} moved to secure storage`)
  if (parked > 0)
    parts.push(
      `${parked} could not be attributed to this account and ${wasWere(parked)} parked for review`,
    )
  if (rejected > 0) {
    parts.push(
      `${rejected} could not be matched to a known action and ${wasWere(rejected)} kept on this device unsent`,
    )
  }
  if (outcomes.some((outcome) => outcome.keysLeftBehind.length > 0)) {
    parts.push(
      'older queued changes remain on this device and will be checked again at the next start',
    )
  }
  return {
    adopted,
    parked,
    rejected,
    quarantined,
    ...(parts.length === 0 ? {} : { notice: `${parts.join('; ')}.` }),
  }
}

const plural = (n: number): string => (n === 1 ? 'change' : 'changes')
const wasWere = (n: number): string => (n === 1 ? 'was' : 'were')

/**
 * The side-cache queue keys, presented UNDER THE LEGACY NAMES the importer scans.
 *
 * A shipped kernel build folded the pre-kernel localStorage queue into
 * `<principal-prefix>.outbox.v1` and `.outbox-awaiting.v1` — the same blob shape
 * (a JSON array of entries), a different address. Rather than teach the importer a
 * second key inventory, the addresses are translated here: the importer keeps ONE
 * key set, and the sequencing rule it enforces (retire only after a durable commit)
 * applies to these keys unchanged, because they are retired through this same map.
 *
 * Keys it does not translate read as ABSENT, deliberately: this pass must not see
 * entity rows, a cursor or the standalone pre-replica blob — the raw pass already
 * owns those, and a second importer touching them would retire keys whose entries
 * the first one is responsible for.
 */
export function sideCacheQueueAsLegacy(
  storage: StorageApi,
  keyPrefix: string,
): LegacyKeyValueStore {
  const map = new Map<string, string>([
    [LEGACY_OUTBOX_KEY, `${keyPrefix}.outbox.v1`],
    [LEGACY_OUTBOX_AWAITING_KEY, `${keyPrefix}.outbox-awaiting.v1`],
  ])
  /** Quarantine writes land beside the key they preserve, on the side-cache
   *  address — otherwise the copy would be written to a legacy name that this
   *  device may not even have, and the evidence would be filed under someone
   *  else's key. */
  const translate = (key: string): string | undefined => {
    const direct = map.get(key)
    if (direct !== undefined) return direct
    if (!key.endsWith(LEGACY_QUARANTINE_SUFFIX)) return undefined
    const base = map.get(key.slice(0, -LEGACY_QUARANTINE_SUFFIX.length))
    return base === undefined ? undefined : `${base}${LEGACY_QUARANTINE_SUFFIX}`
  }
  return {
    getItem: (key) => {
      const at = translate(key)
      if (at === undefined) return null
      try {
        return storage.getItem(at)
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      const at = translate(key)
      // A write with nowhere to go must THROW, not succeed silently: the caller
      // treats a failed quarantine as "leave the original in place", and a
      // no-op that reported success would delete it.
      if (at === undefined) throw new Error(`no side-cache address for ${key}`)
      storage.setItem(at, value)
    },
    removeItem: (key) => {
      const at = translate(key)
      if (at === undefined) return
      storage.removeItem(at)
    },
  }
}
