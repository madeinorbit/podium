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
      seedPoolFixture([props.issue])
      return createElement(controls.IssueCompactControls, props)
    },
  }
})
