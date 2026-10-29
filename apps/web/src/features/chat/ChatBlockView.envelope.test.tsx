import { presentToolBlock } from '@podium/client-core/values'
import { renderMailPointer } from '@podium/commands/mail-pointer-nudge'
import type { TranscriptItem } from '@podium/model'
import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { ChatBlockView } from './ChatBlockView'

// The envelope block renders standalone — no hub/tRPC — so this suite mounts
// ChatBlockView directly instead of going through the ChatView harness.

const activations: string[] = []
vi.mock('@/lib/ref-activation', () => ({
  activateRef: (ref: string) => {
    activations.push(ref)
  },
}))

// An inbox pointer's body comes from the server by id (POD-2143); the stub
// records which ids were asked for.
const bodyRequests: string[] = []
let bodyAnswer: (id: string) => unknown = (id) => ({
  status: 'ready',
  body: `Long review notes\nfull body of ${id}`,
})
vi.mock('./mail-body', () => ({
  useMailBody: (id: string) => {
    bodyRequests.push(id)
    return bodyAnswer(id)
  },
}))

const frame = (id: string, from: string, to: string, body: string, extra = '') =>
  `[podium message ${id} · from ${from} · to ${to} · reply: podium mail reply ${id}]\n${body}\n${extra}[end podium message ${id}]`

function userItem(text: string): TranscriptItem {
  return { id: 'i1', role: 'user', text } as TranscriptItem
}

let host: HTMLDivElement
let root: Root

function mount(
  item: TranscriptItem,
  stickyOperator = false,
  highlighted = false,
  markdownHtml?: ReadonlyMap<string, string>,
  result?: string,
): void {
  act(() => {
    root.render(
      <ChatBlockView
        // As the compute path hands blocks over (POD-2146).
        block={presentToolBlock(result === undefined ? { item } : { item, result })}
        index={0}
        highlighted={highlighted}
        dimmed={false}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
        httpOrigin="http://x"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
        stickyOperator={stickyOperator}
        markdownHtml={markdownHtml}
      />,
    )
  })
}

const toggle = (): HTMLElement | null =>
  host.querySelector('[data-testid="message-envelope-toggle"]')
const group = (): HTMLElement | null => host.querySelector('.mail-group')

