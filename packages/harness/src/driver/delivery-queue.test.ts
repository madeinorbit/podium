import { afterEach, describe, expect, it, vi } from 'vitest'
import { withDeliveryQueue } from './delivery-queue.js'
import type { AgentSessionHandle } from './driver.js'

afterEach(() => vi.useRealTimers())

describe('durable row delivery', () => {
  const fixture = () => {
    vi.useFakeTimers()
    let phase = 'working'
    const send = vi.fn(async (_input: { text: string }, _options?: unknown) => ({
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      at: new Date().toISOString(),
    }))
    const emit = vi.fn()
    const interrupt = vi.fn(async () => {})
    const handle = withDeliveryQueue(
      {
        send,
        interrupt,
        state: async () => ({ phase }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      emit,
    )
    return {
      handle,
      send,
      emit,
      interrupt,
      ready: () => {
        phase = 'idle'
      },
      setPhase: (next: string) => {
        phase = next
      },
    }
  }
  it('refuses durable boundary delivery without rewriting it to when-ready', async () => {
    const f = fixture()
    const receipt = await f.handle.send(
      { rowId: 'mail', text: 'mail' }, { origin: 'mail', delivery: 'at-boundary' },
    )
    expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'unsupported' } })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
  })

  it('holds FIFO rows locally and emits one outcome per row, never on admission', async () => {
    const f = fixture()
    const options = { origin: 'human', delivery: 'when-ready' } as const
    expect((await f.handle.send({ id: 'one', rowId: 'one', text: 'a' }, options)).outcome).toBe(
      'queued',
    )
    await f.handle.send({ id: 'two', rowId: 'two', text: 'b' }, options)
    await f.handle.send({ id: 'one', rowId: 'one', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
    f.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(['a', 'b'])
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      { t: 'delivery', rowId: 'one', outcome: 'delivered' },
      { t: 'delivery', rowId: 'two', outcome: 'delivered' },
    ])
  })
  it('cancel-by-id fences a pending row and repeated cancellation emits nothing', async () => {
    const f = fixture()
    await f.handle.send(
      { id: 'one', rowId: 'one', text: 'a' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await f.handle.cancelDelivery!('one')
    await f.handle.cancelDelivery!('one')
    f.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'dropped',
    })
  })
  it('a retract while typing withdraws nothing, says typing, and the row runs to its outcome', async () => {
    const f = fixture()
    f.ready()
    let accept!: (receipt: Awaited<ReturnType<typeof f.send>>) => void
    const proof = new Promise<Awaited<ReturnType<typeof f.send>>>((resolve) => {
      accept = resolve
    })
    f.send.mockImplementation(() => proof)
    await f.handle.send(
      { id: 'one', rowId: 'one', text: 'a' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.handle.cancelDelivery!('one')).toMatchObject({
      reason: 'busy',
      tooLate: 'typing',
    })
    // The send is never cut mid-way: its signal stays clear, so the driver
    // finishes the submit it started.
    const options = f.send.mock.calls[0]![1] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(false)
    expect(f.emit).not.toHaveBeenCalled()
    accept({
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      at: new Date().toISOString(),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'delivered',
    })
  })

  it('a row the driver refused as busy typed nothing, so a retract wins again', async () => {
    const f = fixture()
    f.ready()
    f.send.mockResolvedValueOnce({ outcome: 'refused', refusal: { reason: 'busy' } } as never)
    await f.handle.send(
      { id: 'one', rowId: 'one', text: 'a' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(await f.handle.cancelDelivery!('one')).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'dropped',
    })
  })

  it('a retract after a failure says failed and repeats the failure, never ok', async () => {
    const f = fixture()
    f.ready()
    f.send.mockResolvedValue({ outcome: 'unverified' } as never)
    await f.handle.send(
      { rowId: 'lost', text: 'once' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(0)
    const failure = f.emit.mock.calls[0]![0]
    expect(failure).toMatchObject({ outcome: 'failed', cause: 'unconfirmed' })
    f.emit.mockClear()
    expect(await f.handle.cancelDelivery!('lost')).toMatchObject({
      reason: 'busy',
      tooLate: 'failed',
    })
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('never retries an ambiguous write and reports a recoverable failure', async () => {
    const f = fixture()
    f.ready()
    f.send.mockResolvedValue({ outcome: 'unverified' } as never)
    await f.handle.send(
      { id: 'one', rowId: 'one', text: 'a' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'failed',
      reason: 'delivery could not be confirmed; check the transcript before retrying',
      // May have been typed: the server records it `unknown` (POD-4775).
      cause: 'unconfirmed',
    })
  })
  it('never retypes an unconfirmed creation prompt', async () => {
    const f = fixture()
    f.ready()
    f.send.mockResolvedValue({ outcome: 'unverified' } as never)
    await f.handle.send({ rowId: 'initial', initialPrompt: true, text: 'create' },
      { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        reason: 'the creation prompt was not confirmed; it will not be typed again automatically',
        cause: 'unconfirmed',
      }),
    )
  })

  it('imports attempted rows as recoverable ambiguity, without a second turn', async () => {
    const f = fixture()
    f.ready()
    await f.handle.send({ rowId: 'old', deliveryRecovery: true, text: 'already typed' },
      { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: 'old', outcome: 'failed', cause: 'unconfirmed' }),
    )
  })

  it('replays acceptance after a lost receipt without submitting again', async () => {
    const f = fixture()
    f.ready()
    const input = { rowId: 'one', text: 'once' }
    const options = { origin: 'human', delivery: 'when-ready' } as const
    await f.handle.send(input, options)
    await vi.advanceTimersByTimeAsync(0)
    await f.handle.send({ ...input, deliveryRecovery: true }, options)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit.mock.calls.map(([event]) => event.outcome)).toEqual(['delivered', 'delivered'])
  })

  // POD-4687: the server restart half of the duplicate story. The server
  // re-forwards every still-queued row with its stable row id; a row this
  // daemon already delivered must report "delivered" again WITHOUT typing —
  // the delivery queue is idempotent by row id for its whole lifetime. The
  // re-forward carries deliveryRecovery (the server reserved the row before
  // the crash), which must not turn a proven delivery into a failure.
  it('replays an already-delivered row id without typing a second time', async () => {
    const f = fixture()
    f.ready()
    const options = { origin: 'human', delivery: 'when-ready' } as const
    await f.handle.send({ rowId: 'repeat', text: 'same text twice' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({ t: 'delivery', rowId: 'repeat', outcome: 'delivered' })
    // The server restarts and re-forwards the row whose outcome never came back.
    f.emit.mockClear()
    await f.handle.send({ rowId: 'repeat', deliveryRecovery: true, text: 'same text twice' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({ t: 'delivery', rowId: 'repeat', outcome: 'delivered' })
  })

  it('replays completed acceptance when cancellation cannot retract it', async () => {
    const f = fixture()
    f.ready()
    await f.handle.send({ rowId: 'accepted', text: 'once' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(0)
    f.emit.mockClear()
    expect(await f.handle.cancelDelivery!('accepted')).toMatchObject({
      reason: 'busy',
      tooLate: 'delivered',
    })
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({ t: 'delivery', rowId: 'accepted', outcome: 'delivered' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('cancellation before admission fences a delayed RPC', async () => {
    const f = fixture()
    f.ready()
    await f.handle.cancelDelivery!('late')
    await f.handle.send({ rowId: 'late', text: 'late' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit.mock.calls.every(([event]) => event.outcome === 'dropped')).toBe(true)
  })

  // A phase that ends on its own waits for the turn boundary with NO
  // deadline: a row admitted while the agent is busy for longer than any
  // old ceiling is typed when the turn ends, never failed.
  for (const phase of ['working', 'compacting', 'needs_user'] as const) {
    it(`waits out a ${phase} turn past the old ceiling, then delivers`, async () => {
      const f = fixture()
      f.setPhase(phase)
      await f.handle.send({ rowId: `long-${phase}`, text: 'wait' }, { origin: 'mail', delivery: 'when-ready' })
      await vi.advanceTimersByTimeAsync(45 * 60_000)
      expect(f.send).not.toHaveBeenCalled()
      expect(f.emit).not.toHaveBeenCalled()
      f.ready()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ rowId: `long-${phase}`, outcome: 'delivered' }),
      )
    })
  }

  // A human answering a question ends needs_user just as a turn's end ends
  // working. The server no longer holds a message for that [POD-4661], so the
  // daemon must: a send made while the agent waits on the human is delivered
  // after the answer, not failed a minute in.
  it('waits through a needs_user question like a running turn, then delivers', async () => {
    const f = fixture()
    f.setPhase('needs_user')
    await f.handle.send({ rowId: 'asked', text: 'after the answer' }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
    f.ready()
    await vi.advanceTimersByTimeAsync(400)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'asked', outcome: 'delivered' }))
  })

  // These phases do not end on their own, so a short ceiling reports the stuck
  // row with a precise reason instead of holding it forever.
  for (const phase of ['unknown', 'errored', 'ended'] as const) {
    it(`keeps the short ceiling for a ${phase} agent`, async () => {
      const f = fixture()
      f.setPhase(phase)
      await f.handle.send({ rowId: phase, text: 'wait' }, { origin: 'mail', delivery: 'when-ready' })
      await vi.advanceTimersByTimeAsync(60_200)
      expect(f.send).not.toHaveBeenCalled()
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          rowId: phase,
          outcome: 'failed',
          reason: 'agent not accepting input',
          // Never typed: the server fails it as not accepting input (POD-4775).
          cause: 'not-accepting-input',
        }),
      )
    })
  }

  it('bounds a never-ready composer with the precise reason', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const emit = vi.fn()
    const handle = withDeliveryQueue({ send, state: async () => ({ phase: 'idle' }) } as unknown as AgentSessionHandle,
      emit, () => false)
    await handle.send({ rowId: 'starting', text: 'first' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_200)
    expect(send).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: 'starting',
        outcome: 'failed',
        reason: 'agent not accepting input',
        cause: 'not-accepting-input',
      }),
    )
  })

  it('does not turn a nested queued receipt into acceptance or retry it', async () => {
    const f = fixture()
    f.ready()
    f.send.mockResolvedValue({ outcome: 'queued' } as never)
    await f.handle.send({ rowId: 'queued', text: 'once' }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('does not claim cancellation retracted a write whose proof was lost', async () => {
    const f = fixture()
    f.ready()
    let finish!: (receipt: Awaited<ReturnType<typeof f.send>>) => void
    f.send.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await f.handle.send({ rowId: 'ambiguous', text: 'once' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.handle.cancelDelivery!('ambiguous')).toMatchObject({
      reason: 'busy',
      tooLate: 'typing',
    })
    finish({ outcome: 'unverified' } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }),
    )
  })

})

describe('interrupt rows (POD-4795)', () => {
  const fixture = () => {
    vi.useFakeTimers()
    let phase = 'working'
    const log: string[] = []
    const send = vi.fn(async (input: { text: string }, options?: { delivery?: string }) => {
      log.push(`type ${input.text} as ${options?.delivery}`)
      return {
        outcome: 'accepted',
        turnEpoch: 1,
        deliveredAs: 'when-ready',
        provenBy: 'protocol-ack',
        at: new Date().toISOString(),
      }
    })
    const emit = vi.fn()
    const interrupt = vi.fn(async () => {
      log.push('cut the turn')
    })
    const make = () =>
      withDeliveryQueue(
        {
          send,
          interrupt,
          state: async () => ({ phase }),
          lease: { state: async () => null },
        } as unknown as AgentSessionHandle,
        emit,
      )
    return {
      handle: make(),
      restart: make,
      send,
      emit,
      interrupt,
      log,
      setPhase: (next: string) => {
        phase = next
      },
    }
  }
  const whenReady = { origin: 'human', delivery: 'when-ready' } as const
  const interrupting = { origin: 'human', delivery: 'interrupt' } as const

  it('cuts a busy turn once and types the interrupt before older queued rows', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'older-1', text: 'older one' }, whenReady)
    await f.handle.send({ rowId: 'older-2', text: 'older two' }, whenReady)
    const receipt = await f.handle.send({ rowId: 'urgent', text: 'stop and do this' }, interrupting)
    // Answered at once, like every row: the reply never waits for the turn.
    expect(receipt).toMatchObject({ outcome: 'queued', position: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    // The turn is cut once, and nothing is typed over it while it runs.
    expect(f.log).toEqual(['cut the turn'])
    f.setPhase('idle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.log).toEqual([
      'cut the turn',
      'type stop and do this as when-ready',
      'type older one as when-ready',
      'type older two as when-ready',
    ])
    expect(f.emit.mock.calls.map(([event]) => event.rowId)).toEqual([
      'urgent',
      'older-1',
      'older-2',
    ])
  })

  it('keeps interrupts in arrival order among themselves', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'plain', text: 'plain' }, whenReady)
    await f.handle.send({ rowId: 'first', text: 'first interrupt' }, interrupting)
    await f.handle.send({ rowId: 'second', text: 'second interrupt' }, interrupting)
    await vi.advanceTimersByTimeAsync(1000)
    f.setPhase('idle')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send.mock.calls.map(([input]) => input.text)).toEqual([
      'first interrupt',
      'second interrupt',
      'plain',
    ])
  })

  it('types an interrupt to an idle agent at once, with no stop to send', async () => {
    const f = fixture()
    f.setPhase('idle')
    await f.handle.send({ rowId: 'urgent', text: 'nothing running' }, interrupting)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.interrupt).not.toHaveBeenCalled()
    expect(f.log).toEqual(['type nothing running as when-ready'])
  })

  it('types a repeated interrupt id once, and once across a daemon restart', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'urgent', text: 'only once' }, interrupting)
    await vi.advanceTimersByTimeAsync(500)
    f.setPhase('idle')
    await vi.advanceTimersByTimeAsync(500)
    // The same id again on this daemon: replayed, never re-cut or retyped.
    await f.handle.send({ rowId: 'urgent', text: 'only once' }, interrupting)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.log).toEqual(['cut the turn', 'type only once as when-ready'])
    expect(f.emit.mock.calls.map(([event]) => event.outcome)).toEqual(['delivered', 'delivered'])
    // The daemon restarts. The server re-forwards the row it reserved as a
    // recovery, and the new queue cuts nothing and types nothing.
    f.setPhase('working')
    const restarted = f.restart()
    f.emit.mockClear()
    await restarted.send(
      { rowId: 'urgent', deliveryRecovery: true, text: 'only once' },
      interrupting,
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.log).toEqual(['cut the turn', 'type only once as when-ready'])
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ rowId: 'urgent', outcome: 'failed', cause: 'unconfirmed' }),
    )
  })
})

