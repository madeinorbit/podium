import { createContext } from 'react'

// UI-only dependency of the mobile root. The connection fixture renders its
// state into a pre element, so no safe-area provider participates in the proof.
const insets = { top: 0, right: 0, bottom: 0, left: 0 }
export const SafeAreaInsetsContext = createContext(insets)
export function useSafeAreaInsets() {
  return insets
}
