import type { IssueViewModel } from '@podium/client-core/replica'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/test-support/model-catalog-mock'
import '@/test-support/mock-core-store-handle'
import { asIssueId, asSessionId, asUserId } from '@podium/model'
import { parseAnyRef } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateRef, closeMiniview, getMiniviewState, openMiniview } from '@/lib/ref-activation'
import type { RefIssueLike, RefSessionLike, ResolvedRef } from '@/lib/ref-miniview'
import { RefCard, RefMiniviewHost, seedCardPosition } from './RefMiniview'

const hostStore = vi.hoisted(() => ({
  machines: [
    {
      id: 'machine-1',
      name: 'Workstation',
      online: true,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { daemon: true },
    },
  ],
  replicaIssues: [] as RefIssueLike[],
  legacyIssues: [] as RefIssueLike[],
  sessions: [] as RefSessionLike[],
  referenceReads: vi.fn(),
  setOpenIssueId: vi.fn(),
  setView: vi.fn(),
  navigateToSession: vi.fn(),
  updateIssue: vi.fn(async () => {}),
  setSelectedIssueId: vi.fn(),
  setFocusedIssueId: vi.fn(),
  retarget: vi.fn(),
}))

vi.mock('@/app/store', async () => {
  const { normalizedFixtureStore } = await import('@/test-support/normalized-issues')
  return {
  useRuntimeSelector: (select: (state: unknown) => unknown) =>
    select({
      ...normalizedFixtureStore({ issues: hostStore.replicaIssues, sessions: hostStore.sessions }),
      trpc: {
        issues: {
          start: { mutate: vi.fn() },
          promote: { mutate: vi.fn() },
          update: { mutate: vi.fn() },
          comments: { query: vi.fn(async () => []) },
        },
      },
      issues: hostStore.legacyIssues,
      sessions: hostStore.sessions,
      repos: [],
      machines: hostStore.machines,
      setOpenIssueId: hostStore.setOpenIssueId,
      setView: hostStore.setView,
      setSelectedIssueId: hostStore.setSelectedIssueId,
      navigateToSession: hostStore.navigateToSession,
      updateIssue: hostStore.updateIssue,
    }),
  }
})

vi.mock('@/app/store-worklist-pool', async () => {
  const { fixturePoolHooks } = await import('@/test-support/pool-fixture')
  const registered = new WeakSet()
  return {
    ...fixturePoolHooks,
    useWorklistPool() {
      const pool = fixturePoolHooks.useWorklistPool()
      if (!registered.has(pool)) {
        registered.add(pool)
        pool.sources.register(['chatContextReader'], {
          read: () => ({ sessions: () => {
            hostStore.referenceReads()
            return { sessions: hostStore.sessions }
          } }),
          dispose() {},
        })
      }
      return pool
    },
  }
})

vi.mock('@/features/chat/use-chat-context', () => ({
  useChatReferenceSessions: () => {
    hostStore.referenceReads()
    return hostStore.sessions
  },
  useChatReferenceMachines: () => hostStore.machines,
  useChatRepositoryKey: () => '',
}))

vi.mock('@/app/operator-focus', () => ({
  useOperatorFocus: () => ({
    focusedIssueId: null,
    setFocusedIssueId: hostStore.setFocusedIssueId,
  }),
}))

vi.mock('@/features/issues/explorer/explorer-context', () => ({
  useIssueExplorer: () => ({ retarget: hostStore.retarget }),
}))

const parent: RefIssueLike = {
  id: asIssueId('iss_parent'),
  prefix: 'POD',
  seq: 500,
  displayRef: 'POD-500',
  title: 'Epic',
}

/** A fully-populated issue (a structural subset of like the store holds). */
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

beforeEach(() => {
  hostStore.replicaIssues = issues
  hostStore.sessions = []
  hostStore.referenceReads.mockClear()
  hostStore.setOpenIssueId.mockClear()
  hostStore.setView.mockClear()
  hostStore.navigateToSession.mockClear()
})

