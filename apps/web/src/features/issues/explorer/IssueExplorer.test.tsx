// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type JSX, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider, useOperatorFocus } from '@/app/operator-focus'
import { makeIssue } from '@/lib/test-issue'
import { ISSUE_VIRTUAL_MAX_ITEMS } from '../use-bounded-virtual-list'
import {
  EXPLORER_SCROLL_CACHE_LIMIT,
  IssueExplorerProvider,
  useIssueExplorer,
} from './explorer-context'
import { IssueExplorer, IssueExplorerCrumbs } from './IssueExplorer'

const EPIC = makeIssue({ id: 'p', seq: 1, title: 'Mission root', stage: 'in_progress' })
const CHILD = makeIssue({ id: 'c', seq: 2, title: 'Live child', parentId: 'p', stage: 'review' })
const STRANGER = makeIssue({ id: 's', seq: 9, title: 'Someone else’s task', stage: 'backlog' })
const ARCHIVED = makeIssue({
  id: 'archived',
  seq: 766,
  displayRef: 'POD-766',
  title: 'Minimap stale-tick crash',
  stage: 'done',
  archived: true,
})
/** A spin-off: no parentId, so it joins the mission through PROVENANCE — its
 *  starting session belongs to the root. That route deliberately keeps deleted
 *  issues, which is what makes it a different case from CHILD. */
const SPINOFF = makeIssue({
  id: 'spin',
  seq: 12,
  title: 'Spun off from the root',
  stage: 'backlog',
  startedBySession: 'sess-p',
})
const BASE_ISSUES = [EPIC, CHILD, STRANGER, ARCHIVED, SPINOFF]
const ROOT_SESSION = { sessionId: 'sess-p', issueId: 'p' } as never

const state = {
  selectedIssueId: null as string | null,
  sessions: [] as never[],
  issues: BASE_ISSUES,
  trpc: {
    issues: {
      comments: { query: vi.fn(async () => []) },
      events: { query: vi.fn(async () => []) },
    },
  },
}

vi.mock('@/app/store', () => ({
  useStore: () => state as never,
  useStoreSelector: (sel: (s: unknown) => unknown) => sel(state),
  useReplicaIssues: () => state.issues,
}))

// The detail is IssuePanelView's job and has its own tests; what this file is
// about is where the explorer goes and what the trail says when it gets there.
vi.mock('../IssuePanelView', () => ({
  IssuePanelView: ({
    issueId,
    onNavigate,
  }: {
    issueId?: string
    onNavigate?: (id: string) => void
  }) => (
    <div data-testid="detail" data-issue-id={issueId}>
      <button type="button" onClick={() => onNavigate?.('s')}>
        walk a relation
      </button>
    </div>
  ),
}))

/** Stands in for a Flight Deck session click — the only way anything outside
 *  the panel points it at a task. */
function DeckClick({ id }: { id: string }): JSX.Element {
  const { setFocusedIssueId } = useOperatorFocus()
  return (
    <button type="button" onClick={() => setFocusedIssueId(id)}>
      deck: {id}
    </button>
  )
}

/** Stands in for the chat ref card's "Open in explorer" — it points the panel
 *  without touching the shell selection at all (POD-1265). */
function CardClick({ id }: { id: string }): JSX.Element {
  const { retarget } = useIssueExplorer()
  return (
    <button type="button" onClick={() => retarget(id)}>
      card: {id}
    </button>
  )
}

/** Reads the pointer from OUTSIDE the dock. Both the trail and the panel live
 *  inside it and unmount with it, so this is the only way to say what the
 *  explorer is scoped to while it is shut. No text: `getByText` queries in the
 *  tests below must not see it. */
function PointerProbe(): JSX.Element {
  const { current } = useIssueExplorer()
  return <div data-testid="pointer" data-current={current ?? ''} />
}

