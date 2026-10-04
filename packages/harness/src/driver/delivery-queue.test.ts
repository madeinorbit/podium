import { afterEach, describe, expect, it, vi } from 'vitest'
import { withDeliveryQueue, type DeliveryJournal } from './delivery-queue.js'
import type { AgentSessionHandle } from './driver.js'
import type { SendOptions, TurnInput } from './turns.js'
import type { RuntimeEventBody } from './events.js'

afterEach(() => vi.useRealTimers())

describe('daemon restart before typing (POD-5556)', () => {
  const options = { origin: 'mail', delivery: 'when-ready' } as const
  const input = { id: 'held-mail', rowId: 'held-mail', text: 'send after the turn', deliveryRecovery: false }

  function owner(journal: DeliveryJournal) {
    let phase = 'working'
    const emit = vi.fn<(event: RuntimeEventBody) => void>()
    const send = vi.fn(async (_input: TurnInput, options: SendOptions) => {
      options.onTypingStarted?.()
      return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready',
        provenBy: 'protocol-ack', at: new Date().toISOString() }
    })
    const handle = withDeliveryQueue({
      send, state: async () => ({ phase }), stop: async () => {},
    } as unknown as AgentSessionHandle, emit, undefined, undefined, journal)
    return { handle, send, emit, idle: () => { phase = 'idle' } }
  }

  it('holds an untyped row again after a new owner receives deliveryRecovery, then types it exactly once', async () => {
    vi.useFakeTimers()
    const started = new Set<string>()
    const stored = new Set<string>()
    const journal = {
      read: (id: string) => stored.has(id) ? { typingStarted: started.has(id) } : undefined,
      store: (id: string) => { stored.add(id) },
      start: (id: string) => { started.add(id) },
      clear: (id: string) => { started.delete(id) },
      record: vi.fn(),
    }
    const before = owner(journal)
    await before.handle.send(input, options)
    await vi.advanceTimersByTimeAsync(200)
    expect(before.send).not.toHaveBeenCalled()
    expect(started.size).toBe(0)
    await before.handle.stop()

    const after = owner(journal)
    await after.handle.send({ ...input, deliveryRecovery: true }, options)
    await vi.advanceTimersByTimeAsync(200)
    expect(after.emit).not.toHaveBeenCalled()
    expect(after.send).not.toHaveBeenCalled()
    after.idle()
    await vi.advanceTimersByTimeAsync(200)
    await after.handle.send({ ...input, deliveryRecovery: true }, options)
    await vi.advanceTimersByTimeAsync(200)
    expect(before.send).not.toHaveBeenCalled()
    expect(after.send).toHaveBeenCalledTimes(1)
    expect(after.emit.mock.calls.map(([event]) => event.t === 'delivery' && event.outcome)).toEqual(['delivered', 'delivered'])
    await after.handle.stop()
  })

  it('keeps a started write on the confirm-or-unconfirmed path after restart', async () => {
    vi.useFakeTimers()
    const after = owner({ read: () => ({ typingStarted: true }), store: vi.fn(), start: vi.fn(), clear: vi.fn(), record: vi.fn() })
    after.idle()
    await after.handle.send({ ...input, deliveryRecovery: true }, options)
    await vi.advanceTimersByTimeAsync(200)
    expect(after.send).not.toHaveBeenCalled()
    expect(after.emit).toHaveBeenCalledWith(expect.objectContaining({ rowId: input.rowId, outcome: 'failed', cause: 'unconfirmed' }))
    await after.handle.stop()
  })
})

