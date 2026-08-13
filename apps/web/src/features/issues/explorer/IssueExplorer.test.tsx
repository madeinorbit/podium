// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const BASE_ISSUES = [EPIC, CHILD, STRANGER, ARCHIVED]

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

function mount(missionId: string | null = null, dockOpen = true): ReturnType<typeof render> {
  return render(
    <OperatorFocusProvider missionId={missionId}>
      <IssueExplorerProvider>
        <DeckClick id="c" />
        <DeckClick id="s" />
        <IssueExplorerCrumbs />
        {dockOpen && <IssueExplorer cwd="/r" />}
      </IssueExplorerProvider>
    </OperatorFocusProvider>,
  )
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

    fireEvent.click(screen.getByRole('tab', { name: /In progress/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/ }))
    expect(scroll.scrollTop).toBe(10_000)
  })

  it('recovers an archived task by exact ref, but not by title', () => {
    mount()
    const search = screen.getByLabelText('Search tasks')

    fireEvent.change(search, { target: { value: 'POD-766' } })
    expect(screen.getByText(/1 match across every stage/)).toBeTruthy()
    expect(screen.getByText('Minimap stale-tick crash')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'minimap' } })
    expect(screen.getByText('Nothing here by that name or ref.')).toBeTruthy()
    expect(screen.queryByText('Minimap stale-tick crash')).toBeNull()
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
