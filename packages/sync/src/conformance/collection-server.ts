/**
 * A SMALL SERVER FOR THE COLLECTION CASES (POD-7086): a world of records, a
 * feed log, a policy, and the two load routes the Replica reads — the first
 * download (`bootstrap`) and the collection fetch (`collections`) — answered
 * in chunks with a marker per instance, as POD-7085's route does.
 *
 * Membership is the declared rule evaluated over the world's values. That is
 * the same evaluator the client uses, which is right for a fixture of the
 * DEVICE store: the server's SQL agreeing with it is the shared rule corpus's
 * job (`@podium/model` `rule-corpus.ts`), not this suite's.
 *
 * Every answer can be held at a gate, cut after N chunks, or answered as of a
 * chosen feed number, which is what the ordering and resume cases need.
 */

import { COLLECTIONS, matchesWhere, recordOf } from '@podium/model'
import { policyArgs, resolveInstance, stubOfValue } from '../replica/holdings'
import type { AuthorityReadPort } from '../replica/ports'
import type {
  BootstrapChunk,
  BootstrapRequired,
  CachePolicy,
  ChangeEnvelope,
  CompleteMarker,
  Cursor,
  DeltaFrame,
  InstanceRequest,
  InstanceSpec,
} from '../replica/types'

/** 2026-11-18T12:00:00Z: every "recent" rule in the cases compares against it. */
export const WORLD_NOW = Date.parse('2026-11-18T12:00:00.000Z')
/** A time inside every "recent" window. */
export const RECENTLY = new Date(WORLD_NOW - 86_400_000).toISOString()
/** A time outside every "recent" window. */
export const LONG_AGO = new Date(WORLD_NOW - 400 * 86_400_000).toISOString()

/** The policy the cases load unless they name another. */
export const WORLD_POLICY: CachePolicy = {
  clientType: 'browser',
  steps: [
    { step: 'live', collections: ['session.live'] },
    { step: 'sidebar', collections: ['issueProjection.sidebar'] },
    { step: 'stubs', collections: ['issueProjection.stubs'] },
  ],
  recentDays: 30,
  cacheCap: 1_000,
}

interface WorldRow {
  readonly entity: string
  readonly id: string
  readonly value: Readonly<Record<string, unknown>>
  readonly seq: number
}

const rowKey = (entity: string, id: string): string => `${entity}\u0000${id}`

/** An issue value with the fields the declared rules read. */
export function issue(
  id: string,
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    repoId: 'repo-1',
    seq: Number(id.replace(/\D/g, '')) || 1,
    title: `Issue ${id}`,
    stage: 'in_progress',
    closedReason: null,
    archived: false,
    deletedAt: null,
    isDraftVessel: false,
    audience: 'team',
    parentId: null,
    updatedAt: LONG_AGO,
    ...fields,
  }
}

/** A session value with the fields the declared rules read. */
export function session(
  sessionId: string,
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    sessionId,
    status: 'live',
    issueId: null,
    archived: false,
    headless: false,
    agentKind: 'claude',
    lastActiveAt: LONG_AGO,
    offer: null,
    ...fields,
  }
}

export class CollectionServer implements AuthorityReadPort {
  readonly feedId = 'feed'
  readonly epoch = 'epoch'
  head = 0
  minAvailableSeq = 0
  /** Rows per chunk of an answer. */
  chunkRows = 2
  policy: CachePolicy = WORLD_POLICY
  /** The record shapes every answer certifies. */
  kindTokens: Readonly<Record<string, string>> = {}
  /** Every first download asked for. */
  bootstraps = 0
  /** Every collection fetch asked for, in order. */
  readonly fetches: InstanceRequest[][] = []
  /** Answer collection fetches as of this feed number instead of the head. */
  answerSeq: number | undefined
  /** Hold every answer before its first chunk until this resolves. */
  gate: Promise<void> | undefined
  /** Stop every answer after this many chunks, as a process that died does: it never resumes. */
  dieAfterChunks: number | undefined
  private chunksServed = 0
  private readonly rows = new Map<string, WorldRow>()
  private readonly log: ChangeEnvelope[] = []

  /** Write a record; returns its feed change. */
  put(entity: string, id: string, value: Readonly<Record<string, unknown>>): ChangeEnvelope {
    this.head += 1
    this.rows.set(rowKey(entity, id), { entity, id, value, seq: this.head })
    const change: ChangeEnvelope = {
      seq: this.head,
      entity,
      entityId: id,
      op: 'upsert',
      payload: value,
    }
    this.log.push(change)
    return change
  }

  /** Delete a record (`remove`) or take it out of this viewer's sight (`evict`). */
  drop(entity: string, id: string, op: 'remove' | 'evict' = 'remove'): ChangeEnvelope {
    this.head += 1
    this.rows.delete(rowKey(entity, id))
    const change: ChangeEnvelope = { seq: this.head, entity, entityId: id, op }
    this.log.push(change)
    return change
  }

