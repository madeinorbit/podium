/**
 * THE SEND PUMP UNDER NATIVE BACKPRESSURE (POD-3931).
 *
 * Bun's `send` answers with a number: positive means written, `-1` means
 * accepted into Bun's own buffer (stop writing until `drain`), `0` means NOT
 * accepted. These cases script that contract against a fake socket so the
 * pump's states can be pinned exactly: what is written while paused (nothing),
 * whether a `-1` frame is ever resent (never), what `0` does to a reliable
 * stream (fails it with a reason), and what a late or repeated `drain` does
 * after disposal (nothing). The real transport is exercised separately in
 * `ordered-client-send.transport.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BootstrapCompressionBudget,
  OrderedClientSend,
  type SendSequenceSource,
} from './ordered-client-send'
import type { SendSocket } from './ws-send'

const limits = { sendBufferLimitBytes: 1024 * 1024, lossySendBufferLimitBytes: 256 * 1024 }
const welcome = (clientId: string) => ({ type: 'welcome' as const, clientId })
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** A socket whose send results are a script the test writes. */
function scriptedSocket(results: number[] = []) {
  const sent: string[] = []
  const drains = new Set<() => void>()
  let script = [...results]
  const ws: SendSocket & { drain(): Promise<void>; script(next: number[]): void } = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => {
      sent.push(typeof data === 'string' ? data : '<binary>')
      return script.length ? (script.shift() as number) : data.length
    },
    sendBinary: () => {
      sent.push('<binary>')
      return script.length ? (script.shift() as number) : 1
    },
    terminate: vi.fn(),
    onDrain: (listener) => {
      drains.add(listener)
      return () => drains.delete(listener)
    },
    // The pump resumes one macrotask after the native drain (see `onDrain`).
    drain: async () => {
      for (const listener of [...drains]) listener()
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    script: (next) => {
      script = [...next]
    },
  }
  return { ws, sent, drains }
}

const types = (sent: string[]) => sent.map((s) => (s.startsWith('{') ? JSON.parse(s).type : s))
const ids = (sent: string[]) => sent.map((s) => JSON.parse(s).clientId)

function sequenceOf(messages: Array<ReturnType<typeof welcome>>): SendSequenceSource & {
  pulled: number
} {
  let i = 0
  return {
    pulled: 0,
    next() {
      this.pulled += 1
      return messages[i++]
    },
  }
}

