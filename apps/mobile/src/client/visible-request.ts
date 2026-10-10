import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { AppState } from 'react-native'

/** Native focus owns the caller; app/document visibility owns refresh demand. */
export function followPhoneRequest(load: () => void): () => void {
  return followVisibleRequest(load, {
    visible: () => typeof document === 'undefined'
      ? AppState.currentState === 'active' || AppState.currentState == null
      : document.visibilityState !== 'hidden',
    subscribe: changed => {
      const subscription = AppState.addEventListener('change', changed)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', changed)
      return () => {
        subscription.remove()
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', changed)
      }
    },
  })
}
