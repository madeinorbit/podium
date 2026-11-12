import { tetra } from '@podium/working-mark/designs'
import { AppState } from 'react-native'
import {
  cancelAnimation,
  Easing,
  makeMutable,
  ReduceMotion,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

// All focused, motion-enabled marks share this UI-runtime clock.
export const workingMarkProgress = makeMutable(0)
let users = 0
let running = false
let subscription: { remove(): void } | undefined

function reconcile() {
  const active = users > 0 && AppState.currentState !== 'background'
  if (active === running) return
  running = active
  cancelAnimation(workingMarkProgress)
  workingMarkProgress.set(tetra.rest ?? 0)
  if (active) {
    workingMarkProgress.set(
      withRepeat(
        withTiming(1, {
          duration: tetra.loop,
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

/** Called only by focused marks that have not opted out of motion. */
export function subscribeWorkingMark(): () => void {
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
