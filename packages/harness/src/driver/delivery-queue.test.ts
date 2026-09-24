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
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      emit,
    )
    return {
      handle,
      send,
      emit,
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
  it('preserves provider acceptance that wins an in-flight cancellation race', async () => {
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
    const cancellation = f.handle.cancelDelivery!('one')
    accept({
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      at: new Date().toISOString(),
    })
    expect(await cancellation).toMatchObject({ reason: 'busy' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'delivered',
    })
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
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed',
      reason: 'the creation prompt was not confirmed; it will not be typed again automatically' }))
  })

  it('imports attempted rows as recoverable ambiguity, without a second turn', async () => {
    const f = fixture()
    f.ready()
    await f.handle.send({ rowId: 'old', deliveryRecovery: true, text: 'already typed' },
      { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'old', outcome: 'failed' }))
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
    expect(await f.handle.cancelDelivery!('accepted')).toMatchObject({ reason: 'busy' })
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

  it('bounds a busy agent without writing or losing the queued text silently', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'busy', text: 'wait' }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 200)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'busy', outcome: 'failed' }))
  })

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

  it('bounds a needs_user wait at the same ceiling as a running turn', async () => {
    const f = fixture()
    f.setPhase('needs_user')
    await f.handle.send({ rowId: 'unanswered', text: 'wait' }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 200)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'unanswered', outcome: 'failed' }))
  })

  // These phases do not end on their own, so a short ceiling reports the stuck
  // row instead of holding it for half an hour.
  for (const phase of ['unknown', 'errored', 'ended'] as const) {
    it(`keeps the short ceiling for a ${phase} agent`, async () => {
      const f = fixture()
      f.setPhase(phase)
      await f.handle.send({ rowId: phase, text: 'wait' }, { origin: 'mail', delivery: 'when-ready' })
      await vi.advanceTimersByTimeAsync(60_200)
      expect(f.send).not.toHaveBeenCalled()
      expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: phase, outcome: 'failed' }))
    })
  }

  it('bounds a never-ready composer', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const emit = vi.fn()
    const handle = withDeliveryQueue({ send, state: async () => ({ phase: 'idle' }) } as unknown as AgentSessionHandle,
      emit, () => false)
    await handle.send({ rowId: 'starting', text: 'first' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(60_200)
    expect(send).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'starting', outcome: 'failed' }))
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
    const cancel = f.handle.cancelDelivery!('ambiguous')
    finish({ outcome: 'unverified' } as never)
    expect(await cancel).toMatchObject({ reason: 'busy' })
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed' }))
  })

})
