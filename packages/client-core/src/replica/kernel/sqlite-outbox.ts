/**
 * THE OUTBOX'S DURABLE HOME ON MOBILE — the kernel outbox store, not a blob.
 *
 * ADR 6 D1 names outbox entries among what localStorage and AsyncStorage "MUST NOT
 * hold ... on any path — including 'degraded'", and D4.1 wants the queue in the same
 * transaction as the entity rows it is optimistic about. `SideCache` satisfies
 * neither for the outbox: it is a `StorageApi` blob store, which on mobile means
 * AsyncStorage. So mobile passes THIS through `KernelReplicaInit.outbox` and the
 * queue lands in the same SQLite file, and the same commit, as the entities.
 *
 * THE SHAPE MISMATCH THAT MADE THIS LOOK IMPOSSIBLE, AND WHY IT IS NOT. POD-1228
 * declined to put the facade over `OutboxStorePort` because the kernel's
 * `OutboxRecord` and the client Outbox's `OutboxEntry` are different shapes, and
 * that is true — but the difference is a MAPPING, and only three fields of it are
 * hard:
 *
 *   `baseline` and `chained` (issue 263 findings 2 and round 2) and `resolvedAt`
 *   are client-side overlay bookkeeping with no kernel counterpart. Dropping them
 *   is not cosmetic: `baseline` is how resolution tells "server truth moved while I
 *   was in flight" from "a competing writer won", and `chained` is what stops a
 *   predecessor's echo being read as that competing writer. A lossy round trip here
 *   would silently break the optimistic overlay on every reload, which is precisely
 *   the class of bug those two fields were added to fix.
 *
 * They survive because the SQLite adapter stores the record with `JSON.stringify`
 * and reads it back with `JSON.parse` VERBATIM (`store.ts` — the row's `record`
 * column is opaque to it). So a record carrying extra fields round-trips intact,
 * and a kernel consumer that only knows `OutboxRecord` simply ignores them. That is
 * asserted below rather than assumed, because it is a property of the adapter's
 * implementation rather than of the port's contract, and it is the single fact this
 * whole module rests on.
 *
 * WHY `load()` READS A MIRROR. `OutboxStorage.load()` is SYNCHRONOUS and
 * `OutboxStorePort.read()` returns a promise, so the two cannot be composed
 * directly. They are reconciled the way the store itself is: hydrate once, then
 * serve reads from an in-memory mirror that every write updates. The caller awaits
 * {@link createKernelOutboxStorage} before handing the facade over — the same
 * "hydrate before you construct" discipline `SqliteSyncStore.open` already imposes,
 * and for the same reason (an un-hydrated store answers every read with an empty
 * slice, which is indistinguishable from a cold client).
 *
 * WHY A SYNCHRONOUS `save()` OVER AN ASYNCHRONOUS `apply()` IS SOUND HERE — AND ONLY
 * HERE. `SqliteOutboxStore.apply` with no span calls `store.autocommit`, which is
 * synchronous, so the durable commit has already happened by the time the promise is
 * created. THIS IS ADAPTER-SPECIFIC AND MUST NOT BE GENERALISED: IndexedDB's commit
 * is genuinely asynchronous — it is why POD-374 had to publish before durability —
 * so a web binding written to this shape would silently reintroduce the write-behind
 * tail loss ADR 6 D1 rejects AsyncStorage for. It cannot be checked at runtime from
 * here (see `save`); it is pinned by a test that reads through a second connection
 * with nothing awaited in between, which an async-commit adapter fails.
 *
 * A DENIED WRITE IS REPORTED, LOUDLY — but not rethrown synchronously, and the
 * difference is honest rather than convenient: `apply` is async, so no outcome is
 * observable before `save()` returns. `writeQueued` on the side-cache path CAN
 * rethrow because `StorageApi.setItem` is synchronous. Here the loss reaches
 * `onDegraded` and through it the UI, which is what D4.4 clause 3 requires; see
 * `save` for why the rethrow was removed rather than faked.
 */

import type { OutboxStorePort } from '@podium/sync/outbox'
import type {
  OutboxAttribution,
  OutboxCommand,
  OutboxRecord,
  OutboxRecordExpectation,
} from '@podium/sync/outbox'
import type { MutationId } from '@podium/protocol'
import type { OutboxEntry, OutboxStorage } from '../../outbox'

