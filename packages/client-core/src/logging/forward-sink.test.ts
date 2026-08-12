import type { ForwardedLogRecord } from '@podium/commands'
import { addSink, clearSinks, type LogRecord, resetLogging } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createForwardingSink } from './forward-sink'

function record(msg: string, level: LogRecord['level'] = 'warn'): LogRecord {
  return { ts: '2026-08-12T00:00:00.000Z', level, ns: 'web', msg }
}

/** A send that resolves on demand, so a test can hold a flush in flight. */
function deferredSend(): {
  send: (records: ForwardedLogRecord[]) => Promise<void>
  batches: ForwardedLogRecord[][]
  settle: (index: number, err?: Error) => void
} {
  const batches: ForwardedLogRecord[][] = []
  const settlers: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  return {
    batches,
    send: (records) => {
      batches.push(records)
      return new Promise<void>((resolve, reject) => {
        settlers.push({ resolve, reject })
      })
    },
    settle: (index, err) => {
      const settler = settlers[index]
      if (!settler) throw new Error(`no in-flight send at ${index}`)
      if (err) settler.reject(err)
      else settler.resolve()
    },
  }
}

describe('forwarding sink', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetLogging()
  })

  it('holds records until the flush interval elapses', async () => {
    const sent: ForwardedLogRecord[][] = []
    const sink = createForwardingSink({
      send: async (records) => {
        sent.push(records)
      },
      flushIntervalMs: 5000,
    })

    sink.write(record('one'))
    await vi.advanceTimersByTimeAsync(4999)
    expect(sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual([[expect.objectContaining({ msg: 'one' })]])
  })

  it('flushes immediately once the batch size is reached, without waiting for the interval', async () => {
    const sent: ForwardedLogRecord[][] = []
    const sink = createForwardingSink({
      send: async (records) => {
        sent.push(records)
      },
      batchSize: 3,
      flushIntervalMs: 5000,
    })

    sink.write(record('a'))
    sink.write(record('b'))
    expect(sent).toHaveLength(0)
    sink.write(record('c'))
    await vi.advanceTimersByTimeAsync(0)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.map((r) => r.msg)).toEqual(['a', 'b', 'c'])
  })

  it('drops the OLDEST records when the queue overflows, keeping the newest', async () => {
    const deferred = deferredSend()
    const sink = createForwardingSink({
      send: deferred.send,
      batchSize: 2,
      maxQueue: 3,
      flushIntervalMs: 5000,
    })

    // First two fill a batch and go in flight, so the queue behind them holds.
    sink.write(record('sent-1'))
    sink.write(record('sent-2'))
    await vi.advanceTimersByTimeAsync(0)
    for (const msg of ['q1', 'q2', 'q3', 'q4']) sink.write(record(msg))

    expect(sink.dropped()).toBe(1)
    deferred.settle(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(deferred.batches[1]?.map((r) => r.msg)).toEqual(['q2', 'q3'])
  })

  it('retries a failed batch after a jittered backoff instead of losing it', async () => {
    const deferred = deferredSend()
    const sink = createForwardingSink({
      send: deferred.send,
      batchSize: 1,
      flushIntervalMs: 5000,
      retryBaseMs: 1000,
      jitter: () => 0, // delay * (0.5 + 0) => half the base
    })

    sink.write(record('keep me'))
    await vi.advanceTimersByTimeAsync(0)
    deferred.settle(0, new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)

    expect(deferred.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(deferred.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(deferred.batches[1]?.map((r) => r.msg)).toEqual(['keep me'])
  })

  it('backs off further on each consecutive failure', async () => {
    const deferred = deferredSend()
    const sink = createForwardingSink({
      send: deferred.send,
      batchSize: 1,
      flushIntervalMs: 60_000,
      retryBaseMs: 1000,
      jitter: () => 1, // delay * 1.5
    })

    sink.write(record('x'))
    await vi.advanceTimersByTimeAsync(0)
    deferred.settle(0, new Error('offline'))
    await vi.advanceTimersByTimeAsync(1500) // 1000 * 1.5
    expect(deferred.batches).toHaveLength(2)

    deferred.settle(1, new Error('still offline'))
    await vi.advanceTimersByTimeAsync(2999) // second attempt waits 2000 * 1.5
    expect(deferred.batches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(deferred.batches).toHaveLength(3)
  })

  it('gives up on a batch the server keeps refusing rather than retrying it forever', async () => {
    let attempts = 0
    const sink = createForwardingSink({
      send: async () => {
        attempts += 1
        throw new Error('400 bad batch')
      },
      batchSize: 1,
      maxAttempts: 3,
      retryBaseMs: 1000,
      jitter: () => 0,
      flushIntervalMs: 60_000,
    })

    sink.write(record('poison'))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(attempts).toBe(3)
    expect(sink.pending()).toBe(0)
    expect(sink.dropped()).toBe(1)
  })

  it('never lets a send failure reach the logging call site', async () => {
    const sink = createForwardingSink({
      send: () => {
        throw new Error('synchronous explosion')
      },
      batchSize: 1,
      flushIntervalMs: 5000,
    })

    expect(() => sink.write(record('boom'))).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('reports its own failure locally at most once per interval, never through the logger', async () => {
    const seen: LogRecord[] = []
    addSink({
      name: 'spy',
      minLevel: 'trace',
      write: (r) => {
        seen.push(r)
      },
    })
    const degraded: string[] = []
    const sink = createForwardingSink({
      send: async () => {
        throw new Error('offline')
      },
      batchSize: 1,
      flushIntervalMs: 5000,
      retryBaseMs: 100,
      jitter: () => 0,
      onDegraded: (message) => degraded.push(message),
    })

    sink.write(record('one'))
    await vi.advanceTimersByTimeAsync(200)

    expect(degraded).toHaveLength(1)
    expect(seen).toEqual([])
    clearSinks()
  })

  it('flush() settles the queue rather than returning while records are still buffered', async () => {
    const sent: ForwardedLogRecord[][] = []
    const sink = createForwardingSink({
      send: async (records) => {
        sent.push(records)
      },
      batchSize: 50,
      flushIntervalMs: 5000,
    })

    sink.write(record('pending'))
    await sink.flush()

    expect(sent).toEqual([[expect.objectContaining({ msg: 'pending' })]])
    expect(sink.pending()).toBe(0)
  })

  it('clamps an oversized message so one huge record cannot poison the batch', async () => {
    const sent: ForwardedLogRecord[][] = []
    const sink = createForwardingSink({
      send: async (records) => {
        sent.push(records)
      },
      batchSize: 1,
      flushIntervalMs: 5000,
    })

    sink.write(record('x'.repeat(20_000)))
    await vi.advanceTimersByTimeAsync(0)

    const forwarded = sent[0]?.[0]
    expect(forwarded?.msg.length).toBeLessThanOrEqual(8192)
    expect(forwarded?.truncated).toBe(true)
  })
})
