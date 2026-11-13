import type { TranscriptItem } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This lane does not run testing-library's auto-cleanup, so an earlier render
// would otherwise still be in the document when the next test queries it.
afterEach(cleanup)
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 1, fontScale: 1 }),
}))

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

const { AskQuestionCard } = await import('./AskQuestionCard')

const ask = (questions: unknown[]): TranscriptItem =>
  ({
    role: 'tool',
    toolName: 'AskUserQuestion',
    toolInputJson: JSON.stringify({ questions }),
  }) as unknown as TranscriptItem

const single = ask([
  { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
])

describe('AskQuestionCard', () => {
  it('lets a recorded answer failure override an earlier successful request acknowledgement', async () => {
    const onAnswer = vi.fn(async () => {})
    const view = render(<AskQuestionCard item={single} live onAnswer={onAnswer} />)
    fireEvent.click(screen.getByLabelText('SQLite'))
    await screen.findByText('Answer sent')
    view.rerender(
      <AskQuestionCard
        item={{ ...single, toolResult: 'Error: answer could not be delivered' }}
        live
        onAnswer={onAnswer}
      />,
    )
    expect(screen.getByText('Error: answer could not be delivered')).toBeTruthy()
    expect(screen.queryByText('Answer sent')).toBeNull()
    fireEvent.click(screen.getByLabelText('Postgres'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2))
  })
  it('retains its focused custom-answer field when opening the keyboard compacts the band', () => {
    const view = render(<AskQuestionCard item={single} live presentation="band" />)
    fireEvent.click(screen.getByLabelText('Write a different answer'))
    const input = screen.getByLabelText('Type your own answer')
    act(() => input.focus())
    fireEvent.change(input, { target: { value: 'DuckDB' } })
    view.rerender(<AskQuestionCard item={single} live presentation="band" compact />)
    expect(screen.getByLabelText('Type your own answer')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect((input as HTMLInputElement).value).toBe('DuckDB')
    expect(screen.queryByTestId('ask-question-compact')).toBeNull()
  })
  it('keeps a tall question scrollable and long options free to wrap', () => {
    const label = 'A much longer option label that needs several lines at Accessibility Medium.'
    render(
      <AskQuestionCard
        item={ask([{ question: 'Which database?\n'.repeat(12), options: [{ label }] }])}
        live
        presentation="band"
      />,
    )
    const scroll = screen.getByTestId('ask-question-scroll')
    expect(Number.parseFloat(scroll.style.maxHeight)).toBeGreaterThan(100)
    expect(Number.parseFloat(scroll.style.maxHeight)).toBeLessThanOrEqual(420)
    const option = screen.getByLabelText(label)
    expect(option.textContent).toBe(label)
    expect(option.querySelector('div')?.style.webkitLineClamp ?? '').toBe('')
  })
  it('compacts while typing, expands on Show, and resets when the keyboard closes', () => {
    const view = render(<AskQuestionCard item={single} live presentation="band" compact />)
    expect(screen.getByTestId('ask-question-compact')).toBeTruthy()
    expect(screen.queryByLabelText('SQLite')).toBeNull()
    fireEvent.click(screen.getByLabelText('Show question'))
    expect(screen.getByLabelText('SQLite')).toBeTruthy()
    view.rerender(<AskQuestionCard item={single} live presentation="band" compact={false} />)
    expect(screen.getByLabelText('SQLite')).toBeTruthy()
    view.rerender(<AskQuestionCard item={single} live presentation="band" compact />)
    expect(screen.queryByLabelText('SQLite')).toBeNull()
  })
  it('submits a tapped option as a 1-based digit', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<AskQuestionCard item={single} live onAnswer={onAnswer} />)

    fireEvent.click(screen.getByLabelText('SQLite'))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [2] }] }),
    )
  })

  // The native menu appends its own Other entry after the agent's options, so a
  // typed answer addresses optionCount + 1 — not one of the listed options.
  it('sends free text through the Other entry, not an option digit', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<AskQuestionCard item={single} live onAnswer={onAnswer} />)

    fireEvent.change(screen.getByLabelText('Type your own answer'), {
      target: { value: '  DuckDB  ' },
    })
    fireEvent.click(screen.getByLabelText('Send answer'))

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({
        choices: [{ freeText: 'DuckDB', otherIndex: 3 }],
      }),
    )
  })

  // POD-770 — per-option `preview` text swaps the NATIVE dialog for a layout with
  // no Other row, where the Other script silently commits option 1 and drops the
  // typed answer. The card ships the fact that produces it, as it does multiSelect.
  const previewed = ask([
    {
      question: 'Pick an approach',
      options: [
        { label: 'Alpha', preview: 'the alpha design' },
        { label: 'Beta', preview: 'the beta design' },
      ],
    },
  ])

  it('marks a previewed question previewLayout, on both the option and the free-text route', async () => {
    const onAnswer = vi.fn(async () => {})
    const view = render(<AskQuestionCard item={previewed} live onAnswer={onAnswer} />)

    fireEvent.click(screen.getByLabelText('Beta'))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({
        choices: [{ optionIndices: [2], previewLayout: true }],
      }),
    )

    view.unmount()
    const onTyped = vi.fn(async () => {})
    render(<AskQuestionCard item={previewed} live onAnswer={onTyped} />)
    fireEvent.change(screen.getByLabelText('Type your own answer'), {
      target: { value: 'neither — do gamma' },
    })
    fireEvent.click(screen.getByLabelText('Send answer'))
    await waitFor(() =>
      expect(onTyped).toHaveBeenCalledWith({
        choices: [{ freeText: 'neither — do gamma', otherIndex: 3, previewLayout: true }],
      }),
    )
  })

  it('skips the whole dialog without any choices', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<AskQuestionCard item={single} live onAnswer={onAnswer} />)

    fireEvent.click(screen.getByLabelText('Skip question'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ skip: true }))
  })

  // A tap must never fire a half-typed sentence at the agent: typing anywhere
  // hands the commit to Send, and the two are mutually exclusive per question.
  it('holds the commit once free text is typed, and each replaces the other', async () => {
    const onAnswer = vi.fn(async () => {})
    render(<AskQuestionCard item={single} live onAnswer={onAnswer} />)

    const box = screen.getByLabelText('Type your own answer')
    fireEvent.change(box, { target: { value: 'DuckDB' } })
    expect(screen.getByLabelText('Send answer')).toBeTruthy()

    // Tapping an option now clears the typed answer and does not auto-send.
    fireEvent.click(screen.getByLabelText('Postgres'))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({ choices: [{ optionIndices: [1] }] }),
    )
    expect((box as HTMLInputElement).value).toBe('')
  })

  it('offers no free-text box or skip on an answered card', () => {
    const answered = {
      ...ask([{ question: 'Which database?', options: [{ label: 'Postgres' }] }]),
      toolResult: '"Which database?"="Postgres"',
    } as TranscriptItem
    render(<AskQuestionCard item={answered} live={false} />)

    expect(screen.queryByLabelText('Type your own answer')).toBeNull()
    expect(screen.queryByLabelText('Skip question')).toBeNull()
  })
})

