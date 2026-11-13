/**
 * RECORDS FROM THE DATABASE (POD-6253 design §1, POD-6763).
 *
 * Every synced record kind registers one {@link RecordBuilder}: `build(ids)`
 * answers "these records as they are published now", `streamAll()` answers
 * "every record of the kind", both as pure functions of database rows. A
 * builder reads only the model tables, through whatever read port the
 * composition root hands it (the server's repositories over the sync worker's
 * read-only connection); it never reads the change log or `change_latest`,
 * and never server memory. That is design rule 1: every synced record can be
 * built from the database alone, by any process, by id.
 *
 * The kernel owns the contract, not the rows: `apps/server` registers the
 * builders, because only it knows the schema. The registry normalises what a
 * builder answers, so a builder may read a superset (one member's rows for a
 * batch of that member's ids) and the caller still gets exactly the ids it
 * asked for, once each, in the order it asked.
 *
 * The change-log commit, the start-up load and the sharing rules read the
 * registry.
 * Kinds backed by the same rows can share a read for one build or stream page.
 */

import type { MetadataEntityKind } from '@podium/protocol'

/** One record as the feed carries it: its row id and its whole wire value. */
export interface BuiltRecord {
  readonly id: string
  readonly value: unknown
}

export interface RecordPage {
  readonly entity: MetadataEntityKind
  readonly records: readonly BuiltRecord[]
}

export type RecordIdsByKind = ReadonlyMap<MetadataEntityKind, readonly string[]>

/** A shared read for kinds that also have their own single-kind builders. */
export interface RecordBuilderGroup<R> {
  readonly kinds: readonly MetadataEntityKind[]
  build(
    reads: R,
    idsByKind: RecordIdsByKind,
  ): Promise<ReadonlyMap<MetadataEntityKind, readonly BuiltRecord[]>>
  streamAll(reads: R): AsyncIterable<RecordPage>
}

/**
 * How a kind's records are found, as the 2026-11-10 audit sorted them:
 *  - `row`: one stored row is one record;
 *  - `row-and-reads`: one row plus a few fixed reads (labels, holds, steps);
 *  - `windowed`: the feed carries only part of the table, and the rule for
 *    which part is a query (issue events, open interactions, messages).
 */
export type RecordBuilderShape = 'row' | 'row-and-reads' | 'windowed'

export interface RecordBuilder<R> {
  readonly kind: MetadataEntityKind
  readonly shape: RecordBuilderShape
  /**
   * The records with these row ids, as published now. An id with no record
   * (no row, outside the window, unparseable) is simply absent. A builder may
   * answer more ids than asked; the registry keeps only the asked ones.
   */
  build(reads: R, ids: readonly string[]): Promise<readonly BuiltRecord[]>
  /** Every record of the kind, a page at a time, in a stable order. */
  streamAll(reads: R): AsyncIterable<readonly BuiltRecord[]>
}

export class DuplicateRecordBuilder extends Error {
  constructor(readonly kind: MetadataEntityKind) {
    super(`a record builder for kind ${kind} is already registered`)
  }
}

export class UnknownRecordBuilder extends Error {
  constructor(readonly kind: string) {
    super(`no record builder is registered for kind ${kind}`)
  }
}

function recordsForIds(records: readonly BuiltRecord[], ids: readonly string[]): BuiltRecord[] {
  const built = new Map<string, BuiltRecord>()
  for (const record of records) {
    if (!built.has(record.id)) built.set(record.id, record)
  }
  return ids.flatMap((id) => {
    const record = built.get(id)
    return record === undefined ? [] : [record]
  })
}

/** The per-kind builders of one composition root. */
export class RecordBuilderRegistry<R> {
  private readonly byKind = new Map<MetadataEntityKind, RecordBuilder<R>>()
  private readonly groupsByKind = new Map<MetadataEntityKind, RecordBuilderGroup<R>>()

