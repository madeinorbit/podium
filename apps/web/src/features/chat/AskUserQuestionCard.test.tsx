import type { TranscriptItem } from '@podium/model'
import { fireEvent } from '@testing-library/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import type { ChatBlock } from './chat'

// ---------------------------------------------------------------------------
// The transcript's decision surface (POD-594). A multi-question ask opens ONE
// question at a time behind a rail of `header` chips, and only a lone
// single-select question still commits on click — everything larger collects
// the set and waits for an explicit send, so revising an earlier answer can
// never fire the submit.
// ---------------------------------------------------------------------------

const ask = (questions: unknown, result?: string): ChatBlock =>
  ({
    item: {
      id: 'q',
      cursor: 'c1',
      role: 'tool',
      text: '',
      toolName: 'AskUserQuestion',
      toolUseId: 'u1',
      toolInputJson: JSON.stringify({ questions }),
    } as TranscriptItem,
    result,
  }) as unknown as ChatBlock

const THREE = [
  {
    question: 'Where does the derivation live?',
    header: '516 dep',
    options: [{ label: 'Promote it (Recommended)' }, { label: 'Wait for 516' }],
  },
  {
    question: 'How deep does the peek go?',
    header: 'Peek depth',
    options: [{ label: 'Two detents' }, { label: 'Push' }],
  },
  {
    question: 'Which runtime?',
    header: 'Runtime',
    options: [{ label: 'Native first' }, { label: 'PWA only' }],
  },
]

