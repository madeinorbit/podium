/**
 * WHAT A RESUMING CONNECTION COSTS WHEN THE SERVER SAYS NO (POD-2061).
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS FILE EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 *
 * Presenting a cursor makes the initial world CONDITIONAL, and the conditional
 * branch — the server refuses the cursor and pushes the world anyway — is where
 * the cost of the whole feature can quietly land. `PushedBootstrapSource` only
 * hands a walk a world that was offered AFTER the walk began; on this path the
 * world arrives FIRST (at admission) and the walk begins later (when the heal
 * comes back `bootstrap-required`). If the seam does not recognise that world as
 * one this connection was owed, the walk drops it and calls `requestFreshWorld`,
 * which is a SOCKET CYCLE — the client tears down a healthy connection to fetch a
 * world already sitting in its own slot, and every refused cursor now costs more
 * than the full-world push it replaced.
 *
 * So the assertion that matters here is `freshWorldRequests === 0`. It is not an
 * optimisation check: `requestFreshWorld` rides the reconnect backoff, and the
 * seam's own comments record a live heal-loop from exactly this area.
 *
 * Everything under test is real — the shipped `Replica`, `PushedBootstrapSource`,
 * `FeedSink` and `ConformanceAuthority`. The only thing modelled is the socket:
 * frames are handed to the sink in the order a server would send them.
 */

import { ConformanceAuthority, type ConformancePrincipal, conformanceUser } from '@podium/sync'
import {
  type BootstrapChunk,
  InMemoryReplicaStore,
  Replica,
  type ReplicaEvent,
} from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import type { FeedServerFrame } from '../../socket-transport'
import { FeedAuthorityClient } from './authority-client'
import { PushedBootstrapSource } from './bootstrap-source'
import { FeedSink } from './sink'

const ALICE: ConformancePrincipal = conformanceUser('user:alice')

function asWireBootstrap(chunk: BootstrapChunk): FeedServerFrame {
  return {
    type: 'feedBootstrap',
    feedId: chunk.feedId,
    epoch: chunk.epoch,
    fromSeq: 0,
    seq: chunk.snapshotSeq,
    minAvailableSeq: 0,
    changes: chunk.changes.map((change) => ({
      seq: change.seq,
      entity: change.entity,
      entityId: change.entityId,
      op: 'upsert',
      value: change.payload,
    })),
    last: chunk.last,
  } as FeedServerFrame
}

function openClient(authority: ConformanceAuthority) {
  const store = new InMemoryReplicaStore()
  const view = store.viewFor('default')
  const events: ReplicaEvent[] = []
  let freshWorldRequests = 0
  const bootstraps = new PushedBootstrapSource({
    requestFreshWorld: () => {
      freshWorldRequests += 1
      // The transport would cycle the socket and the server would push. Modelled
      // so a case that DOES cycle still completes and fails on the counter,
      // rather than hanging until the 30 s chunk timeout and failing on time.
      pushWorld()
    },
  })
  const port = authority.portFor(ALICE)
  const replica = new Replica({
    store: view.cache,
    authority: new FeedAuthorityClient({
      fetchChangesSince: async (cursor) => {
        const reply = await port.changesSince(cursor)
        if (reply.kind === 'bootstrap-required') {
          return {
            kind: 'bootstrap-required',
            ...(reply.reason === undefined ? {} : { reason: reply.reason }),
          }
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
                  value: change.payload,
                }
              : {
                  seq: change.seq,
                  entity: change.entity,
                  entityId: change.entityId,
                  op: change.op,
                },
          ),
        }
      },
      bootstraps,
    }),
    onEvent: (event) => events.push(event),
  })
  const sink = new FeedSink({ replica, bootstraps })
  const pushWorld = (): void => {
    void (async () => {
      for await (const chunk of port.bootstrap()) sink.frame(asWireBootstrap(chunk))
    })()
  }
  return {
    replica,
    sink,
    events,
    pushWorld,
    keys: () =>
      replica
        .entities()
        .map((row) => `${row.entity}:${row.entityId}`)
        .sort(),
    get freshWorldRequests() {
      return freshWorldRequests
    },
  }
}

/** One row this principal may see. The grant is part of it: under
 *  private-by-default an ungranted row is invisible, and a case built out of
 *  invisible rows would assert an empty replica in every arm. */
function commit(authority: ConformanceAuthority, id: string): void {
  authority.append({ entity: 'session', entityId: id, op: 'upsert', payload: { id } })
  authority.grant('user:alice', 'session', id)
}

describe('a connection that presented a cursor', () => {
  it('completes a refused-cursor walk from the pushed world, without a socket cycle', async () => {
    const authority = new ConformanceAuthority()
    commit(authority, 's1')
    const client = openClient(authority)

    // A first, ordinary admission: no position to present, so a world is promised
    // and delivered. This is what gives the client the cursor it will present.
    client.sink.connected(true)
    client.pushWorld()
    await client.replica.settled()
    expect(client.replica.cursor).not.toBeNull()

    client.sink.disconnected()

    // While it was away the log moved AND compacted past its cursor: the heal it
    // is about to run can only answer `bootstrap-required`, which is precisely
    // the case where a server refuses the presented cursor.
    commit(authority, 's2')
    commit(authority, 's3')
    authority.compactTo(authority.head())

    // THE RECONNECT, in wire order: `hello` carried the cursor, the server
    // refused it, and the world it sent instead arrives before the client's heal
    // has come back.
    client.sink.connected(false)
    client.pushWorld()
    await client.replica.settled()

    expect(client.keys()).toEqual(['session:s1', 'session:s2', 'session:s3'])
    expect(client.freshWorldRequests).toBe(0)
  })

  it('resumes from its own cursor when the server sends only a grant', async () => {
    const authority = new ConformanceAuthority()
    commit(authority, 's1')
    const client = openClient(authority)
    client.sink.connected(true)
    client.pushWorld()
    await client.replica.settled()
    const held = client.replica.cursor
    if (held === null) throw new Error('the first admission left no cursor')

    client.sink.disconnected()
    commit(authority, 's2')

    // A GRANTED cursor: one small frame, no world, and the rows committed while
    // the client was away are covered by its own rung-1 heal — the read it runs
    // on every reconnect anyway.
    client.sink.connected(false)
    client.sink.frame({
      type: 'feedResume',
      feedId: held.feedId,
      epoch: held.epoch,
      seq: held.seq,
    })
    await client.replica.settled()

    expect(client.keys()).toEqual(['session:s1', 'session:s2'])
    expect(client.freshWorldRequests).toBe(0)
    // No world was installed, and nothing asked for one: the whole point is that
    // the bytes never left the server.
    expect(client.events.filter((event) => event.type === 'heal')).not.toHaveLength(0)
  })
})