describe('the entry a delivered row became (POD-4774)', () => {
  const fixture = (receiptItem?: { id: string }) => {
    vi.useFakeTimers()
    let named: ((item: { id: string; cursor?: string }) => void) | undefined
    const send = vi.fn(
      async (_input: { text: string }, options?: { onTranscriptItem?: typeof named }) => {
        named = options?.onTranscriptItem
        return {
          outcome: 'accepted',
          turnEpoch: 1,
          deliveredAs: 'when-ready',
          provenBy: 'protocol-ack',
          ...(receiptItem ? { transcriptItem: receiptItem } : {}),
          at: new Date().toISOString(),
        }
      },
    )
    const emit = vi.fn()
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase: 'idle' }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      emit,
    )
    return { handle, emit, name: (item: { id: string; cursor?: string }) => named?.(item) }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const

  it('carries the entry the receipt named on the delivered outcome', async () => {
    const f = fixture({ id: 'entry-1' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'delivered', transcriptItem: { id: 'entry-1' } },
    ])
  })

  it('names an entry learned after the receipt as a second delivered outcome, once, and replays it', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.name({ id: 'entry-2', cursor: 'c-2' })
    f.name({ id: 'entry-other' })
    const named = {
      t: 'delivery',
      rowId: 'row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry-2', cursor: 'c-2' },
    }
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'delivered' },
      named,
    ])
    // A repeated admission of the same row replays the outcome WITH its entry.
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    expect(f.emit.mock.calls.at(-1)?.[0]).toEqual(named)
  })

  it("names a direct send's entry under its turn id", async () => {
    const f = fixture()
    const receipt = await f.handle.send({ id: 'msg_direct', text: 'a' }, options)
    expect(receipt.outcome).toBe('accepted')
    f.name({ id: 'entry-3' })
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      {
        t: 'delivery',
        rowId: 'msg_direct',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-3' },
      },
    ])
  })
})
