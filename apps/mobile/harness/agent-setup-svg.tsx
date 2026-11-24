/** Browser boundary: the real AgentMark's bundled paths render as native SVG tags. */
import type { ComponentProps } from 'react'
export default function Svg(props: ComponentProps<'svg'>) {
  return <svg {...props} />
}
export function Path(props: ComponentProps<'path'>) {
  return <path {...props} />
}
