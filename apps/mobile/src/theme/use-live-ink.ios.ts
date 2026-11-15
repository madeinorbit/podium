import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { adaptiveColor, appearancePalette, color } from './theme'

/** Some native text/image consumers cache a resolved semantic foreground. Give
 * them a changed prop on appearance updates even beneath a memoized parent.
 * Keep Increase Contrast native, and leave explicit signal colors unchanged. */
export function useLiveInk(ink: string): string {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  return useMemo(() => {
    const slot =
      ink === color.text || ink === color.body
        ? 'text'
        : ink === color.textDim || ink === color.label
          ? 'dim'
          : null
    if (slot === null) return ink
    const value = appearancePalette[scheme][slot]
    const contrast = scheme === 'dark' ? appearancePalette.light.bg : appearancePalette.light.text
    return adaptiveColor(value, value, contrast, contrast)
  }, [ink, scheme])
}
