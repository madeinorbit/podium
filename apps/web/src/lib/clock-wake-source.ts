import type { ClockWakeSource } from '@podium/mobx-helpers'

/** Browser events belong to the app, not the platform-free scheduler. */
export const browserClockWakeSource: ClockWakeSource = {
  isActive: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe(wake) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
    window.addEventListener('focus', wake)
    window.addEventListener('pageshow', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      window.removeEventListener('focus', wake)
      window.removeEventListener('pageshow', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  },
}
