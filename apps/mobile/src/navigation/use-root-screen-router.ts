import { useRouter } from 'expo-router'
import { NavigationContainerRefContext } from 'expo-router/build/react-navigation/core/NavigationContainerRefContext'
import { use, useMemo } from 'react'
import { rootScreenRouter } from './root-screen-router'

/** Use the existing root navigation state without subscribing screens to it. */
export function useRootScreenRouter() {
  const router = useRouter()
  const navigation = use(NavigationContainerRefContext)
  return useMemo(() => rootScreenRouter(router, navigation), [router, navigation])
}
