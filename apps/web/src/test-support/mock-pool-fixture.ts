import { vi } from 'vitest'

vi.mock('@/features/worklist/worklist-motion', async () => {
  const { createElement } = await import('react')
  const { LayoutGroup, LazyMotion, MotionConfig } = await import('motion/react')
  const { default: features } = await import('@/features/worklist/worklist-motion-features')
  return {
    WorklistMotion: ({ children, layoutGroupId }: { children: import('react').ReactNode; layoutGroupId: string }) =>
      createElement(LazyMotion, { features, strict: true },
        createElement(MotionConfig, { reducedMotion: 'always' },
          createElement(LayoutGroup, { id: layoutGroupId }, children))),
  }
})

vi.mock('@/app/store-worklist-pool', async () => ({
  ...(await import('./pool-fixture')).fixturePoolHooks,
}))
