/** The native SVG bridge keeps the shipping glyph and rail geometry in the browser. */
import { createElement } from 'react'

export { Circle, default, G, Path, Rect } from '../../mobile/test/inbox-svg'
export const Line = (props: Record<string, unknown>) => createElement('line', props)
export const Ellipse = (props: Record<string, unknown>) => createElement('ellipse', props)
