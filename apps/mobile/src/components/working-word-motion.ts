import { AppState } from 'react-native'
import {
  cancelAnimation,
  Easing,
  makeMutable,
  ReduceMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

// The desktop deck's 2.2s glint, shared by every visible mobile working word.
export const workingWordProgress = makeMutable(0)
let users = 0
let running = false
let subscription: { remove(): void } | undefined

function reconcile() {
  const active = users > 0 && AppState.currentState === 'active'
  if (active === running) return
  running = active
  cancelAnimation(workingWordProgress)
  workingWordProgress.set(0)
  if (active) {
    workingWordProgress.set(
      withRepeat(
        withTiming(1, {
          duration: 2200,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        false,
        undefined,
        ReduceMotion.System,
      ),
    )
  }
}

/** Focused words subscribe once. Frames never cross into JS or React. */
export function subscribeWorkingWord(): () => void {
  if (++users === 1) subscription = AppState.addEventListener('change', reconcile)
  reconcile()
  return () => {
    if (--users === 0) {
      subscription?.remove()
      subscription = undefined
      reconcile()
    }
  }
}
