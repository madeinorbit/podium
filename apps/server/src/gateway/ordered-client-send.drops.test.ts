/**
 * LOSSY DROPS ARE REPORTED, AND A PULLED SEQUENCE CARRIES BINARY (POD-4912).
 *
 * A viewer that lost a live terminal frame has a hole in its screen. The pump
 * says so through the frame's `onDrop`, for both kinds of loss: a frame refused
 * at admission (E6) and one admitted and later dropped because the socket had
 * fallen behind (N4). The serve that repairs the hole is a pulled sequence of
 * binary PTY envelopes, so a sequence may carry binary items.
 */

import { describe, expect, it, vi } from 'vitest'
import { OrderedClientSend, type OrderedSendTimers, SequenceBinary } from './ordered-client-send'
import type { SendSocket } from './ws-send'

const limits = { sendBufferLimitBytes: 1024 * 1024, lossySendBufferLimitBytes: 256 * 1024 }

function socket() {
  const sent: Array<string | Uint8Array> = []
  const ws: SendSocket & { bufferedAmount: number } = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => {
      sent.push(data)
      return data.length
    },
    sendBinary: (data) => {
      sent.push(data)
      return data.byteLength
    },
    terminate: vi.fn(),
    onDrain: () => () => {},
  }
  return { ws, sent }
}

/** Timers whose yields the test releases by hand. */
function heldTimers(): OrderedSendTimers & { release(): void } {
  const yields: Array<() => void> = []
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    yield: (fn) => {
      yields.push(fn)
    },
    release: () => {
      for (const fn of yields.splice(0)) fn()
    },
  }
}

describe('lossy drops report themselves', () => {
  it('an admission reject calls onDrop and returns false', () => {
    const { ws } = socket()
    const sink = new OrderedClientSend(ws, limits)
    ws.bufferedAmount = limits.lossySendBufferLimitBytes + 1
    const onDrop = vi.fn()
    expect(sink.sendBinaryLossy(Uint8Array.of(1, 2, 3), onDrop)).toBe(false)
    expect(onDrop).toHaveBeenCalledOnce()
    const onJsonDrop = vi.fn()
    expect(sink.sendLossy({ type: 'welcome', clientId: 'x' }, onJsonDrop)).toBe(false)
    expect(onJsonDrop).toHaveBeenCalledOnce()
  })

  it('a frame admitted and then dropped by the pump calls onDrop once; a written one never', () => {
    const { ws, sent } = socket()
    const timers = heldTimers()
    // A one-byte turn budget: the first write spends the turn, so the next
    // frames wait for the yield with the socket state the test then sets.
    const sink = new OrderedClientSend(ws, limits, undefined, { turnBudgetBytes: 1, timers })
    const written = vi.fn()
    const dropped = vi.fn()
    sink.sendBinaryLossy(Uint8Array.of(1), written)
    expect(sent).toHaveLength(1)
    expect(sink.sendBinaryLossy(Uint8Array.of(2), dropped)).toBe(true)
    expect(sent).toHaveLength(1)
    ws.bufferedAmount = limits.lossySendBufferLimitBytes + 1
    timers.release()
    expect(sent).toHaveLength(1)
    expect(dropped).toHaveBeenCalledOnce()
    expect(written).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('a reliable frame never reports a drop', () => {
    const { ws } = socket()
    const sink = new OrderedClientSend(ws, limits)
    sink.sendBinary(Uint8Array.of(9))
    expect(sink.stats().failure).toBeUndefined()
  })
})

describe('a pulled sequence may carry binary frames', () => {
  it('writes SequenceBinary items with sendBinary, in order with JSON items', async () => {
    const { ws, sent } = socket()
    const sink = new OrderedClientSend(ws, limits)
    const items = [
      new SequenceBinary(Uint8Array.of(0xaa)),
      { type: 'welcome' as const, clientId: 'mid' },
      new SequenceBinary(Uint8Array.of(0xbb, 0xcc)),
    ]
    let i = 0
    const outcome = await sink.sendSequence({ next: () => items[i++] })
    expect(outcome).toEqual({ ok: true })
    expect(sent.map((s) => (typeof s === 'string' ? JSON.parse(s).clientId : [...s]))).toEqual([
      [0xaa],
      'mid',
      [0xbb, 0xcc],
    ])
    expect(sink.stats().queuedBytes).toBe(0)
  })

  it('fails the stream when a binary item meets a socket that cannot send binary', async () => {
    const { ws } = socket()
    const plain: SendSocket = { ...ws, sendBinary: undefined }
    const sink = new OrderedClientSend(plain, limits)
    const outcome = await sink.sendSequence({
      next: (() => {
        let done = false
        return () => {
          if (done) return undefined
          done = true
          return new SequenceBinary(Uint8Array.of(1))
        }
      })(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'binary-unsupported' })
  })
})
