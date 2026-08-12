import { asIssueId, asSessionId, asUserId } from '@podium/model'
import { parseAnyRef } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeMiniview, openMiniview } from '@/lib/ref-activation'
import type { RefIssueLike, RefSessionLike, ResolvedRef } from '@/lib/ref-miniview'
import { RefCard, RefMiniviewHost, seedCardPosition } from './RefMiniview'

const hostStore = vi.hoisted(() => ({
  replicaIssues: [] as RefIssueLike[],
  legacyIssues: [] as RefIssueLike[],
  updateIssue: vi.fn(async () => {}),
}))

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => hostStore.replicaIssues,
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({
      trpc: {
        issues: {
          start: { mutate: vi.fn() },
          promote: { mutate: vi.fn() },
          update: { mutate: vi.fn() },
        },
      },
      issues: hostStore.legacyIssues,
      sessions: [],
      setOpenIssueId: vi.fn(),
      setView: vi.fn(),
      setSelectedIssueId: vi.fn(),
      navigateToSession: vi.fn(),
      updateIssue: hostStore.updateIssue,
    }),
}))

const parent: RefIssueLike = {
  id: asIssueId('iss_parent'),
  prefix: 'POD',
  seq: 500,
  displayRef: 'POD-500',
  title: 'Epic',
}

/** A fully-populated issue (a structural subset of IssueWire, like the store holds). */
const rich: RefIssueLike = {
  id: asIssueId('iss_1'),
  prefix: 'POD',
  seq: 517,
  displayRef: 'POD-517',
  title: 'Enrich the miniview',
  stage: 'in_progress',
  defaultAgent: 'claude-code',
  priority: 1,
  assignee: asUserId('agent:claude-code'),
  ready: false,
  blocked: true,
  blockedByNotes: [asIssueId('iss_a'), asIssueId('iss_b')],
  childCount: 4,
  childDoneCount: 2,
  parentId: asIssueId('iss_parent'),
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

describe('RefMiniviewHost issue resolution', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    closeMiniview()
    hostStore.legacyIssues = []
    hostStore.replicaIssues = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    closeMiniview()
    act(() => root.unmount())
    container.remove()
  })

  it('resolves a normalized replica issue absent from the legacy store', () => {
    hostStore.replicaIssues = [rich]
    act(() => root.render(<RefMiniviewHost />))
    act(() => openMiniview('POD-517', { x: 100, y: 100 }))

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Enrich the miniview')
    expect(dialog?.textContent).not.toContain('Reference not found')
  })
})

function issueTarget(issue: RefIssueLike): ResolvedRef {
  return { kind: 'issue', ref: { kind: 'issue', prefix: 'POD', seq: issue.seq }, issue }
}

function sessionTarget(session: RefSessionLike): ResolvedRef {
  const ref = session.displayRef ? parseAnyRef(session.displayRef) : null
  if (ref?.kind !== 'session') {
    throw new Error(`session fixture needs a session displayRef, got ${session.displayRef}`)
  }
  return { kind: 'session', ref, session }
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
    // Computed values (not passthrough copy): blocker count from blockedByNotes.length,
    // childDoneCount/childCount, done/total todos, and the resolved parent ref.
    expect(text).toContain('blocked (2)')
    expect(text).toContain('2/4 done')
    expect(text).toContain('2 of 3 done')
    expect(text).toContain('in POD-500')
  })

  it('blocked renders even when ready is also set', () => {
    renderCard(root, { ...rich, ready: true, blocked: true })
    const text = container.textContent ?? ''
    expect(text).toContain('blocked')
    expect(text).not.toContain('ready')
  })

  it('normal availability is silent — no ready chip (POD-155)', () => {
    renderCard(root, { ...rich, blocked: false, blockedByNotes: [], ready: true })
    const text = container.textContent ?? ''
    expect(text).not.toContain('ready')
    expect(text).not.toContain('blocked')
  })

  it('degrades to ref + title for a lean issue (no enrichment fields)', () => {
    renderCard(root, {
      id: asIssueId('iss_x'),
      prefix: 'POD',
      seq: 9,
      displayRef: 'POD-9',
      title: 'Lean',
    })
    const text = container.textContent ?? ''
    expect(text).toContain('POD-9')
    expect(text).toContain('Lean')
    expect(text).not.toContain('subissues')
    expect(text).not.toContain('todos')
  })

  it('omits the parent chip when the parent is not resolvable', () => {
    renderCard(root, { ...rich, parentId: asIssueId('iss_gone') })
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

  it('removes both copy-ref affordances', () => {
    renderWithStart(rich, vi.fn())
    expect(container.textContent).not.toContain('Copy ref')
    expect(container.querySelector('[title^="Copy"]')).toBeNull()
  })
})

