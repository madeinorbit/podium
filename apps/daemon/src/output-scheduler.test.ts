import { asSessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import { describe, it, expect } from 'vitest'
import { OutputScheduler } from './output-scheduler.js'

function harness() {
  const flushed: DaemonPtyOutputBatch[] = []
  const bytes = (value: string): Uint8Array => Buffer.from(value)
  const decoded = () =>
    flushed.map((batch) => ({
      sid: batch.sessionId,
      sourceFrames: batch.sourceFrames,
      bytes: Buffer.from(batch.bytes).toString(),
    }))
  let immediate: (() => void) | null = null
  const timers = new Map<number, () => void>()
  let timerId = 0
  const s = new OutputScheduler({
    flush: (batch) => flushed.push(batch),
    scheduleImmediate: (fn) => { immediate = fn },
    setTimer: (fn, _ms) => { const id = ++timerId; timers.set(id, fn); return id },
    clearTimer: (h) => { timers.delete(h as number) },
    coalesceMs: 75,
    coalesceMaxBytes: 10,
  })
  return { s, flushed, bytes, decoded, runImmediate: () => { const f = immediate; immediate = null; f?.() }, fireTimer: (id = timerId) => timers.get(id)?.() }
}

describe('OutputScheduler', () => {
  it('P0/P1: frames within a tick flush as ONE batch on the immediate', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 0)
    h.s.enqueue(asSessionId('s'), h.bytes('a')); h.s.enqueue(asSessionId('s'), h.bytes('b')); h.s.enqueue(asSessionId('s'), h.bytes('c'))
    expect(h.flushed).toEqual([])      // nothing sent synchronously
    h.runImmediate()
    expect(h.decoded()).toEqual([{ sid: 's', sourceFrames: 3, bytes: 'abc' }])
  })

  it('preserves exact arbitrary bytes when coalescing multiple source frames', () => {
    const h = harness()
    h.s.enqueue(asSessionId('s'), Uint8Array.from([0x00, 0xff, 0x80]))
    h.s.enqueue(asSessionId('s'), Uint8Array.from([0x7f, 0x01]))
    h.runImmediate()

    expect(h.flushed[0]).toMatchObject({ sessionId: 's', sourceFrames: 2 })
    expect(Array.from(h.flushed[0]!.bytes)).toEqual([0x00, 0xff, 0x80, 0x7f, 0x01])
  })

  it('preserves the byte object identity for a one-frame batch', () => {
    const h = harness()
    const frame = Uint8Array.from([0x00, 0xff, 0x80])
    h.s.enqueue(asSessionId('s'), frame)
    h.runImmediate()

    expect(h.flushed[0]).toMatchObject({ sessionId: 's', sourceFrames: 1 })
    expect(h.flushed[0]!.bytes).toBe(frame)
  })

  it('P3: frames coalesce until the timer fires', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('a')); h.s.enqueue(asSessionId('s'), h.bytes('b'))
    expect(h.flushed).toEqual([])
    h.fireTimer()
    expect(h.decoded()).toEqual([{ sid: 's', sourceFrames: 2, bytes: 'ab' }])
  })

  it('P3: a size-cap burst flushes immediately', () => {
    const h = harness()           // coalesceMaxBytes=10
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('12345')); h.s.enqueue(asSessionId('s'), h.bytes('67890')) // 10 bytes → cap hit
    expect(h.decoded()).toEqual([{ sid: 's', sourceFrames: 2, bytes: '1234567890' }])
  })

  it('reports the current relay priority for focused-first reseed pacing', () => {
    const h = harness()
    expect(h.s.priorityOf(asSessionId('s'))).toBe(1)
    h.s.setPriority(asSessionId('s'), 0)
    expect(h.s.priorityOf(asSessionId('s'))).toBe(0)
  })

  it('promoting priority flushes pending right away', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('a'))
    h.s.setPriority(asSessionId('s'), 0)       // promote
    expect(h.decoded()).toEqual([{ sid: 's', sourceFrames: 1, bytes: 'a' }])
  })

  it('remove flushes then drops state', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('a'))
    h.s.remove(asSessionId('s'))
    expect(h.decoded()).toEqual([{ sid: 's', sourceFrames: 1, bytes: 'a' }])
  })
})
