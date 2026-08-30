// @vitest-environment happy-dom
/**
 * THE OPTIMISTIC SEND WINDOW (POD-1595).
 *
 * `justSent` is what puts a moving mark under the operator's prompt before the
 * agent has said anything for itself, and the only interesting question about it
 * is when it STOPS. It used to stop on a fixed 8-second ceiling, which a prompt
 * carrying large attachments routinely outlives — the harness is still reading
 * the files — so the row expired into a gap and the real working row arrived
 * afterwards as a second, separate event.
 *
 * It now stops when the daemon reports on the new turn, detected as a change in
 * `agentState.since` (the stamp of the last phase change). These tests pin both
 * halves: it survives well past the old ceiling in silence, and it yields the
 * instant the daemon speaks — whatever the daemon says.
 */
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import { type UseChatSendOptions, useChatSend } from './use-chat-send'

const sendText = vi.fn(async () => ({ ok: true, disposition: 'accepted' }) as never)
const REFUSED = new Error('offline')
const ledger = vi.fn(async () => [] as never)

/** The one field these tests vary; everything else is inert scaffolding. */
function opts(
  since: string | undefined,
  offer?: { createdAt: string },
  phase = 'idle',
): UseChatSendOptions {
  return {
    sessionId: asSessionId('s-1'),
    trpc: {
      sessions: { sendText: { mutate: sendText } },
      messages: { ledger: { query: ledger }, cancel: { mutate: vi.fn() } },
    } as unknown as Store['trpc'],
    resumeAndSend: vi.fn() as unknown as Store['resumeAndSend'],
    dismissOffer: vi.fn() as unknown as Store['dismissOffer'],
    setPanelMode: vi.fn() as unknown as Store['setPanelMode'],
    setSessionDraft: vi.fn() as unknown as Store['setSessionDraft'],
    initialDraft: '',
    getUserFocus: (() => ({})) as unknown as Store['getUserFocus'],
    attachedSessionId: null as unknown as Store['attachedSessionId'],
    clearAttachedSession: vi.fn() as unknown as Store['clearAttachedSession'],
    getIssueSeq: () => null,
    headless: false,
    superThread: undefined,
    compact: false,
    active: true,
    composer: { sendable: true, canResume: false },
    ownThreadIds: undefined,
    blocks: [],
    session: {
      agentState: { phase, since },
      ...(offer ? { offer: { message: 'Choose', actions: [], ...offer } } : {}),
    },
    headlessTurn: { sendTurn: vi.fn(async () => false), interrupt: vi.fn(async () => {}) },
    canInterrupt: false,
    latestOperatorPrompt: null,
    pinToBottom: () => {},
    initialPendingText: undefined,
  }
}

