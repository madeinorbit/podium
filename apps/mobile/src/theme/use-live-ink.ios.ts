import { useMemo } from 'react'
import { type DynamicColorIOS, useColorScheme } from 'react-native'
import { adaptiveColor, appearancePalette, color } from './theme'

/** Some native text/image consumers cache a resolved semantic foreground. Give
 * them a changed prop on appearance updates even beneath a memoized parent.
 * Keep native contrast variants and leave plain custom tints unchanged. */
export function useLiveInk(ink: string): string {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  return useMemo(() => {
    const slot =
      ink === color.text || ink === color.body
        ? 'text'
        : ink === color.textDim || ink === color.label
          ? 'dim'
          : null
    if (slot !== null) {
      const value = appearancePalette[scheme][slot]
      const contrast = scheme === 'dark' ? appearancePalette.light.bg : appearancePalette.light.text
      return adaptiveColor(value, value, contrast, contrast)
    }
    const dynamic = (ink as unknown as { dynamic?: Parameters<typeof DynamicColorIOS>[0] }).dynamic
    if (!dynamic) return ink
    // The theme only builds dynamic colours from string hex values.
    const value = dynamic[scheme] as string
    const contrast =
      (dynamic[scheme === 'dark' ? 'highContrastDark' : 'highContrastLight'] as
        | string
        | undefined) ?? value
    return adaptiveColor(value, value, contrast, contrast)
  }, [ink, scheme])
}
