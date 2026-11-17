/**
 * COLLECTIONS ON THE WIRE (POD-7085, design POD-7059 "Collections", "Policy",
 * "One loader, one route").
 *
 * A client asks for INSTANCES of declared collections (`@podium/model`
 * `records/declarations.ts`): a collection id with its arguments filled in,
 * the part it wants, and for a sorted, paged collection the position to
 * continue from. The answer is the HTTP sync stream (`sync-stream.ts`): a
 * `syncMeta` line, whole records in `feedBootstrap` frames, issue stubs in
 * `feedStubs` frames, and one `collectionComplete` line per batch of
 * instances that are now complete as of the answer's feed number.
 *
 * Nothing here is a per-screen question: a screen that needs another question
 * gets a collection definition, never a field on this request.
 */

import { ChangeSeqField, recordOf, SlimIssueProjection } from '@podium/model'
import { z } from 'zod'
import { CertifiedRangeFields } from './feed'

/** What kind of app is asking. The server's policy is per client type. */
export const ClientType = z.enum(['phone', 'browser', 'desktop'])
export type ClientType = z.infer<typeof ClientType>

/** The header a client names its type with. */
export const CLIENT_TYPE_HEADER = 'Podium-Client-Type'

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

/** The arguments of one instance ("the tree under X": `{ root: X }`). */
export const CollectionArgs = z.record(z.string().min(1), z.union([Scalar, z.array(Scalar)]))
export type CollectionArgs = z.infer<typeof CollectionArgs>

/** A sort position: the sort fields' values of the last record of a page, in sort order. */
export const SortKey = z.array(Scalar).nonempty()
export type SortKey = z.infer<typeof SortKey>

/** Most instances one request may name; a loader batches below it. */
export const COLLECTION_FETCH_MAX_INSTANCES = 200

/**
 * One instance: a declared collection with its arguments. `via` names the
 * holder that declares a "comes with" (`'issueProjection.sidebar'` for the
 * sidebar's sessions, `'session'` for what every session comes with), whose
 * declaration narrows the collection; a client asks for it when a record
 * enters the holder. `after` continues a paged collection below a position.
 */
export const CollectionInstance = z.object({
  collection: z.string().min(1),
  args: CollectionArgs.optional(),
  /** Only an issue collection may ask for `stub`; the default is the collection's part. */
  part: z.enum(['stub', 'main']).optional(),
  via: z.string().min(1).optional(),
  after: SortKey.optional(),
})
export type CollectionInstance = z.infer<typeof CollectionInstance>

/** The body of `POST /sync/collections`. */
export const CollectionFetchRequest = z.object({
  instances: z.array(CollectionInstance).min(1).max(COLLECTION_FETCH_MAX_INSTANCES),
})
export type CollectionFetchRequest = z.infer<typeof CollectionFetchRequest>

/** One step of the first download, in the order the policy loads it. */
export const PolicyStep = z.object({
  step: z.enum(['always', 'view', 'recent', 'sidebar', 'stubs']),
  /** The collections this step holds (none for `view`, whose instances the client names). */
  collections: z.array(z.string().min(1)),
})
export type PolicyStep = z.infer<typeof PolicyStep>

/**
 * The server's policy for one client type, sent in the load header: which
 * collections the client always holds and in which order they load, how many
 * days "recent" reaches back, and how many records the client may keep as
 * cache. The client never chooses these.
 */
export const SyncPolicy = z.object({
  clientType: ClientType,
  steps: z.array(PolicyStep).nonempty(),
  recentDays: z.number().int().positive(),
  /** Records held as cache beyond the policy's collections. */
  cacheCap: z.number().int().nonnegative(),
})
export type SyncPolicy = z.infer<typeof SyncPolicy>

/** Where a paged instance is complete to: from the top down to `through`, or to its end. */
export const CollectionRange = z.object({
  /** The sort position of the last record sent; absent when the page is empty. */
  through: SortKey.optional(),
  /** True when nothing follows `through`: the instance is complete in full. */
  end: z.boolean(),
})
export type CollectionRange = z.infer<typeof CollectionRange>

/** One instance that is complete as of the marker's `seq`, for this viewer. */
export const CompleteInstance = z.object({
  collection: z.string().min(1),
  args: CollectionArgs.optional(),
  part: z.enum(['stub', 'main']),
  via: z.string().min(1).optional(),
  /** A paged instance: how far it is complete. */
  range: CollectionRange.optional(),
  /** A paged instance's first page: how many records the whole instance holds for this viewer. */
  total: z.number().int().nonnegative().optional(),
})
export type CompleteInstance = z.infer<typeof CompleteInstance>

/**
 * The marker: every record of these instances that this viewer may see was
 * sent in this answer at or before this line, as of `seq`. A client writes it
 * after installing the records before it.
 */
export const CollectionComplete = z.object({
  type: z.literal('collectionComplete'),
  feedId: CertifiedRangeFields.feedId,
  epoch: CertifiedRangeFields.epoch,
  seq: CertifiedRangeFields.seq,
  instances: z.array(CompleteInstance).nonempty(),
})
export type CollectionComplete = z.infer<typeof CollectionComplete>

/** The issue stub's fields, read off the declaration: reference, state, parent. */
export const ISSUE_STUB_FIELDS: readonly string[] = recordOf('issueProjection').stub

/**
 * The stub part of an issue record: its declared stub fields, picked from the
 * slim issue record, so state and parent have one home.
 */
export const IssueStubWire = SlimIssueProjection.pick(
  Object.fromEntries(ISSUE_STUB_FIELDS.map((field) => [field, true])) as {
    [K in keyof z.infer<typeof SlimIssueProjection>]?: true
  },
)
export type IssueStubWire = z.infer<typeof IssueStubWire>

/** One issue at stub level: the issue record's own entity, with only its stub part. */
export const FeedStubChange = z.object({
  seq: ChangeSeqField,
  entity: z.literal('issueProjection'),
  entityId: z.string().min(1),
  op: z.literal('upsert'),
  part: z.literal('stub'),
  value: IssueStubWire,
})
export type FeedStubChange = z.infer<typeof FeedStubChange>

/** A chunk of issue stubs, in the answer's snapshot. Not a record kind of its own. */
export const FeedStubsMessage = z.object({
  type: z.literal('feedStubs'),
  ...CertifiedRangeFields,
  changes: z.array(FeedStubChange),
})
export type FeedStubsMessage = z.infer<typeof FeedStubsMessage>
