/**
 * Harness-only: the real lucide glyphs, drawn as DOM SVG.
 *
 * `lucide-react-native` renders through react-native-svg, whose package entry
 * is Flow-typed native source that vite's optimizer refuses. `lucide-react` is
 * the SAME icon set at the same geometry and takes the same `size`/`color`
 * props the app's `Icon` passes, so a capture shows the shipped glyph rather
 * than a stand-in — only the renderer underneath differs.
 */
export * from 'lucide-react'