function click(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  setKnownRefPrefixes(['POD'])
  activations.length = 0
  bodyRequests.length = 0
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

describe('podium mail', () => {
  // POD-4868 (was POD-4853): the 'continue' auto-continue types, and an
  // automation's prompt, arrive in the short frame — Podium's, never the person.
  it("shows auto-continue's short frame as a note from Podium, not as the person's turn", () => {
    mount(
      userItem(
        '[podium message msg_c · from system:auto-continue · to your session]\ncontinue\n[end podium message msg_c]',
      ),
    )
    expect(host.querySelectorAll('.mail-group')).toHaveLength(1)
    // POD-2076: one quiet line naming the sender, not "1 note from Podium".
    expect(host.textContent).toContain('Note from auto-continue')
    expect(host.textContent).not.toContain('[podium message')
  })

  // FOLDED BY DEFAULT, AND FOLDED AS ONE (POD-993). Mail is provenance: a reader
  // scanning a conversation should see that notes arrived and from whom without
  // the paragraphs — and a burst of three should cost one line, not three.
  it('arrives folded to a single counted line, and opens on a click of it', () => {
    mount(userItem(frame('msg_5', 'issue:POD-84', 'your session', 'background noise')))
    expect(group()?.getAttribute('data-open')).toBe('false')
    expect(host.textContent).toContain('Note from POD-84')
    // No message id on the fold line (POD-2076).
    expect(toggle()?.textContent).not.toContain('msg_5')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.mail-card')).toBeNull()
    click(toggle())
    expect(group()?.getAttribute('data-open')).toBe('true')
    expect(host.querySelector('.mail-card')).not.toBeNull()
  })

  it('folds a burst of frames into one object with one row per note', () => {
    mount(
      userItem(
        frame('msg_1', 'issue:POD-84', 'your session', 'Worktree synced') +
          frame('msg_2', 'issue:POD-90', 'your session', 'Asset path needs confirming'),
      ),
    )
    // One group, one fold line, one count — not two rows.
    expect(host.querySelectorAll('.mail-group')).toHaveLength(1)
    expect(host.textContent).toContain('2 notes from POD-84 · POD-90')
    click(toggle())
    expect(host.querySelectorAll('[data-testid="mail-item"]')).toHaveLength(2)
    expect(host.textContent).toContain('Worktree synced')
    expect(host.textContent).toContain('Asset path needs confirming')
  })

  // POD-2070: the ask binds the RECEIVING AGENT, not the reader, so it is a word
  // on the fold line rather than a reason to open the card.
  it('stays folded when a frame in the burst asks something, and flags it on the line', () => {
    mount(
      userItem(
        frame('msg_a', 'issue:POD-84', 'your session', 'background noise') +
          frame(
            'msg_6',
            'issue:POD-90',
            'your session',
            'please confirm',
            '[a response was requested: reply within this thread (`podium mail reply msg_6`) when you have handled it — any substantive reply satisfies it]\n',
          ),
      ),
    )
    expect(group()?.getAttribute('data-open')).toBe('false')
    expect(host.querySelector('.mail-fold-flag')?.textContent).toBe('· reply asked')
    click(toggle())
    // The frame that asked says so, on its own item, and names the reply target.
    expect(host.querySelector('.mail-item-reply')?.textContent).toContain('msg_6')
  })

  // A burst GROWS: the next poll can extend the same block with a frame that
  // asks something. The line picks the flag up; the group stays folded.
  it('flags a later frame that asks something without opening the group', () => {
    const background = frame('msg_a', 'issue:POD-84', 'your session', 'background noise')
    mount(userItem(background))
    expect(group()?.getAttribute('data-open')).toBe('false')
    mount(
      userItem(
        background +
          frame(
            'msg_b',
            'issue:POD-90',
            'your session',
            'please confirm',
            '[a response was requested: reply within this thread (`podium mail reply msg_b`) when you have handled it — any substantive reply satisfies it]\n',
          ),
      ),
    )
    expect(group()?.getAttribute('data-open')).toBe('false')
    expect(host.querySelector('.mail-fold-flag')?.textContent).toBe('· reply asked')
  })

  it('keeps an opened mail body DOM-stable across an unrelated markdown cache update', () => {
    const body = 'Worktree synced\n\nSelection stays here.'
    const item = userItem(frame('msg_stable', 'issue:POD-84', 'your session', body))
    const html = '<p>Worktree synced</p><p>Selection stays here.</p>'
    mount(item, false, false, new Map([[body, html]]))
    click(toggle())
    click(host.querySelector('.mail-item-head'))
    const node = host.querySelector('.mail-item-body')?.firstChild
    expect(node).toBeDefined()

    mount(
      item,
      false,
      false,
      new Map([
        [body, html],
        ['unrelated', '<p>new</p>'],
      ]),
    )
    expect(host.querySelector('.mail-item-body')?.firstChild).toBe(node)
  })

  // Search matches a block on its FULL text, including bodies this group folds
  // away — so an active hit has to unfold, or search scrolls the reader to a
  // preview that does not contain the word they searched for.
  it('unfolds the group and its frames for the active search hit', () => {
    mount(
      userItem(
        frame(
          'msg_9',
          'issue:POD-84',
          'your session',
          'Worktree synced\n\nthe needle is buried in the body',
        ),
      ),
      false,
      true,
    )
    expect(group()?.getAttribute('data-open')).toBe('true')
    expect(host.querySelector('[data-testid="mail-item"]')?.getAttribute('data-full')).toBe('true')
    expect(host.textContent).toContain('the needle is buried in the body')
  })

  it('renders a nice-id sender as a clickable ref chip that activates the miniview', () => {
    mount(userItem(frame('msg_1', 'issue:POD-84', 'your session', 'see POD-86 for the race')))
    click(toggle())
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env).not.toBeNull()
    expect(env?.getAttribute('data-internal-message')).toBe('true')
    const chip = env?.querySelector<HTMLElement>('a.ref-link[data-ref="POD-84"]')
    expect(chip).not.toBeNull()
    click(chip)
    expect(activations).toEqual(['POD-84'])
  })

  it('previews two lines and opens the full frame on a click of the subject', () => {
    mount(
      userItem(
        frame(
          'msg_7',
          'issue:POD-84',
          'your session',
          'Worktree synced\n\nRebased onto main before your edits landed; see POD-86.',
        ),
      ),
    )
    click(toggle())
    const item = host.querySelector('[data-testid="mail-item"]')
    // Folded: a plain-text preview, no rendered markdown and so no live refs.
    expect(item?.querySelector('.mail-item-preview')?.textContent).toContain('Rebased onto main')
    expect(item?.querySelector('.chat-md')).toBeNull()
    click(item?.querySelector('.mail-item-head'))
    // Opened: the real markdown, with its refs live.
    expect(item?.getAttribute('data-full')).toBe('true')
    expect(item?.querySelector('.chat-md')).not.toBeNull()
    expect(item?.querySelector('a.ref-link[data-ref="POD-86"]')).not.toBeNull()
  })

  it('legacy #seq senders stay plain text (no dead chips)', () => {
    mount(userItem(frame('msg_2', 'issue:#84', 'your session', 'hello')))
    click(toggle())
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env?.textContent).toContain('task #84')
    expect(env?.querySelector('a.ref-link')).toBeNull()
  })

  it('badges a question frame and keeps the binding rule out of the body', () => {
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
    click(toggle())
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env?.textContent).toContain('reply · msg_3')
    expect(env?.textContent).not.toContain('a response was requested')
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
    click(toggle())
    click(host.querySelector('.mail-item-head'))
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env?.querySelector('.mail-item-note')?.textContent).toContain(
      'this agent runs on machine "vmi123"',
    )
    expect(env?.querySelector('.chat-md')?.textContent).not.toContain('runs on machine')
  })

  it('separates a coalesced internal frame from the operator follow-up', () => {
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
    // POD-993: no voice label — the card's side is the attribution — and the
    // brief is a plain in-flow row, never a positioned one.
    expect(prompt?.querySelector('.transcript-you-bubble')).not.toBeNull()
    expect(prompt?.className).not.toContain('sticky')
    expect(prompt?.textContent).toContain('please tighten the sticky prompt')
    expect(prompt?.textContent).not.toContain('PODIUM_INTERNAL_ONLY')
    expect(env?.textContent).not.toContain('please tighten the sticky prompt')
  })

  it('never marks a pure internal frame as an operator prompt', () => {
    mount(userItem(frame('msg_6', 'system', 'your session', 'system note')), true)
    expect(host.querySelector('[data-internal-message="true"]')).not.toBeNull()
    expect(host.querySelector('[data-operator-prompt="true"]')).toBeNull()
    expect(host.querySelector('.transcript-you-bubble')).toBeNull()
  })
})

