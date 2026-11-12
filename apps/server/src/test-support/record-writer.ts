/**
 * A commit writer for a SERVICE test: an Authority over an in-memory change
 * log, with the server's record source over the test's own store, so a
 * commit drains the store's change capture and builds the records its write
 * reached as production does (POD-6920). `appended` holds every change the
 * commits appended, in order.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import {
  Authority,
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
  type EntityChangeSpec,
  type LedgerWriter,
  type RecordSourcePort,
} from '@podium/sync'
import { authorityCommitWriter, memoryChangeLog } from '@podium/sync/testing'
import { databaseRecords } from '../sync/record-source'
import type { RecordReads } from '../sync/record-builders'

/**
 * The record source of a test's own Ledger over a real store: what
 * `relay.ts` gives the production Ledger, so a service under test has its
 * writes captured and built the same way.
 */
export function testStoreRecords(
  store: RecordReads['store'],
  opts: {
    now?: () => number
    effectExecutors?: RecordReads['effectExecutors']
    confirmedPerSession?: number
    eventWindow?: number
  } = {},
): RecordSourcePort {
  return databaseRecords({
    store,
    effectExecutors: opts.effectExecutors ?? { get: () => undefined },
    now: opts.now ?? (() => Date.now()),
    ...(opts.confirmedPerSession === undefined
      ? {}
      : { confirmedPerSession: opts.confirmedPerSession }),
    ...(opts.eventWindow === undefined ? {} : { eventWindow: opts.eventWindow }),
  })
}

export interface RecordTestWriter {
  readonly writer: Pick<LedgerWriter, 'commit'>
  readonly appended: EntityChangeSpec[]
}

/**
 * `store` holds the repositories the test's kinds read and `sync` (the
 * capture's drain); `transact` is the store's unit of work when the test has
 * one (the default runs the commit with no rollback). `kinds` limits the
 * records appended to a subset.
 */
export function recordTestWriter(
  store: Partial<RecordReads['store']>,
  opts: {
    kinds?: readonly MetadataEntityKind[]
    transact?: <T>(fn: () => Promise<T>) => Promise<T>
    now?: () => number
    effectExecutors?: RecordReads['effectExecutors']
  } = {},
): RecordTestWriter {
  const appended: EntityChangeSpec[] = []
  const authority = new Authority({
    store: memoryChangeLog(),
    now: opts.now ?? (() => 1_000),
    transact: opts.transact ?? ((fn) => fn()),
    visibility: new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
    records: databaseRecords(
      {
        store: store as RecordReads['store'],
        effectExecutors: opts.effectExecutors ?? { get: () => undefined },
        now: opts.now ?? (() => 1_000),
      },
      opts.kinds,
    ),
  })
  return {
    writer: authorityCommitWriter(authority, (changes) => appended.push(...changes)),
    appended,
  }
}