const IDLE_SINCE = '2026-08-24T10:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers()
  sendText.mockClear()
  ledger.mockClear()
  ledger.mockResolvedValue([] as never)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useChatSend optimistic window', () => {
  it('seeds a fresh task with its first prompt and the moving send marker', () => {
    const seeded: UseChatSendOptions = {
      ...opts(undefined),
      session: {},
      initialPendingText: 'Plan the release',
    }
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: seeded,
    })

    expect(result.current.pending).toEqual([
      expect.objectContaining({ text: 'Plan the release', state: 'sent' }),
    ])
    expect(result.current.justSent).toBe(true)

    // The engine drops its seed once the server session row lands. The mounted
    // chat owns reconciliation from here and must not flash empty in between.
    rerender({ ...seeded, initialPendingText: undefined })
    expect(result.current.pending).toHaveLength(1)
    expect(result.current.justSent).toBe(true)
  })

  it('releases a host-held first prompt only after its transcript echo arrives', async () => {
    const onInitialPendingSettled = vi.fn()
    const seeded: UseChatSendOptions = {
      ...opts(undefined),
      session: {},
      initialPendingText: 'Plan the release',
      onInitialPendingSettled,
    }
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: seeded,
    })

    rerender({ ...seeded, initialPendingText: undefined })
    expect(onInitialPendingSettled).not.toHaveBeenCalled()

    await act(async () => {
      rerender({
        ...seeded,
        initialPendingText: undefined,
        blocks: [
          {
            item: {
              id: 'echo-1',
              role: 'user',
              text: 'Plan the release',
            } as TranscriptItem,
          },
        ],
      })
    })

    expect(result.current.pending).toEqual([])
    expect(onInitialPendingSettled).toHaveBeenCalledOnce()
  })

  it('opens on send', async () => {
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    expect(result.current.justSent).toBe(false)
    await act(async () => {
      await result.current.send('hello')
    })
    expect(result.current.justSent).toBe(true)
  })

  it('marks only the stopped outgoing bubble when RPC and transcript both report it', async () => {
    const initial = opts(IDLE_SINCE)
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: initial,
    })
    await act(async () => {
      await result.current.send('keep this prompt')
      await result.current.send('cancel this prompt')
    })
    const messageId = result.current.interruptMessageId
    expect(messageId).not.toBeNull()

    await act(async () => {
      result.current.markInterrupted(messageId ?? undefined)
    })

    const interruptedAt = Date.now()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      await result.current.send('sent after the interrupt')
    })

    await act(async () => {
      rerender({
        ...initial,
        blocks: [
          {
            item: {
              id: 'interrupt-1',
              role: 'user',
              text: 'Conversation interrupted',
              event: 'interrupt',
              ts: new Date(interruptedAt).toISOString(),
            } as TranscriptItem,
          },
        ],
      })
    })

    expect(result.current.pending).toEqual([
      expect.objectContaining({ text: 'keep this prompt', state: 'sending' }),
      expect.objectContaining({ text: 'cancel this prompt', state: 'interrupted' }),
      expect.objectContaining({ text: 'sent after the interrupt', state: 'sending' }),
    ])
  })

  it('keeps the interrupted state when a stopped send request rejects later', async () => {
    let rejectSend: (reason: unknown) => void = () => {}
    sendText.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject
        }) as never,
    )
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    let request: Promise<void> | undefined
    await act(async () => {
      request = result.current.send('cancel before send settles')
      await Promise.resolve()
    })

    act(() => result.current.markInterrupted(result.current.interruptMessageId ?? undefined))
    await act(async () => {
      rejectSend(REFUSED)
      await request
    })

    expect(result.current.pending.at(-1)?.state).toBe('interrupted')
  })

  it('keeps a restored durable message visible when it is interrupted', async () => {
    ledger.mockResolvedValueOnce([
      {
        id: 'msg_restored',
        from: 'operator',
        to: 'session:s-1',
        status: 'queued',
        body: 'cancel after refresh',
        createdAt: '2026-08-24T10:00:01.000Z',
        injectedAt: null,
      },
    ] as never)
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.interruptMessageId).toBe('msg_restored')
    act(() => result.current.markInterrupted('msg_restored'))

    expect(result.current.queuedMessages).toEqual([])
    expect(result.current.pending).toEqual([
      expect.objectContaining({
        deliveryId: 'msg_restored',
        text: 'cancel after refresh',
        state: 'interrupted',
      }),
    ])
  })

  it('outlives the old 8s ceiling while the daemon stays silent', async () => {
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await result.current.send('a prompt with three large attachments')
    })
    // The window the report is about: the harness is still reading files and
    // has reported nothing. Under the old rule the row was already gone here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(result.current.justSent).toBe(true)
  })

  it('closes the moment the daemon reports on the new turn', async () => {
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await result.current.send('hello')
    })
    expect(result.current.justSent).toBe(true)
    await act(async () => {
      rerender(opts('2026-08-24T10:00:12.000Z'))
    })
    expect(result.current.justSent).toBe(false)
  })

  it('closes on ANY new phase, not only working — an ask three seconds in still lands', async () => {
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await result.current.send('hello')
    })
    const asked = opts('2026-08-24T10:00:03.000Z')
    await act(async () => {
      rerender({
        ...asked,
        session: { agentState: { phase: 'needs_user', since: '2026-08-24T10:00:03.000Z' } },
      })
    })
    expect(result.current.justSent).toBe(false)
  })

  /** POD-1595 review. Each of these was a real defect in the first cut. */
  it('closes when the send is REFUSED — a red bubble must not sit under "Sending"', async () => {
    sendText.mockRejectedValueOnce(REFUSED)
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await result.current.send('hello')
    })
    // The window used to stay open for the full 30s, suppressing the session's
    // own error and attention lines the whole time.
    expect(result.current.justSent).toBe(false)
    expect(result.current.pending.at(-1)?.state).toBe('failed')
  })

  it('re-arms the ceiling on a SECOND send instead of inheriting the first timer', async () => {
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    await act(async () => {
      await result.current.send('first')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000)
    })
    await act(async () => {
      await result.current.send('second')
    })
    // 5s after the first send's 30s would have fired. The second send is only
    // 6s old, so the row is still its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(result.current.justSent).toBe(true)
  })

  it('leaves an offer answered by its own button hidden when a LATER send fails', async () => {
    const OFFER = '2026-08-24T09:59:00.000Z'
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE, { createdAt: OFFER }),
    })
    await act(async () => {
      await result.current.sendOfferPrompt('merge it', OFFER)
    })
    expect(result.current.dismissedOfferAt).toBe(OFFER)
    // A follow-up the operator types while the accept's clear is still in
    // flight. It is refused — but it did not hide that offer, so it has no
    // business putting an already-answered decision back on the screen.
    sendText.mockRejectedValueOnce(REFUSED)
    await act(async () => {
      await result.current.send('and rebase it too')
    })
    expect(result.current.dismissedOfferAt).toBe(OFFER)
  })

  it('restores an offer that THIS send hid when the send is refused', async () => {
    const OFFER = '2026-08-24T09:59:00.000Z'
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE, { createdAt: OFFER }),
    })
    sendText.mockRejectedValueOnce(REFUSED)
    await act(async () => {
      await result.current.send('ignore the buttons, do this instead')
    })
    // The turn never reached the server, so it answered nothing and the offer
    // is still open. (The first cut never restored it: the "did I hide this?"
    // flag was read out of a React updater that had not run yet.)
    expect(result.current.dismissedOfferAt).toBeNull()
  })

  it('holds through the turn boundary when the send was QUEUED behind a running turn', async () => {
    const WORKING = '2026-08-24T10:00:00.000Z'
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(WORKING, undefined, 'working'),
    })
    await act(async () => {
      await result.current.send('do this next')
    })
    expect(result.current.justSent).toBe(true)
    // Turn 1 ends. That phase change is about the turn that just finished, not
    // about the message still waiting behind it — closing here put the finished
    // turn's parting verdict back under the operator's pending prompt.
    await act(async () => {
      rerender(opts('2026-08-24T10:00:20.000Z', undefined, 'idle'))
    })
    expect(result.current.justSent).toBe(true)
    // The NEXT move is the daemon picking our turn up.
    await act(async () => {
      rerender(opts('2026-08-24T10:00:21.000Z', undefined, 'working'))
    })
    expect(result.current.justSent).toBe(false)
  })

  /** POD-1595 review round two — all three were real, all three in the queued
   *  path added by round one. */
  it('a slow rejection does not close a LATER send’s window', async () => {
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(IDLE_SINCE),
    })
    // A hangs, then rejects. B is sent while A is still in the air, and is fine.
    let rejectA: (e: unknown) => void = () => {}
    sendText.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject
        }) as never,
    )
    let a: Promise<void> | undefined
    await act(async () => {
      a = result.current.send('the slow one')
    })
    await act(async () => {
      await result.current.send('the one that lands')
    })
    expect(result.current.justSent).toBe(true)
    await act(async () => {
      rejectA(REFUSED)
      await a
    })
    // B is genuinely in flight and the daemon has said nothing. Closing here
    // dropped the tail back onto the previous turn's verdict under B's bubble.
    expect(result.current.justSent).toBe(true)
  })

  it('does not run the ceiling down against a turn it is queued behind', async () => {
    const WORKING = '2026-08-24T10:00:00.000Z'
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(WORKING, undefined, 'working'),
    })
    await act(async () => {
      await result.current.send('do this next')
    })
    // Agent turns routinely outlast 30s. The ceiling is for a session saying
    // NOTHING; this one is reporting `working` throughout, so counting down
    // against it closed the window unseen and made the queued fix inert.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(result.current.justSent).toBe(true)
  })

  it('yields to a permission ask raised by the turn it is queued behind', async () => {
    const WORKING = '2026-08-24T10:00:00.000Z'
    const { result, rerender } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(WORKING, undefined, 'working'),
    })
    await act(async () => {
      await result.current.send('do this next')
    })
    // The RUNNING turn asks for approval. That is not it ending, and it is news
    // the operator needs far more than they need our receipt.
    await act(async () => {
      rerender(opts('2026-08-24T10:00:05.000Z', undefined, 'needs_user'))
    })
    expect(result.current.justSent).toBe(false)
  })

  it('gives up eventually on a session that never reports at all', async () => {
    const { result } = renderHook((p: UseChatSendOptions) => useChatSend(p), {
      initialProps: opts(undefined),
    })
    await act(async () => {
      await result.current.send('hello')
    })
    expect(result.current.justSent).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(result.current.justSent).toBe(false)
  })
})
