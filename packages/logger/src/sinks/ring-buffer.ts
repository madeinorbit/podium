import type { LogRecord } from '../record'
import type { Sink } from '../sinks'

/** ~500 records: a minute or so of real traffic, in bounded memory (spec). */
export const DEFAULT_RING_CAPACITY = 500

export interface RingBufferSink extends Sink {
  readonly capacity: number
  /**
   * A new ARRAY holding the buffered records, oldest first. Later writes do not
   * change what a snapshot already handed out, which is what makes it usable as
   * a crash payload while logging continues around the crash handler.
   *
   * The records themselves are the SAME OBJECTS the other sinks were given —
   * this is deliberately not a deep copy, so a crash path does not pay to clone
   * 500 records, and so a snapshot cannot fail on a field that resists cloning.
   * It is safe because {@link Sink.write} forbids mutating a record; a sink that
   * breaks that contract corrupts this history, and the shallow copy is what
   * makes that a contract question rather than a hidden cost.
   */
  snapshot(): LogRecord[]
  clear(): void
}

export interface RingBufferOptions {
  capacity?: number
}

/**
 * The flight recorder: every level, always, oldest-first eviction.
 *
 * It is a sink like any other — nothing bypasses the logger to reach it — and
 * it is pinned at `trace` on purpose. Records below the file sink's threshold
 * still exist HERE, which is the point: `debug`/`trace` context for the minute
 * that mattered, paid for only in memory, shipped only when a crash fires.
 */
export function createRingBufferSink(options: RingBufferOptions = {}): RingBufferSink {
  const capacity = options.capacity ?? DEFAULT_RING_CAPACITY
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`ring buffer capacity must be a positive integer, got ${capacity}`)
  }
  // Fixed-size slots with a write cursor: no array shifting, so a `trace`-heavy
  // process pays O(1) per record however long it runs.
  const slots: Array<LogRecord | undefined> = new Array(capacity)
  let written = 0

  return {
    name: 'ring-buffer',
    minLevel: 'trace',
    capacity,
    write(record: LogRecord): void {
      slots[written % capacity] = record
      written += 1
    },
    snapshot(): LogRecord[] {
      const size = Math.min(written, capacity)
      const start = written - size
      const out: LogRecord[] = []
      for (let i = 0; i < size; i++) {
        const record = slots[(start + i) % capacity]
        if (record) out.push(record)
      }
      return out
    },
    clear(): void {
      slots.fill(undefined)
      written = 0
    },
  }
}
