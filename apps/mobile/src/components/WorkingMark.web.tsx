import { memo, useLayoutEffect, useRef } from 'react'
import { tetra } from '@podium/working-mark/designs'
import { mountWorkingMark } from '@podium/working-mark'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'

/** Own the React hooks in the phone's dependency graph; the package owns drawing. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const host = useRef<HTMLSpanElement>(null)
  const width = Math.round(size * 0.66)
  useLayoutEffect(() => {
    if (!host.current) return
    const mark = mountWorkingMark(host.current, tetra, { size: width, color: tint, method: 'image' })
    return () => mark.destroy()
  }, [width, tint])
  return (
    <span ref={host} aria-hidden="true" data-testid="working-mark"
      style={{ position: 'relative', display: 'inline-block', flex: 'none', verticalAlign: 'middle', width, height: size }} />
  )
})
