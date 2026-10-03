/** Fixture platform bridge: retain the actual StageGlyph geometry/colours
 * while rendering its five SVG primitives directly into the browser DOM. */
import { createElement, type ReactNode } from 'react'

type Props = Record<string, unknown> & { children?: ReactNode }
const primitive = (tag: string) => ({ children, ...props }: Props) => {
  const { accessibilityLabel, accessibilityRole, accessible, ...attributes } = props
  return createElement(tag, {
    ...attributes,
    ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
    ...(accessibilityRole ? { role: accessibilityRole === 'image' ? 'img' : accessibilityRole } : {}),
    ...(accessible === false ? { 'aria-hidden': true } : {}),
  }, children)
}
export default primitive('svg')
export const Circle = primitive('circle')
export const G = primitive('g')
export const Path = primitive('path')
export const Rect = primitive('rect')
