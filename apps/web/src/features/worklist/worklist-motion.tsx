import { type HTMLMotionProps, LayoutGroup, LazyMotion, MotionConfig } from 'motion/react'
import * as m from 'motion/react-m'
import type { JSX, ReactNode, Ref } from 'react'

const loadWorklistMotionFeatures = () =>
  import('./worklist-motion-features').then((module) => module.default)

/** Projection must subtract this scroll offset when virtual rows enter/leave.
 * Otherwise mounting a buffered row can translate the whole group as though
 * the reader's scroll were a layout change. */
export function WorklistScroll(props: HTMLMotionProps<'div'> & { ref?: Ref<HTMLDivElement> }): JSX.Element {
  return <LazyMotion features={loadWorklistMotionFeatures} strict><m.div {...props} layoutScroll /></LazyMotion>
}

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
