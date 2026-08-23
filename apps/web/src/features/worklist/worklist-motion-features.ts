import {
  createAnimationState,
  Feature,
  HTMLProjectionNode,
  HTMLVisualElement,
  isAnimationControls,
  type VisualElement,
} from 'motion-dom'
import { type CreateVisualElement, type FeatureBundle } from 'motion/react'
import { Fragment } from 'react'
import { WorklistMeasureLayout } from './worklist-motion-layout'

/**
 * The worklist only animates values and projects layout. Building these
 * packages locally keeps Motion's gesture and drag implementations out of the
 * lazy chunk; selecting the same keys from domMax would still import them.
 */
class WorklistAnimationFeature extends Feature {
  constructor(node: VisualElement) {
    super(node)
    node.animationState ||= createAnimationState(node)
  }

  private updateAnimationControlsSubscription(): void {
    const { animate } = this.node.getProps()
    if (isAnimationControls(animate)) {
      this.unmountControls = animate.subscribe(this.node)
    }
  }

  mount(): void {
    this.updateAnimationControlsSubscription()
  }

  update(): void {
    const { animate } = this.node.getProps()
    const { animate: previousAnimate } = this.node.prevProps ?? {}
    if (animate !== previousAnimate) this.updateAnimationControlsSubscription()
  }

  unmount(): void {
    this.node.animationState?.reset()
    this.unmountControls?.()
  }
}

const createWorklistVisualElement: CreateVisualElement = (Component, options) =>
  new HTMLVisualElement(options, {
    allowProjection: Component !== Fragment,
  })

const worklistMotionFeatures = {
  animation: { Feature: WorklistAnimationFeature },
  layout: {
    ProjectionNode: HTMLProjectionNode,
    MeasureLayout: WorklistMeasureLayout,
  },
  renderer: createWorklistVisualElement,
} satisfies FeatureBundle

export default worklistMotionFeatures
