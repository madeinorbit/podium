/**
 * ONE LOADER'S SERVER HALF: ANY DECLARED COLLECTION, ONE WAY (POD-7085,
 * design POD-7059 "Collections", "One loader, one route", "Counts").
 *
 * The input is a list of INSTANCES (a declared collection with its arguments,
 * the part asked for, the holder whose "comes with" narrows it, the position
 * to continue a paged one from). The output is whole records in feed format,
 * issues at stub level where asked, and a MARKER per instance once all of its
 * records this viewer may see have been sent. Everything is read inside the
 * caller's snapshot (`sync-worker/producer.ts`): the records and the feed
 * number they are complete as of come from one read transaction.
 *
 * How an instance is answered, the same way for every collection:
 *  1. The rule selects candidate records in SQL (`store/collections.ts`).
 *     A collection with no rule is every record of its type, streamed.
 *  2. The candidates are built by the record builders, checked against the
 *     rule in JavaScript where the SQL may select a superset (a JSON field the
 *     builder drops; `collection-sql.ts`), and filtered by the viewer's rights
 *     exactly as the feed filters them (`decide`, then `shape`).
 *  3. A paged collection answers one page in its sort order, below the asked
 *     position, with a range marker; its first page also carries the total
 *     for this viewer, counted over the records the viewer may see.
 *  4. What the instance's records come with follows, answered in the same
 *     request with one statement per declared link: a collection's own
 *     comes-with (the sidebar's sessions) for its members, then what every
 *     record of a type comes with (an issue's parents, read state, git state
 *     and dependencies; a session's issue and state; a pin's target), until
 *     nothing new arrives. An issue's parents are one walk up the tree. Each
 *     keyed instance gets its marker.
 *
 * A record goes out once per answer: a later collection that holds it again
 * names it in its marker, and the client already has it at the same feed
 * number. A stub is skipped for an issue already sent whole, and an issue
 * sent as a stub is sent again whole when a later collection holds it.
 *
 * Stub-level answers bring nothing along: a stub is not a held record.
 */

import {
  type Clause,
  clausesOf,
  type FieldTest,
  fieldOfPath,
  matchesWhere,
  pathsRead,
  type RecordDeclaration,
  type RuleArgs,
  recordOf,
  type Scalar,
  testKind,
  type Where,
} from '@podium/model'
import {
  type CollectionArgs,
  type CollectionInstance,
  type CompleteInstance,
  ISSUE_STUB_FIELDS,
  type MetadataEntityKind,
  type Principal,
} from '@podium/protocol'
import type { EntityRef, FeedVisibilityPolicy } from '@podium/sync'
import { shapedValue } from '@podium/sync/bootstrap-worker'
import type { BuiltRecord } from '@podium/sync/record-builders'
import type { CollectionRow, CollectionsRepository } from '../store/collections'
import {
  CollectionRequestError,
  KEYED_CHUNK,
  paddedArgs,
  type ResolvedRule,
  resolveRule,
} from './collection-shapes'
import {
  type CollectionKind,
  collectionTarget,
  isCollectionKind,
  keyCount,
  recordIdOf,
} from './collection-sql'

export { CollectionRequestError }

/** Records built per call: the builders' batched reads take a page at a time. */
const BUILD_CHUNK = 500

/** Rounds of "comes with" an answer may take; the declarations need four. */
const MAX_COMES_WITH_ROUNDS = 8

/** What the fetch reads, all within the caller's snapshot. */
export interface FetchPorts {
  readonly collections: Pick<
    CollectionsRepository,
    'select' | 'sorted' | 'after' | 'keyed' | 'ancestors' | 'keyPage'
  >
  readonly records: {
    build(kind: MetadataEntityKind, ids: readonly string[]): Promise<readonly BuiltRecord[]>
    streamAll(kind: MetadataEntityKind): AsyncIterable<readonly BuiltRecord[]>
  }
  /** The sharing rules; `forBootstrap` prepares the facts for a batch of refs. */
  readonly visibility: FeedVisibilityPolicy
  readonly principal: Principal
  /** The clock `newerThan` compares against, for the whole answer. */
  readonly now: number
  /** The policy's numbers (`recentDays`). */
  readonly policyArgs: RuleArgs
}

