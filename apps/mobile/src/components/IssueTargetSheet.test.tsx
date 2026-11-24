import type { IssueViewModel } from '@podium/client-core/replica'
import { createReaderIndex } from '@podium/client-graph/shared/reader-questions'
import { asIssueId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import type { FlatListProps as NativeFlatListProps } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FlatListProps = NativeFlatListProps<string>
let captured: FlatListProps | undefined

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))

vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    children,
    head,
    footer,
    virtualizedContent,
  }: {
    children?: ReactNode
    head?: ReactNode
    footer?: ReactNode
    virtualizedContent?: (scrollEnabled: boolean) => ReactNode
  }) => (
    <>
      {head}
      {virtualizedContent?.(true) ?? children}
      {footer}
    </>
  ),
}))

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  const CapturingFlatList = (props: FlatListProps) => {
    captured = props
    const Empty = props.ListEmptyComponent
    return (
      <div data-testid="target-list">
        {props.data?.length ? null : typeof Empty === 'function' ? <Empty /> : Empty}
      </div>
    )
  }
  return { ...actual, FlatList: CapturingFlatList as ComponentType<FlatListProps> }
})

const { IssueTargetSheet, issueTargetFooterPadding } = await import('./IssueTargetSheet')

afterEach(() => {
  captured = undefined
  cleanup()
})

const candidate = (index: number): IssueViewModel =>
  ({
    id: asIssueId(`issue-${index}`),
    seq: index,
    displayRef: `POD-${index}`,
    repoPath: '/repo',
    repoId: 'repo',
    title: `Candidate ${index}`,
    description: '',
    stage: 'backlog',
    priority: 2,
    type: 'task',
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    blocked: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
  }) as unknown as IssueViewModel

describe('IssueTargetSheet scale boundary', () => {
  it('keeps the loading row inside the open picker and swaps it for the empty result in place', () => {
    const props = {
      visible: true,
      title: 'Parent',
      ids: [],
      query: '',
      onQueryChange: () => {},
      onEndReached: () => {},
      onPick: () => {},
      onClose: () => {},
    }
    const view = render(<IssueTargetSheet {...props} loading />)
    const list = screen.getByTestId('target-list')
    const search = screen.getByRole('textbox', { name: 'Search parent' })
    expect(list.contains(screen.getByLabelText('Loading tasks'))).toBe(true)
    expect(list.contains(search)).toBe(false)
    expect(screen.queryByText('No matching tasks.')).toBeNull()
    expect(captured?.onEndReached).toBeUndefined()

    view.rerender(<IssueTargetSheet {...props} loading={false} />)
    expect(screen.getByTestId('target-list')).toBe(list)
    expect(screen.getByRole('textbox', { name: 'Search parent' })).toBe(search)
    expect(screen.queryByLabelText('Loading tasks')).toBeNull()
    expect(list.contains(screen.getByText('No matching tasks.'))).toBe(true)
    expect(captured?.onEndReached).toBe(props.onEndReached)
  })

  it('hands hundreds of variable-height candidates to a bounded virtualized list', () => {
    const issues = Array.from({ length: 600 }, (_, index) => candidate(index))
    render(
      <IssueTargetSheet
        visible
        title="Parent"
        ids={issues.map((issue) => issue.id)}
        query=""
        onQueryChange={() => {}}
        onEndReached={() => {}}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )

    expect(captured?.data).toHaveLength(600)
    expect(captured?.initialNumToRender).toBeLessThan(600)
    expect(captured?.maxToRenderPerBatch).toBeLessThan(600)
    expect(captured?.windowSize).toBeLessThan(600)
    expect(captured?.scrollEnabled).toBe(true)
    expect(captured?.keyExtractor?.(issues[417]!.id, 417)).toBe('issue-417')
    expect(captured?.getItemLayout).toBeUndefined()
  })

  it('filters the large candidate set by safe title and display ref text', () => {
    const issues = Array.from({ length: 600 }, (_, index) => candidate(index))
    const index = createReaderIndex()
    index.apply({
      type: 'replace',
      rows: issues.map((issue) => ({ kind: 'issue', id: issue.id, value: issue as never })),
    })
    const matches = (query: string) =>
      index.ids({
        kind: 'mobileIssueTargets',
        repoPath: '/repo',
        excludeId: 'owner',
        query,
        limit: 600,
        prefixes: { repo: 'POD' },
      })
    expect(matches('Candidate 417')).toEqual(['issue-417'])
    expect(matches('#599')).toEqual(['issue-599'])
    expect(matches('pod 417')).toEqual(['issue-417'])
  })

  it('clears the home indicator without double-paying it above the keyboard', () => {
    expect(issueTargetFooterPadding(34, 0)).toBe(46)
    expect(issueTargetFooterPadding(34, 280)).toBe(12)
  })
})
