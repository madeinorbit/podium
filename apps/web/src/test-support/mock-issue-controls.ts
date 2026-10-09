import { vi } from 'vitest'

/** Historical controls tests supply their own issue as a prop. Seed that row
 * at the fixture boundary so the controls exercise the shared model's rule. */
vi.mock('@/features/issues/IssueCompactControls', async (original) => {
  const controls = await original<typeof import('@/features/issues/IssueCompactControls')>()
  const { createElement } = await import('react')
  const { seedPoolFixture } = await import('./pool-fixture')
  return {
    ...controls,
    IssueCompactControls: (props: Parameters<typeof controls.IssueCompactControls>[0]) => {
      // Older close-guard fixtures name children only through their counts.
      // Supply the underlying records at the same fixture boundary.
      const children = Array.from({ length: props.issue.childCount ?? 0 }, (_, index) => ({
        ...props.issue,
        id: `${props.issue.id}:fixture-child:${index}`,
        parentId: props.issue.id,
        stage: index < (props.issue.childDoneCount ?? 0) ? 'done' : 'in_progress',
        childCount: 0,
        childDoneCount: 0,
      }))
      seedPoolFixture([props.issue, ...children])
      return createElement(controls.IssueCompactControls, props)
    },
  }
})
