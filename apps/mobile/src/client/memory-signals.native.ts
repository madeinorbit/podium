import type { MemorySignals } from '@podium/sync/replica'
import { AppState, InteractionManager } from 'react-native'

/** An idle moment on the phone: once interactions and animations are done, and the JS thread had a beat. */
const IDLE_AFTER_INTERACTIONS_MS = 500

/**
 * When the phone's memory may let go of the screens left (POD-7161, design
 * POD-7157 "When it shrinks"): after interactions settle, when the app goes
 * to the background, and on the platform's memory warning (iOS; Android
 * reports none through AppState, and its background covers the same need).
 */
export const platformMemorySignals: MemorySignals = {
  requestIdle(run) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(run, IDLE_AFTER_INTERACTIONS_MS)
    })
    return () => {
      task.cancel()
      if (timer !== undefined) clearTimeout(timer)
    }
  },
  subscribe(listener) {
    const change = AppState.addEventListener('change', (state) => {
      if (state === 'background') listener('background')
    })
    const warning = AppState.addEventListener('memoryWarning', () => listener('memoryWarning'))
    return () => {
      change.remove()
      warning.remove()
    }
  },
}