describe('RefCard proposal decisions', () => {
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

  const proposal: RefIssueLike = { ...rich, stage: 'proposed' }

  function renderProposal(
    onStart: (issueId: string) => Promise<unknown>,
    onPromote: (issueId: string) => Promise<unknown>,
    onAgentChange?: (issueId: string, defaultAgent: string) => Promise<unknown>,
  ): void {
    act(() => {
      root.render(
        <RefCard
          refToken="POD-517"
          target={issueTarget(proposal)}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
          onStart={onStart}
          onPromote={onPromote}
          onAgentChange={onAgentChange}
        />,
      )
    })
  }

  it('offers start now and approval to backlog as distinct outcomes', async () => {
    const onPromote = vi.fn(async () => ({}))
    renderProposal(
      vi.fn(async () => ({})),
      onPromote,
    )
    expect(container.textContent).toContain('Run now')
    const backlog = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add to backlog'),
    )
    expect(backlog).toBeDefined()
    await act(async () => backlog?.click())
    expect(onPromote).toHaveBeenCalledWith('iss_1')
    expect(container.textContent).toContain('In backlog')
  })

  it('shows progress while approval is pending', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })
    renderProposal(
      vi.fn(async () => ({})),
      vi.fn(() => pending),
    )
    const backlog = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add to backlog'),
    )
    act(() => backlog?.click())
    expect(container.textContent).toContain('Adding…')
    expect(backlog?.querySelector('.animate-spin')).not.toBeNull()
    await act(async () => resolve())
  })

  it('shows the persisted planned harness in the popup', () => {
    renderProposal(
      vi.fn(async () => ({})),
      vi.fn(async () => ({})),
      vi.fn(async () => ({})),
    )
    expect(container.textContent).toContain('Planned agent')
    expect(container.textContent).toContain('Claude Code')
    expect(container.querySelector('[aria-label="Planned agent harness"]')).not.toBeNull()
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

  it('stays open while choosing from its portaled harness menu', () => {
    const onClose = vi.fn()
    renderWithClose(onClose)
    const portal = document.createElement('div')
    portal.setAttribute('data-ref-miniview-owned', 'true')
    document.body.appendChild(portal)
    act(() => {
      portal.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    portal.remove()
  })
})

describe('RefCard is not draggable (POD-799)', () => {
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

  function renderCard(target: ResolvedRef): HTMLElement {
    act(() => {
      root.render(
        <RefCard
          refToken={rich.displayRef ?? ''}
          anchor={{ x: 300, y: 200 }}
          target={target}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
        />,
      )
    })
    const card = document.querySelector('[role=dialog]')
    if (!(card instanceof HTMLElement)) throw new Error('card did not render')
    return card
  }

  /** A pointer press-and-drag across the card's header region. */
  function dragAcross(card: HTMLElement): void {
    const head = card.firstElementChild
    if (!head) throw new Error('card has no header region')
    act(() => {
      head.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 220 }),
      )
      head.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 560 }),
      )
      head.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 700, clientY: 560 }))
    })
  }

  it('keeps the issue card where it opened when dragged by its head', () => {
    const card = renderCard(issueTarget(rich))
    const { left, top } = card.style
    dragAcross(card)
    expect(card.style.left).toBe(left)
    expect(card.style.top).toBe(top)
  })

  it('keeps the session card where it opened when dragged by its title bar', () => {
    const card = renderCard(
      sessionTarget({
        sessionId: asSessionId('sess-1'),
        displayRef: 'POD-13-A',
        name: 'POD-13-A',
        title: 'Session',
        cwd: '/home/dev/podium',
      }),
    )
    const { left, top } = card.style
    dragAcross(card)
    expect(card.style.left).toBe(left)
    expect(card.style.top).toBe(top)
  })

  it('shows no drag affordance — no grab cursor, no grip handle', () => {
    const card = renderCard(issueTarget(rich))
    expect(card.querySelector('[class*="cursor-grab"]')).toBeNull()
    expect(card.querySelector('.lucide-grip-vertical')).toBeNull()
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
    expect(r.x).toBe(1200 - 416 - 12)
    expect(r.y).toBe(800 - 120)
  })

  it('falls back to the top-right seed without an anchor', () => {
    expect(seedCardPosition(undefined, viewport)).toEqual({ x: 1200 - 416 - 20, y: 88 })
  })

  it('never seeds off-screen on a narrow viewport', () => {
    expect(seedCardPosition({ x: 20, y: 40 }, { width: 320, height: 640 }).x).toBe(12)
  })
})

