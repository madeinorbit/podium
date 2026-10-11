import { AppState } from 'react-native'
import type { Picture } from '@podium/working-mark'
import { createWorkingMarkClock } from './working-mark-clock'

let clock: ReturnType<typeof createWorkingMarkClock> | undefined
let users = 0
let subscriptions: { remove(): void }[] = []

/** Screen focus and reduced motion gate subscriptions in WorkingMark.native. */
export function subscribeWorkingMark(paint: (picture: Picture) => void): () => void {
  if (!clock) {
    clock = createWorkingMarkClock()
    clock.setActive(AppState.currentState == null || AppState.currentState === 'active')
    subscriptions = [
      AppState.addEventListener('change', state => clock?.setActive(state === 'active')),
      AppState.addEventListener('blur', () => clock?.setFocused(false)),
      AppState.addEventListener('focus', () => clock?.setFocused(true)),
    ]
  }
  users++
  const stop = clock.subscribe(paint)
  return () => {
    stop()
    if (--users === 0) {
      for (const subscription of subscriptions) subscription.remove()
      subscriptions = []
      clock = undefined
    }
  }
}

/** Root touch handling wakes the clock without becoming the gesture responder. */
export const noteWorkingMarkInput = () => clock?.wake()
export function useWorkingMarkMotion(): void {}
