/**
 * THE AUTHORITY, AS THE CLIENT REPLICA SEES IT (POD-376).
 *
 * `AuthorityReadPort` has exactly two members and they are the two halves of ADR
 * 2 D7's ladder that reach off-client: `changesSince` is rung 1's heal, and
 * `bootstrap` is where rungs 2–6 all terminate. This class is that port over the
 * v2 wire — an HTTP query for the first, and the pushed-bootstrap seam for the
 * second.
 *
 * NO PRINCIPAL PARAMETER, ANYWHERE. `replica/ports.ts` states the reason and it is
 * worth restating at the one place a network call is actually made: ADR 3 D7 takes
 * the principal from the authenticated transport only, so the slice this client
 * receives is decided by the cookie it presents and by nothing it could put in a
 * request body. A `principal` argument here would be payload identity AND would
 * hand the replica a lever over its own slice.
 *
 * NO RETRY, NO BACKOFF, NO CACHING. A failed heal throws, the Replica's ladder
 * takes it to a re-bootstrap, and the bootstrap has its own bounded attempt
 * count. Retrying here would make two ladders — one of which nothing observes.
 */

import type {
  AuthorityReadPort,
  BootstrapChunk,
  ChangesSinceReply,
  Cursor,
} from '@podium/sync/replica'
import type { PushedBootstrapSource } from './bootstrap-source'

/** The wire answer to `sync.feedChangesSince`, structurally. Declared rather than
 *  imported from the server's router type so this package keeps no edge to it. */
export type FeedChangesSinceReply =
  | {
      readonly kind: 'delta'
      readonly feedId: string
      readonly epoch: string
      readonly fromSeq: number
      readonly seq: number
      readonly minAvailableSeq: number
      readonly changes: readonly {
        readonly seq: number
        readonly entity: string
        readonly entityId: string
        readonly op: 'upsert' | 'remove' | 'evict'
        readonly value?: unknown
      }[]
    }
  | { readonly kind: 'bootstrap-required'; readonly reason?: string }

export interface FeedAuthorityClientDeps {
  /** Bound to the `sync.feedChangesSince` tRPC query. */
  fetchChangesSince(cursor: Cursor): Promise<FeedChangesSinceReply>
  readonly bootstraps: PushedBootstrapSource
}

export class FeedAuthorityClient implements AuthorityReadPort {
  constructor(private readonly deps: FeedAuthorityClientDeps) {}

  async changesSince(cursor: Cursor): Promise<ChangesSinceReply> {
    const reply = await this.deps.fetchChangesSince(cursor)
    if (reply.kind === 'bootstrap-required') {
      return { kind: 'bootstrap-required', ...(reply.reason === undefined ? {} : { reason: reply.reason }) }
    }
    return {
      kind: 'delta',
      feedId: reply.feedId,
      epoch: reply.epoch,
      fromSeq: reply.fromSeq,
      seq: reply.seq,
      minAvailableSeq: reply.minAvailableSeq,
      changes: reply.changes.map((change) =>
        change.op === 'upsert'
          ? {
              seq: change.seq,
              entity: change.entity,
              entityId: change.entityId,
              op: 'upsert' as const,
              payload: change.value,
            }
          : {
              seq: change.seq,
              entity: change.entity,
              entityId: change.entityId,
              op: change.op,
            },
      ),
    }
  }

  bootstrap(): AsyncIterable<BootstrapChunk> {
    return this.deps.bootstraps.bootstrap()
  }
}
