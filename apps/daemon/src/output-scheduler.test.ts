import { describe, it, expect } from 'vitest'
import { OutputScheduler } from './output-scheduler.js'

function harness() {
  const flushed: Array<{ sid: string; frames: string[] }> = []
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
  return { s, flushed, runImmediate: () => { const f = immediate; immediate = null; f?.() }, fireTimer: (id = timerId) => timers.get(id)?.() }
}

describe('OutputScheduler', () => {
  it('P0/P1: frames within a tick flush as ONE batch on the immediate', () => {
    const h = harness()
    h.s.setPriority('s', 0)
    h.s.enqueue('s', 'a'); h.s.enqueue('s', 'b'); h.s.enqueue('s', 'c')
    expect(h.flushed).toEqual([])      // nothing sent synchronously
    h.runImmediate()
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a', 'b', 'c'] }])
  })

  it('P3: frames coalesce until the timer fires', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a'); h.s.enqueue('s', 'b')
    expect(h.flushed).toEqual([])
    h.fireTimer()
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a', 'b'] }])
  })

  it('P3: a size-cap burst flushes immediately', () => {
    const h = harness()           // coalesceMaxBytes=10
    h.s.setPriority('s', 3)
    h.s.enqueue('s', '12345'); h.s.enqueue('s', '67890') // 10 bytes → cap hit
    expect(h.flushed).toEqual([{ sid: 's', frames: ['12345', '67890'] }])
  })

  it('promoting priority flushes pending right away', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a')
    h.s.setPriority('s', 0)       // promote
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a'] }])
  })

  it('remove flushes then drops state', () => {
    const h = harness()
    h.s.setPriority('s', 3)
    h.s.enqueue('s', 'a')
    h.s.remove('s')
    expect(h.flushed).toEqual([{ sid: 's', frames: ['a'] }])
  })
})