  constructor(
    builders: readonly RecordBuilder<R>[] = [],
    groups: readonly RecordBuilderGroup<R>[] = [],
  ) {
    for (const builder of builders) this.register(builder)
    for (const group of groups) {
      for (const kind of group.kinds) {
        this.get(kind)
        if (this.groupsByKind.has(kind)) throw new DuplicateRecordBuilder(kind)
        this.groupsByKind.set(kind, group)
      }
    }
  }

  register(builder: RecordBuilder<R>): this {
    if (this.byKind.has(builder.kind)) throw new DuplicateRecordBuilder(builder.kind)
    this.byKind.set(builder.kind, builder)
    return this
  }

  kinds(): MetadataEntityKind[] {
    return [...this.byKind.keys()]
  }

  has(kind: MetadataEntityKind): boolean {
    return this.byKind.has(kind)
  }

  get(kind: MetadataEntityKind): RecordBuilder<R> {
    const builder = this.byKind.get(kind)
    if (builder === undefined) throw new UnknownRecordBuilder(kind)
    return builder
  }

  /** {@link RecordBuilder.build}, answered for exactly the asked ids, once
   *  each, in the order first asked. */
  async build(reads: R, kind: MetadataEntityKind, ids: readonly string[]): Promise<BuiltRecord[]> {
    const asked = [...new Set(ids)]
    if (asked.length === 0) return []
    return recordsForIds(await this.get(kind).build(reads, asked), asked)
  }

  /** Read the requested kinds together where they share a builder. */
  async *buildMany(reads: R, idsByKind: RecordIdsByKind): AsyncGenerator<RecordPage> {
    const builtGroups = new Set<RecordBuilderGroup<R>>()
    for (const [entity, ids] of idsByKind) {
      if (ids.length === 0) continue
      const group = this.groupsByKind.get(entity)
      if (group) {
        if (builtGroups.has(group)) continue
        const askedByKind = new Map<MetadataEntityKind, readonly string[]>()
        for (const kind of group.kinds) {
          const asked = idsByKind.get(kind)
          if (asked?.length) askedByKind.set(kind, [...new Set(asked)])
        }
        if (askedByKind.size > 1) {
          builtGroups.add(group)
          const built = await group.build(reads, askedByKind)
          for (const [kind, asked] of askedByKind) {
            yield { entity: kind, records: recordsForIds(built.get(kind) ?? [], asked) }
          }
          continue
        }
      }
      yield { entity, records: await this.build(reads, entity, ids) }
    }
  }

  streamAll(reads: R, kind: MetadataEntityKind): AsyncIterable<readonly BuiltRecord[]> {
    return this.get(kind).streamAll(reads)
  }

  /** Every record, in registry order, with each group streamed at its first kind. */
  async *streamAllKinds(reads: R): AsyncGenerator<RecordPage> {
    const streamedGroups = new Set<RecordBuilderGroup<R>>()
    for (const [entity, builder] of this.byKind) {
      const group = this.groupsByKind.get(entity)
      if (group) {
        if (streamedGroups.has(group)) continue
        streamedGroups.add(group)
        yield* group.streamAll(reads)
      } else {
        for await (const records of builder.streamAll(reads)) yield { entity, records }
      }
    }
  }
}

/** Pages of a list already in hand; a builder whose source reads its whole
 *  answer at once still streams it in pages of this size. */
export const RECORD_PAGE_SIZE = 500

export async function* pagesOf(
  records: readonly BuiltRecord[] | Promise<readonly BuiltRecord[]>,
  size = RECORD_PAGE_SIZE,
): AsyncGenerator<readonly BuiltRecord[]> {
  const all = await records
  for (let at = 0; at < all.length; at += size) yield all.slice(at, at + size)
}

/** Collect a stream (tests and tools; production streams page by page). */
export async function collectRecords(
  stream: AsyncIterable<readonly BuiltRecord[]>,
): Promise<BuiltRecord[]> {
  const out: BuiltRecord[] = []
  for await (const page of stream) out.push(...page)
  return out
}