  /** The feed frame covering `(from, head]`. */
  frameSince(from: number): DeltaFrame {
    return {
      kind: 'delta',
      feedId: this.feedId,
      epoch: this.epoch,
      fromSeq: from,
      seq: this.head,
      minAvailableSeq: this.minAvailableSeq,
      changes: this.log.filter((change) => change.seq > from),
    }
  }

  cursorAt(seq: number = this.head): Cursor {
    return { feedId: this.feedId, epoch: this.epoch, seq }
  }

  async changesRange(cursor: Cursor): Promise<AsyncIterable<DeltaFrame> | BootstrapRequired> {
    if (cursor.seq < this.minAvailableSeq)
      return { kind: 'bootstrap-required', reason: 'compacted' }
    const frame = cursor.seq < this.head ? this.frameSince(cursor.seq) : undefined
    return (async function* () {
      if (frame !== undefined) yield frame
    })()
  }

  bootstrap(): AsyncIterable<BootstrapChunk> {
    this.bootstraps += 1
    const instances = this.policy.steps.flatMap((step) =>
      step.collections.map((collection) => ({
        collection,
        part: COLLECTIONS.get(collection)?.part ?? 'main',
      })),
    )
    return this.answer(instances, this.head, true)
  }

  collections(instances: readonly InstanceRequest[]): AsyncIterable<BootstrapChunk> {
    this.fetches.push([...instances])
    return this.answer(instances, this.answerSeq ?? this.head, false)
  }

  /** The world's members of one instance, as the server would select them. */
  members(spec: InstanceSpec): WorldRow[] {
    const resolved = resolveInstance(spec, policyArgs(this.policy))
    if (resolved === undefined) throw new Error(`undeclared collection ${spec.collection}`)
    const declaration = recordOf(resolved.of)
    const parentLink = declaration?.parentLink
    const key = declaration?.key
    const of = resolved.of
    return [...this.rows.values()]
      .filter((row) => row.entity === of)
      .filter(
        (row) =>
          resolved.where === undefined ||
          matchesWhere(resolved.where, row.value, {
            now: WORLD_NOW,
            args: resolved.args,
            ...(parentLink === undefined
              ? {}
              : {
                  parentOf: (id: string) => {
                    const parent = this.rows.get(rowKey(of, id))?.value[parentLink]
                    return parent === undefined ? undefined : ((parent as string | null) ?? null)
                  },
                }),
            ...(key === undefined
              ? {}
              : { idOf: (record: Readonly<Record<string, unknown>>) => record[key] as string }),
          }),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private answer(
    instances: readonly InstanceSpec[],
    at: number,
    first: boolean,
  ): AsyncIterable<BootstrapChunk> {
    const chunks: BootstrapChunk[] = []
    const base = {
      feedId: this.feedId,
      epoch: this.epoch,
      snapshotSeq: at,
      last: false,
      kindTokens: { ...this.kindTokens },
    }
    for (const spec of instances) {
      const stub = spec.part === 'stub'
      const rows = this.members(spec).filter((row) => row.seq <= at)
      const envelopes = rows.map(
        (row): ChangeEnvelope => ({
          seq: row.seq,
          entity: row.entity,
          entityId: row.id,
          op: 'upsert',
          payload: stub ? stubOfValue(row.entity, row.value) : row.value,
        }),
      )
      const marker: CompleteMarker = {
        collection: spec.collection,
        part: spec.part,
        ...(spec.args === undefined ? {} : { args: spec.args }),
        ...(spec.via === undefined ? {} : { via: spec.via }),
      }
      if (envelopes.length === 0) chunks.push({ ...base, changes: [], complete: [marker] })
      for (let offset = 0; offset < envelopes.length; offset += this.chunkRows) {
        const slice = envelopes.slice(offset, offset + this.chunkRows)
        const lastOfInstance = offset + this.chunkRows >= envelopes.length
        chunks.push({
          ...base,
          changes: stub ? [] : slice,
          ...(stub ? { stubs: slice } : {}),
          ...(lastOfInstance ? { complete: [marker] } : {}),
        })
      }
    }
    chunks.push({ ...base, changes: [], last: true })
    if (first) chunks[0] = { ...chunks[0]!, policy: this.policy }
    const server = this
    const gate = this.gate
    return (async function* () {
      if (gate !== undefined) await gate
      for (const chunk of chunks) {
        if (server.dieAfterChunks !== undefined && server.chunksServed >= server.dieAfterChunks) {
          // The process died here: the answer never continues.
          await new Promise<never>(() => {})
        }
        server.chunksServed += 1
        yield chunk
      }
    })()
  }

  /** Chunks served so far, across every answer. */
  get served(): number {
    return this.chunksServed
  }
}