describe('send pump: native results and drain', () => {
  it('advances once on -1, sends nothing while paused, resumes exactly once on drain', async () => {
    const { ws, sent } = scriptedSocket([10, -1, 10, 10])
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    sink.send(welcome('b'))
    sink.send(welcome('c'))
    sink.send(welcome('d'))
    // `a` written, `b` accepted with -1: the pump pauses with c and d still queued.
    expect(ids(sent)).toEqual(['a', 'b'])
    expect(sink.stats().paused).toBe(true)
    await ws.drain()
    // Never resend `b`; c and d go out in order once drained.
    expect(ids(sent)).toEqual(['a', 'b', 'c', 'd'])
    expect(sink.stats().paused).toBe(false)
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(sink.stats().queuedBytes).toBe(0)
  })

  it('a send while paused queues behind the pause instead of bypassing it', async () => {
    const { ws, sent } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    sink.send(welcome('b'))
    expect(ids(sent)).toEqual(['a'])
    sink.send(welcome('c'))
    expect(ids(sent)).toEqual(['a'])
    await ws.drain()
    expect(ids(sent)).toEqual(['a', 'b', 'c'])
  })

  it('stays paused on a drain that leaves the socket above the high-water mark', async () => {
    const { ws, sent } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    sink.send(welcome('b'))
    ws.bufferedAmount = limits.sendBufferLimitBytes + 1
    await ws.drain()
    expect(ids(sent)).toEqual(['a'])
    ws.bufferedAmount = 0
    await ws.drain()
    expect(ids(sent)).toEqual(['a', 'b'])
  })

  it('a 0 result fails the reliable stream with send-not-accepted, never skipping the frame', () => {
    const { ws, sent } = scriptedSocket([0])
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    sink.send(welcome('b'))
    expect(ids(sent)).toEqual(['a'])
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(sink.stats().failure).toBe('send-not-accepted')
  })

  it('a throwing send fails the reliable stream with send-error', () => {
    const { ws } = scriptedSocket()
    ws.send = () => {
      throw new Error('boom')
    }
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(sink.stats().failure).toBe('send-error')
  })

  it('rejects lossy frames offered while paused and never terminates for them', async () => {
    const { ws, sent } = scriptedSocket([10, -1])
    const sink = new OrderedClientSend(ws, limits)
    sink.send(welcome('a'))
    expect(sink.sendLossy(welcome('stream-1'))).toBe(true)
    // `stream-1` accepted with -1: paused. A lossy offer now is refused outright.
    expect(sink.sendLossy(welcome('stream-2'))).toBe(false)
    sink.send(welcome('b'))
    await ws.drain()
    expect(ids(sent)).toEqual(['a', 'stream-1', 'b'])
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('late and repeated drains after dispose do nothing and release nothing twice', async () => {
    const { ws, sent, drains } = scriptedSocket([-1])
    const budget = new BootstrapCompressionBudget()
    const sink = new OrderedClientSend(ws, limits, undefined, budget)
    sink.send(welcome('a'))
    sink.send(welcome('b'))
    sink.dispose()
    expect(drains.size).toBe(0)
    expect(budget.bytes).toBe(0)
    await ws.drain()
    await ws.drain()
    expect(ids(sent)).toEqual(['a'])
    sink.dispose()
    expect(budget.bytes).toBe(0)
  })

  it('close while paused settles a pending sequence with socket-closed once', async () => {
    const { ws } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits)
    const outcome = sink.sendSequence(sequenceOf([welcome('a'), welcome('b'), welcome('c')]))
    ws.readyState = 3
    sink.dispose()
    await expect(outcome).resolves.toEqual({ ok: false, reason: 'socket-closed' })
    await ws.drain()
  })
})

describe('send pump: lazy sequences', () => {
  it('pulls only as far ahead as the prepare bound while paused', async () => {
    const { ws, sent } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
      prepareAheadCount: 2,
    })
    const source = sequenceOf(Array.from({ length: 10 }, (_, i) => welcome(`s${i}`)))
    const outcome = sink.sendSequence(source)
    // s0 accepted with -1 → paused; at most two more prepared ahead.
    expect(ids(sent)).toEqual(['s0'])
    expect(source.pulled).toBeLessThanOrEqual(3)
    ws.script([-1])
    await ws.drain()
    expect(ids(sent)).toEqual(['s0', 's1'])
    expect(source.pulled).toBeLessThanOrEqual(4)
    ws.script([])
    await ws.drain()
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(ids(sent)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`))
    expect(source.pulled).toBe(11)
  })

  it('bounds prepared bytes as well as prepared count', () => {
    const { ws, sent } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
      prepareAheadCount: 100,
      prepareAheadBytes: 64,
    })
    const source = sequenceOf(Array.from({ length: 10 }, (_, i) => welcome(`s${i}`)))
    void sink.sendSequence(source)
    expect(ids(sent)).toEqual(['s0'])
    // One 32-byte-ish frame fits under 64 bytes of prepared output, not ten.
    expect(source.pulled).toBeLessThanOrEqual(3)
  })

  it('keeps later sends behind an unfinished sequence', async () => {
    const { ws, sent } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits)
    const outcome = sink.sendSequence(sequenceOf([welcome('s0'), welcome('s1')]))
    sink.send(welcome('after'))
    expect(ids(sent)).toEqual(['s0'])
    await ws.drain()
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(ids(sent)).toEqual(['s0', 's1', 'after'])
  })

  it('yields between turns so one sequence cannot monopolise the loop', async () => {
    const { ws, sent } = scriptedSocket()
    const yields: Array<() => void> = []
    const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
      turnBudgetBytes: 100,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        yield: (fn) => yields.push(fn),
      },
    })
    const outcome = sink.sendSequence(
      sequenceOf(Array.from({ length: 20 }, (_, i) => welcome(`s${i}`))),
    )
    expect(sent.length).toBeLessThan(20)
    expect(yields).toHaveLength(1)
    while (yields.length) yields.shift()?.()
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(sent).toHaveLength(20)
  })

  it('fails with no-progress-timeout only while reliable work is pending and stalled', async () => {
    vi.useFakeTimers()
    try {
      const { ws, sent } = scriptedSocket([-1])
      const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
        noProgressTimeoutMs: 1000,
      })
      sink.send(welcome('a'))
      sink.send(welcome('b'))
      vi.advanceTimersByTime(900)
      // A drain that flushed bytes is progress even if it leaves us paused.
      ws.bufferedAmount = limits.sendBufferLimitBytes + 1
      void ws.drain() // fake timers run the deferred resume below
      vi.advanceTimersByTime(900)
      expect(ws.terminate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(ws.terminate).toHaveBeenCalledOnce()
      expect(sink.stats().failure).toBe('no-progress-timeout')
      expect(ids(sent)).toEqual(['a'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not time out while idle with nothing reliable pending', () => {
    vi.useFakeTimers()
    try {
      const { ws } = scriptedSocket([-1])
      const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
        noProgressTimeoutMs: 1000,
      })
      sink.send(welcome('a'))
      vi.advanceTimersByTime(5000)
      expect(ws.terminate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a sequence larger than the application queue limit is not eagerly materialised', async () => {
    const { ws, sent } = scriptedSocket()
    const sink = new OrderedClientSend(ws, limits, undefined, undefined, {
      maxQueuedBytes: 200,
      prepareAheadCount: 1,
    })
    const outcome = sink.sendSequence(
      sequenceOf(Array.from({ length: 50 }, (_, i) => welcome(`s${i}`))),
    )
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(sent).toHaveLength(50)
  })

  it('an immediate reliable send over the application queue limit fails with a reason', () => {
    const { ws } = scriptedSocket([-1])
    const sink = new OrderedClientSend(ws, limits, undefined, undefined, { maxQueuedBytes: 100 })
    sink.send(welcome('a'))
    sink.send(welcome('x'.repeat(200)))
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(sink.stats().failure).toBe('application-queue-limit')
  })

  it('waits for shared-budget capacity instead of failing a lazy sequence', async () => {
    const budget = new BootstrapCompressionBudget(150, 1)
    const { ws, sent } = scriptedSocket()
    const other = new OrderedClientSend(scriptedSocket([-1]).ws, limits, undefined, budget)
    other.send(welcome('a'))
    other.send(welcome('hold-the-budget-hold-the-budget'))
    const held = budget.bytes
    expect(held).toBeGreaterThan(100)
    const sink = new OrderedClientSend(ws, limits, undefined, budget)
    const outcome = sink.sendSequence(sequenceOf([welcome('s0'), welcome('s1')]))
    await tick()
    expect(sent).toEqual([])
    expect(ws.terminate).not.toHaveBeenCalled()
    other.dispose()
    await tick()
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(ids(sent)).toEqual(['s0', 's1'])
    expect(budget.bytes).toBe(0)
  })
})
