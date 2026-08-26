/**
 * THE STREAMED TURN, HOOK AND ROW (POD-2293).
 *
 * Two halves, tested where each one's mistakes live: the hook decides WHICH
 * frame is current and when the preview goes away, and the feed decides what a
 * preview row looks like next to the finished rows it precedes.
 */

import type { ChatBlock, RenderableRow } from '@podium/client-core/viewmodels'
import { asSessionId, type TranscriptItem } from '@podium/model'
import type { TurnPreviewMessage } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, pairToolResults } from './chat'
import { TranscriptFeed } from './TranscriptFeed'
import { type TurnPreview, useTurnPreview } from './use-turn-preview'

const SESSION = asSessionId('s1')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.useRealTimers()
})

// -- the hub fake -----------------------------------------------------------

type Listener = (...args: never[]) => void

function fakeHub() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    hub: {
      on(kind: string, cb: Listener) {
        const set = listeners.get(kind) ?? new Set<Listener>()
        set.add(cb)
        listeners.set(kind, set)
        return () => set.delete(cb)
      },
    } as never,
    emit(kind: string, ...args: unknown[]) {
      act(() => {
        for (const cb of listeners.get(kind) ?? []) (cb as (...a: unknown[]) => void)(...args)
      })
    },
    listenerCount: (kind: string) => listeners.get(kind)?.size ?? 0,
  }
}

const frame = (over: Partial<TurnPreviewMessage> = {}): TurnPreviewMessage => ({
  type: 'turnPreview',
  sessionId: SESSION,
  turnEpoch: 1,
  seq: 1,
  items: [{ kind: 'text', itemId: 'a', text: 'partial' }],
  ...over,
})

/** Mount the hook alone and expose what it currently holds. */
function mountHook(hub: unknown, sessionId = SESSION): { current: () => TurnPreview | null } {
  let latest: TurnPreview | null = null
  function Probe(): null {
    latest = useTurnPreview(sessionId, hub as never)
    return null
  }
  act(() => {
    root.render(<Probe />)
  })
  return { current: () => latest }
}

describe('useTurnPreview', () => {
  it('holds the newest frame and ignores one that lost a race', () => {
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit(
      'turnPreview',
      SESSION,
      frame({ seq: 5, items: [{ kind: 'text', itemId: 'a', text: 'five' }] }),
    )
    expect(preview.current()?.items).toEqual([{ kind: 'text', itemId: 'a', text: 'five' }])

    // Same epoch, EARLIER cursor. Applying it would rewind the reply on screen,
    // which is the one artefact a snapshot plane exists to make impossible.
    emit(
      'turnPreview',
      SESSION,
      frame({ seq: 4, items: [{ kind: 'text', itemId: 'a', text: 'four' }] }),
    )
    expect(preview.current()?.items).toEqual([{ kind: 'text', itemId: 'a', text: 'five' }])

    emit(
      'turnPreview',
      SESSION,
      frame({ seq: 6, items: [{ kind: 'text', itemId: 'a', text: 'six' }] }),
    )
    expect(preview.current()?.items).toEqual([{ kind: 'text', itemId: 'a', text: 'six' }])
  })

  it('ignores frames for another session on the same socket', () => {
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit('turnPreview', asSessionId('other'), frame())
    expect(preview.current()).toBeNull()
  })

  it('clears on the terminal frame', () => {
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit('turnPreview', SESSION, frame())
    expect(preview.current()).not.toBeNull()
    emit('turnPreview', SESSION, frame({ seq: 2, items: [], done: true }))
    expect(preview.current()).toBeNull()
  })

  it('does NOT let a late terminal wipe the turn that came after it', () => {
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit('turnPreview', SESSION, frame({ turnEpoch: 2, seq: 9 }))
    // Epoch 1's `done`, arriving after epoch 2 started. Clearing on it would
    // blank a reply that is genuinely in progress.
    emit('turnPreview', SESSION, frame({ turnEpoch: 1, seq: 3, items: [], done: true }))
    expect(preview.current()?.turnEpoch).toBe(2)
  })

  it('drops the preview when the socket goes down', () => {
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit('turnPreview', SESSION, frame())
    emit('connectionHealth', { status: 'degraded', rttMs: null, since: 0 })
    // Degraded is not down: frames may still be arriving, and blanking a live
    // reply on a slow link would be worse than showing it.
    expect(preview.current()).not.toBeNull()
    emit('connectionHealth', { status: 'down', rttMs: null, since: 0 })
    expect(preview.current()).toBeNull()
  })

  it('gives up on a preview nothing has refreshed', () => {
    vi.useFakeTimers()
    const { hub, emit } = fakeHub()
    const preview = mountHook(hub)
    emit('turnPreview', SESSION, frame())
    act(() => {
      vi.advanceTimersByTime(19_000)
    })
    expect(preview.current()).not.toBeNull()
    // A daemon that died mid-turn sends no terminal and the socket stays up.
    // Without this the chat shows half a reply, apparently still typing, forever.
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(preview.current()).toBeNull()
  })

  it('unsubscribes on unmount', () => {
    const { hub, listenerCount } = fakeHub()
    mountHook(hub)
    expect(listenerCount('turnPreview')).toBe(1)
    act(() => {
      root.unmount()
    })
    expect(listenerCount('turnPreview')).toBe(0)
    // Re-created so the shared afterEach can unmount without throwing.
    root = createRoot(host)
  })
})