/** One record as it goes out: the viewer's value, and the part sent. */
export interface FetchedRecord {
  readonly entity: MetadataEntityKind
  readonly entityId: string
  readonly value: unknown
}

export type FetchOutput =
  | { readonly type: 'records'; readonly records: readonly FetchedRecord[] }
  | { readonly type: 'stubs'; readonly records: readonly FetchedRecord[] }
  | { readonly type: 'complete'; readonly instances: readonly CompleteInstance[] }

/** An instance checked against the declarations. */
export interface ResolvedInstance {
  readonly rule: ResolvedRule
  readonly declaration: RecordDeclaration
  readonly part: 'stub' | 'main'
  /** The instance's own arguments, as the client named them. */
  readonly args: CollectionArgs
  readonly after?: readonly Scalar[]
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((key, at) => key === [...b].sort()[at])

/** Check one requested instance against the declarations; throws {@link CollectionRequestError}. */
export function resolveInstance(instance: CollectionInstance): ResolvedInstance {
  const rule = resolveRule(instance.collection, instance.via)
  const declaration = recordOf(rule.kind)
  if (declaration === undefined)
    throw new CollectionRequestError(`${rule.kind} is not a declared record type`)
  const args = instance.args ?? {}
  if (!sameKeys(Object.keys(args), rule.params)) {
    throw new CollectionRequestError(
      `${rule.id} takes ${rule.params.length === 0 ? 'no arguments' : rule.params.join(', ')}, got ${Object.keys(args).join(', ') || 'none'}`,
    )
  }
  for (const [name, value] of Object.entries(args)) {
    if (Array.isArray(value))
      throw new CollectionRequestError(`${rule.id}: argument ${name} must be one value`)
  }
  const part = instance.part ?? rule.collection.part
  if (part === 'stub' && declaration.stub.length === 0)
    throw new CollectionRequestError(`${rule.kind} has no stub part`)
  const page = rule.collection.page
  if (instance.after !== undefined) {
    if (page === undefined) throw new CollectionRequestError(`${rule.id} is not paged`)
    if (instance.after.length !== page.sort.length)
      throw new CollectionRequestError(`${rule.id}: a position has ${page.sort.length} values`)
  }
  if ((rule.where !== undefined || page !== undefined) && !isCollectionKind(rule.kind))
    throw new CollectionRequestError(`${rule.kind} has no table a rule can read`)
  return {
    rule,
    declaration,
    part,
    args,
    ...(instance.after === undefined ? {} : { after: instance.after as readonly Scalar[] }),
  }
}

/** The rule without its `descendantsOf` tests, which only SQL can walk; `undefined` when none is left. */
function checkableWhere(where: Where): Where | undefined {
  const clauses = clausesOf(where).map((clause) =>
    Object.fromEntries(
      Object.entries(clause).filter(([, test]) => testKind(test as FieldTest) !== 'descendantsOf'),
    ),
  )
  if (clauses.some((clause) => Object.keys(clause).length === 0)) return undefined
  return clauses.length === 1 ? (clauses[0] as Clause) : (clauses as Clause[])
}

/** Whether the rule reads a JSON field, where the SQL may select a superset. */
function readsJson(kind: CollectionKind, where: Where | undefined): boolean {
  if (where === undefined) return false
  const target = collectionTarget(kind)
  return pathsRead(where).some((path) => target.field(fieldOfPath(path))?.type === 'json')
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`

/** One record after the rights check: its value as built and as this viewer receives it. */
interface Visible {
  readonly id: string
  readonly built: Readonly<Record<string, unknown>>
  readonly shaped: unknown
}

/**
 * One answer: the instances of one request, or every step of a first
 * download. It remembers what it has sent, so each record goes out once.
 */
export class CollectionAnswer {
  /** Records sent whole, and issues sent at stub level only. */
  private readonly whole = new Set<string>()
  private readonly stubbed = new Set<string>()
  /** Issues whose ancestors have been walked. */
  private readonly walked = new Set<string>()
  /** Keyed instances already marked complete. */
  private readonly marked = new Set<string>()

  constructor(private readonly ports: FetchPorts) {}

  /** Answer one instance and everything it comes with. */
  async *instance(instance: ResolvedInstance): AsyncGenerator<FetchOutput> {
    const { rule, part } = instance
    if (part === 'stub') {
      yield* this.stubs(instance)
      return
    }
    const members: Visible[] = []
    let range: CompleteInstance['range']
    let total: number | undefined
    if (rule.collection.page !== undefined) {
      // A paged collection is answered a page at a time, with or without a rule.
      const answer = await this.page(instance)
      range = answer.range
      total = answer.total
      members.push(...answer.members)
      const out = this.fresh(rule.kind, answer.members)
      if (out.length > 0) yield { type: 'records', records: out }
    } else if (rule.where === undefined) {
      for await (const page of this.ports.records.streamAll(rule.kind as MetadataEntityKind)) {
        const visible = await this.visible(rule.kind, page, undefined, instance)
        members.push(...visible)
        const out = this.fresh(rule.kind, visible)
        if (out.length > 0) yield { type: 'records', records: out }
      }
    } else {
      const ids = this.ids(
        rule.kind,
        await this.ports.collections.select(rule, this.args(instance), this.ports.now),
      )
      for (const batch of chunks(ids, BUILD_CHUNK)) {
        const visible = await this.built(rule.kind, batch, rule.where, instance)
        members.push(...visible)
        const out = this.fresh(rule.kind, visible)
        if (out.length > 0) yield { type: 'records', records: out }
      }
    }
    yield {
      type: 'complete',
      instances: [
        {
          collection: rule.collection.id,
          ...(Object.keys(instance.args).length === 0 ? {} : { args: instance.args }),
          part,
          ...(rule.via === undefined ? {} : { via: rule.via }),
          ...(range === undefined ? {} : { range }),
          ...(total === undefined ? {} : { total }),
        },
      ],
    }
    const arrived = new Map<string, Visible[]>([[rule.kind, members]])
    for (const entry of rule.collection.comesWith ?? []) {
      const holder = resolveRule(entry.collection, rule.collection.id)
      yield* this.comesWith(rule.kind, instance.declaration, members, entry, holder, arrived)
    }
    yield* this.closure(arrived)
  }

  /** The arguments a statement binds: the instance's and the policy's. */
  private args(instance: { args: CollectionArgs }): RuleArgs {
    return { ...this.ports.policyArgs, ...instance.args } as RuleArgs
  }

  /** Record ids of selected rows, once each, in their order. */
  private ids(kind: string, rows: readonly CollectionRow[]): string[] {
    const width = isCollectionKind(kind) ? keyCount(kind) : 1
    const out = new Set<string>()
    for (const row of rows) {
      const id = recordIdOf(kind as CollectionKind, row.slice(0, width))
      if (id !== null) out.add(id)
    }
    return [...out]
  }

  /** Build these records, keep those the rule holds for, then those the viewer may see. */
  private async built(
    kind: string,
    ids: readonly string[],
    where: Where | undefined,
    instance: { args: CollectionArgs },
  ): Promise<Visible[]> {
    if (ids.length === 0) return []
    const records = await this.ports.records.build(kind as MetadataEntityKind, ids)
    return await this.visible(kind, records, where, instance)
  }

  /** The rule's check in JavaScript, then the rights check. */
  private async visible(
    kind: string,
    records: readonly BuiltRecord[],
    where: Where | undefined,
    instance: { args: CollectionArgs },
  ): Promise<Visible[]> {
    const check =
      where !== undefined && isCollectionKind(kind) && readsJson(kind, where)
        ? checkableWhere(where)
        : undefined
    const held =
      check === undefined
        ? records
        : records.filter((record) =>
            matchesWhere(check, record.value as Record<string, unknown>, {
              now: this.ports.now,
              args: this.args(instance),
            }),
          )
    if (held.length === 0) return []
    const entity = kind as MetadataEntityKind
    const policy = await this.prepared(held.map((record) => ({ entity, entityId: record.id })))
    const out: Visible[] = []
    for (const record of held) {
      const ref: EntityRef = { entity, entityId: record.id }
      if (!policy.decide(this.ports.principal, ref).visible) continue
      out.push({
        id: record.id,
        built: record.value as Readonly<Record<string, unknown>>,
        shaped: shapedValue(policy, this.ports.principal, ref, record.value),
      })
    }
    return out
  }

  /** Which refs the viewer may see, without building them (a total). */
  private async visibleIds(kind: string, ids: readonly string[]): Promise<Set<string>> {
    const entity = kind as MetadataEntityKind
    const out = new Set<string>()
    for (const batch of chunks(ids, BUILD_CHUNK)) {
      const policy = await this.prepared(batch.map((entityId) => ({ entity, entityId })))
      for (const entityId of batch)
        if (policy.decide(this.ports.principal, { entity, entityId }).visible) out.add(entityId)
    }
    return out
  }

  private async prepared(refs: readonly EntityRef[]): Promise<FeedVisibilityPolicy> {
    return (await this.ports.visibility.forBootstrap?.(refs)) ?? this.ports.visibility
  }

  /** The records not yet sent whole in this answer, as they go out. */
  private fresh(kind: string, visible: readonly Visible[]): FetchedRecord[] {
    const out: FetchedRecord[] = []
    for (const record of visible) {
      const key = keyOf(kind, record.id)
      if (this.whole.has(key)) continue
      this.whole.add(key)
      out.push({ entity: kind as MetadataEntityKind, entityId: record.id, value: record.shaped })
    }
    return out
  }

  /** One page of a paged collection, below the asked position, and its first page's total. */
  private async page(instance: ResolvedInstance): Promise<{
    members: Visible[]
    range: NonNullable<CompleteInstance['range']>
    total?: number
  }> {
    const { rule } = instance
    const page = rule.collection.page!
    const kind = rule.kind as CollectionKind
    const width = keyCount(kind)
    const json = readsJson(kind, rule.where)
    const args = this.args(instance)
    const members: Visible[] = []
    let through: readonly Scalar[] | undefined
    if (instance.after === undefined) {
      // The first page: the whole collection in its order, for the total.
      const rows = await this.ports.collections.sorted(rule, args, this.ports.now)
      const ordered = rows.flatMap((row) => {
        const id = recordIdOf(kind, row.slice(0, width))
        return id === null ? [] : [{ id, sort: row.slice(width) as Scalar[] }]
      })
      let candidates = ordered
      if (json) {
        // A JSON field: only the built record can say whether it is held.
        const held = new Set<string>()
        for (const batch of chunks(ordered, BUILD_CHUNK)) {
          for (const record of await this.built(
            kind,
            batch.map((r) => r.id),
            rule.where,
            instance,
          ))
            held.add(record.id)
        }
        candidates = ordered.filter((row) => held.has(row.id))
      } else {
        const seen = await this.visibleIds(
          kind,
          ordered.map((row) => row.id),
        )
        candidates = ordered.filter((row) => seen.has(row.id))
      }
      const first = candidates.slice(0, page.size)
      for (const batch of chunks(first, BUILD_CHUNK)) {
        const built = await this.built(
          kind,
          batch.map((row) => row.id),
          rule.where,
          instance,
        )
        const byId = new Map(built.map((record) => [record.id, record]))
        for (const row of batch) {
          const record = byId.get(row.id)
          if (record !== undefined) members.push(record)
        }
      }
      through = first.at(-1)?.sort
      return {
        members,
        range: {
          ...(through === undefined ? {} : { through: through as [Scalar, ...Scalar[]] }),
          end: candidates.length <= page.size,
        },
        total: candidates.length,
      }
    }
    // A later page: rows strictly below the position, a bounded read at a time.
    // A row the viewer may not see is skipped, so a read may take more rows
    // than the page holds; `end` is true only when the reads ran out.
    let cursor: readonly Scalar[] = instance.after
    let exhausted = false
    let more = false
    reading: while (members.length < page.size && !exhausted) {
      const limit = page.size * 2
      const rows = await this.ports.collections.after(rule, args, this.ports.now, cursor, limit)
      exhausted = rows.length < limit
      const ordered = rows.flatMap((row) => {
        const id = recordIdOf(kind, row.slice(0, width))
        return id === null ? [] : [{ id, sort: row.slice(width) as Scalar[] }]
      })
      if (rows.length > 0) cursor = rows.at(-1)!.slice(width) as Scalar[]
      const built = await this.built(
        kind,
        ordered.map((row) => row.id),
        rule.where,
        instance,
      )
      const byId = new Map(built.map((record) => [record.id, record]))
      for (const row of ordered) {
        const record = byId.get(row.id)
        if (record === undefined) continue
        if (members.length === page.size) {
          more = true
          break reading
        }
        members.push(record)
        through = row.sort
      }
    }
    return {
      members,
      range: {
        ...(through === undefined ? {} : { through: through as [Scalar, ...Scalar[]] }),
        end: exhausted && !more,
      },
    }
  }

  /** An issue collection at stub level: the stub fields of each record, nothing along. */
  private async *stubs(instance: ResolvedInstance): AsyncGenerator<FetchOutput> {
    const { rule } = instance
    const emit = (visible: readonly Visible[]): FetchedRecord[] => {
      const out: FetchedRecord[] = []
      for (const record of visible) {
        const key = keyOf(rule.kind, record.id)
        if (this.whole.has(key) || this.stubbed.has(key)) continue
        this.stubbed.add(key)
        const shaped = record.shaped as Record<string, unknown>
        out.push({
          entity: rule.kind as MetadataEntityKind,
          entityId: record.id,
          value: Object.fromEntries(
            ISSUE_STUB_FIELDS.filter((field) => field in shaped).map((field) => [
              field,
              shaped[field],
            ]),
          ),
        })
      }
      return out
    }
    // A record sent earlier in this answer, whole or as a stub, is not built again.
    const unsent = (id: string) =>
      !this.whole.has(keyOf(rule.kind, id)) && !this.stubbed.has(keyOf(rule.kind, id))
    if (rule.where === undefined && isCollectionKind(rule.kind) && keyCount(rule.kind) === 1) {
      // Every record of the type, listed by key a page at a time (POD-7153):
      // only the ones not sent yet are built, BUILD_CHUNK at a time.
      const kind = rule.kind
      let pending: string[] = []
      let after = ''
      for (let more = true; more; ) {
        const keys = await this.ports.collections.keyPage(kind, after, BUILD_CHUNK)
        more = keys.length === BUILD_CHUNK
        if (keys.length > 0) after = keys.at(-1)!
        for (const key of keys) {
          const id = recordIdOf(kind, [key])
          if (id !== null && unsent(id)) pending.push(id)
        }
        while (pending.length >= BUILD_CHUNK || (!more && pending.length > 0)) {
          const batch = pending.slice(0, BUILD_CHUNK)
          pending = pending.slice(BUILD_CHUNK)
          const out = emit(await this.built(kind, batch, undefined, instance))
          if (out.length > 0) yield { type: 'stubs', records: out }
        }
      }
    } else if (rule.where === undefined) {
      for await (const page of this.ports.records.streamAll(rule.kind as MetadataEntityKind)) {
        const out = emit(await this.visible(rule.kind, page, undefined, instance))
        if (out.length > 0) yield { type: 'stubs', records: out }
      }
    } else {
      const ids = this.ids(
        rule.kind,
        await this.ports.collections.select(rule, this.args(instance), this.ports.now),
      ).filter(unsent)
      for (const batch of chunks(ids, BUILD_CHUNK)) {
        const out = emit(await this.built(rule.kind, batch, rule.where, instance))
        if (out.length > 0) yield { type: 'stubs', records: out }
      }
    }
    yield {
      type: 'complete',
      instances: [
        {
          collection: rule.collection.id,
          ...(Object.keys(instance.args).length === 0 ? {} : { args: instance.args }),
          part: 'stub',
          ...(rule.via === undefined ? {} : { via: rule.via }),
        },
      ],
    }
  }

  /**
   * One declared comes-with for these holders: the target collection's
   * records for every holder's key at once, then a marker per keyed instance.
   * New records join `arrived`, for what they in turn come with.
   */
  private async *comesWith(
    holderKind: string,
    holderDeclaration: RecordDeclaration,
    holders: readonly Visible[],
    entry: NonNullable<ResolvedRule['comesWith']>,
    target: ResolvedRule,
    arrived: Map<string, Visible[]>,
  ): AsyncGenerator<FetchOutput> {
    const keyField = entry.key ?? holderDeclaration.key
    if (keyField === undefined) return
    const param = target.params[0]!
    const keys = new Set<string>()
    for (const holder of holders) {
      if (entry.if !== undefined && !matchesWhere(entry.if, holder.built, { now: this.ports.now }))
        continue
      const key = holder.built[keyField]
      if (typeof key === 'string' && key !== '') keys.add(key)
    }
    const via = target.via!
    const pending = [...keys].filter(
      (key) => !this.marked.has(`${via}>${target.collection.id}:${key}`),
    )
    if (pending.length === 0) return
    const isParentWalk =
      target.kind === holderKind &&
      holderDeclaration.parentLink !== undefined &&
      entry.key === holderDeclaration.parentLink &&
      target.collection.name === 'one'
    const fresh: Visible[] = []
    if (isParentWalk) {
      // Its parent, and so every ancestor: one walk up, from the holders not walked yet.
      const start = holders.map((holder) => holder.id).filter((id) => !this.walked.has(id))
      for (const batch of chunks(start, KEYED_CHUNK)) {
        const ancestors = await this.ports.collections.ancestors(batch)
        for (const id of batch) this.walked.add(id)
        for (const id of ancestors) this.walked.add(id)
        const unsent = ancestors.filter((id) => !this.whole.has(keyOf(holderKind, id)))
        for (const ids of chunks(unsent, BUILD_CHUNK)) {
          const visible = await this.built(holderKind, ids, undefined, { args: {} })
          const out = this.fresh(holderKind, visible)
          fresh.push(...visible)
          if (out.length > 0) yield { type: 'records', records: out }
        }
      }
    } else {
      for (const batch of chunks(pending, KEYED_CHUNK)) {
        const args = paddedArgs({ ...this.ports.policyArgs, [param]: batch })
        const rows = await this.ports.collections.keyed(target, args, this.ports.now)
        const ids = this.ids(target.kind, rows).filter(
          (id) => !this.whole.has(keyOf(target.kind, id)),
        )
        for (const chunk of chunks(ids, BUILD_CHUNK)) {
          // The keyed SQL is exact: no comes-with target reads a JSON field.
          const visible = await this.built(target.kind, chunk, undefined, { args: {} })
          const out = this.fresh(target.kind, visible)
          fresh.push(...visible)
          if (out.length > 0) yield { type: 'records', records: out }
        }
      }
    }
    for (const key of pending) this.marked.add(`${via}>${target.collection.id}:${key}`)
    for (const batch of chunks(pending, 1000)) {
      yield {
        type: 'complete',
        instances: batch.map((key) => ({
          collection: target.collection.id,
          args: { [param]: key },
          part: 'main' as const,
          via,
        })),
      }
    }
    if (fresh.length > 0) arrived.set(target.kind, [...(arrived.get(target.kind) ?? []), ...fresh])
  }

  /**
   * What every record of a type comes with, for the records that arrived,
   * round by round until nothing new arrives. A record that arrived in an
   * earlier round of this answer is not asked about again.
   */
  private async *closure(arrived: Map<string, Visible[]>): AsyncGenerator<FetchOutput> {
    let round = new Map(arrived)
    for (let at = 0; round.size > 0; at++) {
      if (at === MAX_COMES_WITH_ROUNDS)
        throw new Error(
          'comes-with did not settle; the declarations form a longer chain than expected',
        )
      const next = new Map<string, Visible[]>()
      for (const [kind, records] of round) {
        const declaration = recordOf(kind)
        if (declaration === undefined || records.length === 0) continue
        for (const entry of declaration.comesWith) {
          const target = resolveRule(entry.collection, kind)
          yield* this.comesWith(kind, declaration, records, entry, target, next)
        }
      }
      round = next
    }
  }
}
