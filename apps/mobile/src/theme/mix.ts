/**
 * JS equivalent of CSS `color-mix(in srgb, …)` for React Native, which has no
 * color-mix. Mixing happens on gamma-encoded sRGB channels — the same space the
 * web redesign's `issue-mix-*` utilities use — so a given recipe (e.g. "issue
 * colour 16% over #16161c") produces identical pixels on web and native.
 */

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

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** `mix(colour, 16, base)` ≡ CSS `color-mix(in srgb, colour 16%, base)`. */
export function mix(colour: string, percent: number, base: string): string {
  const [r1, g1, b1] = parseHex(colour)
  const [r2, g2, b2] = parseHex(base)
  const p = percent / 100
  return toHex(r1 * p + r2 * (1 - p), g1 * p + g2 * (1 - p), b1 * p + b2 * (1 - p))
}

/** `alpha('#f59e0b', 0.45)` → `rgba(245,158,11,0.45)` (CSS `rgba(C, .45)`). */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
