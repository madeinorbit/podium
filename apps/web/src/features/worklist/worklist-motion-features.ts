import { domMax, type FeatureBundle } from 'motion/react'

/**
 * Worklist motion is transforms, opacity, height, and layout projection. Keep
 * this explicit pick narrow even if domMax gains more features.
 */
const { animation, layout, renderer } = domMax

const worklistMotionFeatures = {
  animation,
  layout,
  renderer,
} satisfies FeatureBundle

export default worklistMotionFeatures
