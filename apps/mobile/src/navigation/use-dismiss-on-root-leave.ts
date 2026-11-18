import { NavigationContainerRefContext } from 'expo-router/build/react-navigation/core/NavigationContainerRefContext'
import { use, useEffect, useEffectEvent } from 'react'
import { isRootSheetRoute } from './root-screen-router'

/** Dismiss local modals when a full-screen route leaves their presenting page. */
export function useDismissOnRootLeave(dismiss: () => void, visible = true) {
  const navigation = use(NavigationContainerRefContext)
  const onLeave = useEffectEvent(dismiss)
  useEffect(() => {
    if (!navigation || !visible) return
    const initial = navigation.getRootState()
    const ownerKey = initial?.routes[initial.index]?.key
    if (!ownerKey) return
    let left = false
    return navigation.addListener('state', () => {
      const state = navigation.getRootState()
      const focused = state?.routes[state.index]
      // Native pickers, backgrounding, nested tab navigation and presenting
      // another sheet must not dismiss the form or discard its draft.
      if (!left && focused && focused.key !== ownerKey && !isRootSheetRoute(focused.name)) {
        left = true
        onLeave()
      }
    })
  }, [navigation, visible])
}
