import { LayoutGroup, LazyMotion, MotionConfig } from 'motion/react'
import { createContext, type JSX, type ReactNode, useContext } from 'react'

const loadWorklistMotionFeatures = () =>
  import('./worklist-motion-features').then((module) => module.default)
const WorklistMotionContext = createContext(false)

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
  // Keep the scrolling ancestor and its rows in the same lazy feature boundary,
  // so row projection can account for the ancestor's layoutScroll offset.
  if (useContext(WorklistMotionContext)) return <LayoutGroup id={layoutGroupId}>{children}</LayoutGroup>
  return (
    <LazyMotion features={loadWorklistMotionFeatures} strict>
      <WorklistMotionContext.Provider value={true}>
      <MotionConfig reducedMotion="user">
        <LayoutGroup id={layoutGroupId}>{children}</LayoutGroup>
      </MotionConfig>
      </WorklistMotionContext.Provider>
    </LazyMotion>
  )
}
