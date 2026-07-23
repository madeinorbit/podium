import type { TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKnownRefPrefixes } from '@/lib/markdown'
import { ChatBlockView } from './ChatBlockView'

// The envelope block renders standalone — no hub/tRPC — so this suite mounts
// ChatBlockView directly instead of going through the ChatView harness.

const activations: string[] = []
vi.mock('@/lib/ref-activation', () => ({
  activateRef: (ref: string) => {
    activations.push(ref)
  },
}))

const frame = (id: string, from: string, to: string, body: string, extra = '') =>
  `[podium message ${id} · from ${from} · to ${to} · reply: podium mail reply ${id}]\n${body}\n${extra}[end podium message ${id}]`

function userItem(text: string): TranscriptItem {
  return { id: 'i1', role: 'user', text } as TranscriptItem
}

let host: HTMLDivElement
let root: Root

function mount(item: TranscriptItem, stickyOperator = false): void {
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
        stickyOperator={stickyOperator}
      />,
    )
  })
}

beforeEach(() => {
  setKnownRefPrefixes(['POD'])
  activations.length = 0
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

describe('envelope block', () => {
  it('renders a nice-id sender as a clickable ref chip that activates the miniview', () => {
    mount(userItem(frame('msg_1', 'issue:POD-84', 'your session', 'see POD-86 for the race')))
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env).not.toBeNull()
    expect(env?.getAttribute('data-internal-message')).toBe('true')
    expect(env?.textContent).toContain('Internal')
    const chips = env!.querySelectorAll('a.ref-link')
    // Header sender chip + body POD-86 chip (linkified by the markdown pass).
    const refs = [...chips].map((a) => a.getAttribute('data-ref'))
    expect(refs).toContain('POD-84')
    expect(refs).toContain('POD-86')
    act(() => {
      ;(
        [...chips].find((a) => a.getAttribute('data-ref') === 'POD-84') as HTMLElement
      ).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(activations).toEqual(['POD-84'])
  })

  it('legacy #seq senders stay plain text (no dead chips)', () => {
    mount(userItem(frame('msg_2', 'issue:#84', 'your session', 'hello')))
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env!.textContent).toContain('task #84 · agent')
    expect(env!.querySelector('a.ref-link')).toBeNull()
  })

  it('badges a reply-requested frame and hides the rule line', () => {
    mount(
      userItem(
        frame(
          'msg_3',
          'issue:POD-84',
          'your session',
          'please confirm',
          '[a response was requested: reply within this thread (`podium mail reply msg_3`) when you have handled it — any substantive reply satisfies it]\n',
        ),
      ),
    )
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env!.textContent).toContain('reply requested')
    expect(env!.textContent).not.toContain('a response was requested')
  })

  it('renders the cross-machine note as a footer, not body text', () => {
    mount(
      userItem(
        frame(
          'msg_4',
          'issue:POD-84',
          'your session',
          'hi',
          '[this agent runs on machine "vmi123" — inspect its working tree with: podium workspace fetch ses_9]\n',
        ),
      ),
    )
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env!.textContent).toContain('this agent runs on machine "vmi123"')
    expect(env!.querySelector('.chat-md')!.textContent).not.toContain('runs on machine')
  })

  it('separates a coalesced internal frame from the sticky operator follow-up', () => {
    mount(
      userItem(
        `${frame(
          'msg_5',
          'issue:POD-84',
          'your session',
          'PODIUM_INTERNAL_ONLY',
        )}please tighten the sticky prompt`,
      ),
      true,
    )

    const env = host.querySelector<HTMLElement>('[data-internal-message="true"]')
    const prompt = host.querySelector<HTMLElement>('[data-operator-prompt="true"]')
    expect(env).not.toBeNull()
    expect(prompt).not.toBeNull()
    expect(env?.className).not.toContain('sticky')
    expect(env?.textContent).toContain('PODIUM_INTERNAL_ONLY')
    expect(prompt?.className).toContain('sticky')
    expect(prompt?.querySelector('[data-sticky-prompt-backdrop]')).not.toBeNull()
    expect(prompt?.textContent).toContain('You')
    expect(prompt?.textContent).toContain('please tighten the sticky prompt')
    expect(prompt?.textContent).not.toContain('PODIUM_INTERNAL_ONLY')
  })

  it('never marks a pure internal frame as an operator prompt, even if sticky is requested', () => {
    mount(userItem(frame('msg_6', 'system', 'your session', 'system note')), true)
    expect(host.querySelector('[data-internal-message="true"]')).not.toBeNull()
    expect(host.querySelector('[data-operator-prompt="true"]')).toBeNull()
    expect(host.querySelector('[data-sticky-prompt-backdrop]')).toBeNull()
    expect(host.querySelector('.sticky')).toBeNull()
  })
})
