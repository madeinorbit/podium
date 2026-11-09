import { compareStructural, reaction } from 'mobx'
import type { NavigationProvider } from '../../navigation-provider'

/** Retain only this policy's addressed pool reads. Rebind before releasing the
 * old watch, so lazy navigation answers survive a provider/selection change. */
export function observeNavigation(
  navigation: () => NavigationProvider,
  read: () => readonly unknown[],
  changed: () => void,
  replaced?: (provider: NavigationProvider) => void,
): () => void {
  let stopRead: (() => void) | undefined
  const stopProvider = reaction(
    navigation,
    (provider) => {
      replaced?.(provider)
      const previous = stopRead
      stopRead = provider.watch
        ? provider.watch(read, changed)
        : reaction(read, changed, { equals: compareStructural })
      previous?.()
      changed()
    },
    { fireImmediately: true },
  )
  return () => {
    stopProvider()
    stopRead?.()
  }
}
