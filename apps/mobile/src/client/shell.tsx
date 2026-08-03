/**
 * THE THREE FACTS THE COMPOSITION ROOT OWNS AND THE STORE CANNOT (POD-332).
 *
 * When `MobileClientValue` was deleted, every field on it moved to the shared
 * store, a published slice, or a hub read — except these three, and they are
 * here rather than in a general-purpose adapter BECAUSE they are not store
 * state:
 *
 *  - `error` is the store's FATAL error, delivered through `StoreProvider`'s
 *    `onFatalError` callback. It is a message the provider is handed, not a
 *    field it can read back off a snapshot.
 *  - `notice` is the STORAGE degradation channel (ADR 6 D4.4's never-silent
 *    posture): a degraded SQLite store, a legacy migration that could not carry
 *    queued work across, a discarded cursor. All three are produced while the
 *    replica is being ASSEMBLED — before a store exists at all.
 *  - `eraseLocalData` erases this principal's SQLite + AsyncStorage namespace.
 *    It belongs to the assembly that opened them, and sign-out must be able to
 *    call it after the store is gone.
 *
 * It is deliberately not a place to put anything else. A field that CAN be read
 * off the store or a slice belongs there — that is the whole point of the
 * deletion this module survived, and the test in `mobile-shell.test.tsx` pins
 * the membership so a fourth field is an argued change rather than a drift.
 */
import { createContext, type ReactNode, useContext } from 'react'

export interface MobileShell {
  /** Fatal store error, or null. Rendered as a screen-local strip. */
  readonly error: string | null
  /** Storage degradation / migration loss the user is owed, or null. */
  readonly notice: string | null
  /** Default sign-out policy: erase this principal's complete local namespace. */
  eraseLocalData(): Promise<void>
}

const ShellContext = createContext<MobileShell | null>(null)

export function MobileShellProvider({
  value,
  children,
}: {
  value: MobileShell
  children: ReactNode
}) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

/** The composition root's own three facts. Throws outside the provider, the
 *  same fail-loud posture `useStore` takes. */
export function useMobileShell(): MobileShell {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useMobileShell must be used inside MobileClientProvider')
  return value
}