describe('operator events', () => {
  it('composes an interrupt as a neutral stop event with its timestamp', () => {
    mount({
      id: 'interrupt-1',
      role: 'user',
      text: '',
      event: 'interrupt',
      ts: '2026-08-08T20:42:00.000Z',
    } as TranscriptItem)

    const event = host.querySelector('[data-event="interrupt"]')
    expect(event).not.toBeNull()
    expect(event?.classList.contains('transcript-interrupt')).toBe(true)
    expect(event?.textContent).toContain('Interrupted by you')
    expect(event?.querySelector('.transcript-interrupt-stop')?.textContent).toBe('□')
    expect(event?.querySelector('.chat-clk')).not.toBeNull()
  })

  it('names plan approval as the pending operator action', () => {
    mount({
      id: 'plan-1',
      role: 'tool',
      text: '',
      toolName: 'ExitPlanMode',
      toolTitle: 'Review the proposed rollout plan',
      toolUseId: 'plan-use',
    } as TranscriptItem)

    const card = host.querySelector('[data-testid="asked-you"] .asked-you')
    expect(card?.getAttribute('data-attention')).toBe('plan')
    expect(card?.textContent).toContain('Plan ready · needs you')
    expect(card?.textContent).toContain('Review the proposed rollout plan')
  })
})

