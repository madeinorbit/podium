import { type ReactNode, useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import {
  ReduceMotion,
  ReducedMotionConfig,
  useReducedMotion,
} from 'react-native-reanimated'
import { ReducedMotionContext } from './useReduceMotion'

export function ReducedMotionProvider({ children }: { children: ReactNode }) {
  const reduceMotionAtLaunch = useReducedMotion()
  const [reduceMotion, setReduceMotion] = useState(reduceMotionAtLaunch)

  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => subscription.remove()
  }, [])

  return (
    <ReducedMotionContext.Provider value={reduceMotion}>
      <ReducedMotionConfig mode={reduceMotion ? ReduceMotion.Always : ReduceMotion.Never} />
      {children}
    </ReducedMotionContext.Provider>
  )
}
