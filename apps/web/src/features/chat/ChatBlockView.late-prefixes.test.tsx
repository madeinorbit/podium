import type { TranscriptItem } from '@podium/model'
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getKnownRefPrefixesVersion, setKnownRefPrefixes } from '@/lib/markdown-references'
import { ChatBlockView } from './ChatBlockView'

/**
 * POD-4966: the ref-prefix registry arrives asynchronously (RefPrefixSync), and
 * cached transcript rows can render first. A row rendered against the empty
 * registry retained unlinked HTML because its memo had no registry dependency
 * (introduced in a074c93bf). Linkified HTML must follow the registry without
 * depending on ordinary issue updates.
 */

vi.mock('@/lib/ref-activation', () => ({ activateRef: () => {} }))

const frame = (id: string, from: string, body: string) =>
  `[podium message ${id} · from ${from} · to your session · reply: podium mail reply ${id}]\n${body}\n[end podium message ${id}]`

let host: HTMLDivElement
let root: Root

function mount(item: TranscriptItem, markdownHtml?: ReadonlyMap<string, string>): void {
  act(() => {
    root.render(
      <ChatBlockView
        block={{ item }}
        index={0}
        highlighted={false}
        dimmed={false}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
        httpOrigin="http://x"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
        markdownHtml={markdownHtml}
      />,
    )
  })
}

function click(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  setKnownRefPrefixes([])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  setKnownRefPrefixes([])
})

describe('ref links when the prefix registry arrives after the row rendered', () => {
  it('links a message body once the prefixes are registered', () => {
    mount({
      id: 'a1',
      role: 'assistant',
      text: 'Filed POD-4945 for the follow-up.',
    } as TranscriptItem)
    expect(host.querySelector('a.ref-link')).toBeNull()
    act(() => setKnownRefPrefixes(['POD']))
    expect(host.querySelector('a.ref-link[data-ref="POD-4945"]')).not.toBeNull()
  })

  it('links an opened mail body and its sender chip once the prefixes are registered', () => {
    mount({
      id: 'u1',
      role: 'user',
      text: frame('msg_1', 'issue:POD-84', 'See POD-86.'),
    } as TranscriptItem)
    click(host.querySelector('[data-testid="message-envelope-toggle"]'))
    click(host.querySelector('[data-testid="mail-item"] .mail-item-head'))
    expect(host.querySelector('a.ref-link')).toBeNull()
    act(() => setKnownRefPrefixes(['POD']))
    expect(host.querySelector('a.ref-link[data-ref="POD-86"]')).not.toBeNull()
    expect(host.querySelector('a.ref-link[data-ref="POD-84"]')).not.toBeNull()
  })

  it('links worker-rendered markdown once prefixes arrive without replacing its cached input', () => {
    const text = 'Filed POD-4945 for the follow-up.'
    const cachedHtml = new Map([[text, '<p>Filed POD-4945 for the follow-up.</p>']])
    mount({ id: 'cached', role: 'assistant', text } as TranscriptItem, cachedHtml)
    expect(host.querySelector('a.ref-link')).toBeNull()
    act(() => setKnownRefPrefixes(['POD']))
    expect(host.querySelector('a.ref-link[data-ref="POD-4945"]')).not.toBeNull()
  })

  it('does not move the version when a refetch returns the same prefixes', () => {
    setKnownRefPrefixes(['POD', 'SP'])
    const before = getKnownRefPrefixesVersion()
    setKnownRefPrefixes(['SP', 'POD'])
    expect(getKnownRefPrefixesVersion()).toBe(before)
    setKnownRefPrefixes(['POD'])
    expect(getKnownRefPrefixesVersion()).toBe(before + 1)
  })
})
