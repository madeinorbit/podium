import { asIssueId, type IssueWire } from '@podium/model'
import { cleanup, render } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import type { FlatListProps as NativeFlatListProps } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FlatListProps = NativeFlatListProps<IssueWire>
let captured: FlatListProps | undefined

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))

vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    children,
    footer,
    virtualizedContent,
  }: {
    children?: ReactNode
    footer?: ReactNode
    virtualizedContent?: (scrollEnabled: boolean) => ReactNode
  }) => (
    <>
      {virtualizedContent?.(true) ?? children}
      {footer}
    </>
  ),
}))

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  const CapturingFlatList = (props: FlatListProps) => {
    captured = props
    return null
  }
  return { ...actual, FlatList: CapturingFlatList as ComponentType<FlatListProps> }
})

const { IssueTargetSheet, filterIssueTargets } = await import('./IssueTargetSheet')

afterEach(() => {
  captured = undefined
  cleanup()
})

const candidate = (index: number): IssueWire =>
  ({
    id: asIssueId(`issue-${index}`),
    seq: index,
    displayRef: `POD-${index}`,
    repoPath: '/repo',
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
  }) as IssueWire

describe('IssueTargetSheet scale boundary', () => {
  it('hands hundreds of variable-height candidates to a bounded virtualized list', () => {
    const issues = Array.from({ length: 600 }, (_, index) => candidate(index))
    render(
      <IssueTargetSheet
        visible
        title="Parent"
        issues={issues}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )

    expect(captured?.data).toHaveLength(600)
    expect(captured?.initialNumToRender).toBeLessThan(600)
    expect(captured?.maxToRenderPerBatch).toBeLessThan(600)
    expect(captured?.windowSize).toBeLessThan(600)
    expect(captured?.scrollEnabled).toBe(true)
    expect(captured?.keyExtractor?.(issues[417]!, 417)).toBe('issue-417')
    expect(captured?.getItemLayout).toBeUndefined()
  })

  it('filters the large candidate set by safe title and display ref text', () => {
    const issues = Array.from({ length: 600 }, (_, index) => candidate(index))
    expect(filterIssueTargets(issues, 'Candidate 417').map((issue) => issue.id)).toEqual([
      'issue-417',
    ])
    expect(filterIssueTargets(issues, '#599').map((issue) => issue.id)).toEqual(['issue-599'])
    expect(filterIssueTargets(issues, 'pod 417').map((issue) => issue.id)).toEqual(['issue-417'])
  })

  it('keeps the pinned Cancel control above the home indicator', () => {
    const { getByRole } = render(
      <IssueTargetSheet
        visible
        title="Parent"
        issues={[]}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )

    const cancel = getByRole('button', { name: 'Cancel' })
    expect((cancel.parentElement as HTMLElement).style.paddingBottom).toBe('46px')
  })
})
