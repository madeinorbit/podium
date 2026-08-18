import type { ChatActivity, RenderableRow } from '@podium/client-core/viewmodels'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildChatRows, pairToolResults } from './chat'
import { TranscriptFeed } from './TranscriptFeed'

// THE TAIL STANDS IN A SLOT OF CONSTANT HEIGHT (POD-1290 follow-up, the
// residual "small jumps" report of 2026-08-18).
//
// The tail is keyed on its state so a phase change REMOUNTS the row (the
// morph-then-be-still grammar), and an idle transcript renders no tail at all.
// Both are right visually and each was a geometry change at the very bottom of
// a pinned feed: the row's height appearing, vanishing and reappearing is
// exactly the hop the reader sees, because Safari scrolls on the compositor
// and paints a frame of the old position before the main-thread correction
// lands — and a tail UNMOUNT additionally invites the engine to clamp the
// offset up by the vanished height before the remount grows it back.
//
// So the tail renders inside a slot that is always there and never changes
// size (min-height covers the tallest variant, styles.css). The morphs and
// the nothing-when-idle stay; the geometry stops moving. The slot is also the
// scroller's permanent LAST CHILD, which gives the anchoring-engine regime
// ([data-anchor-end] > :last-child) a stable node to anchor instead of one
// that remounts on every phase change.

let host: HTMLDivElement
let root: Root

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text }) as TranscriptItem

function rowsFor(items: TranscriptItem[]): RenderableRow[] {
  return buildChatRows(pairToolResults(items)).map((row, index) => ({
    row,
    index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}),
  })) as RenderableRow[]
}

function render(activity: ChatActivity | null): void {
  const items = [say('a1', 'an answer')]
  const blocks = pairToolResults(items)
  act(() => {
    root.render(
      <TranscriptFeed
        scrollerRef={createRef<HTMLDivElement>()}
        onScroll={() => {}}
        claimScrollForArrival={() => {}}
        compact={false}
        superagent={false}
        phase="ready"
        rows={rowsFor(items)}
        blocks={blocks}
        markdownHtml={new Map()}
        search={{ activeRow: -1, filtering: false, matches: [], activeMatch: 0 } as never}
        moreAbove={false}
        loadingOlder={false}
        loadOlder={() => {}}
        sessionId={asSessionId('s1')}
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
        activity={activity}
        attribution={{} as never}
      />,
    )
  })
}

const slot = (): HTMLElement | null => host.querySelector('[data-testid="feed-tail-slot"]')
const tailRow = (): HTMLElement | null => host.querySelector('[data-testid="feed-tail"]')

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
})

describe('the tail stands in a slot of constant height', () => {
  it('stands even when idle renders no tail at all', () => {
    render(null)
    expect(slot()).not.toBeNull()
    expect(tailRow()).toBeNull()
  })

  it('holds the same node while the tail inside it comes, morphs and goes', () => {
    render({ tone: 'working', label: 'Working' } as ChatActivity)
    const standing = slot()
    expect(standing).not.toBeNull()
    expect(tailRow()?.dataset.tail).toBe('working')

    render({ tone: 'attention', label: 'needs answer' } as ChatActivity)
    expect(slot()).toBe(standing)
    expect(tailRow()?.dataset.tail).toBe('waiting')

    render(null)
    expect(slot()).toBe(standing)
    expect(tailRow()).toBeNull()
  })

  it('is the last child of the feed, so the end anchor lands on stable geometry', () => {
    render({ tone: 'working', label: 'Working' } as ChatActivity)
    const feed = slot()?.parentElement as HTMLElement
    expect(feed.lastElementChild).toBe(slot())
  })
})
