/** Kernel pull recovery across resume and retention loss; no pushed bootstrap fixture. */
import {
  ConformanceAuthority,
  type ConformancePrincipal,
  conformanceUser,
} from '@podium/sync/testing'
import {
  type BootstrapChunk,
  InMemoryReplicaStore,
  Replica,
  type ReplicaEvent,
} from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import type { FeedServerFrame } from '../../socket-transport'
import { FeedSink } from './sink'

const ALICE: ConformancePrincipal = conformanceUser('user:alice')


function openClient(authority: ConformanceAuthority) {
  const store = new InMemoryReplicaStore()
  const view = store.viewFor('default')
  const events: ReplicaEvent[] = []
  let bootstrapRequests = 0
const port = authority.portFor(ALICE)
  const replica = new Replica({
    store: view.cache,
    authority: {
        changesRange: (cursor, signal, target) => port.changesRange(cursor, signal, target),
        bootstrap: (signal) => {
          bootstrapRequests += 1
          return port.bootstrap(signal)
        },
      },
      onEvent: (event) => events.push(event),
  })
  const sink = new FeedSink({ replica })
  return {
    replica,
    sink,
    events,
    keys: () =>
      replica
        .entities()
        .map((row) => `${row.entity}:${row.entityId}`)
        .sort(),
    get bootstrapRequests() {
      return bootstrapRequests
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
  it('pulls a fresh snapshot when the resume cursor was compacted', async () => {
    const authority = new ConformanceAuthority()
    await authority.resolveIdentity()
    commit(authority, 's1')
    const client = openClient(authority)

    // A first, ordinary admission: no position to present, so a world is promised
    // and delivered. This is what gives the client the cursor it will present.
    client.sink.connected(true)
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
    await client.replica.settled()

    expect(client.keys()).toEqual(['session:s1', 'session:s2', 'session:s3'])
    expect(client.bootstrapRequests).toBe(2)
  })

  it('resumes from its own cursor when the server sends only a grant', async () => {
    const authority = new ConformanceAuthority()
    await authority.resolveIdentity()
    commit(authority, 's1')
    const client = openClient(authority)
    client.sink.connected(true)
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
    expect(client.bootstrapRequests).toBe(1)
    // No world was installed, and nothing asked for one: the whole point is that
    // the bytes never left the server.
    expect(client.events.filter((event) => event.type === 'heal')).not.toHaveLength(0)
  })
})
