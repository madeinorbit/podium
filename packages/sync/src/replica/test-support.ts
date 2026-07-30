/**
 * Fakes and builders for the Replica conformance work (POD-306). Kept beside the
 * kernel rather than inside one test file because POD-370 (outbox) and POD-373
 * (wiring) drive the same state machine and must not each grow their own
 * incompatible authority double.
 *
 * `FakeAuthority` can be driven two ways on purpose: automatically (give it a
 * slice, it streams chunks and ends) for ordinary cases, and MANUALLY (push
 * chunks one at a time) for the cases that only exist mid-walk — a frame arriving
 * during a bootstrap, or a disconnect between two chunks. A suite that can only
 * drive the automatic path cannot test D6's buffering rule at all.
 */

import type { AuthorityReadPort } from './ports'
import type { BootstrapChunk, ChangeEnvelope, ChangesSinceReply, Cursor, DeltaFrame } from './types'

export const FEED_ID = 'feed-1'
export const EPOCH = 'epoch-1'

export function upsertChange(
  seq: number,
  entity: string,
  entityId: string,
  payload: unknown,
  extra: Partial<ChangeEnvelope> = {},
): ChangeEnvelope {
  return { seq, entity, entityId, op: 'upsert', payload, ...extra }
}

/** A TOMBSTONE — the entity is gone, globally. */
export function removeChange(seq: number, entity: string, entityId: string): ChangeEnvelope {
  return { seq, entity, entityId, op: 'remove' }
}

/** A VISIBILITY exit — it still exists, for others (Amendment 1 D14.1). */
export function evictChange(seq: number, entity: string, entityId: string): ChangeEnvelope {
  return { seq, entity, entityId, op: 'evict' }
}

export function deltaFrame(
  fromSeq: number,
  seq: number,
  changes: readonly ChangeEnvelope[] = [],
  overrides: Partial<DeltaFrame> = {},
): DeltaFrame {
  // `minAvailableSeq: 0` — "this fixture's log has pruned nothing", which is true
  // of every scripted fixture and is the value a compaction case OVERRIDES. It is
  // spelled here rather than defaulted inside the Replica precisely so that the
  // default lives in the fixture, where it is visible, instead of in the
  // production path, where an authority that published nothing would inherit it.
  return {
    kind: 'delta',
    feedId: FEED_ID,
    epoch: EPOCH,
    fromSeq,
    seq,
    minAvailableSeq: 0,
    changes,
    ...overrides,
  }
}

/** An empty certified frame. Under private-by-default this is the NORMAL frame. */
export function watermark(
  fromSeq: number,
  seq: number,
  overrides: Partial<DeltaFrame> = {},
): DeltaFrame {
  return deltaFrame(fromSeq, seq, [], overrides)
}

export function cursorAt(seq: number, overrides: Partial<Cursor> = {}): Cursor {
  return { feedId: FEED_ID, epoch: EPOCH, seq, ...overrides }
}

type ChunkSignal = BootstrapChunk | 'end' | Error

class ChunkChannel {
  private queue: ChunkSignal[] = []
  private waiter: (() => void) | null = null

  push(signal: ChunkSignal): void {
    this.queue.push(signal)
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  async *stream(): AsyncIterable<BootstrapChunk> {
    for (;;) {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve
        })
      }
      const signal = this.queue.shift() as ChunkSignal
      if (signal === 'end') return
      if (signal instanceof Error) throw signal
      yield signal
    }
  }
}

export interface SlicePlan {
  readonly snapshotSeq: number
  readonly rows: readonly ChangeEnvelope[]
  /** Chunking is a tuning parameter, not a protocol constant (ADR 2 D6). */
  readonly chunkSize?: number
}

export class FakeAuthority implements AuthorityReadPort {
  feedId = FEED_ID
  epoch = EPOCH

  readonly changesSinceCalls: Cursor[] = []
  changesSinceQueue: (ChangesSinceReply | Error)[] = []

  bootstrapCalls = 0
  /** Automatic mode: the slice this principal may see at `snapshotSeq`. */
  slice: SlicePlan | null = null
  /** Fail this many bootstrap attempts before serving the slice (D6 restart). */
  bootstrapFailures = 0
  /** Manual mode: set to drive chunks by hand for mid-walk cases. */
  manual: ChunkChannel | null = null

  async changesSince(cursor: Cursor): Promise<ChangesSinceReply> {
    this.changesSinceCalls.push(cursor)
    const next = this.changesSinceQueue.shift()
    if (next === undefined) return { kind: 'bootstrap-required', reason: 'no scripted reply' }
    if (next instanceof Error) throw next
    return next
  }

  bootstrap(): AsyncIterable<BootstrapChunk> {
    this.bootstrapCalls += 1
    if (this.manual !== null) return this.manual.stream()
    if (this.bootstrapFailures > 0) {
      this.bootstrapFailures -= 1
      return failingStream()
    }
    const slice = this.slice
    if (slice === null) return failingStream(new Error('no slice configured'))
    return chunkStream(this.feedId, this.epoch, slice)
  }

  /** Switch to manual mode and return the channel the test pushes chunks into. */
  driveManually(): ChunkChannel {
    this.manual = new ChunkChannel()
    return this.manual
  }
}

export function bootstrapChunk(
  snapshotSeq: number,
  changes: readonly ChangeEnvelope[],
  last: boolean,
  overrides: Partial<BootstrapChunk> = {},
): BootstrapChunk {
  return { feedId: FEED_ID, epoch: EPOCH, snapshotSeq, changes, last, ...overrides }
}

async function* chunkStream(
  feedId: string,
  epoch: string,
  slice: SlicePlan,
): AsyncIterable<BootstrapChunk> {
  const size = slice.chunkSize ?? 2
  const rows = slice.rows
  if (rows.length === 0) {
    yield { feedId, epoch, snapshotSeq: slice.snapshotSeq, changes: [], last: true }
    return
  }
  for (let i = 0; i < rows.length; i += size) {
    // Yielding to the microtask queue between chunks is what makes "a delta
    // arrived mid-walk" reachable in a test at all.
    await Promise.resolve()
    yield {
      feedId,
      epoch,
      snapshotSeq: slice.snapshotSeq,
      changes: rows.slice(i, i + size),
      last: i + size >= rows.length,
    }
  }
}

/**
 * A bootstrap stream that rejects on the first pull. Hand-rolled rather than an
 * async generator because a generator that only throws contains no `yield`,
 * which is a lint error and, fairly, a confusing shape.
 */
function failingStream(
  error = new Error('bootstrap stream failed'),
): AsyncIterable<BootstrapChunk> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<BootstrapChunk>> => Promise.reject(error),
    }),
  }
}
