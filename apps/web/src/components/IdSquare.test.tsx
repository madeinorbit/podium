import type { IssueViewModel } from '@podium/client-core/replica'
import type { UnbrandIds } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdSquare, idSquareLabel } from './IdSquare'

function issue(over: Partial<UnbrandIds<IssueViewModel>> = {}): IssueViewModel {
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
    blockedByNotes: [],
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
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
    ...over,
  } as unknown as IssueViewModel
}

function square(): HTMLElement {
  return screen.getByTestId('issue-id-square') as HTMLElement
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

  it('a new issue the server has not numbered reads as pending, never POD-0 (POD-6400)', () => {
    expect(idSquareLabel({ ...issue({ seq: 0 }), displayRef: 'POD-…' })).toEqual({
      prefix: 'POD',
      number: '…',
      full: 'POD-…',
    })
    expect(idSquareLabel(issue({ seq: 0 }))).toEqual({ prefix: '#', number: '…', full: '#…' })
  })

  it.each([
    { size: 20, radius: 5, fontSize: '7px' },
    { size: 26, radius: 7, fontSize: '9.1px' },
    { size: 30, radius: 7, fontSize: '10.5px' },
  ])('keeps both identifier lines in a $size px square', ({ size, radius, fontSize }) => {
    render(<IdSquare issue={issue({ linearIdentifier: 'pod-128' })} size={size} state="working" />)
    const el = square()
    expect(el.getAttribute('data-prefix')).toBe('POD')
    expect(el.getAttribute('data-number')).toBe('128')
    expect(el.textContent).toBe('POD128')
    expect(el.style.width).toBe(`${size}px`)
    expect(el.style.height).toBe(`${size}px`)
    expect(el.style.borderRadius).toBe(`${radius}px`)
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('font-semibold')
    // The number sets the square's size; the prefix matches it and recedes by
    // ink alone (POD-783). Sub-30px squares stay proportional to the 10.5px
    // desktop pair rather than to a second, smaller ratio.
    expect(el.style.fontSize).toBe(fontSize)
    const prefix = el.firstElementChild as HTMLElement
    expect(prefix.textContent).toBe('POD')
    expect(prefix.style.fontSize).toBe(fontSize)
  })

  it('sets the desktop row square on the shell’s 10.5px micro floor, prefix included', () => {
    // POD-783: the prefix used to be two thirds of the number — 6.5px on a 30px
    // square, below anything the shell can legibly render. Both marks now sit on
    // the floor and prefixColor is what separates them.
    render(<IdSquare issue={issue({ linearIdentifier: 'POD-9' })} state="working" size={30} />)
    expect(square().style.fontSize).toBe('10.5px')
    expect((square().firstElementChild as HTMLElement).style.fontSize).toBe('10.5px')
  })
})

describe('IdSquare square language', () => {
  it('renders the recessed neutral square, dashed and dimmed for queued or idle', () => {
    const { rerender } = render(<IdSquare issue={issue()} state="working" />)
    // Every neutral tone is a token read (POD-388) so the square repaints with
    // the theme; the solid/dashed seam still carries the resting distinction.
    expect(square().getAttribute('style')).toContain('border-style: solid')
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().getAttribute('style')).toContain('background: var(--muted)')
    expect(square().getAttribute('style')).toContain('color: var(--muted-foreground)')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="queued" />)
    expect(square().getAttribute('style')).toContain('border-style: dashed')
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().getAttribute('style')).toContain('background: var(--muted)')
    expect(square().style.opacity).toBe('0.65')

    rerender(<IdSquare issue={issue()} state="idle" />)
    expect(square().getAttribute('data-state')).toBe('idle')
    expect(square().style.opacity).toBe('0.65')
  })

  it('keeps the solid live look for waiting and done rows', () => {
    const { rerender } = render(<IdSquare issue={issue()} state="waiting" />)
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="done" />)
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().style.opacity).toBe('1')
  })

  it('optionally composes the shared corner badges', () => {
    const { container, rerender } = render(
      <IdSquare issue={issue()} state="working" badge={{ kind: 'spinner' }} />,
    )
    expect(square().getAttribute('data-badge')).toBe('spinner')
    expect(container.querySelector('.pod-mark')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'working' })).toBeTruthy()

    rerender(<IdSquare issue={issue()} state="waiting" badge={{ kind: 'count', count: 2 }} />)
    expect(square().getAttribute('data-badge')).toBe('count')
    expect(screen.getByRole('img', { name: '2 waiting on you' }).textContent).toBe('2')
  })

  it('opens the task on rail squares before and after selection', () => {
    const onPrimary = vi.fn()
    const { rerender } = render(<IdSquare issue={issue()} state="queued" onPrimary={onPrimary} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open task #39' }))
    rerender(<IdSquare issue={issue()} state="queued" selected onPrimary={onPrimary} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open task #39' }))
    expect(onPrimary).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets a row own navigation when its identity has no separate action', () => {
    const open = vi.fn()
    render(
      <button type="button" onClick={open}>
        <IdSquare issue={issue()} state="queued" />
      </button>,
    )
    expect(square().tagName).toBe('SPAN')
    fireEvent.click(square())
    expect(open).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
