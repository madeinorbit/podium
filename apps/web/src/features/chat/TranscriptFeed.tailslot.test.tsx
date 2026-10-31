import type { ChatActivity, RenderableRow, SessionIssueOutcome } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
// the nothing-when-idle stay; the geometry stops moving.

let host: HTMLDivElement
let root: Root

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text }) as TranscriptItem

const tool = (toolResult?: string): TranscriptItem => ({
  id: 'tool-1',
  role: 'tool',
  text: '',
  toolName: 'Read',
  toolUseId: 'use-1',
  ts: '2026-08-18T12:00:00.000Z',
  ...(toolResult === undefined ? {} : { toolResult }),
})

function rowsFor(items: TranscriptItem[]): RenderableRow[] {
  return buildChatRows(pairToolResults(items)).map((row, index) => ({
    row,
    index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}),
  })) as RenderableRow[]
}

function render(
  activity: ChatActivity | null,
  items: TranscriptItem[] = [say('a1', 'an answer')],
  outcome: SessionIssueOutcome | null = null,
): void {
  const blocks = pairToolResults(items)
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
        onRetractQueued={async () => {}}
        overlay={null}
        turnPreview={null}
        activity={activity}
        attribution={{} as never}
        outcome={outcome}
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
  vi.useRealTimers()
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

  it('keeps the session working mark through tool-call arrival and completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-18T12:00:01.000Z'))
    const working = { tone: 'working', label: 'Working' } as ChatActivity
    const prose = say('a1', 'an answer')

    render(working, [prose])
    expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)
    expect(tailRow()?.dataset.tail).toBe('working')

    render(working, [prose, tool()])
    const line = (): HTMLElement | null => host.querySelector('[data-testid="work-line"]')
    expect(line()?.dataset.state).toBe('handoff')
    expect(line()?.querySelector('.pod-mark')).toBeNull()
    expect(tailRow()?.dataset.tail).toBe('working')
    expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)

    render(working, [prose, tool('done')])
    expect(line()?.dataset.state).toBe('done')
    expect(line()?.querySelector('.pod-mark')).toBeNull()
    expect(tailRow()?.dataset.tail).toBe('working')
    expect(host.querySelectorAll('.pod-mark')).toHaveLength(1)
  })
})

describe('an issue outcome ends the transcript (POD-2151)', () => {
  const landed: SessionIssueOutcome = {
    kind: 'landed',
    at: '2026-10-26T19:59:00.000Z',
    branch: 'tf.dev',
    sha: 'fcd1385',
  }
  const card = (): HTMLElement | null => host.querySelector('[data-testid="issue-outcome-card"]')

  it('suppresses the stale status a parent stop kept, such as a retryable error', () => {
    render({ tone: 'error', label: 'rate limited' } as ChatActivity, undefined, landed)
    expect(card()?.textContent).toContain('Landed on tf.dev')
    expect(tailRow()).toBeNull()
    expect(card()?.nextElementSibling).toBe(slot())
    render({ tone: 'idle', label: 'interrupted' } as ChatActivity, undefined, landed)
    expect(tailRow()).toBeNull()
  })

  it('still reports a wake the operator asked for after it', () => {
    render({ tone: 'working', label: 'Waking the agent…' } as ChatActivity, undefined, landed)
    expect(card()).not.toBeNull()
    expect(tailRow()?.dataset.tail).toBe('working')
  })

  it('still reports a message the operator just sent after it', () => {
    render(
      { tone: 'idle', label: 'Sending', transient: 'just-sent' } as ChatActivity,
      undefined,
      landed,
    )
    expect(card()).not.toBeNull()
    expect(tailRow()?.dataset.tail).toBe('sending')
  })

  it('leaves the tail alone without an outcome', () => {
    render({ tone: 'error', label: 'rate limited' } as ChatActivity)
    expect(card()).toBeNull()
    expect(tailRow()?.dataset.tail).toBe('error')
  })
})
