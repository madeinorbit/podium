import { describe, expect, it } from 'vitest'
import type { LogLevel } from '../levels'
import { buildRecord } from '../record'
import { createRingBufferSink, DEFAULT_RING_CAPACITY } from './ring-buffer'

function record(msg: string, level: LogLevel = 'info') {
  return buildRecord({ level, ns: 'test:ns', msg, fields: {}, context: {} })
}

describe('ring buffer sink', () => {
  it('keeps every level, always — it is the flight recorder', () => {
    expect(createRingBufferSink().minLevel).toBe('trace')
  })

  it('defaults to 500 records', () => {
    expect(createRingBufferSink().capacity).toBe(DEFAULT_RING_CAPACITY)
    expect(DEFAULT_RING_CAPACITY).toBe(500)
  })

  it('returns what it was given, oldest first', () => {
    const sink = createRingBufferSink({ capacity: 4 })
    sink.write(record('a'))
    sink.write(record('b'))
    expect(sink.snapshot().map((r) => r.msg)).toEqual(['a', 'b'])
  })

  it('evicts oldest-first once capacity is reached', () => {
    const sink = createRingBufferSink({ capacity: 3 })
    for (const msg of ['a', 'b', 'c', 'd', 'e']) sink.write(record(msg))
    expect(sink.snapshot().map((r) => r.msg)).toEqual(['c', 'd', 'e'])
  })

  it('stays bounded no matter how much is written', () => {
    const sink = createRingBufferSink({ capacity: 10 })
    for (let i = 0; i < 1000; i++) sink.write(record(`m${i}`))
    expect(sink.snapshot()).toHaveLength(10)
    expect(sink.snapshot()[9]?.msg).toBe('m999')
  })

  it('hands out an array copy, so later logging cannot change a taken snapshot', () => {
    const sink = createRingBufferSink({ capacity: 3 })
    sink.write(record('a'))
    const snapshot = sink.snapshot()
    sink.write(record('b'))
    expect(snapshot).toHaveLength(1)
    expect(snapshot.map((r) => r.msg)).toEqual(['a'])
  })

  it('shares the record OBJECTS rather than deep-copying them', () => {
    // Pinned deliberately, because the docstring used to claim a snapshot was
    // simply "safe to ship" — which is only true given the contract that a sink
    // must not mutate a record. This test states the actual semantics, so
    // switching to a deep copy later is a decision someone makes on purpose
    // rather than a silent change of meaning.
    const sink = createRingBufferSink({ capacity: 3 })
    const written = record('a')
    sink.write(written)
    expect(sink.snapshot()[0]).toBe(written)
  })

  it('empties on clear', () => {
    const sink = createRingBufferSink({ capacity: 3 })
    sink.write(record('a'))
    sink.clear()
    expect(sink.snapshot()).toEqual([])
  })

  it('refuses a capacity below one rather than silently keeping nothing', () => {
    expect(() => createRingBufferSink({ capacity: 0 })).toThrow(/capacity/i)
  })
})
