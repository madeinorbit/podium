/**
 * RECORD PARITY (POD-6763): is a built record the published record?
 *
 * For each kind, the published side is `change_latest` (what a new client is
 * sent today); the built side is the kind's builder on the same snapshot. Two
 * questions per kind, record for record:
 *
 *  - `build(ids)` for every published id: equal value, different value, or no
 *    record built;
 *  - `streamAll()`: which built ids are not published at all.
 *
 * Equality is on the JSON values (key order ignored); `byteEqual` also counts
 * the records whose serialized JSON is byte-identical, which is what the
 * Authority's dedup compares today.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import type { BuiltRecord, RecordBuilderRegistry } from '@podium/sync/record-builders'

export interface PublishedRow {
  readonly entityId: string
  readonly payload: string | null
}

export interface RecordDifference {
  readonly id: string
  /** Top-level fields whose values differ (`*` when either side is not an object). */
  readonly fields: readonly string[]
  readonly published?: unknown
  readonly built?: unknown
}

export interface KindParity {
  readonly kind: MetadataEntityKind
  /** Rows in `change_latest` with a payload. */
  readonly published: number
  /** Published rows `build(ids)` answered with an equal value. */
  readonly equal: number
  /** …of which byte-identical JSON. */
  readonly byteEqual: number
  /** Published rows `build(ids)` answered with a different value. */
  readonly differing: number
  /** Published rows `build(ids)` built no record for. */
  readonly notBuilt: number
  /** Records `streamAll()` built. */
  readonly streamed: number
  /** Streamed records that are not published. */
  readonly notPublished: number
  /** Published rows `streamAll()` did not build. */
  readonly notStreamed: number
  /** Streamed records whose value differs from `build(ids)` of the same id. */
  readonly streamDiffersFromBuild: number
  /** Up to `sampleLimit` of each problem, for the report. */
  readonly samples: {
    readonly differing: readonly RecordDifference[]
    readonly notBuilt: readonly string[]
    readonly notPublished: readonly string[]
    readonly notStreamed: readonly string[]
  }
  /** Fields that differ, counted over every differing record. */
  readonly differingFields: Readonly<Record<string, number>>
}

/** JSON with object keys sorted, after a JSON round trip (undefined dropped). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null))))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return out
}

function differingFieldsOf(published: unknown, built: unknown): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(published) || !isObject(built)) return ['*']
  const keys = new Set([...Object.keys(published), ...Object.keys(built)])
  return [...keys]
    .filter((key) => canonicalJson(published[key]) !== canonicalJson(built[key]))
    .sort()
}

export async function kindParity<R>(
  registry: RecordBuilderRegistry<R>,
  reads: R,
  kind: MetadataEntityKind,
  published: readonly PublishedRow[],
  options: {
    sampleLimit?: number
    idsPerBuild?: number
    keepValues?: boolean
    /** Top-level fields left out of the comparison on both sides. */
    ignoreFields?: readonly string[]
  } = {},
): Promise<KindParity> {
  const ignored = options.ignoreFields ?? []
  const comparable = (value: unknown): unknown => {
    if (ignored.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value))
      return value
    const out = { ...(value as Record<string, unknown>) }
    for (const field of ignored) delete out[field]
    return out
  }
  const sampleLimit = options.sampleLimit ?? 5
  const idsPerBuild = options.idsPerBuild ?? 500
  const rows = published.filter((row) => row.payload !== null)
  const publishedById = new Map(rows.map((row) => [row.entityId, row.payload as string]))
  const builtById = new Map<string, BuiltRecord>()
  const ids = [...publishedById.keys()]
  for (let at = 0; at < ids.length; at += idsPerBuild) {
    for (const record of await registry.build(reads, kind, ids.slice(at, at + idsPerBuild))) {
      builtById.set(record.id, record)
    }
  }
  let equal = 0,
    byteEqual = 0,
    differing = 0,
    notBuilt = 0
  const samples = {
    differing: [] as RecordDifference[],
    notBuilt: [] as string[],
    notPublished: [] as string[],
    notStreamed: [] as string[],
  }
  const differingFields: Record<string, number> = {}
  for (const [id, payload] of publishedById) {
    const record = builtById.get(id)
    if (record === undefined) {
      notBuilt++
      if (samples.notBuilt.length < sampleLimit) samples.notBuilt.push(id)
      continue
    }
    const json = JSON.stringify(record.value)
    if (json === payload) {
      equal++
      byteEqual++
      continue
    }
    const stored = comparable(JSON.parse(payload) as unknown)
    const built = comparable(record.value)
    if (canonicalJson(stored) === canonicalJson(built)) {
      equal++
      continue
    }
    differing++
    const fields = differingFieldsOf(stored, built)
    for (const field of fields) differingFields[field] = (differingFields[field] ?? 0) + 1
    if (samples.differing.length < sampleLimit) {
      samples.differing.push({
        id,
        fields,
        ...(options.keepValues ? { published: stored, built } : {}),
      })
    }
  }
  let streamed = 0,
    notPublished = 0,
    streamDiffersFromBuild = 0
  const streamedIds = new Set<string>()
  for await (const page of registry.streamAll(reads, kind)) {
    for (const record of page) {
      streamed++
      streamedIds.add(record.id)
      if (!publishedById.has(record.id)) {
        notPublished++
        if (samples.notPublished.length < sampleLimit) samples.notPublished.push(record.id)
        continue
      }
      const byId = builtById.get(record.id)
      if (
        byId !== undefined &&
        canonicalJson(comparable(byId.value)) !== canonicalJson(comparable(record.value))
      ) {
        streamDiffersFromBuild++
      }
    }
  }
  let notStreamed = 0
  for (const id of publishedById.keys()) {
    if (streamedIds.has(id)) continue
    notStreamed++
    if (samples.notStreamed.length < sampleLimit) samples.notStreamed.push(id)
  }
  return {
    kind,
    published: rows.length,
    equal,
    byteEqual,
    differing,
    notBuilt,
    streamed,
    notPublished,
    notStreamed,
    streamDiffersFromBuild,
    samples,
    differingFields,
  }
}

/** A kind is at parity when every published record is built equal by id and
 *  streamed, and nothing unpublished is streamed. */
export const atParity = (p: KindParity): boolean =>
  p.differing === 0 &&
  p.notBuilt === 0 &&
  p.notPublished === 0 &&
  p.notStreamed === 0 &&
  p.streamDiffersFromBuild === 0
