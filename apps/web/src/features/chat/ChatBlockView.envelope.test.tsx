import { MobxPool } from '@podium/client-graph'
import { MailReply } from './mail-reply'
import './test-support/no-message-attachments'
import { presentToolBlock } from '@podium/client-core/values'
import { renderMailPointer } from '@podium/commands/mail-pointer-nudge'
import type { TranscriptItem } from '@podium/model'
import { asSessionId } from '@podium/model'
import { getByRole } from '@testing-library/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import type { QuoteInput } from '@/lib/quote/quote-sinks'
import { ChatBlockView } from './ChatBlockView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
const defaultBodyAnswer = (id: string) => ({
  status: 'ready',
  body: `Long review notes\nfull body of ${id}`,
})
let bodyAnswer: (id: string) => unknown = defaultBodyAnswer
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
  onQuote?: (quote: QuoteInput) => void,
  mailReply?: MailReply,
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
        onQuote={onQuote}
        mailReply={mailReply}
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
  bodyAnswer = defaultBodyAnswer
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
    // POD-2076, POD-2286: one quiet line naming the sender and what it said.
    expect(host.textContent).toContain('auto-continue  continue')
    expect(host.textContent).not.toContain('[podium message')
  })

  // FOLDED BY DEFAULT, AND FOLDED AS ONE (POD-993). Mail is provenance: a reader
  // scanning a conversation should see that notes arrived and from whom without
  // the paragraphs — and a burst of three should cost one line, not three.
  it('arrives folded to a single counted line, and opens on a click of it', () => {
    mount(userItem(frame('msg_5', 'issue:POD-84', 'your session', 'background noise')))
    expect(group()?.getAttribute('data-open')).toBe('false')
    expect(host.textContent).toContain('POD-84  background noise')
    // No message id on the fold line (POD-2076).
    expect(toggle()?.textContent).not.toContain('msg_5')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.mail-item-detail')).toBeNull()
    click(toggle())
    expect(group()?.getAttribute('data-open')).toBe('true')
    expect(host.querySelector('.mail-item-detail')).not.toBeNull()
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
    expect(host.textContent).toContain('Read 2 notes')
    click(toggle())
    expect(host.querySelectorAll('[data-testid="mail-item"]')).toHaveLength(2)
    expect(host.textContent).toContain('Worktree synced')
    expect(host.textContent).toContain('Asset path needs confirming')
  })

  // POD-2070: the ask binds the RECEIVING AGENT, not the reader, so it is a word
  // on the fold line rather than a reason to open the card.
  it('keeps agent reply requests inside the fold', () => {
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
    expect(host.querySelector('.quiet-ask')).toBeNull()
    click(toggle())
    // The frame that asked says so, on its own item, and names the reply target.
    expect(host.querySelectorAll('.mail-item-head')).toHaveLength(2)
  })

  // A burst GROWS: the next poll can extend the same block with a frame that
  // asks something. The line picks the flag up; the group stays folded.
  it('keeps a later agent reply request folded', () => {
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
    expect(host.querySelector('.quiet-ask')).toBeNull()
  })

  it('keeps an opened mail body DOM-stable across an unrelated markdown cache update', () => {
    const body = 'Worktree synced\n\nSelection stays here.'
    const item = userItem(frame('msg_stable', 'issue:POD-84', 'your session', body))
    const html = '<p>Worktree synced</p><p>Selection stays here.</p>'
    mount(item, false, false, new Map([[body, html]]))
    click(toggle())
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

  it('discloses the body once without repeating its subject', () => {
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
    const item = host.querySelector('[data-testid="mail-item"]')
    expect(item?.querySelector('.mail-item-detail')).toBeNull()
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

  it('shows an agent reply request in the route without the binding rule', () => {
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
    expect(env?.textContent).toContain('reply requested')
    expect(env?.querySelector('.mail-item-badge')).toBeNull()
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
    const env = host.querySelector('[data-testid="message-envelope"]')
    expect(env?.querySelector('.mail-item-note')?.textContent).toContain(
      'this agent runs on machine "vmi123"',
    )
    expect(env?.querySelector('.chat-md')?.textContent ?? '').not.toContain('runs on machine')
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
    expect(toggle()?.textContent).toContain('To POD-2128  Ready for review')
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
    expect(host.querySelector('.mail-item-body')?.textContent).toContain('Ready for review')
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
    expect(toggle()?.textContent).toContain('To POD-3  done')
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

it('routes Reply to the mail composer and keeps Quote as a separate action', () => {
  const reply = new MailReply(new MobxPool({ coarseNow: 0, selectedIssueId: null }), {
    show: async () => {
      throw new Error('offline fixture')
    },
    reply: async () => null,
  })
  const quote = vi.fn()
  const text =
    frame('background', 'system:steward', 'issue:POD-2287', 'Status\nAll checks pass') +
    frame(
      'ask',
      'issue:POD-2242',
      'the operator',
      'whether inbox reads keep their own row\nWhich would you prefer?',
      '[this is a question: answer the sender]\n',
    )
  mount(userItem(text), false, false, undefined, undefined, quote, reply)
  expect(host.querySelector('.quiet-ask')?.textContent).toContain(
    'POD-2242 asks whether inbox reads keep their own row',
  )
  expect(host.querySelector('.quiet-ask')?.closest('.work-line')).toBeNull()
  expect(host.querySelector('.mail-item-badge')).toBeNull()
  expect(host.querySelectorAll('[data-block]')).toHaveLength(1)
  expect(host.querySelector('[data-row-key]')?.getAttribute('data-row-key')).toBe('i1')
  click(host.querySelector('.quiet-ask-reply'))
  expect(quote).not.toHaveBeenCalled()
  expect(reply.active).toBe(true)
  expect(reply.target).toEqual({ id: 'ask', from: 'issue:POD-2242' })
  click(host.querySelector('.mail-item-quote'))
  expect(quote).toHaveBeenCalledWith({
    text: 'whether inbox reads keep their own row\nWhich would you prefer?',
    source: 'question from POD-2242',
  })
  expect(host.textContent).toContain('Which would you prefer?')
})

it('discloses a fetched sent note completely without repeating its preview', () => {
  bodyAnswer = () => ({ status: 'ready', body: 'Ready for review\nThe checks passed.' })
  mount(
    {
      id: 'sent',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: "podium mail send --to POD-2242 --body 'Ready for review'",
    },
    false,
    false,
    undefined,
    'sent msg_review to POD-2242 (delivered)',
  )
  click(toggle())
  expect(host.querySelector('.mail-item-body')?.textContent).toContain('Ready for review')
  expect(host.querySelector('.mail-item-body')?.textContent).toContain('The checks passed.')
  expect(host.querySelector('.work-line-phrase')?.textContent).toBe('To POD-2242')
  expect(host.textContent?.match(/Ready for review/g)).toHaveLength(1)
})

const firstParagraph =
  'Please read [the conflict report](https://example.com/conflict), review POD-86 and run `bun run test` before landing.'
for (const forceOpen of [false, true]) {
  it.each([
    firstParagraph,
    `${firstParagraph} ${'Keep this complete. '.repeat(40)}Last words.`,
    `${firstParagraph}\n\nFollow-up paragraph.`,
  ])(`preserves first-paragraph markdown and full text on disclosure (forceOpen=${forceOpen}): %s`, (body) => {
    mount(userItem(frame('msg_full', 'issue:POD-2242', 'your session', body)), false, forceOpen)
    if (!forceOpen) click(toggle())
    const content = host.querySelector<HTMLElement>('.mail-item-body')!
    expect(content.querySelector('a[href="https://example.com/conflict"]')?.textContent).toBe(
      'the conflict report',
    )
    expect(content.querySelector('a.ref-link[data-ref="POD-86"]')).not.toBeNull()
    expect(content.querySelector('code')?.textContent).toBe('bun run test')
    if (body.includes('Last words.')) expect(content.textContent).toContain('Last words.')
    if (body.includes('Follow-up paragraph.'))
      expect(content.textContent).toContain('Follow-up paragraph.')
    expect(host.querySelector('.work-line-phrase')?.textContent).toBe('POD-2242')
    expect(
      host.querySelectorAll('.mail-item-body a[href="https://example.com/conflict"]'),
    ).toHaveLength(1)
  })

  it(`preserves a one-line sent-note pointer body (forceOpen=${forceOpen})`, () => {
    bodyAnswer = () => ({ status: 'ready', body: firstParagraph })
    mount(
      {
        id: 'sent_full',
        role: 'tool',
        text: '',
        toolName: 'Bash',
        toolInput: `podium mail send --to POD-2242 --body '${firstParagraph}'`,
      },
      false,
      forceOpen,
      undefined,
      'sent msg_full to POD-2242 (delivered)',
    )
    if (!forceOpen) {
      expect(bodyRequests).toEqual([])
      click(toggle())
    }
    expect(bodyRequests).toContain('msg_full')
    const content = host.querySelector('.mail-item-body')
    expect(content?.querySelector('a[href="https://example.com/conflict"]')).not.toBeNull()
    expect(content?.textContent).toContain('before landing.')
    expect(host.querySelector('.work-line-phrase')?.textContent).toBe('To POD-2242')
  })
}

it('includes the visible sender and subject in a note toggle accessible name', () => {
  mount(userItem(frame('msg_label', 'issue:POD-2242', 'your session', 'Ready for review')))
  expect(getByRole(host, 'button', { name: /^Unfold POD-2242\s+Ready for review$/ })).toBe(toggle())
  expect(toggle()?.getAttribute('aria-label')).toContain(
    toggle()?.textContent?.replace(/\s+/g, ' ').trim(),
  )
  click(toggle())
  expect(getByRole(host, 'button', { name: /^Fold POD-2242\s+Ready for review$/ })).toBe(toggle())
})

it('includes the visible recipient and subject in a sent-note toggle accessible name', () => {
  mount(
    {
      id: 'sent_label',
      role: 'tool',
      text: '',
      toolName: 'Bash',
      toolInput: "podium mail send --to POD-2242 --body 'Ready for review'",
    },
    false,
    false,
    undefined,
    'sent msg_label to POD-2242 (delivered)',
  )
  expect(getByRole(host, 'button', { name: /^Unfold To POD-2242\s+Ready for review$/ })).toBe(
    toggle(),
  )
})

it.each([
  'request_user_input',
  'ExitPlanMode',
])('renders an unstructured %s question once and retains the real result', (toolName) => {
  const item: TranscriptItem = {
    id: 'generic-question',
    role: 'tool',
    text: '',
    toolName,
    toolTitle: 'Which branch should I use?',
    toolInput: 'Which branch should I use?',
  }
  mount(item)
  const card = host.querySelector('.asked-you')!
  expect(card.textContent?.split('Which branch should I use?')).toHaveLength(2)
  expect(card.querySelector('.tool-block')).toBeNull()
  expect(card.querySelector('.asked-you-result')).toBeNull()
  mount(item, false, false, undefined, 'Use main.')
  expect(card.querySelector('.asked-you-result')?.textContent).toBe('Use main.')
  expect(card.textContent?.split('Which branch should I use?')).toHaveLength(2)
})
