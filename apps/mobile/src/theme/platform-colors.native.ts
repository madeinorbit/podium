import { type ColorValue, DynamicColorIOS, Platform, PlatformColor } from 'react-native'

export function semanticColor(iosName: string, fallback: string): string {
  return (Platform.OS === 'ios' ? PlatformColor(iosName) : fallback) as unknown as string
}

export function adaptiveColor(
  light: string,
  dark: string,
  highContrastLight: string,
  highContrastDark: string,
): string {
  return (Platform.OS === 'ios'
    ? DynamicColorIOS({
        light,
        dark,
        highContrastLight,
        highContrastDark,
      })
    : dark) as unknown as string
}

export function fadeDynamicColor(
  value: unknown,
  opacity: number,
  fade: (entry: string, opacity: number) => string,
): string | null {
  if (Platform.OS !== 'ios' || !value || typeof value !== 'object' || !('dynamic' in value)) {
    return null
  }

  const dynamic = (
    value as {
      dynamic: {
        light: ColorValue
        dark: ColorValue
        highContrastLight?: ColorValue
        highContrastDark?: ColorValue
      }
    }
  ).dynamic
  const faded = (entry: ColorValue | undefined): ColorValue | undefined =>
    entry === undefined ? undefined : (fade(entry as unknown as string, opacity) as ColorValue)

  return DynamicColorIOS({
    light: faded(dynamic.light)!,
    dark: faded(dynamic.dark)!,
    highContrastLight: faded(dynamic.highContrastLight),
    highContrastDark: faded(dynamic.highContrastDark),
  }) as unknown as string
}