/**
 * A kernel record carrying the client Outbox's own bookkeeping.
 *
 * Extra fields on a durable record are usually a smell; here they are the
 * alternative to a lossy mapping, and they are contained: nothing in the kernel
 * reads them, and the one place they are produced and consumed is this file.
 */
export interface ClientOutboxRecord extends OutboxRecord {
  /** `OutboxEntry.baseline` — the target row's replica fingerprint at enqueue. */
  readonly clientBaseline?: string
  /** `OutboxEntry.chained` — a same-row entry already existed at enqueue. */
  readonly clientChained?: boolean
  /** `OutboxEntry.resolvedAt` — when the executor resolved. */
  readonly clientResolvedAt?: number
}

export interface KernelOutboxStorageInit {
  readonly outbox: OutboxStorePort
  /**
   * Resolves a client entry's bare `kind` to the contract it was authored under.
   *
   * Required for the same reason `readLegacyReplica` requires it: `OutboxCommand`
   * carries `{name, version, delivery}` and an entry carries only a name, so
   * guessing a version would re-author the write under a contract its input may
   * not satisfy (ADR 3 D9).
   */
  readonly resolveCommand: (kind: string) => OutboxCommand | undefined
  readonly attribution: OutboxAttribution
  /** Surfaced, never swallowed (D4.4 clause 3). Called before the rethrow. */
  readonly onDegraded: (error: unknown) => void
}

export interface KernelOutboxStorages {
  readonly queued: OutboxStorage
  readonly awaiting: OutboxStorage
}

/**
 * `OutboxEntry.state === 'awaiting-truth'` is D9's `accepted` — "the Authority took
 * it, it has not been applied to my view yet". The mapping is POD-377's, and it is
 * the one that matters: reading an awaiting entry back as `queued` would RE-SEND a
 * mutation the Authority already accepted, which is the bug that made the legacy
 * path keep the two in separate stores.
 */
const AWAITING_STATE = 'accepted' as const

function toRecord(
  entry: OutboxEntry,
  init: KernelOutboxStorageInit,
  command: OutboxCommand,
): ClientOutboxRecord {
  return {
    mutationId: entry.mutationId as MutationId,
    command,
    input: entry.input,
    // ADR 3 D12 is FIFO within a partition and the contract's target extractor
    // computes the key from data a client entry does not carry. One partition for
    // the whole client queue is over-serialised and correct; splitting by
    // mutationId would give every entry its own and lose the ordering between two
    // edits of the same row — the thing `chained` exists to track.
    partitionKey: CLIENT_PARTITION,
    attribution: init.attribution,
    state: entry.state === 'awaiting-truth' ? AWAITING_STATE : 'queued',
    queuedAt: entry.queuedAt,
    attempts: 0,
    ...(entry.baseline === undefined ? {} : { clientBaseline: entry.baseline }),
    ...(entry.chained === undefined ? {} : { clientChained: entry.chained }),
    ...(entry.resolvedAt === undefined ? {} : { clientResolvedAt: entry.resolvedAt }),
  }
}

function toEntry(record: ClientOutboxRecord): OutboxEntry {
  return {
    mutationId: record.mutationId,
    kind: record.command.name,
    input: record.input,
    queuedAt: record.queuedAt,
    ...(record.state === AWAITING_STATE ? { state: 'awaiting-truth' as const } : {}),
    ...(record.clientBaseline === undefined ? {} : { baseline: record.clientBaseline }),
    ...(record.clientChained === undefined ? {} : { chained: record.clientChained }),
    ...(record.clientResolvedAt === undefined ? {} : { resolvedAt: record.clientResolvedAt }),
  }
}

/** The one ordering partition the whole client queue shares — see `toRecord`. */
export const CLIENT_PARTITION = 'client-outbox'

/**
 * Hydrate the mirror and return the two homes.
 *
 * The two `OutboxStorage`s are VIEWS over ONE kernel store, split by state rather
 * than by table: `queued` owns everything that is not accepted, `awaiting` owns what
 * is. That is why each `save` may only add, replace and remove within its OWN half —
 * a whole-store write from one view would silently delete the other's rows, which is
 * exactly the clobbering `OutboxStorePort.apply`'s record-level contract warns about.
 */
