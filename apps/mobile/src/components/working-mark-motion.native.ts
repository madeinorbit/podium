import { AppState } from 'react-native'
import type { Picture } from '@podium/working-mark'
import { createWorkingMarkClock } from './working-mark-clock'

let clock: ReturnType<typeof createWorkingMarkClock> | undefined
let users = 0
let subscription: { remove(): void } | undefined

/** Screen focus and reduced motion gate subscriptions in WorkingMark.native; only the background stops the clock. */
export function subscribeWorkingMark(paint: (picture: Picture) => void): () => void {
  if (!clock) {
    clock = createWorkingMarkClock()
    clock.setActive(AppState.currentState !== 'background')
    subscription = AppState.addEventListener('change', state => clock?.setActive(state !== 'background'))
  }
  users++
  const stop = clock.subscribe(paint)
  return () => {
    stop()
    if (--users === 0) {
      subscription?.remove()
      subscription = undefined
      clock = undefined
    }
  }
}