describe('RefMiniviewHost issue resolution', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    closeMiniview()
    hostStore.legacyIssues = []
    hostStore.replicaIssues = []
    hostStore.setSelectedIssueId.mockClear()
    hostStore.setFocusedIssueId.mockClear()
    hostStore.retarget.mockClear()
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

  it('reads no session roster while closed and releases it after closing', () => {
    hostStore.replicaIssues = [rich]
    act(() => root.render(<RefMiniviewHost />))
    expect(hostStore.referenceReads).not.toHaveBeenCalled()
    hostStore.sessions = [{ sessionId: asSessionId('s_late'), displayRef: 'POD-517-A', cwd: '/repo' }]
    act(() => root.render(<RefMiniviewHost />))
    expect(hostStore.referenceReads).not.toHaveBeenCalled()
    act(() => openMiniview('POD-517', { x: 100, y: 100 }))
    expect(hostStore.referenceReads).toHaveBeenCalledTimes(1)
    act(() => closeMiniview())
    hostStore.referenceReads.mockClear()
    hostStore.sessions = []
    act(() => root.render(<RefMiniviewHost />))
    expect(hostStore.referenceReads).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps direct issue activation available without reading the session roster', () => {
    hostStore.replicaIssues = [rich]
    act(() => root.render(<RefMiniviewHost />))
    act(() => activateRef('POD-517', { ctrlKey: true }))
    expect(hostStore.setOpenIssueId).toHaveBeenCalledWith('iss_1')
    expect(hostStore.setView).toHaveBeenCalledWith('issues')
    expect(hostStore.referenceReads).not.toHaveBeenCalled()
    expect(getMiniviewState()).toBeNull()
  })

  it('resolves direct session activation from the latest roster on demand', () => {
    act(() => root.render(<RefMiniviewHost />))
    hostStore.sessions = [{ sessionId: asSessionId('s_late'), displayRef: 'POD-517-A', cwd: '/repo' }]
    act(() => activateRef('POD-517-A', { metaKey: true }))
    expect(hostStore.navigateToSession).toHaveBeenCalledWith('POD-517-A')
    expect(hostStore.referenceReads).toHaveBeenCalledTimes(1)
    expect(getMiniviewState()).toBeNull()
  })

  // POD-1265: the escalation is a LOOK, not a move. Pointing the explorer used
  // to run through the shell selection, which is also what the sidebar
  // highlights and what keys the tab area's workspace — so reading a ref in
  // chat dragged the whole workspace onto whatever task was mentioned.
  it('points the explorer at the task without moving the shell', () => {
    hostStore.replicaIssues = [rich, parent]
    const panels: unknown[] = []
    const onPanel = (event: Event): void => {
      panels.push((event as CustomEvent).detail)
    }
    window.addEventListener('podium:open-right-panel', onPanel)
    try {
      act(() => root.render(<RefMiniviewHost />))
      act(() => openMiniview('POD-517', { x: 100, y: 100 }))
      const open = [...document.body.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Open in explorer'),
      )
      expect(open).toBeDefined()
      act(() => open?.click())

      expect(hostStore.retarget).toHaveBeenCalledWith('iss_1')
      expect(panels).toEqual(['issue'])
      expect(hostStore.setSelectedIssueId).not.toHaveBeenCalled()
      expect(hostStore.setFocusedIssueId).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('podium:open-right-panel', onPanel)
    }
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

  it('loads the comment count on demand and refreshes it when issue activity moves', async () => {
    const loadComments = vi.fn().mockResolvedValue([{}, {}])
    const issue = { ...rich, panel: undefined, childCount: 0, updatedAt: 't1', commentCount: 99 }
    const show = (updatedAt: string) =>
      root.render(
        <RefCard
          refToken="POD-517"
          target={issueTarget({ ...issue, updatedAt })}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
          loadComments={loadComments}
        />,
      )
    await act(async () => {
      show('t1')
    })
    expect(loadComments).toHaveBeenCalledWith(issue.id)
    expect(container.textContent).toContain('2 comments')
    expect(container.textContent).not.toContain('99 comments')
    loadComments.mockResolvedValue([{}])
    await act(async () => {
      show('t2')
    })
    expect(container.textContent).toContain('1 comment')
    loadComments.mockResolvedValue([])
    await act(async () => {
      show('t3')
    })
    expect(container.textContent).not.toContain('Activity')
  })

  it('ignores a late comments response after the card switches issues', async () => {
    let finish!: (rows: never[]) => void
    const loadComments = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue([{}])
    const show = (issue: RefIssueLike) =>
      root.render(
        <RefCard
          refToken="POD-517"
          target={issueTarget(issue)}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
          loadComments={loadComments}
        />,
      )
    await act(async () => {
      show({ ...rich, panel: undefined, childCount: 0 })
    })
    await act(async () => {
      show({ ...parent, stage: 'done', childCount: 0 })
    })
    expect(container.textContent).toContain('1 comment')
    await act(async () => {
      finish([{} as never, {} as never])
    })
    expect(container.textContent).toContain('1 comment')
    expect(container.textContent).not.toContain('2 comments')
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
    )
    expect(container.textContent).toContain('Planned agent')
    expect(container.textContent).toContain('Claude Code')
    expect(container.querySelector('[aria-label="Planned agent harness"]')).not.toBeNull()
  })

  it('hides the planned harness once the issue has started', () => {
    act(() => {
      root.render(
        <RefCard
          refToken="POD-517"
          target={issueTarget({
            ...proposal,
            stage: 'in_progress',
            worktreePath: '/r/.worktrees/issue-517',
          })}
          issues={issues}
          onClose={() => {}}
          onOpenFull={() => {}}
        />,
      )
    })

    expect(container.textContent).not.toContain('Planned agent')
    expect(container.querySelector('[aria-label="Planned agent harness"]')).toBeNull()
  })
})

