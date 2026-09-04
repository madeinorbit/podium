import { createContext, useContext } from 'react'

export const ReducedMotionContext = createContext(false)

/**
 * Whether the operator has asked the system for less motion.
 *
 * RootLayoutShell owns the platform subscription so every consumer sees the
 * same value before its first render and when the system setting changes.
 */
export function useReduceMotion(): boolean {
  return useContext(ReducedMotionContext)
}
