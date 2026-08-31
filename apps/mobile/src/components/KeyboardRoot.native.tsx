import type { ReactNode } from 'react'
import { KeyboardProvider } from 'react-native-keyboard-controller'

/** One owner for the native keyboard frame and interactive dismissal progress. */
export function KeyboardRoot({ children }: { children: ReactNode }) {
  return <KeyboardProvider>{children}</KeyboardProvider>
}
