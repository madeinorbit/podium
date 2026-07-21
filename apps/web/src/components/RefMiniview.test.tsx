import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefIssueLike, ResolvedRef } from '@/lib/ref-miniview'
import { RefCard, seedCardPosition } from './RefMiniview'

const parent: RefIssueLike = {
  id: 'iss_parent',
  prefix: 'POD',
  seq: 500,
  displayRef: 'POD-500',
  title: 'Epic',
}

/** A fully-populated issue (a structural subset of IssueWire, like the store holds). */
const rich: RefIssueLike = {
  id: 'iss_1',
  prefix: 'POD',
  seq: 517,
  displayRef: 'POD-517',
  title: 'Enrich the miniview',
  stage: 'in_progress',
  priority: 1,
  assignee: 'agent:claude-code',
  ready: false,
  blocked: true,
  blockedBy: ['iss_a', 'iss_b'],
  childCount: 4,
  childDoneCount: 2,
  parentId: 'iss_parent',
  activityNotes: 'Card now shows stage, todos and status.',
  panel: {
    todos: [
      { text: 'widen data path', done: true },
      { text: 'redesign card', done: true },
      { text: 'tests', done: false },
    ],
  },
}

const issues = [rich, parent]

function issueTarget(issue: RefIssueLike): ResolvedRef {
  return { kind: 'issue', ref: { kind: 'issue', prefix: 'POD', seq: issue.seq }, issue }
}

function renderCard(root: Root, issue: RefIssueLike): void {
  act(() => {
    root.render(
      <RefCard
        refToken={issue.displayRef ?? ''}
        target={issueTarget(issue)}
        issues={issues}
        onClose={() => {}}
        onOpenFull={() => {}}
      />,
    )
  })
}

describe('RefCard issue summary (#517)', () => {
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

  it('derives blocker count, subissue + todo progress, and the resolved parent ref', () => {
    renderCard(root, rich)
    const text = container.textContent ?? ''
    // Identity: the card renders the right issue.
    expect(text).toContain('POD-517')
    expect(text).toContain('Enrich the miniview')
    // Computed values (not passthrough copy): blocker count from blockedBy.length,
    // childDoneCount/childCount, done/total todos, and the resolved parent ref.
    expect(text).toContain('blocked (2)')
    expect(text).toContain('2/4 subissues done')
    expect(text).toContain('2/3 todos')
    expect(text).toContain('in POD-500')
  })

  it('blocked wins over ready', () => {
    renderCard(root, { ...rich, ready: true, blocked: true })
    const text = container.textContent ?? ''
    expect(text).toContain('blocked')
    expect(text).not.toContain('ready')
  })

  it('shows the ready chip when unblocked and ready', () => {
    renderCard(root, { ...rich, blocked: false, blockedBy: [], ready: true })
    const text = container.textContent ?? ''
    expect(text).toContain('ready')
    expect(text).not.toContain('blocked')
  })

  it('degrades to ref + title for a lean issue (no enrichment fields)', () => {
    renderCard(root, { id: 'iss_x', prefix: 'POD', seq: 9, displayRef: 'POD-9', title: 'Lean' })
    const text = container.textContent ?? ''
    expect(text).toContain('POD-9')
    expect(text).toContain('Lean')
    expect(text).not.toContain('subissues')
    expect(text).not.toContain('todos')
  })

  it('omits the parent chip when the parent is not resolvable', () => {
    renderCard(root, { ...rich, parentId: 'iss_gone' })
    expect(container.textContent).not.toContain('in POD-500')
  })
})

describe('RefCard run now (POD-110)', () => {
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

  function renderWithStart(
    issue: RefIssueLike,
    onStart: (issueId: string) => Promise<unknown>,
  ): void {
    act(() => {
      root.render(
        <RefCard
          refToken={issue.displayRef ?? ''}
          target={issueTarget(issue)}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
          onStart={onStart}
        />,
      )
    })
  }

  const runNowButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Run now'))

  it('offers Run now on a startable issue and fires onStart with the issue id', async () => {
    const onStart = vi.fn(async () => ({}))
    renderWithStart(rich, onStart) // rich has no worktreePath and is open
    const btn = runNowButton()
    expect(btn).toBeDefined()
    await act(async () => btn?.click())
    expect(onStart).toHaveBeenCalledWith('iss_1')
    // A settled start stays disabled ("Started") until the store's worktree
    // update unmounts the action.
    const started = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Started'),
    )
    expect(started?.disabled).toBe(true)
  })

  it('hides Run now once the issue has a worktree (agent already on it)', () => {
    renderWithStart({ ...rich, worktreePath: '/r/.worktrees/issue-517' }, vi.fn())
    expect(runNowButton()).toBeUndefined()
  })

  it('hides Run now on closed and archived issues', () => {
    renderWithStart({ ...rich, closedReason: 'done' }, vi.fn())
    expect(runNowButton()).toBeUndefined()
    renderWithStart({ ...rich, archived: true }, vi.fn())
    expect(runNowButton()).toBeUndefined()
  })

  it('renders the failure inline and re-offers the button', async () => {
    const onStart = vi.fn(() => Promise.reject(new Error('spawn failed')))
    renderWithStart(rich, onStart)
    await act(async () => runNowButton()?.click())
    expect(container.textContent).toContain('spawn failed')
    expect(runNowButton()?.disabled).toBe(false)
  })
})

describe('RefCard outside-click dismissal', () => {
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

  function renderWithClose(onClose: () => void): void {
    act(() => {
      root.render(
        <RefCard
          refToken={rich.displayRef ?? ''}
          target={issueTarget(rich)}
          issues={issues}
          onClose={onClose}
          onOpenFull={() => {}}
        />,
      )
    })
  }

  it('closes on a pointerdown outside the card', () => {
    const onClose = vi.fn()
    renderWithClose(onClose)
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open on a pointerdown inside the card', () => {
    const onClose = vi.fn()
    renderWithClose(onClose)
    const inside = document.querySelector('[role=dialog] span')
    expect(inside).not.toBeNull()
    act(() => {
      inside?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('seedCardPosition', () => {
  const viewport = { width: 1200, height: 800 }

  it('seeds just below-left of the activating click', () => {
    expect(seedCardPosition({ x: 400, y: 300 }, viewport)).toEqual({ x: 376, y: 314 })
  })

  it('clamps into the viewport on every edge', () => {
    expect(seedCardPosition({ x: 2, y: 2 }, viewport)).toEqual({ x: 12, y: 16 })
    const r = seedCardPosition({ x: 1195, y: 795 }, viewport)
    expect(r.x).toBe(1200 - 340 - 12)
    expect(r.y).toBe(800 - 120)
  })

  it('falls back to the top-right seed without an anchor', () => {
    expect(seedCardPosition(undefined, viewport)).toEqual({ x: 1200 - 340 - 20, y: 88 })
  })
})
