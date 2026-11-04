import { createContext, useContext } from 'react'

export const AccountContext = createContext<{ signOut(): Promise<void> } | null>(null)
export const useAccount = () => useContext(AccountContext)

/** Ends this tab's signed-in runtime: LoginGate drops it and asks the server who is signed in. */
export const SYNC_AUTH_EXPIRED_EVENT = 'podium:sync-auth-expired'

/**
 * End the runtime bound to `principal` (its replica namespace key). The event
 * names its account so a late refusal from an account that is already gone, such
 * as a request still in flight from before a switch, cannot end the next one's
 * sign-in (POD-6292).
 */
export function expireSignedInRuntime(principal: string): void {
  window.dispatchEvent(new CustomEvent(SYNC_AUTH_EXPIRED_EVENT, { detail: { principal } }))
}

/** The account an expiry event names, if it names one. */
export function expiredPrincipalOf(event: Event): string | undefined {
  const detail = (event as CustomEvent<{ principal?: unknown } | null>).detail
  return typeof detail?.principal === 'string' ? detail.principal : undefined
}
