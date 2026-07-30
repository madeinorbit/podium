import type { TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

// The superagent-column compact treatment (engraved-column.md §2.5, POD-164):
// role labels carry mono clocks, the latest answer carries the issue-context
// suffix, and a trailing "→ next:" line splits out of the markdown body.

let host: HTMLDivElement
let root: Root

function mount(
  item: TranscriptItem,
  opts: { compact?: boolean; ctxSeq?: number | null } = {},
): void {
  act(() => {
    root.render(
      <ChatBlockView
        block={{ item }}
        index={0}
        highlighted={false}
        dimmed={false}
        sessionId="s1"
        cwd="/r"
        openFile={() => {}}
        httpOrigin="http://x"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
        compact={opts.compact ?? true}
        ctxSeq={opts.ctxSeq ?? null}
      />,
    )
  })
}

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

const answer = (text: string): TranscriptItem =>
  ({
    id: 'a1',
    role: 'assistant',
    answer: true,
    text,
    ts: '2026-07-22T14:31:00Z',
  }) as TranscriptItem

describe('compact chat blocks (POD-164)', () => {
  it('labels the answer SUPER AGENT with a mono clock', () => {
    mount(answer('All merged.'))
    const label = host.querySelector('.transcript-answer-label')
    expect(label?.textContent).toContain('Super agent')
    expect(label?.querySelector('.chat-clk')).not.toBeNull()
  })

  it('renders the issue-context suffix only when a ctxSeq is given', () => {
    mount(answer('All merged.'), { ctxSeq: 128 })
    expect(host.querySelector('.chat-ctx')?.textContent).toBe('· POD-128 context')
    mount(answer('All merged.'), { ctxSeq: null })
    expect(host.querySelector('.chat-ctx')).toBeNull()
  })

  it('splits a trailing "→ next:" line into the mono amber row', () => {
    mount(answer('Only POD-105 is blocking.\n→ next: merge POD-105 from its card'))
    expect(host.querySelector('.chat-next')?.textContent).toBe(
      '→ next: merge POD-105 from its card',
    )
    // The line left the markdown body.
    expect(host.querySelector('.chat-md')?.textContent).not.toContain('→ next:')
  })

  it('keeps full-size rendering untouched: Answer label, no clock, no split', () => {
    mount(answer('Done.\n→ next: nothing'), { compact: false })
    expect(host.querySelector('.transcript-answer-label')?.textContent).toBe('Answer')
    expect(host.querySelector('.chat-clk')).toBeNull()
    expect(host.querySelector('.chat-next')).toBeNull()
  })

  it('user blocks keep the You label and gain the clock', () => {
    mount({ id: 'u1', role: 'user', text: 'hi', ts: '2026-07-22T14:31:00Z' } as TranscriptItem)
    const label = host.querySelector('.transcript-you-label')
    expect(label?.textContent).toContain('You')
    expect(label?.querySelector('.chat-clk')).not.toBeNull()
  })
})
