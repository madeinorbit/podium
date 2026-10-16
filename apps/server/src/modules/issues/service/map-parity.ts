/**
 * THE ISSUE MAP AGAINST THE DATABASE, SIDE BY SIDE (POD-6158, design §7 step 3.2).
 *
 * The issue readers move from `IssueStore`'s in-memory map to repository
 * queries one group at a time. Until the map is deleted, every switched reader
 * answers from the database and, in development builds, also asks the map the
 * same question and logs any difference under the `server:issue-map-parity`
 * tag. The soak on the operator's development build is what proves the two
 * agree on real data before the map goes.
 *
 * Three modes:
 * - `off`: a packaged stable or edge build. The map answer is never computed.
 * - `log`: a development build (a source run or a dev-channel version).
 * - `throw`: under vitest, so every existing test of a switched reader is also
 *   an old/new comparison and a difference fails the test that found it.
 *
 * The comparison is by value, not identity: object keys in any order, and a
 * `null` or `undefined` property the same as an absent one. The map holds
 * installed drafts, which leave out the nullable columns a create never set;
 * the database hands back freshly mapped rows with those columns `null`.
 */

import { createLogger } from '@podium/logger'
import { isDevChannelVersion } from '@podium/protocol'

const log = createLogger('server:issue-map-parity')

export type IssueMapParityMode = 'off' | 'log' | 'throw'

function defaultMode(): IssueMapParityMode {
  if (process.env.VITEST) return 'throw'
  // The literal `process.env.PODIUM_APP_VERSION` is what the packaged build
  // rewrites (see features.ts); absent means a source run, which is development.
  const version = process.env.PODIUM_APP_VERSION
  if (version === undefined || version === 'dev') return 'log'
  return isDevChannelVersion(version) ? 'log' : 'off'
}

let mode: IssueMapParityMode = defaultMode()
let differences = 0

export function issueMapParityMode(): IssueMapParityMode {
  return mode
}

/** Tests only: switch the mode and get the previous one back. */
export function setIssueMapParityMode(next: IssueMapParityMode): IssueMapParityMode {
  const previous = mode
  mode = next
  return previous
}

/** Differences seen by this process since it started (log mode). */
export function issueMapParityDifferences(): number {
  return differences
}

export class IssueMapParityError extends Error {
  constructor(
    readonly reader: string,
    readonly key: unknown,
    readonly map: unknown,
    readonly db: unknown,
  ) {
    super(
      `issue map parity: ${reader}(${JSON.stringify(key)}) differs\n` +
        `  map: ${JSON.stringify(canonical(map))}\n` +
        `  db:  ${JSON.stringify(canonical(db))}`,
    )
    this.name = 'IssueMapParityError'
  }
}

/** A JSON-able value with sorted keys and no `undefined` properties. */
function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [canonical(key), canonical(entry)] as const)
      .sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1))
  }
  if (value instanceof Set) return [...value].map(canonical).sort()
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Error) return { error: value.name, message: value.message }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined && entry !== null) out[key] = canonical(entry)
    }
    return out
  }
  return value
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** The top-level fields that differ, for a readable log line about two rows. */
function differingFields(map: unknown, db: unknown): Record<string, { map: unknown; db: unknown }> | undefined {
  if (!map || !db || typeof map !== 'object' || typeof db !== 'object') return undefined
  if (Array.isArray(map) || Array.isArray(db)) return undefined
  const out: Record<string, { map: unknown; db: unknown }> = {}
  const a = map as Record<string, unknown>
  const b = db as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameValue(a[key], b[key])) out[key] = { map: a[key], db: b[key] }
  }
  return out
}

/**
 * Compare a reader's database answer with what the map would have said.
 *
 * `mapAnswer` runs only when the comparison is on, synchronously, right after
 * the database read: the map is in-process and moves only on commits, so this
 * asks both at the same moment as far as any write can tell.
 */
export function compareWithIssueMap<T>(
  reader: string,
  key: unknown,
  mapAnswer: () => T,
  dbAnswer: T,
): void {
  if (mode === 'off') return
  let map: T
  try {
    map = mapAnswer()
  } catch (err) {
    // The map side failing is itself an answer to compare (a refusal on one
    // side only is a difference). Errors compare by name and message.
    map = err as T
  }
  if (sameValue(map, dbAnswer)) return
  if (mode === 'throw') throw new IssueMapParityError(reader, key, map, dbAnswer)
  differences += 1
  const fields = differingFields(map, dbAnswer)
  log.warn('issue map and database disagree', {
    reader,
    key,
    ...(fields ? { fields } : { map: canonical(map), db: canonical(dbAnswer) }),
    differences,
  })
}

/** {@link compareWithIssueMap} for a reader whose database side may refuse. */
export async function compareOutcomeWithIssueMap<T>(
  reader: string,
  key: unknown,
  mapAnswer: () => T | Promise<T>,
  dbAnswer: () => Promise<T>,
  /** Both answers as compared, when the order of equal elements is not part
   *  of the answer (see the caller). */
  canonical: (value: T) => unknown = (value) => value,
): Promise<T> {
  if (mode === 'off') return await dbAnswer()
  let mapOutcome: { value: T } | { error: unknown }
  try {
    mapOutcome = { value: await mapAnswer() }
  } catch (error) {
    mapOutcome = { error }
  }
  let dbOutcome: { value: T } | { error: unknown }
  try {
    dbOutcome = { value: await dbAnswer() }
  } catch (error) {
    dbOutcome = { error }
  }
  const view = (outcome: { value: T } | { error: unknown }) =>
    'error' in outcome ? outcome : { value: canonical(outcome.value) }
  compareWithIssueMap(reader, key, () => view(mapOutcome), view(dbOutcome))
  if ('error' in dbOutcome) throw dbOutcome.error
  return dbOutcome.value
}
