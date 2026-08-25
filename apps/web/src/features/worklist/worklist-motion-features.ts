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
  private unmountControls?: VoidFunction

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

  override mount(): void {
    this.updateAnimationControlsSubscription()
  }

  override update(): void {
    const { animate } = this.node.getProps()
    const { animate: previousAnimate } = this.node.prevProps ?? {}
    if (animate !== previousAnimate) this.updateAnimationControlsSubscription()
  }

  override unmount(): void {
    this.node.animationState?.reset()
    this.unmountControls?.()
  }
}

type AnimationFeatureClass = NonNullable<
  NonNullable<FeatureBundle['animation']>['Feature']
>

const createWorklistVisualElement: CreateVisualElement = (Component, options) =>
  new HTMLVisualElement(options, {
    allowProjection: Component !== Fragment,
  })

const worklistMotionFeatures = {
  animation: {
    // Motion types the public Feature constructor with unknown, while its base
    // class constructor requires the VisualElement passed here at runtime.
    Feature: WorklistAnimationFeature as AnimationFeatureClass,
  },
  layout: {
    ProjectionNode: HTMLProjectionNode,
    MeasureLayout: WorklistMeasureLayout,
  },
  renderer: createWorklistVisualElement,
} satisfies FeatureBundle

export default worklistMotionFeatures