describe('RefCard planned agent settings', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    hostStore.updateIssue.mockReset()
    hostStore.updateIssue.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function show(
    issue: RefIssueLike = { ...rich, stage: 'backlog' },
    onClose = vi.fn(),
    onStart = vi.fn(async () => ({})),
  ): void {
    act(() =>
      root.render(
        <RefCard
          refToken="POD-517"
          target={issueTarget(issue)}
          issues={issues}
          machines={hostStore.machines}
          onClose={onClose}
          onOpenFull={vi.fn()}
          onStart={onStart}
        />,
      ),
    )
  }

  it.each([
    [
      'Planned agent harness',
      'Codex',
      { defaultAgent: 'codex', defaultModel: 'auto', defaultEffort: 'auto' },
    ],
    ['Model', 'Sonnet', { defaultModel: 'sonnet', defaultEffort: 'auto' }],
    ['Effort', 'High', { defaultEffort: 'high' }],
    ['Machine', 'Workstation', { machineId: 'machine-1' }],
  ])('saves %s on the issue and reads it back when reopened', async (name, option, patch) => {
    show()
    fireEvent.click(screen.getByRole('button', { name }))
    fireEvent.click(await screen.findByRole('menuitem', { name: option }))
    await waitFor(() => expect(hostStore.updateIssue).toHaveBeenCalledWith('iss_1', patch))
    await waitFor(() => expect(container.textContent).toContain('Saved'))
    act(() => root.render(null))
    show({ ...rich, stage: 'backlog', ...patch } as RefIssueLike)
    expect(screen.getByRole('button', { name }).textContent).toContain(option)
  })

  it('keeps the card open while selecting a portaled model option', async () => {
    const onClose = vi.fn()
    show(undefined, onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const option = await screen.findByRole('menuitem', { name: 'Sonnet' })
    fireEvent.pointerDown(option)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(option)
    await waitFor(() =>
      expect(hostStore.updateIssue).toHaveBeenCalledWith('iss_1', {
        defaultModel: 'sonnet',
        defaultEffort: 'auto',
      }),
    )
  })

  it('waits for a settings write before allowing Run now', async () => {
    let resolve!: () => void
    hostStore.updateIssue.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const onStart = vi.fn(async () => ({}))
    show(undefined, undefined, onStart)
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'High' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run now' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Model' }).disabled).toBe(true)
    expect(container.textContent).toContain('Saving…')
    await act(async () => resolve())
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('iss_1'))
  })

  it('restores the saved selection and shows a refused write inline', async () => {
    hostStore.updateIssue.mockRejectedValueOnce(new Error('machine unavailable'))
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Machine' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workstation' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('machine unavailable'),
    )
    expect(screen.getByRole('button', { name: 'Machine' }).textContent).toContain('auto')
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
    portal.setAttribute('data-overlay-owner', 'ref-miniview')
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
    renderWith(
      rich,
      [session({ sessionId: 's_own', issueId: asIssueId('iss_1'), displayRef: 'POD-517-A' })],
      {
        onGoToSession,
      },
    )
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
      [
        session({
          sessionId: 's_parent',
          issueId: asIssueId('iss_parent'),
          displayRef: 'POD-500-A',
        }),
      ],
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