describe('inbox pointer notes (POD-2143)', () => {
  it('folds a pointer as a note, not the human, and fetches its body only on open', () => {
    mount(userItem(renderMailPointer(1, [{ from: 'issue:POD-2128', ids: ['msg_big'] }])), true)
    expect(host.querySelectorAll('.mail-group')).toHaveLength(1)
    expect(toggle()?.textContent).toContain('Note from POD-2128')
    expect(host.textContent).not.toContain('podium issue mail inbox')
    expect(host.querySelector('[data-sticky-prompt]')).toBeNull()
    expect(bodyRequests).toEqual([])
    click(toggle())
    expect(bodyRequests).toContain('msg_big')
    expect(host.textContent).toContain('Long review notes')
    click(host.querySelector('.mail-item-head'))
    expect(host.querySelector('.mail-item-body')?.textContent).toContain('full body of msg_big')
  })

  it('tells a refused body apart from a failed load, and offers a retry only for the latter', () => {
    const pointerLine = renderMailPointer(1, [{ from: 'issue:POD-2128', ids: ['msg_big'] }])
    const keep = bodyAnswer
    try {
      bodyAnswer = () => ({ status: 'denied' })
      mount(userItem(pointerLine))
      click(toggle())
      expect(host.textContent).toContain("You can't view this message")
      expect(host.querySelector('.mail-item-retry')).toBeNull()

      const retry = vi.fn()
      bodyAnswer = () => ({ status: 'error', retry })
      mount({ ...userItem(pointerLine), id: 'i2' } as TranscriptItem)
      expect(host.textContent).toContain('Could not load this message')
      click(host.querySelector('.mail-item-retry'))
      expect(retry).toHaveBeenCalledOnce()
    } finally {
      bodyAnswer = keep
    }
  })

  it('folds a legacy pointer without ids and says the body went to the inbox', () => {
    mount(
      userItem(
        "[podium] 1 message(s) from issue:POD-84 — run 'podium issue mail inbox' to read them, " +
          'then close your turn without repeating your last answer: no message if they needed ' +
          'nothing or only a reply, one sentence if you acted on them, more only if they change ' +
          'what you told the human; leave your standing offer as it is',
      ),
    )
    expect(toggle()?.textContent).toContain('Note from POD-84')
    click(toggle())
    expect(bodyRequests).toEqual([])
    expect(host.textContent).toContain('Delivered via the inbox')
  })
})

// The agent's own mail (POD-2146): a send reads as the note it sent.
describe('mail the agent sent', () => {
  const bash = (command: string): TranscriptItem =>
    ({
      id: 't1',
      role: 'tool',
      text: '',
      ts: '2026-10-26T14:02:00Z',
      toolName: 'Bash',
      toolInput: command,
      toolUseId: 't1',
    }) as TranscriptItem
  const send = bash(`podium mail send --to POD-2128 --body 'Ready for review'`)

  it('folds a send to "Note to" and fetches its body only when opened', () => {
    mount(send, false, false, undefined, 'sent msg_9 to POD-2128 (delivered)')
    expect(toggle()?.textContent).toContain('Note to POD-2128')
    expect(host.textContent).not.toContain('podium mail send')
    expect(bodyRequests).toEqual([])
    click(toggle())
    expect(host.querySelector('.mail-item-route')?.textContent).toContain('POD-2128')
    expect(bodyRequests).toEqual(['msg_9'])
    expect(host.textContent).toContain('full body of msg_9')
  })

  it('shows the preview while the body loads', () => {
    bodyAnswer = () => ({ status: 'loading' })
    mount(send, false, false, undefined, 'sent msg_9 to POD-2128 (delivered)')
    click(toggle())
    expect(host.querySelector('.mail-item-subject')?.textContent).toBe('Ready for review')
    bodyAnswer = (id) => ({ status: 'ready', body: `Long review notes\nfull body of ${id}` })
  })

  it('names a reply by the recipient the CLI printed', () => {
    mount(
      bash(`podium mail reply msg_1 --body 'done'`),
      false,
      false,
      undefined,
      'replied msg_4 to issue:POD-3 (acked msg_1)',
    )
    expect(toggle()?.textContent).toContain('Note to POD-3')
  })

  it('keeps a failed send as an error tool row', () => {
    mount(send, false, false, undefined, 'Exit code 1\npodium mail: send was not accepted')
    expect(host.querySelector('[data-testid="message-envelope"]')).toBeNull()
    expect(host.querySelector('.tool-block')?.getAttribute('data-verdict')).toBe('err')
  })

  it('folds an inbox read to "Read N notes" with the listing behind it', () => {
    const listing =
      '* msg_1 issue:POD-2 2026-10-26T10:00:00Z\n  hi\n* msg_2 issue:POD-4 2026-10-26T10:01:00Z\n  yo'
    mount(bash('podium issue mail inbox'), false, false, undefined, listing)
    const row = host.querySelector('[data-testid="inbox-read"]')
    expect(row?.textContent).toContain('Read 2 notes')
    expect(row?.querySelector('pre')).toBeNull()
    click(row?.querySelector('.mail-fold'))
    expect(row?.querySelector('pre')?.textContent).toContain('msg_2')
  })
})

describe('reference activation across transcript kinds', () => {
  it('activates a reference inside a recap block', () => {
    mount({
      id: 'recap-1',
      role: 'system',
      systemKind: 'recap',
      text: 'Continue POD-84.',
    } as TranscriptItem)
    const chip = host.querySelector<HTMLElement>('a.ref-link[data-ref="POD-84"]')
    expect(chip).not.toBeNull()
    click(chip)
    expect(activations).toEqual(['POD-84'])
  })
})
