import './test-support/no-message-attachments'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBlockView } from './ChatBlockView'

let host: HTMLDivElement
let root: Root

const summary: TranscriptItem = {
  id: 'compaction-summary',
  role: 'system',
  systemKind: 'compaction',
  ts: '2026-10-23T06:18:00Z',
  text: 'This session is being continued from a previous conversation.\n\n## Earlier work\n\nThe full summary stays available.\n\n[Changed file](src/example.ts)',
}

function mount(item = summary, highlighted = false): void {
  act(() => {
    root.render(
      <ChatBlockView
        block={{ item }}
        index={3}
        highlighted={highlighted}
        dimmed={false}
        sessionId={asSessionId('s1')}
        cwd="/repo"
        openFile={() => {}}
        httpOrigin="http://example.test"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
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
  act(() => root.unmount())
  host.remove()
})

describe('chat compaction notes', () => {
  it('folds the summary without presenting it as an operator prompt', () => {
    mount()
    const button = host.querySelector('button')
    if (!button) throw new Error('Missing compaction disclosure')
    expect(button.textContent).toContain('Context compacted')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.chat-md')).toBeNull()
    expect(host.querySelector('[data-operator-prompt]')).toBeNull()
    expect(host.querySelector('[data-pinnable]')).toBeNull()
    expect(host.querySelector('[data-block="3"]')?.getAttribute('data-row-key')).toBe(summary.id)
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe(summary.ts)
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.hidden).toBe(true)

    act(() => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.chat-md h2')?.textContent).toBe('Earlier work')
    expect(host.querySelector('.chat-md')?.textContent).toContain(
      'The full summary stays available.',
    )
    expect(host.querySelector('.chat-md a')?.textContent).toBe('Changed file')
    expect(host.querySelector('[aria-label="Copy message"]')).not.toBeNull()

    // Ordinary feed updates preserve the reader's disclosure choice.
    mount({ ...summary })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.chat-md')).toBeNull()
  })

  it('names an idle compaction and its token counts in the head', () => {
    const notice = 'Compacted while idle, before the prompt cache expired'
    mount({
      ...summary,
      compaction: { trigger: 'auto', preTokens: 358_780, postTokens: 8_952, idle: true, notice },
    })
    const detail = host.querySelector('.compaction-note-detail')
    expect(detail?.textContent).toBe('while idle · 359k → 9k tokens')
    expect(detail?.getAttribute('title')).toBe(notice)
    expect(host.querySelectorAll('[data-system-kind="compaction"]')).toHaveLength(1)
  })

  it('shows a boundary whose summary has not arrived without an empty disclosure', () => {
    mount({ ...summary, text: '', compaction: { trigger: 'manual' } })
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Context compacted')
    expect(host.querySelector('.compaction-note-detail')?.textContent).toBe('on request')
  })

  it('reveals an active search hit and folds again when search leaves', () => {
    mount(summary, true)
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.chat-md')?.textContent).toContain(
      'The full summary stays available.',
    )
    mount(summary, false)
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.chat-md')).toBeNull()
  })

  it('keeps ordinary system notes and recaps visible', () => {
    for (const systemKind of [undefined, 'recap'] as const) {
      mount({ ...summary, systemKind })
      expect(host.querySelector('[data-system-kind="compaction"]')).toBeNull()
      expect(host.querySelector('.chat-md')?.textContent).toContain(
        'The full summary stays available.',
      )
    }
  })
})
