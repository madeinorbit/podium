import { fadeDynamicColor } from './platform-colors'

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** `alpha('#d9b477', 0.45)` → `rgba(217,180,119,0.45)` (CSS `rgba(C, .45)`). */
export function alpha(hex: string, a: number): string {
  const value = hex as unknown
  const dynamic = fadeDynamicColor(value, a, alpha)
  if (dynamic) return dynamic
  // UIKit semantic colors already include platform opacity. Preserve those
  // opaque tokens rather than trying to infer an RGB value from a name.
  if (typeof value !== 'string') return hex
  const [r, g, b] = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
