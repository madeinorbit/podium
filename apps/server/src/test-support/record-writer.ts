/**
 * A commit writer for a SERVICE test whose kind compares at save (POD-6769):
 * an Authority over an in-memory change log, with the server's record builders
 * over the test's own store, so a commit's named records are built around its
 * write as production builds them. `appended` holds every change the commits
 * appended, in order.
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
import { COMPARE_AT_SAVE_KINDS, compareAtSaveRecords } from '../sync/compare-at-save'
import type { RecordReads } from '../sync/record-builders'

/**
 * The record source of a test's own Ledger over a real store: what
 * `relay.ts` gives the production Ledger, so a service under test that names
 * records (a moved kind) is built around its write the same way.
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
  return compareAtSaveRecords({
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
 * `store` holds only the repositories the test's kinds read; `transact` is the
 * store's unit of work when the test has one (the default runs the commit with
 * no rollback).
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
    records: compareAtSaveRecords(
      {
        store: store as RecordReads['store'],
        effectExecutors: opts.effectExecutors ?? { get: () => undefined },
        now: opts.now ?? (() => 1_000),
      },
      opts.kinds ?? COMPARE_AT_SAVE_KINDS,
    ),
  })
  return {
    writer: authorityCommitWriter(authority, (changes) => appended.push(...changes)),
    appended,
  }
}
