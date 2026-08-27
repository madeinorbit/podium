import { asSessionId } from '@podium/model'
import { describe, it, expect } from 'vitest'
import { OutputScheduler } from './output-scheduler.js'

function harness() {
  const flushed: Array<{ sid: string; frames: readonly Uint8Array[] }> = []
  const bytes = (value: string): Uint8Array => Buffer.from(value)
  const decoded = () =>
    flushed.map(({ sid, frames }) => ({
      sid,
      frames: frames.map((frame) => Buffer.from(frame).toString()),
    }))
  let immediate: (() => void) | null = null
  const timers = new Map<number, () => void>()
  let timerId = 0
  const s = new OutputScheduler({
    flush: (sid, frames) => flushed.push({ sid, frames }),
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
    expect(h.decoded()).toEqual([{ sid: 's', frames: ['a', 'b', 'c'] }])
  })

  it('P3: frames coalesce until the timer fires', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('a')); h.s.enqueue(asSessionId('s'), h.bytes('b'))
    expect(h.flushed).toEqual([])
    h.fireTimer()
    expect(h.decoded()).toEqual([{ sid: 's', frames: ['a', 'b'] }])
  })

  it('P3: a size-cap burst flushes immediately', () => {
    const h = harness()           // coalesceMaxBytes=10
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('12345')); h.s.enqueue(asSessionId('s'), h.bytes('67890')) // 10 bytes → cap hit
    expect(h.decoded()).toEqual([{ sid: 's', frames: ['12345', '67890'] }])
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
    expect(h.decoded()).toEqual([{ sid: 's', frames: ['a'] }])
  })

  it('remove flushes then drops state', () => {
    const h = harness()
    h.s.setPriority(asSessionId('s'), 3)
    h.s.enqueue(asSessionId('s'), h.bytes('a'))
    h.s.remove(asSessionId('s'))
    expect(h.decoded()).toEqual([{ sid: 's', frames: ['a'] }])
  })
})
