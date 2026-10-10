import type { ClockWakeSource } from '@podium/mobx-helpers'
import { AppState } from 'react-native'

export const platformClockWakeSource: ClockWakeSource = {
  isActive: () => AppState.currentState === 'active',
  subscribe(wake) {
    const subscription = AppState.addEventListener('change', wake)
    return () => subscription.remove()
  },
}