function tree(missionId: string | null = null, dockOpen = true): JSX.Element {
  return (
    <OperatorFocusProvider missionId={missionId}>
      <IssueExplorerProvider>
        <DeckClick id="c" />
        <DeckClick id="s" />
        <DeckClick id="spin" />
        <CardClick id="s" />
        <CardClick id="spin" />
        <PointerProbe />
        {dockOpen && <IssueExplorerCrumbs />}
        {dockOpen && <IssueExplorer cwd="/r" />}
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}

function mount(missionId: string | null = null, dockOpen = true): ReturnType<typeof render> {
  return render(tree(missionId, dockOpen))
}

/** The live level. Two are mounted while a move is running — the one arriving
 *  is always last in the DOM, and the one leaving is inert. */
function detail(): HTMLElement {
  const levels = screen.getAllByTestId('detail')
  return levels[levels.length - 1] as HTMLElement
}

function ScrollCacheProbe({ onRead }: { onRead: (values: number[]) => void }): JSX.Element {
  const { listScrollTop, rememberListScrollTop } = useIssueExplorer()
  useEffect(() => {
    for (let index = 0; index < EXPLORER_SCROLL_CACHE_LIMIT + 4; index += 1) {
      rememberListScrollTop(`search:${index}`, index + 1)
    }
    onRead(
      Array.from({ length: EXPLORER_SCROLL_CACHE_LIMIT + 4 }, (_, index) =>
        listScrollTop(`search:${index}`),
      ),
    )
  }, [listScrollTop, onRead, rememberListScrollTop])
  return <div />
}

afterEach(() => {
  cleanup()
  state.selectedIssueId = null
  state.issues = BASE_ISSUES
  state.sessions = [] as never[]
  vi.clearAllMocks()
})

describe('issue explorer navigation', () => {
  it('caps remembered query scroll positions', () => {
    let values: number[] = []
    render(
      <IssueExplorerProvider>
        <ScrollCacheProbe onRead={(next) => (values = next)} />
      </IssueExplorerProvider>,
    )
    expect(values.slice(0, 4)).toEqual([0, 0, 0, 0])
    expect(values.slice(4)).toEqual(
      Array.from({ length: EXPLORER_SCROLL_CACHE_LIMIT }, (_, index) => index + 5),
    )
  })

  it('opens on the task list when the shell is pointing at nothing', () => {
    mount()
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
    // The trail is rooted at the list even when the list is all there is.
    expect(screen.getByTestId('explorer-crumbs').textContent).toContain('Tasks')
  })

  it('opens on the task list when the selection is an empty draft vessel (POD-1112)', () => {
    // The composer's placeholder, still selected after a reload with its session
    // never started. It is not a task the operator chose, so the explorer must
    // not open on it — the cold shell gets level 0.
    // A vessel has no checkout of its own — that is what makes it a placeholder.
    const vessel = makeIssue({
      id: 'v',
      seq: 111,
      title: 'Draft',
      stage: 'backlog',
      draft: true,
      worktreePath: null,
    })
    state.issues = [...BASE_ISSUES, vessel]
    state.selectedIssueId = 'v'
    mount('v')
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
    expect(screen.queryByTestId('detail')).toBeNull()
    expect(screen.getByTestId('explorer-crumbs').textContent).toContain('Tasks')
  })

  it('opens on a vessel that HAS its session — the composer still has a subject', () => {
    // A vessel has no checkout of its own — that is what makes it a placeholder.
    const vessel = makeIssue({
      id: 'v',
      seq: 111,
      title: 'Draft',
      stage: 'backlog',
      draft: true,
      worktreePath: null,
    })
    state.issues = [...BASE_ISSUES, vessel]
    state.sessions = [{ sessionId: 's-new', issueId: 'v', archived: false }] as never[]
    state.selectedIssueId = 'v'
    mount('v')
    expect(detail().getAttribute('data-issue-id')).toBe('v')
  })

  it('opens on the bucket that has something in it', () => {
    mount()
    // `needs` is first and non-empty here (a task in review is asking for one),
    // so the list opens there rather than on an empty In progress.
    expect(screen.getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByText('Live child')).toBeTruthy()
    expect(screen.queryByText('Someone else’s task')).toBeNull()
  })

  it('searches across every stage, ignoring the tab', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'else' } })
    expect(screen.getByText(/1 match across every stage/)).toBeTruthy()
    expect(screen.getByText('Someone else’s task')).toBeTruthy()
  })

  it('bounds a deep 674-task bucket and restores its tab scroll position', () => {
    vi.useFakeTimers()
    state.issues = Array.from({ length: 674 }, (_, index) =>
      makeIssue({
        id: `large-${index}`,
        seq: index + 1,
        title: `Large task ${index}`,
        stage: 'backlog',
      }),
    )
    const view = mount()
    const scroll = view.container.querySelector('[data-dock-scroll]') as HTMLElement
    const list = view.container.querySelector('ul[aria-label="Tasks"]') as HTMLElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 320 })
    vi.spyOn(scroll, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 320, height: 320 }) as DOMRect,
    )
    vi.spyOn(list, 'getBoundingClientRect').mockImplementation(
      () => ({ top: -scroll.scrollTop, bottom: 20_894 - scroll.scrollTop }) as DOMRect,
    )

    scroll.scrollTop = 10_000
    fireEvent.scroll(scroll)
    act(() => vi.runOnlyPendingTimers())
    expect(screen.getAllByTestId('explorer-row').length).toBeLessThanOrEqual(
      ISSUE_VIRTUAL_MAX_ITEMS,
    )
    expect(screen.getAllByRole('listitem')[0]?.getAttribute('aria-posinset')).not.toBe('1')

    fireEvent.click(screen.getByRole('tab', { name: /In Progress/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    expect(scroll.scrollTop).toBe(10_000)
  })

  it('recovers an archived task by exact ref, but not by title', () => {
    mount()
    const search = screen.getByLabelText('Search tasks')

    fireEvent.change(search, { target: { value: 'POD-766' } })
    expect(screen.getByText(/1 match across every stage/)).toBeTruthy()
    expect(screen.getByText('Minimap stale-tick crash')).toBeTruthy()
    const archivedRow = screen.getByText('Minimap stale-tick crash').closest('button')
    expect(archivedRow).toBeTruthy()
    expect(within(archivedRow as HTMLElement).getByText('archived')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'minimap' } })
    expect(screen.getByText('Nothing here by that name or ref.')).toBeTruthy()
    expect(screen.queryByText('Minimap stale-tick crash')).toBeNull()
  })

  it('opens the archived task it recovered (POD-1277)', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'POD-766' } })
    fireEvent.click(screen.getByText('Minimap stale-tick crash'))

    // A row the list offers has to open. It used to push a level the panel
    // refused, which left an empty state written for a chat with no task yet.
    expect(detail().dataset.issueId).toBe('archived')
    expect(screen.getByTestId('explorer-crumbs').textContent).toContain('archived')
  })

  it('sends a level whose task left the replica back to the index (POD-1277)', () => {
    const view = mount()
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    fireEvent.click(screen.getByText('Someone else’s task'))
    expect(detail().dataset.issueId).toBe('s')

    state.issues = [EPIC, CHILD, ARCHIVED]
    act(() => view.rerender(tree()))

    expect(screen.queryByTestId('detail')).toBeNull()
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
    expect(screen.getByTestId('explorer-crumbs').textContent).not.toContain('#9')
  })

  it('falls back to the task list when the shell has nothing left to point at (POD-1471)', () => {
    // Removing the session the deck was showing leaves the mission unresolvable.
    // The task the explorer is parked on is still perfectly alive, so "its task
    // was deleted" does not catch this — what went away is the SUBJECT, and a
    // panel still captioned with a task reads as still scoped to one.
    state.selectedIssueId = 'p'
    const view = mount('p')
    fireEvent.click(screen.getByText('deck: c'))
    expect(detail().dataset.issueId).toBe('c')

    state.selectedIssueId = null
    act(() => view.rerender(tree(null)))

    expect(screen.queryByTestId('detail')).toBeNull()
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
    expect(screen.getByTestId('explorer-crumbs').textContent).not.toContain('#2')
  })

  it('drops a deleted task while the dock is shut (POD-1471)', () => {
    // The pointer outlives the panel by design, so the rule that retires a dead
    // level has to outlive it too. This is checked on the POINTER and not on
    // what renders: the panel remounts on reopen and retires the level itself,
    // which hides the difference at exactly the moment it stops mattering.
    const view = mount()
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    fireEvent.click(screen.getByText('Someone else’s task'))
    expect(screen.getByTestId('pointer').dataset.current).toBe('s')

    // Closing the dock must NOT move the pointer — that is the explorer's
    // standing contract, and the reason the rule cannot live in the panel.
    act(() => view.rerender(tree(null, false)))
    expect(screen.getByTestId('pointer').dataset.current).toBe('s')

    // Tombstoned, not dropped: a delete lands as `deletedAt` on a row that is
    // still in the replica, and that is the half the row-count check cannot see.
    state.issues = [EPIC, CHILD, { ...STRANGER, deletedAt: 'now' }, ARCHIVED]
    act(() => view.rerender(tree(null, false)))
    expect(screen.getByTestId('pointer').dataset.current).toBe('')

    act(() => view.rerender(tree(null, true)))
    expect(screen.queryByTestId('detail')).toBeNull()
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
  })

  it('falls back to the live mission root, not to level 0, when the focused task is tombstoned (POD-1471)', () => {
    // Deleting the task the explorer is ON is not the same as having nothing to
    // point at: the mission it belonged to is still there. The tombstone drops
    // the child out of the mission index, so the subject moves child -> root in
    // the SAME commit that marks the level's task gone, and the two rules fire
    // together. Retiring the dead level must not beat the re-aim, or the panel
    // lands on the full list while the shell still points at live work.
    state.selectedIssueId = 'p'
    const view = mount('p')
    fireEvent.click(screen.getByText('deck: c'))
    expect(screen.getByTestId('pointer').dataset.current).toBe('c')

    state.issues = [EPIC, { ...CHILD, deletedAt: 'now' }, STRANGER, ARCHIVED]
    act(() => view.rerender(tree('p')))

    expect(screen.getByTestId('pointer').dataset.current).toBe('p')
    expect(detail().dataset.issueId).toBe('p')
  })

  it('re-aims when a deleted SPIN-OFF keeps its mission membership (POD-1471)', () => {
    // Membership does not always end at the grave. A child drops out of the
    // mission index when it is tombstoned, but a spin-off belongs by provenance
    // — its starting session is the root's — and that route keeps deleted rows
    // on purpose. So the subject would go on resolving to the dead task, and the
    // explorer would sit on the full list with its mission still selected.
    state.selectedIssueId = 'p'
    state.sessions = [ROOT_SESSION] as never
    const view = mount('p')
    fireEvent.click(screen.getByText('deck: spin'))
    expect(screen.getByTestId('pointer').dataset.current).toBe('spin')

    state.issues = [EPIC, CHILD, STRANGER, ARCHIVED, { ...SPINOFF, deletedAt: 'now' }]
    act(() => view.rerender(tree('p')))

    expect(screen.getByTestId('pointer').dataset.current).toBe('p')
  })

  it('sends a ref card pointed at a deleted task to the list, not to the deck (POD-1265)', () => {
    // A card in chat points the explorer WITHOUT moving the shell. If the task
    // it names is gone, the honest answer is the list — substituting whatever
    // the deck happens to be showing answers a question nobody asked.
    state.selectedIssueId = 'p'
    state.sessions = [ROOT_SESSION] as never
    const view = mount('p')
    expect(screen.getByTestId('pointer').dataset.current).toBe('p')

    state.issues = [EPIC, CHILD, ARCHIVED, SPINOFF, { ...STRANGER, deletedAt: 'now' }]
    act(() => view.rerender(tree('p')))
    fireEvent.click(screen.getByText('card: s'))

    expect(screen.getByTestId('pointer').dataset.current).toBe('')
  })

  it('rides out an empty replica with a mission selected (POD-1277)', () => {
    // The mission-scoped half of the ride-out. Without a mission the subject is
    // null on both sides of the blink, so the retarget effect short-circuits on
    // `target === lastTarget` and its own empty-replica gate is never exercised
    // — the trail would survive with or without it. Here the subject really does
    // go p -> null -> p, so only the gate keeps the trail.
    state.selectedIssueId = 'p'
    state.sessions = [ROOT_SESSION] as never
    const view = mount('p')
    fireEvent.click(screen.getByText('deck: c'))
    expect(screen.getByTestId('pointer').dataset.current).toBe('c')

    state.issues = []
    act(() => view.rerender(tree('p')))
    expect(screen.getByTestId('pointer').dataset.current).toBe('c')

    state.issues = BASE_ISSUES
    act(() => view.rerender(tree('p')))
    expect(screen.getByTestId('pointer').dataset.current).toBe('c')
  })

  it('rides out an empty replica without losing the trail (POD-1277)', () => {
    // A reconnect mid-flight empties the replica for a frame. That resolves the
    // subject to nothing and marks every level's task gone, which is exactly
    // what the two rules above act on — so both wait for the replica to have
    // content. Otherwise a blinking socket sends the operator home.
    const view = mount()
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    fireEvent.click(screen.getByText('Someone else’s task'))
    expect(detail().dataset.issueId).toBe('s')

    state.issues = []
    act(() => view.rerender(tree()))
    expect(detail().dataset.issueId).toBe('s')

    state.issues = BASE_ISSUES
    act(() => view.rerender(tree()))
    expect(detail().dataset.issueId).toBe('s')
  })

  it('pushes a task from the list and pops back to it from the trail', () => {
    mount()
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    fireEvent.click(screen.getByText('Someone else’s task'))
    expect(detail().dataset.issueId).toBe('s')
    expect(screen.getByTestId('explorer-crumbs').textContent).toContain('#9')

    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
  })

  it('walks a relation deeper and keeps the whole trail', () => {
    state.selectedIssueId = 'p'
    mount('p')
    expect(detail().dataset.issueId).toBe('p')

    fireEvent.click(screen.getByText('walk a relation'))
    expect(detail().dataset.issueId).toBe('s')
    const trail = screen.getByTestId('explorer-crumbs').textContent ?? ''
    expect(trail).toContain('#1')
    expect(trail).toContain('#9')
  })

  it('goes back FURTHER than the task that opened the detail, onto the list', () => {
    state.selectedIssueId = 'p'
    mount('p')
    // Opened by the shell at depth 1, with no list ever visited — the root
    // crumb still gets you there.
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    expect(screen.getByTestId('explorer-list')).toBeTruthy()
  })

  it('resets the chain when the deck retargets it', () => {
    state.selectedIssueId = 'p'
    mount('p')
    fireEvent.click(screen.getByText('walk a relation'))
    expect(detail().dataset.issueId).toBe('s')

    fireEvent.click(screen.getByText('deck: c'))
    expect(detail().dataset.issueId).toBe('c')
    // One step, not four: the trail describes how the operator navigated, and
    // a click in another column is not a step in it.
    const trail = screen.getByTestId('explorer-crumbs').textContent ?? ''
    expect(trail).not.toContain('#9')
  })

  it('takes a target from outside the mission without the shell moving (POD-1265)', () => {
    state.selectedIssueId = 'p'
    mount('p')
    expect(detail().dataset.issueId).toBe('p')

    // The focus route cannot land here: the stranger is not in mission `p`, so
    // `resolveFocus` discards it and the panel stays on the root. That is why
    // the ref card used to move the SELECTION — and why it no longer has to.
    fireEvent.click(screen.getByText('deck: s'))
    expect(detail().dataset.issueId).toBe('p')

    fireEvent.click(screen.getByText('card: s'))
    expect(detail().dataset.issueId).toBe('s')
    expect(state.selectedIssueId).toBe('p')
    // A reset, not a push: the card is another surface, not a step in this trail.
    expect(screen.getByTestId('explorer-crumbs').textContent).not.toContain('#1')
  })

  it('keeps tracking while the panel is closed, and reopens on what you last touched', () => {
    state.selectedIssueId = 'p'
    const view = render(
      <OperatorFocusProvider missionId="p">
        <IssueExplorerProvider>
          <Closeable />
        </IssueExplorerProvider>
      </OperatorFocusProvider>,
    )
    expect(detail().dataset.issueId).toBe('p')

    fireEvent.click(screen.getByText('close dock'))
    expect(screen.queryByTestId('detail')).toBeNull()

    // A deck click with nobody looking still moves the pointer.
    fireEvent.click(screen.getByText('deck: c'))
    fireEvent.click(screen.getByText('open dock'))
    expect(detail().dataset.issueId).toBe('c')
    view.unmount()
  })
})

/** The dock's open/close, which unmounts the panel but not the state above it. */
function Closeable(): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      <DeckClick id="c" />
      <button type="button" onClick={() => setOpen((v) => !v)}>
        {open ? 'close dock' : 'open dock'}
      </button>
      {open && <IssueExplorer cwd="/r" />}
    </>
  )
}
