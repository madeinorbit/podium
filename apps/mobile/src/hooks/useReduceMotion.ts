import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/**
 * Whether the operator has asked the system for less motion.
 *
 * Works on both targets: native reads the OS switch, and react-native-web maps
 * it onto `prefers-reduced-motion`, listener included.
 *
 * Starts `false` and corrects on the first tick rather than blocking a render —
 * the query is a promise, and the worst case is one animated transition before
 * the answer lands.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduce(value)
      })
      .catch(() => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      alive = false
      sub?.remove()
    }
  }, [])

  return reduce
}
