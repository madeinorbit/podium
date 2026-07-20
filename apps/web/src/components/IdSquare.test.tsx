// @vitest-environment happy-dom
import type { IssueWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdSquare, idSquareLabel } from './IdSquare'

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'iss_39',
    repoPath: '/repo',
    seq: 39,
    title: 'Shared identity',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 1,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    archived: false,
    readAt: null,
    unread: false,
    origin: 'human',
    audience: 'human',
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...over,
  }
}

function square(): HTMLButtonElement {
  return screen.getByTestId('issue-id-square') as HTMLButtonElement
}

afterEach(cleanup)

describe('IdSquare identity', () => {
  it('splits a current external identifier and falls back to the current #seq scheme', () => {
    expect(idSquareLabel(issue({ linearIdentifier: 'POD-128' }))).toEqual({
      prefix: 'POD',
      number: '128',
      full: 'POD-128',
    })
    expect(idSquareLabel(issue({ seq: 39 }))).toEqual({
      prefix: '#',
      number: '39',
      full: '#39',
    })
  })

  it('uses the server displayRef so the square reads POD-78, not #78 (POD-85)', () => {
    expect(idSquareLabel({ ...issue({ seq: 78 }), displayRef: 'POD-78' })).toEqual({
      prefix: 'POD',
      number: '78',
      full: 'POD-78',
    })
    // An explicit linear identifier still wins over the local ref.
    expect(
      idSquareLabel({ ...issue({ linearIdentifier: 'ENG-4' }), displayRef: 'POD-9' }).prefix,
    ).toBe('ENG')
  })

  it('keeps the fixed 26px / 7px / 6.5px square in every state', () => {
    render(
      <IdSquare
        issue={issue({ linearIdentifier: 'pod-128' })}
        state="working"
        onColorChange={vi.fn()}
      />,
    )
    const el = square()
    expect(el.getAttribute('data-prefix')).toBe('POD')
    expect(el.getAttribute('data-number')).toBe('128')
    expect(el.textContent).toBe('POD128')
    expect(el.getAttribute('style')).toContain('width: 26px')
    expect(el.getAttribute('style')).toContain('height: 26px')
    expect(el.getAttribute('style')).toContain('border-radius: 7px')
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-[6.5px]')
    expect(el.className).toContain('font-semibold')
  })
})

describe('IdSquare square language', () => {
  it('renders solid grey for working and dashed/dimmed for queued or idle', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue()} state="working" onColorChange={onColorChange} />,
    )
    expect(square().getAttribute('style')).toContain('border: 1px solid #8d8d9a')
    expect(square().getAttribute('style')).toContain('color: #c5c5d0')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="queued" onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('border: 1px dashed #6c6c78')
    expect(square().getAttribute('style')).toContain('color: #8d8d9a')
    expect(square().style.opacity).toBe('0.65')

    rerender(<IdSquare issue={issue()} state="idle" onColorChange={onColorChange} />)
    expect(square().getAttribute('data-state')).toBe('idle')
    expect(square().style.opacity).toBe('0.65')
  })

  it('uses a solid issue-colour fill and preserves the selected neutral treatment', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue({ color: 'violet' })} state="queued" onColorChange={onColorChange} />,
    )
    expect(square().getAttribute('style')).toContain('background: #8b5cf6')
    expect(square().getAttribute('style')).toContain('border: 1px solid transparent')
    expect(square().getAttribute('data-color')).toBe('violet')
    expect(square().style.opacity).toBe('0.65')

    rerender(<IdSquare issue={issue()} state="idle" selected onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('border: 1px solid #c8d2e0')
    expect(square().getAttribute('style')).toContain('color: #e8edf5')
    expect(square().getAttribute('style')).toContain('rgba(148,163,184,.3)')
    expect(square().style.opacity).toBe('1')
  })

  it('keeps the solid live look for waiting and done rows', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue()} state="waiting" onColorChange={onColorChange} />,
    )
    expect(square().getAttribute('style')).toContain('border: 1px solid #8d8d9a')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="done" onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('border: 1px solid #8d8d9a')
    expect(square().style.opacity).toBe('1')
  })

  it('optionally composes the shared corner badges', () => {
    const { container, rerender } = render(
      <IdSquare
        issue={issue()}
        state="working"
        badge={{ kind: 'spinner' }}
        onColorChange={vi.fn()}
      />,
    )
    expect(square().getAttribute('data-badge')).toBe('spinner')
    expect(container.querySelector('.spb')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'working' })).toBeTruthy()

    rerender(
      <IdSquare
        issue={issue()}
        state="waiting"
        badge={{ kind: 'count', count: 2 }}
        onColorChange={vi.fn()}
      />,
    )
    expect(square().getAttribute('data-badge')).toBe('count')
    expect(screen.getByRole('img', { name: '2 waiting on you' }).textContent).toBe('2')
  })

  it('selects first on rail squares and only opens the picker once selected', () => {
    const onPrimary = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue()} state="queued" onPrimary={onPrimary} onColorChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open task #39' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(
      <IdSquare
        issue={issue()}
        state="queued"
        selected
        onPrimary={onPrimary}
        onColorChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set colour for task #39' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Task colour for #39' })).toBeTruthy()
  })
})

describe('IdSquare colour picker', () => {
  it('opens with a white trigger ring and optimistically selects a canonical slot', async () => {
    const onColorChange = vi.fn(async () => undefined)
    render(<IdSquare issue={issue()} state="working" onColorChange={onColorChange} />)

    const el = screen.getByRole('button', { name: 'Set colour for task #39' })
    fireEvent.click(el)
    expect(el.getAttribute('style')).toContain('0 0 0 2px #f3f3f8')
    expect(screen.getByRole('dialog', { name: 'Task colour for #39' })).toBeTruthy()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(10)

    fireEvent.click(screen.getByRole('button', { name: 'Violet' }))
    expect(el.getAttribute('data-color')).toBe('violet')
    await waitFor(() => expect(onColorChange).toHaveBeenCalledWith('violet'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the current colour and clears to the neutral optional field', async () => {
    const onColorChange = vi.fn(async () => undefined)
    render(
      <IdSquare issue={issue({ color: 'teal' })} state="working" onColorChange={onColorChange} />,
    )

    const el = screen.getByRole('button', { name: 'Set colour for task #39' })
    fireEvent.click(el)
    expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'No colour' }))

    expect(el.getAttribute('data-color')).toBe('none')
    await waitFor(() => expect(onColorChange).toHaveBeenCalledWith(null))
  })

  it('dismisses on Escape and outside click without mutating', () => {
    const onColorChange = vi.fn()
    render(<IdSquare issue={issue()} state="idle" onColorChange={onColorChange} />)
    const el = screen.getByRole('button', { name: 'Set colour for task #39' })

    fireEvent.click(el)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(el)

    fireEvent.click(el)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onColorChange).not.toHaveBeenCalled()
  })
})
