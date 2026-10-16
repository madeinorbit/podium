/**
 * THE SESSION MAP AGAINST THE DATABASE, SIDE BY SIDE (POD-6160, design §7 step 3.2).
 *
 * The session readers move from the in-memory session map (every non-deleted
 * session as a live `Session`) to durable records read from the database, one
 * reader group at a time. Until the map shrinks to running sessions (D2g), every
 * switched reader answers from the database and, in development builds, also
 * asks the map the same question and logs any difference under the
 * `server:session-map-parity` tag. The soak on the operator's development build
 * is what proves the two agree on real data before the map shrinks.
 *
 * Three modes, as the issue map's comparison (`modules/issues/service/map-parity.ts`):
 * - `off`: a packaged stable or edge build. The map answer is never computed.
 * - `log`: a development build (a source run or a dev-channel version).
 * - `throw`: under vitest, so every existing test of a switched reader is also
 *   an old/new comparison and a difference fails the test that found it.
 *
 * `PODIUM_SESSION_MAP_PARITY=off|log` overrides the build's mode outside
 * vitest: the server-data bench sets `off`, so an A/B measures the database
 * reads and not the comparison, and `log` to measure the comparison itself.
 *
 * The comparison is by value: object keys in any order, and a `null` or
 * `undefined` property the same as an absent one.
 */

import { createLogger } from '@podium/logger'
import type { SessionMeta } from '@podium/model'
import { isDevChannelVersion } from '@podium/protocol'

const log = createLogger('server:session-map-parity')

export type SessionMapParityMode = 'off' | 'log' | 'throw'

/** The mode a process starts in; exported for its test. */
export function defaultSessionMapParityMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
  // The literal `process.env.PODIUM_APP_VERSION` is what the packaged build
  // rewrites (see features.ts); absent means a source run, which is development.
  version: string | undefined = process.env.PODIUM_APP_VERSION,
): SessionMapParityMode {
  if (env.VITEST) return 'throw'
  const forced = env.PODIUM_SESSION_MAP_PARITY
  if (forced === 'off' || forced === 'log') return forced
  if (version === undefined || version === 'dev') return 'log'
  return isDevChannelVersion(version) ? 'log' : 'off'
}

let mode: SessionMapParityMode = defaultSessionMapParityMode()
let differences = 0

export function sessionMapParityMode(): SessionMapParityMode {
  return mode
}

/** Tests only: switch the mode and get the previous one back. */
export function setSessionMapParityMode(next: SessionMapParityMode): SessionMapParityMode {
  const previous = mode
  mode = next
  return previous
}

/** Differences seen by this process since it started (log mode). */
export function sessionMapParityDifferences(): number {
  return differences
}

/**
 * WHAT A SESSION THAT RAN IN THIS PROCESS KEEPS AND ITS RECORD DOES NOT.
 *
 * A durable record is what a restart restores: the row and its satellites. A
 * session that ran in this process and then stopped still carries the last
 * values of its live plane in the map — its terminal (controller, geometry,
 * epoch, attached clients, gated requests, busy), what its live driver told us
 * on bind (driver id, configure fields, attach kinds, the draft engine), the
 * facts learned from its transcript tail and never stored (colour, observed
 * model and effort, context use), and the handoff overlay. None of them
 * describes a stopped session, a restart already clears every one of them, and
 * a session that runs again learns them afresh. They are not compared.
 *
 * `lastActiveAt` and `lastInputAt` ARE compared. They are stored by the activity
 * flush a few seconds after the fact, so a development log can show one of them
 * for a session that stopped inside that window; a difference that persists is
 * a real one.
 */
export const LIVE_PLANE_META_FIELDS = [
  'controllerId',
  'geometry',
  'requestsGated',
  'epoch',
  'clientCount',
  'busy',
  'driverId',
  'configureFields',
  'attachKinds',
  'draftSyncEngine',
  'agentColor',
  'observedModel',
  'observedEffort',
  'contextUsagePercent',
  'handoffTargetMachineId',
] as const satisfies readonly (keyof SessionMeta)[]

export class SessionMapParityError extends Error {
  constructor(
    readonly reader: string,
    readonly key: unknown,
    readonly map: unknown,
    readonly db: unknown,
  ) {
    super(
      `session map parity: ${reader}(${JSON.stringify(key)}) differs\n` +
        `  map: ${JSON.stringify(canonical(map))}\n` +
        `  db:  ${JSON.stringify(canonical(db))}`,
    )
    this.name = 'SessionMapParityError'
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

/** The top-level fields that differ, for a readable log line about two values. */
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
export function compareWithSessionMap<T>(
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
  if (mode === 'throw') throw new SessionMapParityError(reader, key, map, dbAnswer)
  differences += 1
  const fields = differingFields(map, dbAnswer)
  log.warn('session map and database disagree', {
    reader,
    key,
    ...(fields ? { fields } : { map: canonical(map), db: canonical(dbAnswer) }),
    differences,
  })
}
