import { LayoutGroup, LazyMotion, MotionConfig } from 'motion/react'
import type { JSX, ReactNode } from 'react'

const loadWorklistMotionFeatures = () =>
  import('./worklist-motion-features').then((module) => module.default)

/**
 * One lazy feature boundary for every animated worklist row and fold. `strict`
 * rejects a full `motion` component below this boundary during development.
 */
export function WorklistMotion({
  layoutGroupId,
  children,
}: {
  layoutGroupId: string
  children: ReactNode
}): JSX.Element {
  return (
    <LazyMotion features={loadWorklistMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <LayoutGroup id={layoutGroupId}>{children}</LayoutGroup>
      </MotionConfig>
    </LazyMotion>
  )
}
