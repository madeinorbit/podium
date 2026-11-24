/** Resolve the same iOS theme tokens for light/dark browser evidence. */
const light = new URLSearchParams(window.location.search).get('appearance') !== 'dark'
const system: Record<string, string> = {
  systemBackground: '#ffffff',
  secondarySystemBackground: '#f2f2f7',
  tertiarySystemBackground: '#ffffff',
  label: '#000000',
  secondaryLabel: '#636366',
  tertiaryLabel: '#8a8a8e',
  separator: 'rgba(60,60,67,0.22)',
  opaqueSeparator: '#c7c7cc',
  systemFill: '#e5e5ea',
}
export function semanticColor(name: string, fallback: string) {
  return light ? (system[name] ?? fallback) : fallback
}
export function adaptiveColor(day: string, night: string) {
  return light ? day : night
}
export function fadeDynamicColor() {
  return null
}