// -- the row ----------------------------------------------------------------

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text }) as TranscriptItem

function renderFeed(items: TranscriptItem[], turnPreview: TurnPreview | null): void {
  const blocks: ChatBlock[] = pairToolResults(items)
  const rows = buildChatRows(blocks).map((row, index) => ({
    row,
    index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}),
  })) as RenderableRow[]
  act(() => {
    root.render(
      <TranscriptFeed
        setScrollerRef={() => {}}
        setContentRef={() => {}}
        onScroll={() => {}}
        onPointerUp={() => {}}
        compact={false}
        superagent={false}
        phase="ready"
        rows={rows}
        blocks={blocks}
        markdownHtml={new Map()}
        search={{ activeRow: -1, filtering: false, matches: [], activeMatch: 0 } as never}
        moreAbove={false}
        loadingOlder={false}
        loadOlder={() => {}}
        sessionId={SESSION}
        cwd="/r"
        session={undefined}
        httpOrigin="http://x"
        openFile={() => {}}
        onOpenImage={() => {}}
        onAnswerAsk={async () => {}}
        livePendingAskIndex={-1}
        pendingAskBlock={null}
        lastAnswerBlockIndex={-1}
        ctxSeq={null}
        collapseContext={false}
        stickyEnabled={false}
        isOperatorPromptRow={() => false}
        pending={[]}
        restoredQueued={[]}
        onRetractQueued={async () => {}}
        overlay={null}
        turnPreview={turnPreview}
        activity={null}
        attribution={{} as never}
      />,
    )
  })
}

const previewRow = (): HTMLElement | null => host.querySelector('[data-turn-preview]')

describe('the preview row in the feed', () => {
  it('renders nothing at all when there is no preview', () => {
    renderFeed([say('a1', 'done')], null)
    expect(previewRow()).toBeNull()
  })

  it('draws the text still being written', () => {
    renderFeed([], { turnEpoch: 1, items: [{ kind: 'text', itemId: 'a', text: 'half a rep' }] })
    expect(previewRow()?.textContent).toContain('half a rep')
  })

  it('draws a running tool without claiming a result', () => {
    renderFeed([], {
      turnEpoch: 1,
      items: [
        {
          kind: 'running',
          itemId: 'cmd',
          item: { id: 'cmd', role: 'tool', text: '', toolName: 'Bash', toolInput: 'sleep 120' },
        },
      ],
    })
    const tool = host.querySelector('[data-turn-preview-tool]')
    expect(tool?.textContent).toBe('Bash sleep 120')
    // A preview row that looked like a finished ToolBlock would be asserting an
    // outcome it does not have.
    expect(host.querySelector('[data-turn-preview] [data-testid="tool-block"]')).toBeNull()
  })

  it('does not duplicate the reply once the durable item has landed', () => {
    // The server retires a row against the item that supersedes it, so by the
    // time the transcript carries the answer the preview no longer names it.
    renderFeed([say('a1', 'the whole answer')], { turnEpoch: 1, items: [] })
    expect(previewRow()).toBeNull()
    expect(host.textContent).toContain('the whole answer')
  })
})
