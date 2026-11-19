import { type Href, router } from 'expo-router'

/**
 * Opt-in browser-test hook (POD-7177): `?e2e=1` on the phone web build exposes
 * `globalThis.__podiumPhoneRouter`, the same imperative router a tap calls
 * (`router.push` from a Work row, `router.back` from Done). Probes and browser
 * tests move through the app with it instead of writing `history` themselves:
 * an entry pushed behind the router's back is an entry the router does not
 * hold, and the following popstate is not what a tap does. Off by default, as
 * `?e2e=1` is for the terminal's test API.
 */
export type PhoneRouterHook = {
  push(href: string): void
  navigate(href: string): void
  back(): void
  canGoBack(): boolean
}

export function installE2eRouterHook(): void {
  if (typeof window === 'undefined') return
  if (new URLSearchParams(window.location.search).get('e2e') !== '1') return
  const hook: PhoneRouterHook = {
    push: (href) => router.push(href as Href),
    navigate: (href) => router.navigate(href as Href),
    back: () => router.back(),
    canGoBack: () => router.canGoBack(),
  }
  ;(globalThis as { __podiumPhoneRouter?: PhoneRouterHook }).__podiumPhoneRouter = hook
}