describe('RefCard escalations (POD-786)', () => {
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

  const session = (
    over: Omit<Partial<RefSessionLike>, 'sessionId'> & { sessionId: string },
  ): RefSessionLike => ({
    cwd: '/repo',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    ...over,
    sessionId: asSessionId(over.sessionId),
  })

  function renderWith(
    issue: RefIssueLike,
    sessions: RefSessionLike[],
    handlers: { onOpenFull?: () => void; onGoToSession?: (id: string) => void } = {},
  ): void {
    act(() => {
      root.render(
        <RefCard
          refToken={issue.displayRef ?? ''}
          target={issueTarget(issue)}
          issues={issues}
          sessions={sessions}
          onClose={() => {}}
          onOpenFull={handlers.onOpenFull ?? (() => {})}
          onGoToSession={handlers.onGoToSession ?? (() => {})}
        />,
      )
    })
  }

  const button = (text: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

  it('sends the reader to the explorer, not to a peek drawer', () => {
    const onOpenFull = vi.fn()
    renderWith(rich, [], { onOpenFull })
    expect(container.textContent).not.toContain('Open issue peek')
    const explorer = button('Open in explorer')
    expect(explorer).toBeDefined()
    act(() => explorer?.click())
    expect(onOpenFull).toHaveBeenCalled()
  })

  it('offers the task’s own session and hands back its id', () => {
    const onGoToSession = vi.fn()
    renderWith(rich, [session({ sessionId: 's_own', issueId: 'iss_1', displayRef: 'POD-517-A' })], {
      onGoToSession,
    })
    const go = button('Go to session')
    expect(go).toBeDefined()
    act(() => go?.click())
    expect(onGoToSession).toHaveBeenCalledWith('s_own')
  })

  it('names the PARENT session when the subtask has none of its own', () => {
    const onGoToSession = vi.fn()
    // `rich` is parented on iss_parent (POD-500); only the parent has run.
    renderWith(
      rich,
      [session({ sessionId: 's_parent', issueId: 'iss_parent', displayRef: 'POD-500-A' })],
      { onGoToSession },
    )
    // The label must not claim this task's own session, and the ref it lands on
    // is spelled out so the landing is not a surprise.
    expect(button('Go to session')).toBeUndefined()
    const go = button('Parent session')
    expect(go?.textContent).toContain('POD-500-A')
    act(() => go?.click())
    expect(onGoToSession).toHaveBeenCalledWith('s_parent')
  })

  it('offers no session action at all when nothing in the chain has run', () => {
    renderWith(rich, [])
    expect(button('Go to session')).toBeUndefined()
    expect(button('Parent session')).toBeUndefined()
    expect(button('Open in explorer')).toBeDefined()
  })
})

describe('RefCard identity row (POD-786)', () => {
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

  it('carries priority beside the ref, not down on the meta line', () => {
    renderCard(root, rich)
    const identity = container.querySelector('[data-issue-reference]')?.parentElement
    expect(identity?.textContent).toContain('POD-517')
    expect(identity?.textContent).toContain('P1')
    // The meta line still carries the enrichments — priority just is not one.
    expect(container.textContent).toContain('in POD-500')
  })

  it('omits priority entirely when the issue has none', () => {
    renderCard(root, { ...rich, priority: undefined })
    expect(container.querySelector('[aria-label="P1"]')).toBeNull()
  })
})