const options = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('button[role="radio"], button[role="checkbox"]'),
]
const sendButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => /^Send answers?$/.test(b.textContent ?? ''))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AskUserQuestionCard', () => {
  it('commits on click for a lone single-select question', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    expect(sendButton()).toBeUndefined()
    await act(async () => options()[1]?.click())
    expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [2] }] })
  })

  it('names network submission without borrowing the computing spinner', async () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}))
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    await act(async () => {
      options()[0]?.click()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('sending')
    expect(container.querySelector('.pod-mark')).toBeNull()
  })

  it('opens one question at a time and steps to the next unanswered one', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard block={ask(THREE)} cls="" index={0} livePending onAnswer={onAnswer} />,
      ),
    )
    // Only the open question's options are mounted — not all six.
    expect(options()).toHaveLength(2)
    expect(container.textContent).toContain('Where does the derivation live?')
    expect(container.textContent).not.toContain('Which runtime?')

    await act(async () => options()[0]?.click())
    expect(container.textContent).toContain('How deep does the peek go?')
    // Answering does NOT submit while questions remain.
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('waits for an explicit send once every question is answered', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard block={ask(THREE)} cls="" index={0} livePending onAnswer={onAnswer} />,
      ),
    )
    await act(async () => options()[0]?.click())
    await act(async () => options()[1]?.click())
    await act(async () => options()[0]?.click())
    // All three answered, and still nothing sent without the press.
    expect(onAnswer).not.toHaveBeenCalled()
    const send = sendButton()
    expect(send?.disabled).toBe(false)
    await act(async () => send?.click())
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ optionIndices: [1] }, { optionIndices: [2] }, { optionIndices: [1] }],
    })
  })

  it('keeps the send button disabled while a question is unanswered', async () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(THREE)}
          cls=""
          index={0}
          livePending
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(sendButton()?.disabled).toBe(true)
  })

  it('collects a multi-select set and sends it in one call', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([
            {
              question: 'Which lanes?',
              multiSelect: true,
              options: [{ label: 'Unit' }, { label: 'Browser' }, { label: 'Multi' }],
            },
          ])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    await act(async () => options()[0]?.click())
    await act(async () => options()[2]?.click())
    expect(onAnswer).not.toHaveBeenCalled()
    await act(async () => sendButton()?.click())
    // The shape travels with the picks — the native menu leaves a multi-select
    // question only on Tab, and the server cannot tell from the indices alone.
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ optionIndices: [1, 3], multiSelect: true }],
    })
  })

  it('submits free text via Other with otherIndex = optionCount + 1', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    const input = container.querySelector<HTMLInputElement>('[data-testid="ask-free-text"]')
    expect(input).toBeTruthy()
    await act(async () => {
      if (!input) return
      fireEvent.change(input, { target: { value: 'ship the long path' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ freeText: 'ship the long path', otherIndex: 3 }],
    })
  })

  // POD-770. Per-option `preview` text swaps the NATIVE dialog for a side-by-side
  // layout with no Other row, where the server's Other script silently commits
  // option 1 and drops the typed answer. The card cannot see that dialog, so it
  // ships the fact that produces it — as it already does for multiSelect.
  const PREVIEWED = [
    {
      question: 'Pick an approach',
      options: [
        { label: 'Alpha', preview: 'the alpha design' },
        { label: 'Beta', preview: 'the beta design' },
      ],
    },
  ]

  it('marks a previewed question previewLayout when free text is typed', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(PREVIEWED)}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    const input = container.querySelector<HTMLInputElement>('[data-testid="ask-free-text"]')
    await act(async () => {
      if (!input) return
      fireEvent.change(input, { target: { value: 'neither — do gamma' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ freeText: 'neither — do gamma', otherIndex: 3, previewLayout: true }],
    })
  })

  it('marks a previewed question previewLayout when an option is clicked', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(PREVIEWED)}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    // A previewed question is browsed before it is answered (POD-708), so the
    // click selects and the send delivers. What is asserted here is the SHAPE
    // that reaches the server, which is unchanged.
    await act(async () => options()[1]?.click())
    await act(async () => sendButton()?.click())
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ optionIndices: [2], previewLayout: true }],
    })
  })

  it('leaves previewLayout off a multi-select, which the native dialog never previews', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([{ ...PREVIEWED[0], multiSelect: true }])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    await act(async () => options()[0]?.click())
    await act(async () => sendButton()?.click())
    expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [1], multiSelect: true }] })
  })

  it('Skip submits { skip: true }', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }])}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    const skip = container.querySelector<HTMLButtonElement>('[data-testid="ask-skip"]')
    expect(skip).toBeTruthy()
    await act(async () => skip?.click())
    expect(onAnswer).toHaveBeenCalledWith({ skip: true })
  })

  it('lifts "(Recommended)" out of the label into its own chip', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask([THREE[0]])}
          cls=""
          index={0}
          livePending
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(container.textContent).toContain('Promote it')
    expect(container.textContent).not.toContain('(Recommended)')
    expect(container.textContent?.toLowerCase()).toContain('rec')
    // A one-click card has no separate confirm: its recommendation is the one
    // yellow action, while the alternate remains neutral.
    expect(options()[0]?.querySelector('.bg-primary')).not.toBeNull()
    expect(options()[1]?.querySelector('.bg-primary')).toBeNull()
  })

  it('renders an answered ask as a receipt, without the recommendation suffix', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(THREE, '"Where does the derivation live?"="Promote it (Recommended)"')}
          cls=""
          index={0}
          livePending={false}
          onAnswer={async () => {}}
        />,
      ),
    )
    const receipt = container.querySelector('[data-testid="ask-receipt"]')
    expect(receipt).toBeTruthy()
    expect(receipt?.textContent).toContain('Promote it')
    expect(receipt?.textContent).not.toContain('(Recommended)')
  })

  it('shows every question, and no controls, when the card is read-only', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(THREE)}
          cls=""
          index={0}
          livePending={false}
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(options()).toHaveLength(0)
    expect(container.textContent).toContain('Which runtime?')
  })

  // -------------------------------------------------------------------------
  // Option previews (POD-708). The mockup is the comparison, so the card has to
  // let you look at one option while another is selected — which is exactly the
  // thing commit-on-click cannot do.
  // -------------------------------------------------------------------------

  const DRAWN = [
    {
      question: 'How far should the cache go?',
      header: 'Scope',
      options: [
        { label: 'Cache-first (Recommended)', preview: 'FRAME 1\n[ cached transcript ]' },
        { label: 'Cold state only', preview: 'FRAME 1\n[ skeleton rows ]' },
      ],
    },
  ]
  const well = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-testid="ask-preview"]')

  it('a lone single-select stops committing on click once an option has a preview', async () => {
    const onAnswer = vi.fn(async () => {})
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(DRAWN)}
          cls=""
          index={0}
          livePending
          onAnswer={onAnswer}
        />,
      ),
    )
    await act(async () => options()[1]?.click())
    // Selected, not sent — browsing must never answer.
    expect(onAnswer).not.toHaveBeenCalled()
    expect(options()[1]?.getAttribute('aria-checked')).toBe('true')
    await act(async () => sendButton()?.click())
    // previewLayout rides along because the same condition that opens the well
    // here changes the dialog the server has to type into (POD-770).
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ optionIndices: [2], previewLayout: true }],
    })
  })

  it('shows the recommended option first and follows hover to another', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(DRAWN)}
          cls=""
          index={0}
          livePending
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(well()?.textContent).toContain('cached transcript')
    act(() => {
      const target = options()[1]
      if (target) fireEvent.mouseEnter(target)
    })
    expect(well()?.textContent).toContain('skeleton rows')
    // …and hovering is still not answering.
    expect(options()[1]?.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the mockup on a parked card, which has no pointer to follow', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(DRAWN)}
          cls=""
          index={0}
          livePending={false}
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(container.querySelector('[data-testid="ask-readonly"]')).toBeTruthy()
    expect(well()?.textContent).toContain('cached transcript')
  })

  it('gives a lone question its header chip, which only the rail carries otherwise', () => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          block={ask(DRAWN)}
          cls=""
          index={0}
          livePending
          onAnswer={async () => {}}
        />,
      ),
    )
    expect(container.textContent).toContain('Scope')
  })
})
