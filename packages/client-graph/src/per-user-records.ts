/**
 * MY PER-USER RECORDS IN THE POOL (POD-6673): the reads screens share.
 *
 * Pins and personal settings are synced records the feed delivers to their
 * owner only, so every `pin` row in the pool is mine and the one
 * `userPreferences` row is mine. Each read below is tracked: a pin made on my
 * other device, or a setting changed there, moves it without a request.
 */

import type { PinKind } from '@podium/model'
import { compareShallow, computed, type IComputedValue } from 'mobx'
import { here } from './lookup'
import type { UserPreferencesModel } from './models'
import type { MobxPool, PoolRows } from './pool'

const NONE: readonly string[] = Object.freeze([])

type PinReads = Readonly<Record<PinKind, IComputedValue<readonly string[]>>>

/** One list per pin kind, kept equal by value so a reader's layout keeps its
 *  identity while my pins do not change. */
function pinReads(pool: Pick<MobxPool, 'tables' | 'sources'>): PinReads {
  return pool.sources.view('per-user.pins', () => {
    const of = (kind: PinKind) =>
      computed(
        (): readonly string[] => {
          const pins: { entityId: string; pinnedAt: string }[] = []
          // A pool without the table (a screen's stand-in in a test) holds no pins.
          for (const value of pool.tables.pin?.values() ?? []) {
            const row = value as PoolRows['pin']
            if (row.kind === kind) pins.push({ entityId: row.entityId, pinnedAt: row.pinnedAt })
          }
          if (pins.length === 0) return NONE
          pins.sort((a, b) =>
            a.pinnedAt === b.pinnedAt
              ? a.entityId.localeCompare(b.entityId)
              : a.pinnedAt < b.pinnedAt
                ? -1
                : 1,
          )
          return pins.map((pin) => pin.entityId)
        },
        { equals: compareShallow },
      )
    return { panel: of('panel'), issue: of('issue'), worktree: of('worktree'), repo: of('repo') }
  })
}

/** What I pinned of one kind (session ids for `panel`, issue ids, worktree or
 *  repo paths), in the order I pinned them. */
export function pinnedIds(
  pool: Pick<MobxPool, 'tables' | 'sources'>,
  kind: PinKind,
): readonly string[] {
  if (pool.sources === undefined) return NONE
  return pinReads(pool)[kind].get()
}

type PinSets = Readonly<Record<PinKind, IComputedValue<ReadonlySet<string>>>>

const NO_PINS: ReadonlySet<string> = Object.freeze(new Set<string>())

/** One set per pin kind, rebuilt only when that kind's pins change. */
function pinSets(pool: Pick<MobxPool, 'tables' | 'sources'>): PinSets {
  return pool.sources.view('per-user.pin-sets', () => {
    const of = (kind: PinKind) =>
      computed((): ReadonlySet<string> => {
        const ids = pinnedIds(pool, kind)
        return ids.length === 0 ? NO_PINS : new Set(ids)
      })
    return { panel: of('panel'), issue: of('issue'), worktree: of('worktree'), repo: of('repo') }
  })
}

/** Did I pin this thing? A keyed lookup on my pins of that kind (POD-6692:
 *  what `IssueModel.pinned` reads). Tracked: a pin on my other device moves it. */
export function isPinned(
  pool: Pick<MobxPool, 'tables' | 'sources'>,
  kind: PinKind,
  entityId: string,
): boolean {
  if (pool.sources === undefined) return false
  return pinSets(pool)[kind].get().has(entityId)
}

/** My personal settings, resolved with defaults; undefined until the pool
 *  has its first publication. */
export function myPreferences(
  pool: Pick<MobxPool, 'tables' | 'model'>,
): UserPreferencesModel | undefined {
  // A pool without the table (a screen's stand-in in a test) holds no record.
  for (const id of pool.tables.userPreferences?.keys() ?? []) {
    return here(pool.model('userPreferences', id))
  }
  return undefined
}