export async function createKernelOutboxStorage(
  init: KernelOutboxStorageInit,
): Promise<KernelOutboxStorages> {
  const mirror = new Map<string, ClientOutboxRecord>()
  for (const record of await init.outbox.read()) {
    mirror.set(record.mutationId, record as ClientOutboxRecord)
  }

  const inHome = (record: ClientOutboxRecord, awaiting: boolean): boolean =>
    (record.state === AWAITING_STATE) === awaiting

  const view = (awaiting: boolean): OutboxStorage => ({
    load: () =>
      [...mirror.values()]
        .filter((record) => inHome(record, awaiting))
        .sort((a, b) => a.queuedAt - b.queuedAt)
        .map(toEntry),

    save: (entries: OutboxEntry[]) => {
      const next = new Map<string, ClientOutboxRecord>()
      for (const entry of entries) {
        const command = init.resolveCommand(entry.kind)
        if (command === undefined) {
          // Refused rather than guessed, and LOUDLY: an entry whose contract cannot
          // be resolved is user work we are about to fail to persist, which is the
          // same loss class as a quota denial.
          const error = new Error(
            `[podium] OUTBOX persistence failed — no contract resolves '${entry.kind}'; ` +
              'this queued write cannot be stored and would be LOST',
          )
          init.onDegraded(error)
          throw error
        }
        next.set(entry.mutationId, toRecord(entry, init, command))
      }

      const put = [...next.values()]
      // Only this home's rows may be removed — see the header on why a whole-store
      // write would clobber the other view.
      const remove = [...mirror.values()]
        .filter((record) => inHome(record, awaiting) && !next.has(record.mutationId))
        .map((record) => record.mutationId)

      const expect: OutboxRecordExpectation[] = [
        ...put.map((record) => ({
          mutationId: record.mutationId,
          expect: (mirror.get(record.mutationId)?.state ?? 'absent') as
            | OutboxRecord['state']
            | 'absent',
        })),
        ...remove.map((mutationId) => ({
          mutationId,
          expect: mirror.get(mutationId)?.state as OutboxRecord['state'],
        })),
      ]

      // WHY THERE IS NO SYNCHRONOUS RETHROW FOR A STORAGE FAILURE, and why that is a
      // limitation rather than a choice. `OutboxStorePort.apply` is an `async`
      // function: even when the durable commit happens synchronously inside it —
      // which on SQLite it does, via `store.autocommit`, before the first await —
      // a thrown error becomes a REJECTION and a success settles on a later
      // microtask. So `save()` cannot observe either outcome before it returns.
      //
      // An earlier draft tried to guard this with a `settled` flag and rethrow when
      // it was still false. That instrument could never say yes: the flag is false
      // on EVERY adapter, correct ones included, so the guard fired against real
      // SQLite. It was removed rather than weakened, because a check that cannot
      // pass is worse than no check — it would have been silenced, and the silencing
      // would have removed the real reporting with it.
      //
      // What survives is the reporting D4.4 clause 3 actually requires: the failure
      // reaches `onDegraded`, and through it the UI. The synchronous rethrow the
      // legacy path had is not reproducible over an async port, and pretending
      // otherwise would be the write-behind story ADR 6 D1 rejects, told with a
      // reassuring error type.
      //
      // The property this binding DOES depend on — that the commit is durable by the
      // time `save()` returns, not merely scheduled — is not checkable at runtime
      // here. It is pinned by `sqlite-outbox.test.ts`, which opens a SECOND
      // connection over the same file immediately after `save()` returns, with
      // nothing awaited in between, and requires the row to already be there. An
      // adapter without synchronous commit fails that case.
      void init.outbox
        .apply({ put, remove, expect })
        .then((result) => {
          if (result.ok) return
          init.onDegraded(
            new Error(
              `[podium] OUTBOX write conflicted on ${result.conflicts.join(', ')} — ` +
                'queued offline writes may be LOST on reload',
            ),
          )
        })
        .catch((error: unknown) => {
          init.onDegraded(error)
        })

      for (const mutationId of remove) mirror.delete(mutationId)
      for (const record of put) mirror.set(record.mutationId, record)
    },
  })

  return { queued: view(false), awaiting: view(true) }
}
