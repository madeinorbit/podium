import type { JSX } from 'react'

/**
 * THE MESSAGE FOOT'S GLYPHS, TRACED FROM THE DESIGN'S OWN FONT.
 *
 * The handoff draws the copy and quote actions in Material Symbols Rounded at
 * `opsz 20, wght 300, FILL 0, GRAD 0`, set at 13px. Rendering them with the
 * shell's lucide set — which is what the first pass did — gets neither the
 * shapes nor the weight: lucide's `Quote` is a pair of quotation BOXES where
 * Material's `format_quote` is the "99" double comma, and lucide draws a 24-unit
 * icon that fills its whole 13px square in a 1.75-unit stroke, where a 13px
 * Material glyph carries side bearings and lands nearer 8.5×10px of much finer
 * ink. Side by side the difference reads as "bigger and heavier", which is
 * exactly how it was reported.
 *
 * So the outlines below ARE that font's, pulled from Google's published wght-300
 * Rounded sources, and shipped as inline SVG on the font's own `0 -960 960 960`
 * em box. Same geometry as the design, drawn the way the rest of the shell draws
 * icons — no second webfont to load, block on, or pay for in the bundle, and no
 * network dependency in a surface that must work offline.
 *
 * `check` is not in the handoff (the design never shows a copied state); it is
 * the same family at the same weight so the confirmation does not change texture
 * mid-gesture.
 */
const PATHS = {
  copy: 'M362.31-260Q332-260 311-281q-21-21-21-51.31v-455.38Q290-818 311-839q21-21 51.31-21h335.38Q728-860 749-839q21 21 21 51.31v455.38Q770-302 749-281q-21 21-51.31 21H362.31Zm0-60h335.38q4.62 0 8.46-3.85 3.85-3.84 3.85-8.46v-455.38q0-4.62-3.85-8.46-3.84-3.85-8.46-3.85H362.31q-4.62 0-8.46 3.85-3.85 3.84-3.85 8.46v455.38q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85Zm-140 200Q192-120 171-141q-21-21-21-51.31v-485.38q0-12.77 8.62-21.39 8.61-8.61 21.38-8.61t21.39 8.61q8.61 8.62 8.61 21.39v485.38q0 4.62 3.85 8.46 3.84 3.85 8.46 3.85h365.38q12.77 0 21.39 8.61 8.61 8.62 8.61 21.39 0 12.77-8.61 21.38-8.62 8.62-21.39 8.62H222.31ZM350-320v-480 480Z',
  quote:
    'm271.23-298.85 68.39-118.46q-3.46 1.92-8.08 2.69t-9.23.77q-61 0-103.58-42.93-42.57-42.93-42.57-103.22 0-61 42.57-103.58 42.58-42.57 103.58-42.57 60.29 0 103.22 42.57 42.93 42.58 42.93 103.45 0 21.21-5.11 39.36-5.12 18.15-14.97 34.62l-125.46 217.3q-3.75 6.75-10.5 10.88-6.75 4.12-15.01 4.12-17.26 0-25.87-15-8.62-15-.31-30Zm355.39 0L695-417.31q-3.46 1.92-8.08 2.69-4.61.77-9.23.77-61 0-103.57-42.93-42.58-42.93-42.58-103.22 0-61.38 42.58-103.77 42.57-42.38 103.57-42.38 60.29 0 103.22 42.57 42.93 42.58 42.93 103.45 0 21.21-5.11 39.36-5.12 18.15-14.96 34.62l-125.46 217.3q-3.75 6.75-10.51 10.88-6.75 4.12-15 4.12-17.26 0-25.88-15-8.61-15-.3-30Zm-252-208.84q21.54-21.54 21.54-52.31 0-30.77-21.54-52.31-21.54-21.54-52.31-21.54-30.77 0-52.31 21.54-21.54 21.54-21.54 52.31 0 30.77 21.54 52.31 21.54 21.54 52.31 21.54 30.77 0 52.31-21.54Zm355.38 0q21.54-21.54 21.54-52.31 0-30.77-21.54-52.31-21.54-21.54-52.31-21.54-30.77 0-52.31 21.54-21.54 21.54-21.54 52.31 0 30.77 21.54 52.31 21.54 21.54 52.31 21.54 30.77 0 52.31-21.54ZM677.69-560Zm-355.38 0Z',
  check:
    'm382-339.38 345.54-345.54q8.92-8.93 20.88-9.12 11.96-.19 21.27 9.12 9.31 9.31 9.31 21.38 0 12.08-9.31 21.39l-362.38 363q-10.85 10.84-25.31 10.84-14.46 0-25.31-10.84l-167-167q-8.92-8.93-8.8-21.2.11-12.26 9.42-21.57t21.38-9.31q12.08 0 21.39 9.31L382-339.38Z',
  close:
    'M480-437.85 277.08-234.92q-8.31 8.3-20.89 8.5-12.57.19-21.27-8.5-8.69-8.7-8.69-21.08 0-12.38 8.69-21.08L437.85-480 234.92-682.92q-8.3-8.31-8.5-20.89-.19-12.57 8.5-21.27 8.7-8.69 21.08-8.69 12.38 0 21.08 8.69L480-522.15l202.92-202.93q8.31-8.3 20.89-8.5 12.57-.19 21.27 8.5 8.69 8.7 8.69 21.08 0 12.38-8.69 21.08L522.15-480l202.93 202.92q8.3 8.31 8.5 20.89.19 12.57-8.5 21.27-8.7 8.69-21.08 8.69-12.38 0-21.08-8.69L480-437.85Z',
} as const

export type MetaGlyphName = keyof typeof PATHS

/** One foot glyph at the design's 13px, filled in the current ink. */
export function MetaGlyph({ name, size = 13 }: { name: MetaGlyphName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
