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
    const unverified = {
      outcome: 'unverified',
      deliveredAs: 'when-ready',
      verificationWindowMs: 4800,
      at: new Date().toISOString(),
    } as const
    f.send.mockResolvedValue(unverified as never)
    await f.handle.send(
      { id: 'one', rowId: 'one', text: 'a' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.send).toHaveBeenCalledTimes(1)
    // The inner unverified receipt rides along (POD-4802) so the server can
    // tell "bytes written, unproven" from a proven loss.
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'one',
      outcome: 'failed',
      reason: 'delivery could not be confirmed; check the transcript before retrying',
      receipt: unverified,
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

  // POD-4700: a daemon-held direct send answers `queued` AT ONCE — the reply
  // must land inside the server's RPC window, never after the turn it waits
  // on — and drains in FIFO order behind the durable rows.
  it('answers a held row queued at once and drains it after the turn', async () => {
    const f = fixture()
    const options = { origin: 'human', delivery: 'when-ready' } as const
    await f.handle.send({ rowId: 'durable', text: 'first' }, options)
    const held = await f.handle.send(
      { id: 'turn-direct', rowId: 'turn-direct', text: 'held' },
      { ...options, daemonHeld: true },
    )
    // Both stubs, synchronously: nothing waited for the running turn.
    expect(held).toMatchObject({ outcome: 'queued', deliveredAs: 'queue' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
    f.ready()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(['first', 'held'])
    expect(f.emit.mock.calls.map(([event]) => event)).toEqual([
      { t: 'delivery', rowId: 'durable', outcome: 'delivered' },
      { t: 'delivery', rowId: 'turn-direct', outcome: 'delivered' },
    ])
  })

  // A held row that leaves the queue without being typed is a loss nobody
  // else settles: its turn id goes out through abandonment so the server
  // dead-letters it. Durable rows are spared — a new owner recovers them.
  it('reports held turn ids on teardown and spares durable rows', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => ({
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      at: new Date().toISOString(),
    }))
    const emit = vi.fn()
    const abandoned: Array<{ turns: Array<{ id: string }>; reason: string }> = []
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase: 'working' }),
        lease: { state: async () => null },
        stop: async () => {},
      } as unknown as AgentSessionHandle,
      emit,
      () => true,
      () => true,
      ({ turns, reason }) => {
        abandoned.push({ turns: [...turns], reason })
      },
    )
    const options = { origin: 'human', delivery: 'when-ready' } as const
    await handle.send({ rowId: 'durable', text: 'recoverable' }, options)
    await handle.send(
      { id: 'turn-direct', rowId: 'turn-direct', text: 'never typed' },
      { ...options, daemonHeld: true },
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).not.toHaveBeenCalled()
    await (handle as unknown as { stop(): Promise<unknown> }).stop()
    expect(send).not.toHaveBeenCalled()
    // Only the held turn is reported; the durable row goes quietly to its
    // next owner, and no delivery event claims either outcome.
    expect(abandoned).toEqual([
      { turns: [{ id: 'turn-direct', text: 'never typed', origin: 'human' }], reason: 'teardown' },
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it('abandons an expired held row as never-live', async () => {
    const f = fixture()
    const abandoned: Array<{ turns: Array<{ id: string }>; reason: string }> = []
    const handle = withDeliveryQueue(
      {
        send: f.send,
        state: async () => ({ phase: 'working' }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      f.emit,
      () => true,
      () => true,
      ({ turns, reason }) => {
        abandoned.push({ turns: [...turns], reason })
      },
    )
    await handle.send(
      { id: 'turn-stuck', rowId: 'turn-stuck', text: 'never ready' },
      { origin: 'human', delivery: 'when-ready', daemonHeld: true },
    )
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000)
    expect(f.send).not.toHaveBeenCalled()
    expect(abandoned).toEqual([
      { turns: [{ id: 'turn-stuck', text: 'never ready', origin: 'human' }], reason: 'never-live' },
    ])
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: 'turn-stuck', outcome: 'failed' }),
    )
  })

  // POD-4716: routine mail flooded sessions — N old fyi rows each opened its own
  // turn after a boot re-forward. The daemon now coalesces contiguous
  // coalescable rows into ONE digest turn, settling each rowId individually.
  // Urgent and expect-response rows keep one-turn-per-row behaviour.
  describe('POD-4716 routine-mail digest', () => {
    it('coalesces N queued fyi rows behind a busy turn into exactly one typed turn', async () => {
      const f = fixture()
      const options = { origin: 'mail', delivery: 'when-ready' } as const
      const N = 20
      for (let i = 0; i < N; i++) {
        await f.handle.send(
          { id: `m${i}`, rowId: `m${i}`, text: `body ${i}`, coalescable: true },
          options,
        )
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).not.toHaveBeenCalled()
      expect(f.emit).not.toHaveBeenCalled()
      f.ready()
      await vi.advanceTimersByTimeAsync(1000)
      // Exactly one turn typed for all N rows.
      expect(f.send).toHaveBeenCalledTimes(1)
      const typed = String(f.send.mock.calls[0]![0].text)
      for (let i = 0; i < N; i++) expect(typed).toContain(`body ${i}`)
      // Every row settled delivered by that one turn; none typed twice.
      expect(f.emit).toHaveBeenCalledTimes(N)
      expect(f.emit.mock.calls.map(([event]) => event)).toEqual(
        Array.from({ length: N }, (_, i) => ({ t: 'delivery', rowId: `m${i}`, outcome: 'delivered' })),
      )
    })

    it('coalesces a boot re-forward of N old fyi rows into one digest, never N turns', async () => {
      const f = fixture()
      f.ready()
      const options = { origin: 'mail', delivery: 'when-ready' } as const
      const N = 20
      for (let i = 0; i < N; i++) {
        await f.handle.send(
          { id: `old${i}`, rowId: `old${i}`, text: `old body ${i}`, coalescable: true },
          options,
        )
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.emit).toHaveBeenCalledTimes(N)
      expect(f.emit.mock.calls.map(([event]) => event.outcome)).toEqual(Array(N).fill('delivered'))
    })

    it('keeps urgent rows one-turn-each and preserves order around a digest', async () => {
      const f = fixture()
      const mail = { origin: 'mail', delivery: 'when-ready' } as const
      await f.handle.send({ id: 'u1', rowId: 'u1', text: 'urgent one' }, mail)
      await f.handle.send({ id: 'f1', rowId: 'f1', text: 'fyi one', coalescable: true }, mail)
      await f.handle.send({ id: 'f2', rowId: 'f2', text: 'fyi two', coalescable: true }, mail)
      await f.handle.send({ id: 'u2', rowId: 'u2', text: 'urgent two' }, mail)
      f.ready()
      await vi.advanceTimersByTimeAsync(2000)
      // Urgent rows type alone; the contiguous fyi pair types once as a digest.
      expect(f.send).toHaveBeenCalledTimes(3)
      expect(f.send.mock.calls.map(([input]) => String(input.text))).toEqual([
        'urgent one',
        expect.stringContaining('fyi one'),
        'urgent two',
      ])
      expect(String(f.send.mock.calls[1]![0].text)).toContain('fyi two')
      expect(f.emit.mock.calls.map(([event]) => event.rowId)).toEqual(['u1', 'f1', 'f2', 'u2'])
      expect(f.emit.mock.calls.every(([event]) => event.outcome === 'delivered')).toBe(true)
    })
  })
})
