// @vitest-environment happy-dom
import type { ConcertmasterEntryModel } from '@podium/client-graph/models'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConcertmasterAskCard, type RespondToAsk } from './ConcertmasterAskCard'

afterEach(() => cleanup())

const ask = (over: Record<string, unknown>): ConcertmasterEntryModel =>
  ({
    id: 's1\n1',
    entryId: '1',
    sessionId: 's1',
    kind: 'ask',
    number: 1,
    body: 'Ship today?',
    createdAt: '2026-11-20T09:14:00.000Z',
    status: 'open',
    open: (over.status ?? 'open') === 'open',
    isAsk: true,
    ...over,
  }) as unknown as ConcertmasterEntryModel

const settles = (): ReturnType<typeof vi.fn<RespondToAsk>> => vi.fn<RespondToAsk>(async () => true)

describe('ConcertmasterAskCard', () => {
  it('answers a decision with the option that was pressed', async () => {
    const onRespond = settles()
    const entry = ask({ askKind: 'decision', options: ['Ship', 'Wait'] })
    render(<ConcertmasterAskCard entry={entry} onRespond={onRespond} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }))
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith(entry, 'answered', 'Wait'))
  })

  it('takes other words for a decision once asked for', async () => {
    const onRespond = settles()
    render(
      <ConcertmasterAskCard
        entry={ask({ askKind: 'decision', options: ['Ship', 'Wait'] })}
        onRespond={onRespond}
      />,
    )
    expect(screen.queryByTestId('concertmaster-ask-text')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Something else…' }))
    fireEvent.change(screen.getByTestId('concertmaster-ask-text'), {
      target: { value: '  Ship on Monday  ' },
    })
    fireEvent.click(screen.getByTestId('concertmaster-ask-send'))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(expect.anything(), 'answered', 'Ship on Monday'),
    )
  })

  it('answers a question on Enter, and not while the field is empty', async () => {
    const onRespond = settles()
    render(<ConcertmasterAskCard entry={ask({ askKind: 'question' })} onRespond={onRespond} />)
    const field = screen.getByTestId('concertmaster-ask-text')
    expect((screen.getByTestId('concertmaster-ask-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onRespond).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'Postgres' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(expect.anything(), 'answered', 'Postgres'),
    )
  })

  it('marks a to-do done, and dismisses any ask', async () => {
    const onRespond = settles()
    render(<ConcertmasterAskCard entry={ask({ askKind: 'todo' })} onRespond={onRespond} />)
    expect(screen.queryByTestId('concertmaster-ask-text')).toBeNull()
    fireEvent.click(screen.getByTestId('concertmaster-ask-done'))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(expect.anything(), 'done', undefined),
    )
    fireEvent.click(screen.getByTestId('concertmaster-ask-dismiss'))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(expect.anything(), 'dismissed', undefined),
    )
  })

  it('says so when a response was not delivered, and stays answerable', async () => {
    const onRespond = vi.fn<RespondToAsk>(async () => {
      throw new Error('offline')
    })
    render(<ConcertmasterAskCard entry={ask({ askKind: 'todo' })} onRespond={onRespond} />)
    fireEvent.click(screen.getByTestId('concertmaster-ask-done'))
    expect((await screen.findByRole('alert')).textContent).toContain('not delivered')
    expect((screen.getByTestId('concertmaster-ask-done') as HTMLButtonElement).disabled).toBe(false)
  })

  it('draws a settled ask as a line with what it was settled with, and no controls', () => {
    render(
      <ConcertmasterAskCard
        entry={ask({
          askKind: 'decision',
          status: 'answered',
          answer: 'Ship',
          settledBy: 'user',
          settledAt: '2026-11-20T09:20:00.000Z',
        })}
        onRespond={settles()}
      />,
    )
    const card = screen.getByTestId('concertmaster-ask')
    expect(card.getAttribute('data-ask-status')).toBe('answered')
    expect(card.textContent).toContain('Decided')
    expect(screen.getByTestId('concertmaster-ask-answer').textContent).toBe('Ship')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