describe('exact history proof contradicting a final failure (POD-4894)', () => {
  it.each([
    ['entry', 'server'], ['late', 'server'], ['direct', 'server'],
    ['entry', 'terminal'], ['late', 'terminal'],
  ] as const)('keeps failed final after %s proof on a %s driver', async (via, family) => {
    vi.useFakeTimers()
    let onEntry: ((item: { id: string }, refs?: { kind: string; id: string }[]) => void) | undefined
    let onLate: ((proof: { transcriptItem?: { id: string }; harnessRef?: { kind: string; id: string }[] }) => void) | undefined
    let onNo: ((reason: string, cause?: 'agent-exited') => void) | undefined
    const emit = vi.fn()
    const send = vi.fn(async (_input: TurnInput, options: SendOptions) => {
      onEntry = options.onTranscriptItem
      onLate = options.onLateProof
      onNo = options.onUnrecorded
      return { outcome: 'accepted', held: 'memory', turnEpoch: 1, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: new Date().toISOString() }
    })
    const handle = withDeliveryQueue({
      send, state: async () => ({ phase: 'idle' }), lease: { state: async () => null },
      binding: { family },
    } as unknown as AgentSessionHandle, emit)
    const input = { id: 'msg_one', ...(via === 'direct' ? {} : { rowId: 'msg_one' }), text: 'private prompt' }
    const options = { origin: 'human', delivery: 'when-ready' } as const
    await handle.send(input, options)
    await vi.advanceTimersByTimeAsync(0)
    onNo?.('not in history after exit', 'agent-exited')
    const failed = emit.mock.calls.at(-1)![0]
    expect(failed).toMatchObject({ outcome: 'failed', cause: 'agent-exited' })
    const proof = {
      transcriptItem: { id: 'entry-1' },
      harnessRef: [{ kind: 'codex-client-message', id: input.id }],
    }
    const prove = () => via !== 'late'
      ? onEntry?.(proof.transcriptItem, proof.harnessRef)
      : onLate?.(proof)
    prove()
    prove()
    expect(emit.mock.calls.map(([event]) => event).filter((event) => event.outcome === 'delivered')).toEqual(family === 'server' ? [
      { t: 'delivery', rowId: input.id, outcome: 'delivered', ...proof },
    ] : [])
    if (via !== 'direct') {
      await handle.send(input, options)
      expect(emit.mock.calls.at(-1)![0]).toEqual(failed)
    }
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('durable row delivery', () => {
  const fixture = () => {
    vi.useFakeTimers()
    let phase = 'working'
    let composerReady = true
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
      () => composerReady,
    )
    return {
      handle,
      send,
      emit,
      interrupt,
      ready: () => {
        phase = 'idle'
        composerReady = true
      },
      setPhase: (next: string) => {
        phase = next
      },
      setComposerReady: (next: boolean) => {
        composerReady = next
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

  // The ceiling counts a CONTINUOUS not-accepting stretch, never the time
  // since arrival (POD-4826): after twenty minutes behind a busy turn, one
  // wrong state reading (a reattach's first seconds, a flicker) must not fail
  // a row that has been "stuck" for one poll.
  const notAccepting = {
    unknown: (f: ReturnType<typeof fixture>) => f.setPhase('unknown'),
    'idle but not ready': (f: ReturnType<typeof fixture>) => {
      f.setPhase('idle')
      f.setComposerReady(false)
    },
  }
  for (const [label, enter] of Object.entries(notAccepting)) {
    it(`delivers after a long busy wait and one ${label} reading`, async () => {
      const f = fixture()
      await f.handle.send(
        { rowId: 'waited', text: 'after the turn' },
        { origin: 'mail', delivery: 'when-ready' },
      )
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      enter(f)
      await vi.advanceTimersByTimeAsync(200)
      expect(f.emit).not.toHaveBeenCalled()
      f.ready()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.emit).toHaveBeenCalledTimes(1)
      expect(f.emit).toHaveBeenCalledWith(
        expect.objectContaining({ rowId: 'waited', outcome: 'delivered' }),
      )
    })
  }

  it('fails a row only after the agent stays not accepting for the whole ceiling', async () => {
    const f = fixture()
    await f.handle.send(
      { rowId: 'stuck', text: 'wait' },
      { origin: 'mail', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    f.setPhase('unknown')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_400)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: 'stuck',
        outcome: 'failed',
        reason: 'agent not accepting input',
        cause: 'not-accepting-input',
      }),
    )
  })

  it('a reading of a live turn restarts the not-accepting stretch', async () => {
    const f = fixture()
    f.setPhase('unknown')
    await f.handle.send(
      { rowId: 'flicker', text: 'wait' },
      { origin: 'mail', delivery: 'when-ready' },
    )
    await vi.advanceTimersByTimeAsync(40_000)
    f.setPhase('working')
    await vi.advanceTimersByTimeAsync(400)
    f.setPhase('unknown')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(f.emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(21_000)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: 'flicker',
        outcome: 'failed',
        cause: 'not-accepting-input',
      }),
    )
  })

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

/**
 * A MESSAGE THE PROGRAM HOLDS IN MEMORY IS NOT DELIVERED YET (POD-4849).
 *
 * Codex answers `turn/steer`, and a `turn/start` that lands on a running turn,
 * at once — and records the message only at its next model call. Stopped
 * before that call, the message is dropped. Such a receipt says `held:
 * 'memory'`, and the row settles on what follows it: `delivered` naming the
 * entry once recorded, or `failed` + `unconfirmed` (the server's `unknown`)
 * when the program says it will not be recorded any more.
 */
describe('a receipt held in memory (POD-4849)', () => {
  type Named = (item: { id: string }) => void
  type Unrecorded = (reason: string) => void
  const fixture = () => {
    vi.useFakeTimers()
    let named: Named | undefined
    let unrecorded: Unrecorded | undefined
    let early: ((named: Named, unrecorded: Unrecorded) => void) | undefined
    const send = vi.fn(
      async (
        _input: { text: string },
        options?: { onTranscriptItem?: Named; onUnrecorded?: Unrecorded },
      ) => {
        named = options?.onTranscriptItem
        unrecorded = options?.onUnrecorded
        // What arrives before the receipt goes back, when a test asks for it.
        if (named && unrecorded) early?.(named, unrecorded)
        return {
          outcome: 'accepted',
          turnEpoch: 1,
          deliveredAs: 'steer',
          provenBy: 'protocol-ack',
          held: 'memory',
          at: new Date().toISOString(),
        }
      },
    )
    const emit = vi.fn()
    const stop = vi.fn(async () => {})
    let phase = 'idle'
    const handle = withDeliveryQueue(
      {
        send,
        stop,
        state: async () => ({ phase }),
        lease: { state: async () => null },
        binding: {},
      } as unknown as AgentSessionHandle,
      emit,
    )
    return {
      handle,
      send,
      emit,
      events: () => emit.mock.calls.map(([event]) => event),
      name: (item: { id: string }) => named?.(item),
      unrecorded: (reason: string) => unrecorded?.(reason),
      beforeReceipt: (act: (named: Named, unrecorded: Unrecorded) => void) => {
        early = act
      },
      setPhase: (next: string) => {
        phase = next
      },
    }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const

  it('settles nothing on the receipt, and delivered once the program records it', async () => {
    const f = fixture()
    await f.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(1000)
    // The program has it: the server hears `accepted`, and how it is held
    // (POD-4886), so the person no longer sees `typed` for the whole hold.
    expect(f.events()).toEqual([{ t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory' }])
    f.name({ id: 'entry-1' })
    expect(f.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory' },
      { t: 'delivery', rowId: 'row', outcome: 'delivered', transcriptItem: { id: 'entry-1' } },
    ])
  })

  it('ends as unconfirmed, never delivered, when the program will not record it', async () => {
    const f = fixture()
    await f.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.unrecorded('the turn was interrupted before Codex recorded the message')
    // A record that arrives after the drop changes nothing here: the server's
    // late proof by id is the only way back (POD-4840).
    f.name({ id: 'entry-late' })
    expect(f.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory' },
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'the turn was interrupted before Codex recorded the message',
        cause: 'unconfirmed',
      },
    ])
  })

  it('takes a record or a drop that arrived before the receipt', async () => {
    const recorded = fixture()
    recorded.beforeReceipt((named) => named({ id: 'entry-early' }))
    await recorded.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'delivered', transcriptItem: { id: 'entry-early' } },
    ])

    const dropped = fixture()
    dropped.beforeReceipt((_named, unrecorded) => unrecorded('dropped'))
    await dropped.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(dropped.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'failed', reason: 'dropped', cause: 'unconfirmed' },
    ])
  })

  it('types the next row while one waits for its record, and a retract of it is too late', async () => {
    const f = fixture()
    await f.handle.send({ id: 'held', rowId: 'held', text: 'a' }, options)
    await f.handle.send({ id: 'next', rowId: 'next', text: 'b' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(['a', 'b'])
    expect(await f.handle.cancelDelivery!('held')).toMatchObject({
      reason: 'busy',
      tooLate: 'typing',
    })
    expect(f.events()).toEqual([
      { t: 'delivery', rowId: 'held', outcome: 'accepted', held: 'memory' },
      { t: 'delivery', rowId: 'next', outcome: 'accepted', held: 'memory' },
    ])
  })

  it('a repeated admission of a row waiting for its record types nothing again', async () => {
    const f = fixture()
    await f.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    const again = await f.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(1000)
    expect(again.outcome).toBe('queued')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.events()).toEqual([{ t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory' }])
  })

  it('teardown discards a row waiting for its record, like every other row', async () => {
    const f = fixture()
    await f.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    await f.handle.stop!()
    f.unrecorded('the session ended')
    f.name({ id: 'entry-late' })
    // A new owner receives the durable row again and settles it by recovery.
    expect(f.events()).toEqual([{ t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory' }])
  })
})

/**
 * A MESSAGE THE PROGRAM KEEPS ACROSS ITS OWN RESTART (POD-4886; POD-4819 §4,
 * §9). An OpenCode v2 admission, a Codex `thread/queue` item: it may run later
 * on its own, so nothing but the program's record settles it. No timer and no
 * end of a turn or session moves it to unconfirmed, and a daemon restart does
 * not end the watch: the server forwards the row again saying it is held
 * durably, and the new owner watches it again without typing a byte.
 */
describe('a receipt held durably (POD-4886)', () => {
  type Named = (item: { id: string }) => void
  type Unrecorded = (reason: string) => void
  type Watch = { onTranscriptItem?: Named; signal?: AbortSignal }
  const daemon = (opts: { rewatch?: boolean } = {}) => {
    let named: Named | undefined
    let unrecorded: Unrecorded | undefined
    const watched: Array<{ input: { text: string }; watch: Watch }> = []
    const send = vi.fn(
      async (
        _input: { text: string },
        options?: { onTranscriptItem?: Named; onUnrecorded?: Unrecorded },
      ) => {
        named = options?.onTranscriptItem
        unrecorded = options?.onUnrecorded
        return {
          outcome: 'accepted',
          turnEpoch: 1,
          deliveredAs: 'queue',
          provenBy: 'protocol-ack',
          held: 'durable',
          harnessRef: [{ kind: 'message', id: 'msg_prog' }],
          at: new Date().toISOString(),
        }
      },
    )
    const emit = vi.fn()
    const stop = vi.fn(async () => {})
    const handle = withDeliveryQueue(
      {
        send,
        stop,
        state: async () => ({ phase: 'idle' }),
        lease: { state: async () => null },
        binding: {},
        ...(opts.rewatch === false
          ? {}
          : {
              watchHeld: (input: { text: string }, watch: Watch) => {
                watched.push({ input, watch })
              },
            }),
      } as unknown as AgentSessionHandle,
      emit,
    )
    return {
      handle,
      send,
      watched,
      events: () => emit.mock.calls.map(([event]) => event),
      name: (item: { id: string }) => named?.(item),
      unrecorded: (reason: string) => unrecorded?.(reason),
    }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const
  const accepted = {
    t: 'delivery',
    rowId: 'row',
    outcome: 'accepted',
    held: 'durable',
    harnessRef: [{ kind: 'message', id: 'msg_prog' }],
  }

  it('says accepted and durable, and no timer or ended turn settles it', async () => {
    vi.useFakeTimers()
    const d = daemon()
    await d.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(d.events()).toEqual([accepted])
    // What ends a memory hold does not end this one: the program still has it.
    d.unrecorded('the turn ended before the program recorded the message')
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(d.events()).toEqual([accepted])
    d.name({ id: 'entry-1' })
    expect(d.events()).toEqual([
      accepted,
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-1' },
        harnessRef: [{ kind: 'message', id: 'msg_prog' }],
      },
    ])
  })

  it('survives a daemon restart: the new owner watches it again, types nothing, never gives up', async () => {
    vi.useFakeTimers()
    const before = daemon()
    await before.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(before.events()).toEqual([accepted])

    // The daemon restarts: its memory is gone. The server still holds the row
    // and forwards it again as a recovery, saying the program holds it durably.
    const after = daemon()
    const receipt = await after.handle.send(
      { id: 'row', rowId: 'row', text: 'a', deliveryRecovery: true, held: 'durable' },
      options,
    )
    expect(receipt.outcome).toBe('queued')
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(after.send).not.toHaveBeenCalled()
    expect(after.watched.map(({ input }) => input.text)).toEqual(['a'])
    expect(after.events()).toEqual([])
    // Too late to retract: the program has it.
    expect(await after.handle.cancelDelivery!('row')).toMatchObject({ reason: 'busy' })
    // A repeated forward watches nothing twice.
    await after.handle.send(
      { id: 'row', rowId: 'row', text: 'a', deliveryRecovery: true, held: 'durable' },
      options,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(after.watched).toHaveLength(1)

    after.watched[0]!.watch.onTranscriptItem!({ id: 'entry-1' })
    expect(after.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'delivered', transcriptItem: { id: 'entry-1' } },
    ])
  })

  it('a driver that cannot watch again leaves it open, never unconfirmed', async () => {
    vi.useFakeTimers()
    const after = daemon({ rewatch: false })
    await after.handle.send(
      { id: 'row', rowId: 'row', text: 'a', deliveryRecovery: true, held: 'durable' },
      options,
    )
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(after.send).not.toHaveBeenCalled()
    expect(after.events()).toEqual([])
  })

  it('a recovery the server does not call durable still ends unconfirmed, as before', async () => {
    vi.useFakeTimers()
    const after = daemon()
    await after.handle.send({ id: 'row', rowId: 'row', text: 'a', deliveryRecovery: true }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(after.send).not.toHaveBeenCalled()
    expect(after.watched).toEqual([])
    expect(after.events()).toMatchObject([{ rowId: 'row', outcome: 'failed', cause: 'unconfirmed' }])
  })

  it('teardown ends the watch; the next owner is given the row again', async () => {
    vi.useFakeTimers()
    const d = daemon()
    await d.handle.send({ id: 'row', rowId: 'row', text: 'a', deliveryRecovery: true, held: 'durable' }, options)
    await vi.advanceTimersByTimeAsync(0)
    await d.handle.stop!()
    expect(d.watched[0]!.watch.signal?.aborted).toBe(true)
    d.watched[0]!.watch.onTranscriptItem!({ id: 'entry-late' })
    expect(d.events()).toEqual([])
  })
})

/**
 * PROOF THAT COMES AFTER THE WINDOW STILL COUNTS (POD-4840).
 *
 * A row whose send came back `unverified` settles `failed` with cause
 * `unconfirmed` — the server records it `unknown`. The driver keeps watching,
 * and when the harness's own record of the prompt lands late it says so
 * through `onLateProof`: the row moves forward to `delivered`, naming the
 * entry. Forward only: nothing leaves `delivered`, and a row that failed
 * because it was never typed has no proof to receive.
 */
describe('late proof of an unconfirmed row (POD-4840)', () => {
  type LateProof = (seen: { transcriptItem?: { id: string; cursor?: string } }) => void
  const fixture = (receipt: Record<string, unknown> = { outcome: 'unverified' }) => {
    vi.useFakeTimers()
    const proofs = new Map<string, LateProof | undefined>()
    const send = vi.fn(async (input: { text: string }, options?: { onLateProof?: LateProof }) => {
      proofs.set(input.text, options?.onLateProof)
      return {
        deliveredAs: 'when-ready',
        verificationWindowMs: 4800,
        at: new Date().toISOString(),
        ...receipt,
      }
    })
    const emit = vi.fn()
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase: 'idle' }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      emit,
    )
    const prove = (text: string, seen: Parameters<LateProof>[0]) => {
      const onLateProof = proofs.get(text)
      if (!onLateProof) throw new Error(`the send of ${text} armed no late proof`)
      onLateProof(seen)
    }
    return { handle, emit, prove, events: () => emit.mock.calls.map(([event]) => event) }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const
  const unconfirmed = {
    t: 'delivery',
    rowId: 'row',
    outcome: 'failed',
    reason: 'delivery could not be confirmed; check the transcript before retrying',
    cause: 'unconfirmed',
  }

  it('moves an unconfirmed row to delivered, naming the entry, once, and replays it', async () => {
    const f = fixture()
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events()).toEqual([unconfirmed])
    f.prove('a', { transcriptItem: { id: 'entry-1', cursor: 'c-1' } })
    f.prove('a', { transcriptItem: { id: 'entry-other' } })
    const delivered = {
      t: 'delivery',
      rowId: 'row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry-1', cursor: 'c-1' },
    }
    expect(f.events()).toEqual([unconfirmed, delivered])
    // A repeated admission replays the delivered outcome, never the failure.
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    expect(f.events().at(-1)).toEqual(delivered)
    // And a retract now loses to a delivery.
    expect(await f.handle.cancelDelivery?.('row')).toMatchObject({ tooLate: 'delivered' })
  })

  it('ignores late proof for a row that failed without being typed', async () => {
    const f = fixture({
      outcome: 'refused',
      refusal: { reason: 'staging_failed', detail: 'no upload' },
    })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    const failed = { t: 'delivery', rowId: 'row', outcome: 'failed', reason: 'no upload' }
    expect(f.events()).toEqual([failed])
    // Whatever reaches the queue later, a row nobody typed was not delivered.
    f.prove('a', { transcriptItem: { id: 'entry-1' } })
    expect(f.events()).toEqual([failed])
  })

  it("moves a direct send's unconfirmed turn to delivered under its turn id", async () => {
    const f = fixture()
    const receipt = await f.handle.send({ id: 'msg_direct', text: 'a' }, options)
    expect(receipt.outcome).toBe('unverified')
    f.prove('a', { transcriptItem: { id: 'entry-3' } })
    expect(f.events()).toEqual([
      {
        t: 'delivery',
        rowId: 'msg_direct',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-3' },
      },
    ])
  })
})

/**
 * THE PROGRAM'S OWN "NO" (POD-4887; POD-4819 §6.1 N2b, N3, N4). A driver that
 * proves from the program's own evidence that a typed message is not in its
 * conversation passes the cause with `onUnrecorded`; the row ends `failed`
 * with it — safe to resend — never `unknown`. Without one, nothing changes.
 */
describe("the program's own proven \"no\" (POD-4887)", () => {
  type Unrecorded = (reason: string, proof?: 'dropped-by-agent' | 'not-recorded' | 'agent-exited') => void
  type LateProof = (seen: { transcriptItem?: { id: string } }) => void
  const fixture = (receipt: Record<string, unknown>) => {
    vi.useFakeTimers()
    const unrecorded = new Map<string, Unrecorded | undefined>()
    const proofs = new Map<string, LateProof | undefined>()
    let early: ((unrecorded: Unrecorded) => void) | undefined
    const send = vi.fn(
      async (
        input: { text: string },
        options?: { onUnrecorded?: Unrecorded; onLateProof?: LateProof },
      ) => {
        unrecorded.set(input.text, options?.onUnrecorded)
        proofs.set(input.text, options?.onLateProof)
        if (options?.onUnrecorded) early?.(options.onUnrecorded)
        return { deliveredAs: 'when-ready', at: new Date().toISOString(), ...receipt }
      },
    )
    const emit = vi.fn()
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase: 'idle' }),
        lease: { state: async () => null },
        binding: {},
      } as unknown as AgentSessionHandle,
      emit,
    )
    return {
      handle,
      events: () => emit.mock.calls.map(([event]) => event),
      settlements: () =>
        emit.mock.calls.map(([event]) => event).filter((event) => event.outcome !== 'accepted'),
      disprove: (text: string, ...args: Parameters<Unrecorded>) => unrecorded.get(text)?.(...args),
      prove: (text: string, seen: Parameters<LateProof>[0]) => proofs.get(text)?.(seen),
      beforeReceipt: (act: (unrecorded: Unrecorded) => void) => {
        early = act
      },
    }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const
  const heldReceipt = {
    outcome: 'accepted',
    turnEpoch: 1,
    provenBy: 'transcript-echo',
    held: 'memory',
  }
  const unverified = { outcome: 'unverified', verificationWindowMs: 4800 }

  it('fails a held row with the cause the program proved', async () => {
    const f = fixture(heldReceipt)
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.disprove('a', 'dropped by a hook', 'dropped-by-agent')
    f.disprove('a', 'the session ended before the harness recorded it')
    expect(f.settlements()).toEqual([
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'dropped by a hook',
        cause: 'dropped-by-agent',
      },
    ])
  })

  it('takes a proof that came before an unverified receipt: failed, never unknown', async () => {
    const f = fixture(unverified)
    f.beforeReceipt((unrecorded) => unrecorded('blocked by a hook', 'dropped-by-agent'))
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settlements()).toEqual([
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'blocked by a hook',
        cause: 'dropped-by-agent',
      },
    ])
  })

  it('takes a proof that came before a held receipt', async () => {
    const f = fixture(heldReceipt)
    f.beforeReceipt((unrecorded) => unrecorded('the program exited', 'agent-exited'))
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settlements()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'failed', reason: 'the program exited', cause: 'agent-exited' },
    ])
  })

  it('moves an unconfirmed row to a late "no" once, and nothing moves it after', async () => {
    const f = fixture(unverified)
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    const unconfirmed = {
      t: 'delivery',
      rowId: 'row',
      outcome: 'failed',
      reason: 'delivery could not be confirmed; check the transcript before retrying',
      cause: 'unconfirmed',
    }
    expect(f.settlements()).toEqual([unconfirmed])
    f.disprove('a', 'the program exited without it', 'agent-exited')
    const exited = { ...unconfirmed, reason: 'the program exited without it', cause: 'agent-exited' }
    expect(f.settlements()).toEqual([unconfirmed, exited])
    // `failed` stays final: a second "no" or a late record moves nothing.
    f.disprove('a', 'again', 'not-recorded')
    f.prove('a', { transcriptItem: { id: 'entry-late' } })
    expect(f.settlements()).toEqual([unconfirmed, exited])
    // A repeated admission replays the proven "no".
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    expect(f.events().at(-1)).toEqual(exited)
  })

  it('a "no" without proof after an unverified receipt changes nothing', async () => {
    const f = fixture(unverified)
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    const before = f.settlements()
    f.disprove('a', 'the watch closed')
    expect(f.settlements()).toEqual(before)
  })

  it('never fails a durable hold, even with a proof', async () => {
    const f = fixture({ ...heldReceipt, held: 'durable' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.disprove('a', 'the program exited', 'agent-exited')
    expect(f.settlements()).toEqual([])
  })

  it('a row refused before typing keeps its refusal', async () => {
    const f = fixture({ outcome: 'refused', refusal: { reason: 'staging_failed', detail: 'no upload' } })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.disprove('a', 'the program exited', 'agent-exited')
    expect(f.settlements()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'failed', reason: 'no upload' },
    ])
  })

  it("fails a direct send under its turn id only on a proof", async () => {
    const f = fixture(unverified)
    await f.handle.send({ id: 'msg_direct', text: 'a' }, options)
    f.disprove('a', 'the watch closed')
    expect(f.events()).toEqual([])
    f.disprove('a', 'the program exited without it', 'agent-exited')
    expect(f.events()).toEqual([
      {
        t: 'delivery',
        rowId: 'msg_direct',
        outcome: 'failed',
        reason: 'the program exited without it',
        cause: 'agent-exited',
      },
    ])
  })
})

