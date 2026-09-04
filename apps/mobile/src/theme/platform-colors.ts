/** Plain-color fallback used by Expo web, Android, and unit tests. */
export function semanticColor(_iosName: string, fallback: string): string {
  return fallback
}

/** Podium keeps its established dark palette outside the supported iOS app. */
export function adaptiveColor(_light: string, dark: string): string {
  return dark
}

/** Dynamic UIKit colors exist only in the native implementation. */
export function fadeDynamicColor(
  _value: unknown,
  _opacity: number,
  _fade: (entry: string, opacity: number) => string,
): string | null {
  return null
}
