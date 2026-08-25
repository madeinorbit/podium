import { frame, globalProjectionState, microtask, type VisualElement } from 'motion-dom'
import {
  LayoutGroupContext,
  type MotionProps,
  SwitchLayoutGroupContext,
  usePresence,
} from 'motion/react'
import { Component, useContext, type ContextType, type JSX } from 'react'

type LayoutGroup = ContextType<typeof LayoutGroupContext>
type SwitchLayoutGroup = ContextType<typeof SwitchLayoutGroupContext>

type MeasureLayoutProps = MotionProps & {
  visualElement: VisualElement
  layoutGroup: LayoutGroup
  switchLayoutGroup?: SwitchLayoutGroup
  isPresent: boolean
  safeToRemove?: VoidFunction | null
}

/**
 * Motion does not publish layout as a standalone LazyMotion package. This is
 * its projection lifecycle without the drag package that domMax couples to it.
 */
let hasTakenSnapshot = false

class WorklistMeasureLayoutWithContext extends Component<MeasureLayoutProps> {
  override componentDidMount(): void {
    const { visualElement, layoutGroup, switchLayoutGroup, layoutId } = this.props
    const { projection } = visualElement
    if (projection) {
      layoutGroup.group?.add(projection)
      if (switchLayoutGroup?.register && layoutId) switchLayoutGroup.register(projection)
      if (hasTakenSnapshot) projection.root?.didUpdate()
      projection.addEventListener('animationComplete', () => this.safeToRemove())
      projection.setOptions({
        ...projection.options,
        layoutDependency: this.props.layoutDependency,
        onExitComplete: () => this.safeToRemove(),
      })
    }
    globalProjectionState.hasEverUpdated = true
  }

  override getSnapshotBeforeUpdate(previous: MeasureLayoutProps): null {
    const { layoutDependency, visualElement, drag, isPresent } = this.props
    const { projection } = visualElement
    if (!projection) return null

    projection.isPresent = isPresent
    if (previous.layoutDependency !== layoutDependency) {
      projection.setOptions({ ...projection.options, layoutDependency })
    }
    hasTakenSnapshot = true
    if (
      drag ||
      previous.layoutDependency !== layoutDependency ||
      layoutDependency === undefined ||
      previous.isPresent !== isPresent
    ) {
      projection.willUpdate()
    } else {
      this.safeToRemove()
    }

    if (previous.isPresent !== isPresent) {
      if (isPresent) {
        projection.promote()
      } else if (!projection.relegate()) {
        frame.postRender(() => {
          const stack = projection.getStack()
          if (!stack?.members.length) this.safeToRemove()
        })
      }
    }
    return null
  }

  override componentDidUpdate(): void {
    const { visualElement, layoutAnchor } = this.props
    const { projection } = visualElement
    if (!projection) return

    projection.options.layoutAnchor = layoutAnchor
    projection.root?.didUpdate()
    microtask.postRender(() => {
      if (!projection.currentAnimation && projection.isLead()) this.safeToRemove()
    })
  }

  override componentWillUnmount(): void {
    const { visualElement, layoutGroup, switchLayoutGroup } = this.props
    const { projection } = visualElement
    hasTakenSnapshot = true
    if (!projection) return

    projection.scheduleCheckAfterUnmount()
    layoutGroup.group?.remove(projection)
    switchLayoutGroup?.deregister?.(projection)
  }

  private safeToRemove(): void {
    this.props.safeToRemove?.()
  }

  override render(): null {
    return null
  }
}

export function WorklistMeasureLayout(
  props: MotionProps & { visualElement: VisualElement },
): JSX.Element {
  const [isPresent, safeToRemove] = usePresence()
  const layoutGroup = useContext(LayoutGroupContext)
  const switchLayoutGroup = useContext(SwitchLayoutGroupContext)
  return (
    <WorklistMeasureLayoutWithContext
      {...props}
      layoutGroup={layoutGroup}
      switchLayoutGroup={switchLayoutGroup}
      isPresent={isPresent}
      safeToRemove={safeToRemove}
    />
  )
}
