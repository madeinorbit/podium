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
import { asSessionId } from '@podium/model'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import { type UseChatSendOptions, useChatSend } from './use-chat-send'

const sendText = vi.fn(async () => ({ ok: true, disposition: 'accepted' }) as never)
const ledger = vi.fn(async () => [] as never)

/** The one field these tests vary; everything else is inert scaffolding. */
function opts(since: string | undefined): UseChatSendOptions {
  return {
    sessionId: asSessionId('s-1'),
    trpc: {
      sessions: { sendText: { mutate: sendText } },
      messages: { ledger: { query: ledger }, cancel: { mutate: vi.fn() } },
    } as unknown as Store['trpc'],
    resumeAndSend: vi.fn() as unknown as Store['resumeAndSend'],
    dismissOffer: vi.fn() as unknown as Store['dismissOffer'],
    setPanelMode: vi.fn() as unknown as Store['setPanelMode'],
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
    session: { agentState: { phase: 'idle', since } },
    headlessTurn: { sendTurn: vi.fn(async () => false) },
    pinToBottom: () => {},
    initialPendingText: undefined,
  }
}

const IDLE_SINCE = '2026-08-24T10:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers()
  sendText.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useChatSend optimistic window', () => {
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
