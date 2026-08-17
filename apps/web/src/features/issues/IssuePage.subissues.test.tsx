// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'

const PARENT = makeIssue({
  id: 'p',
  repoPath: '/r',
  seq: 1,
  title: 'Epic',
  childCount: 2,
  childDoneCount: 0,
})
const CHILD_LIVE = makeIssue({
  id: 'c-live',
  repoPath: '/r',
  seq: 2,
  title: 'Live child',
  parentId: 'p',
})
const CHILD_ARCHIVED = makeIssue({
  id: 'c-arch',
  repoPath: '/r',
  seq: 3,
  title: 'Archived child',
  parentId: 'p',
  archived: true,
})

let mockIssues = [PARENT, CHILD_LIVE, CHILD_ARCHIVED]

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: {
          get: { query: vi.fn(async () => ({ gitWorkflow: { mergeStyle: 'ff-only' } })) },
        },
        issues: {
          events: { query: vi.fn(async () => []) },
          addSession: { mutate: vi.fn() },
          addShell: { mutate: vi.fn() },
          start: { mutate: vi.fn() },
          update: { mutate: vi.fn() },
          addComment: { mutate: vi.fn() },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      issues: mockIssues,
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    // Selector hooks (useStoreSelector) reach the same mocked state.
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => (state() as unknown as { issues: never[] }).issues,
  }
})

afterEach(() => {
  mockIssues = [PARENT, CHILD_LIVE, CHILD_ARCHIVED]
  cleanup()
})

describe('IssuePage sub-issue list (#133)', () => {
  it('keeps an archived parent visible on the child, marked archived', () => {
    mockIssues = [{ ...PARENT, archived: true, stage: 'done' }, CHILD_LIVE]
    render(
      <IssuePage
        issue={CHILD_LIVE}
        orderedIds={[CHILD_LIVE.id]}
        onBack={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )
    expect(screen.getAllByRole('button', { name: /Epic/ }).length).toBeGreaterThan(0)
    const marks = screen.getAllByTestId('issue-edge-archived')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.every((el) => el.textContent === 'archived')).toBe(true)
    // The empty parent trigger, addressed by its label rather than its word —
    // an archived parent still RESOLVES, so the row must not fall back to it.
    expect(screen.queryByRole('button', { name: 'Set parent' })).toBeNull()
  })

  it('keeps an archived child visible under the parent, marked archived', () => {
    render(
      <IssuePage issue={PARENT} orderedIds={[PARENT.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
    )
    const list = screen.getByTestId('sub-issues')
    // Both children render — the archived one is NOT dropped.
    expect(within(list).getByText('Live child')).toBeTruthy()
    const archivedRow = within(list).getByText('Archived child').closest('button')
    expect(archivedRow).toBeTruthy()
    // ...and it is visibly marked archived.
    expect(within(archivedRow as HTMLElement).getByText('archived')).toBeTruthy()
  })

  it('keeps archived done children visible on a finished parent', () => {
    const doneParent = { ...PARENT, stage: 'done' as const, childCount: 1, childDoneCount: 1 }
    const doneArchived = {
      ...CHILD_ARCHIVED,
      stage: 'done' as const,
      closedReason: 'done' as const,
    }
    mockIssues = [doneParent, doneArchived]
    render(
      <IssuePage
        issue={doneParent}
        orderedIds={[doneParent.id]}
        onBack={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )
    const list = screen.getByTestId('sub-issues')
    const archivedRow = within(list).getByText('Archived child').closest('button')
    expect(archivedRow).toBeTruthy()
    expect(within(archivedRow as HTMLElement).getByText('archived')).toBeTruthy()
  })
})