describe('a refusal is a proven "no" (POD-4839)', () => {
  const fixture = (refusal: { reason: string; detail?: string }) => {
    vi.useFakeTimers()
    let alive = true
    const send = vi.fn(async (_input: { text: string }, _options?: unknown) => ({
      outcome: 'refused' as const,
      refusal,
    }))
    const emit = vi.fn()
    const handle = withDeliveryQueue(
      {
        send,
        state: async () => ({ phase: 'idle' }),
        lease: { state: async () => null },
      } as unknown as AgentSessionHandle,
      emit,
      undefined,
      () => alive,
    )
    return {
      handle,
      send,
      emit,
      end: () => {
        alive = false
      },
    }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const

  it('settles any final refusal as never typed, with its detail, never unconfirmed', async () => {
    // A JSON-RPC or HTTP refusal of the request recorded nothing (POD-4834,
    // N2), and every other refusal is reached before a byte is written.
    const f = fixture({ reason: 'invalid_value', detail: 'codex turn/start → -32600: bad input' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'row',
      outcome: 'failed',
      reason: 'codex turn/start → -32600: bad input',
    })
  })

  it('settles a refusal it has no rule for as never typed, named by its reason', async () => {
    const f = fixture({ reason: 'no_archive_yet' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'row',
      outcome: 'failed',
      reason: 'no_archive_yet',
    })
  })

  it('leaves a row refused by an ended session to the server, for the next owner', async () => {
    // Hibernate, stop and a dead process end the session; the server still
    // holds the row and forwards it again on the next bind.
    const f = fixture({ reason: 'not_running' })
    f.send.mockImplementationOnce(async () => {
      f.end()
      return { outcome: 'refused', refusal: { reason: 'not_running' } }
    })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).not.toHaveBeenCalled()
  })

  it('waits for a live session whose process is not running, then fails it as never typed', async () => {
    const f = fixture({ reason: 'not_running', detail: 'the opencode server for this session is gone' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.send.mock.calls.length).toBeGreaterThan(1)
    expect(f.emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_400)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      t: 'delivery',
      rowId: 'row',
      outcome: 'failed',
      reason: 'agent not accepting input',
      cause: 'not-accepting-input',
    })
  })

  it('a session that ends while it waits keeps the row for the next owner', async () => {
    const f = fixture({ reason: 'not_running' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(30_000)
    f.end()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.emit).not.toHaveBeenCalled()
  })

  it('a retract while it waits on a session that is not running still wins', async () => {
    const f = fixture({ reason: 'not_running' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await f.handle.cancelDelivery?.('row')).toEqual({ ok: true })
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({ t: 'delivery', rowId: 'row', outcome: 'dropped' })
  })
})

/**
 * THE PROGRAM'S OWN IDS TRAVEL WITH THE ROW'S OUTCOME (POD-4841).
 *
 * A driver names them on the receipt (the answer to the send) and beside the
 * entry it learns later. Every outcome for the row carries all the ids known
 * by then, merged; ids alone never move a row — only the receipt or the entry
 * does — so a late id with nothing else emits nothing.
 */
describe("the program's own ids for a row (POD-4841)", () => {
  type Ref = { kind: string; id: string }
  type Named = (item: { id: string }, harnessRef?: readonly Ref[]) => void
  type Unrecorded = (reason: string) => void
  type LateProof = (proof: { transcriptItem?: { id: string }; harnessRef?: readonly Ref[] }) => void
  const turn = { kind: 'codex-turn', id: 'turn-1' }
  const echo = { kind: 'codex-client-message', id: 'row' }
  const fixture = (receipt: Record<string, unknown>) => {
    vi.useFakeTimers()
    let named: Named | undefined
    let unrecorded: Unrecorded | undefined
    let lateProof: LateProof | undefined
    const send = vi.fn(
      async (
        _input: { text: string },
        options?: { onTranscriptItem?: Named; onUnrecorded?: Unrecorded; onLateProof?: LateProof },
      ) => {
        named = options?.onTranscriptItem
        unrecorded = options?.onUnrecorded
        lateProof = options?.onLateProof
        return {
          turnEpoch: 1,
          deliveredAs: 'when-ready',
          provenBy: 'protocol-ack',
          verificationWindowMs: 4800,
          at: new Date().toISOString(),
          ...receipt,
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
    return {
      handle,
      events: () => emit.mock.calls.map(([event]) => event),
      name: (item: { id: string }, refs?: readonly Ref[]) => named?.(item, refs),
      unrecorded: (reason: string) => unrecorded?.(reason),
      prove: (proof: Parameters<LateProof>[0]) => lateProof?.(proof),
    }
  }
  const options = { origin: 'human', delivery: 'when-ready' } as const

  it("carries the receipt's ids on the delivered outcome, and replays them", async () => {
    const f = fixture({ outcome: 'accepted', transcriptItem: { id: 'entry-1' }, harnessRef: [turn] })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    const delivered = {
      t: 'delivery',
      rowId: 'row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry-1' },
      harnessRef: [turn],
    }
    expect(f.events()).toEqual([delivered])
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    expect(f.events().at(-1)).toEqual(delivered)
  })

  it('merges ids learned with a late entry into the second delivered outcome', async () => {
    const f = fixture({ outcome: 'accepted', harnessRef: [turn] })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.name({ id: 'entry-2' }, [turn, echo])
    expect(f.events()).toEqual([
      { t: 'delivery', rowId: 'row', outcome: 'delivered', harnessRef: [turn] },
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-2' },
        harnessRef: [turn, echo],
      },
    ])
  })

  it('a held row keeps its receipt ids until it settles, either way', async () => {
    const recorded = fixture({ outcome: 'accepted', held: 'memory', harnessRef: [turn] })
    await recorded.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    // The hold is reported with the ids known so far (POD-4886).
    const accepted = { t: 'delivery', rowId: 'row', outcome: 'accepted', held: 'memory', harnessRef: [turn] }
    expect(recorded.events()).toEqual([accepted])
    recorded.name({ id: 'entry-1' }, [echo])
    expect(recorded.events()).toEqual([
      accepted,
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-1' },
        harnessRef: [turn, echo],
      },
    ])

    const lost = fixture({ outcome: 'accepted', held: 'memory', harnessRef: [turn] })
    await lost.handle.send({ id: 'row', rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    lost.unrecorded('the turn was interrupted')
    // The turn id is what a later look-up of an unconfirmed steer needs most.
    expect(lost.events()).toEqual([
      accepted,
      {
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'the turn was interrupted',
        cause: 'unconfirmed',
        harnessRef: [turn],
      },
    ])
  })

  it('carries the ids a late proof names', async () => {
    const f = fixture({ outcome: 'unverified' })
    await f.handle.send({ rowId: 'row', text: 'a' }, options)
    await vi.advanceTimersByTimeAsync(0)
    f.prove({ transcriptItem: { id: 'entry-1' }, harnessRef: [echo] })
    expect(f.events().at(-1)).toEqual({
      t: 'delivery',
      rowId: 'row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry-1' },
      harnessRef: [echo],
    })
  })

  it("names a direct send's ids under its turn id, the receipt's with the entry's", async () => {
    const f = fixture({ outcome: 'accepted', harnessRef: [turn] })
    await f.handle.send({ id: 'msg_direct', text: 'a' }, options)
    f.name({ id: 'entry-3' }, [echo])
    expect(f.events()).toEqual([
      {
        t: 'delivery',
        rowId: 'msg_direct',
        outcome: 'delivered',
        transcriptItem: { id: 'entry-3' },
        harnessRef: [turn, echo],
      },
    ])
  })
})