it('submits the identity and content captured by the rendered card', async () => {
  const onAnswer = vi.fn(async () => {})
  render(<AskQuestionCard item={single} live interactionId="ask:rendered" onAnswer={onAnswer} />)
  fireEvent.click(screen.getByLabelText('SQLite'))
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith({
      interactionId: 'ask:rendered',
      question: single.toolInputJson,
      choices: [{ optionIndices: [2] }],
    }),
  )
})

it('keeps long pinned options readable and retains the custom-answer path', async () => {
  const label = 'Keep the wordmark and place the longer description underneath it'
  const onAnswer = vi.fn(async () => {})
  render(
    <AskQuestionCard
      item={ask([
        { question: 'Which wordmark should stay?', options: [{ label }, { label: 'None' }] },
      ])}
      presentation="band"
      live
      onAnswer={onAnswer}
    />,
  )
  const option = screen.getByLabelText(label)
  expect(option.textContent).toBe(label)
  expect(screen.queryByText('CLAUDE IS ASKING')).toBeNull()
  fireEvent.click(screen.getByLabelText('Write a different answer'))
  fireEvent.change(screen.getByLabelText('Type your own answer'), {
    target: { value: 'Use the small mark' },
  })
  fireEvent.click(screen.getByLabelText('Send answer'))
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith({
      choices: [{ freeText: 'Use the small mark', otherIndex: 3 }],
    }),
  )
})
