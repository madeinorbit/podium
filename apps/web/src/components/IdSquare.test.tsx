// @vitest-environment happy-dom
import {
  type IssueWireInput,
  type IssueWire,
} from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdSquare, idSquareLabel } from './IdSquare'

function issue(over: Partial<IssueWireInput> = {}): IssueWire {
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
    origin: 'human',
    audience: 'human',
    draft: false,
    ...over,
  } as unknown as IssueWire
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

  it('keeps the fixed 26px square, 7px radius and the two-line mono lockup', () => {
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
    expect(el.className).toContain('font-semibold')
    // The number sets the square's size; the prefix matches it and recedes by
    // ink alone (POD-783). Sub-30px squares stay proportional to the 10.5px
    // desktop pair rather than to a second, smaller ratio.
    expect(el.style.fontSize).toBe('9.1px')
    const prefix = el.firstElementChild as HTMLElement
    expect(prefix.textContent).toBe('POD')
    expect(prefix.style.fontSize).toBe('9.1px')
  })

  it('sets the desktop row square on the shell’s 10.5px micro floor, prefix included', () => {
    // POD-783: the prefix used to be two thirds of the number — 6.5px on a 30px
    // square, below anything the shell can legibly render. Both marks now sit on
    // the floor and prefixColor is what separates them.
    render(<IdSquare issue={issue({ linearIdentifier: 'POD-9' })} state="working" size={30} onColorChange={vi.fn()} />)
    expect(square().style.fontSize).toBe('10.5px')
    expect((square().firstElementChild as HTMLElement).style.fontSize).toBe('10.5px')
  })
})

describe('IdSquare square language', () => {
  it('renders the recessed neutral square, dashed and dimmed for queued or idle', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue()} state="working" onColorChange={onColorChange} />,
    )
    // Every neutral tone is a token read (POD-388) so the square repaints with
    // the theme; the solid/dashed seam still carries the resting distinction.
    expect(square().getAttribute('style')).toContain('border-style: solid')
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().getAttribute('style')).toContain('background: var(--muted)')
    expect(square().getAttribute('style')).toContain('color: var(--muted-foreground)')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="queued" onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('border-style: dashed')
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().getAttribute('style')).toContain('background: var(--muted)')
    expect(square().style.opacity).toBe('0.65')

    rerender(<IdSquare issue={issue()} state="idle" onColorChange={onColorChange} />)
    expect(square().getAttribute('data-state')).toBe('idle')
    expect(square().style.opacity).toBe('0.65')
  })

  it('tints rather than fills with the issue colour, and rims it at the scaled 35% (POD-725)', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue({ color: 'violet' })} state="queued" onColorChange={onColorChange} />,
    )
    // A tint over --muted, never a slab of the raw hue: the identity mark must
    // not be the loudest object in a column of quiet paper rows. Both doses ride
    // the theme's --issue-*-scale, exactly as the issue-mix-* utilities do.
    //
    // The mixes themselves are only assertable in a real engine — happy-dom's
    // CSS parser DROPS any declaration whose value is a color-mix(), which is
    // why the coloured square reports no background at all here (the same reason
    // SidebarUnified.selected-weight leaves the selected row's paint to the
    // Chromium probe). What this suite can hold is the structural fact: the raw
    // palette hex is no longer painted anywhere on the square, and the neutral
    // --muted fill is not what a coloured square falls back to either.
    expect(square().style.background).not.toContain('#8b5cf6')
    expect(square().style.background).not.toBe('var(--muted)')
    expect(square().style.borderColor).not.toBe('transparent')
    expect(square().getAttribute('data-color')).toBe('violet')
    expect(square().style.opacity).toBe('0.65')

    // An uncoloured, unselected square keeps the flat token fill — the tint is
    // the exception, not the default.
    rerender(<IdSquare issue={issue()} state="queued" onColorChange={onColorChange} />)
    expect(square().style.background).toBe('var(--muted)')

    // Selected borrows the no-colour flow and carries NO outer halo: selection
    // is said by the row's own band and spine, not a second ring here.
    rerender(<IdSquare issue={issue()} state="idle" selected onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('color: var(--text-strong)')
    expect(square().style.boxShadow).toBe('')
    expect(square().style.opacity).toBe('1')
  })

  it('keeps the solid live look for waiting and done rows', () => {
    const onColorChange = vi.fn()
    const { rerender } = render(
      <IdSquare issue={issue()} state="waiting" onColorChange={onColorChange} />,
    )
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
    expect(square().style.opacity).toBe('1')

    rerender(<IdSquare issue={issue()} state="done" onColorChange={onColorChange} />)
    expect(square().getAttribute('style')).toContain('border-color: var(--border-strong)')
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
    expect(container.querySelector('.pod-mark')).toBeTruthy()
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
    expect(el.getAttribute('style')).toContain('0 0 0 2px var(--text-strong)')
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

  // POD-697: colour names a MISSION. A sub-issue already runs under its parent's
  // (the shell tints from the nearest coloured ancestor), so its square is pure
  // identity — no picker, and no click that pretends there is one.
  it('is identity only on a sub-task — no picker to open', () => {
    const onColorChange = vi.fn()
    render(
      <IdSquare issue={issue({ parentId: 'iss_root' })} state="working" onColorChange={onColorChange} />,
    )
    const el = screen.getByRole('button', { name: 'Task #39' })
    expect(el.getAttribute('aria-haspopup')).toBeNull()
    fireEvent.click(el)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onColorChange).not.toHaveBeenCalled()
  })

  it('keeps a sub-task’s rail square on its primary action even once selected', () => {
    const onPrimary = vi.fn()
    render(
      <IdSquare
        issue={issue({ parentId: 'iss_root' })}
        state="queued"
        selected
        onPrimary={onPrimary}
        onColorChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open task #39' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
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
