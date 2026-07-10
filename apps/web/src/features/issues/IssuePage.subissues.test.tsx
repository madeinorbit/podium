// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuePage } from './IssuePage'
import { makeIssue } from './test-issue'

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
      issues: [PARENT, CHILD_LIVE, CHILD_ARCHIVED],
      setSelectedWorktree: vi.fn(),
      setPane: vi.fn(),
      setView: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    // Selector hooks (useStoreSelector) reach the same mocked state.
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

afterEach(cleanup)

describe('IssuePage sub-issue list (#133)', () => {
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
})
