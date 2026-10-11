import { memo } from 'react'
import { tetra } from '@podium/working-mark/designs'
import { WorkingMark as AnimatedWorkingMark } from '@podium/working-mark/react'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'

/** Fit the shared tetra into the existing phone cell without changing row layout. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const width = Math.round(size * 0.66)
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none', alignItems: 'center', width, height: size }}>
      <AnimatedWorkingMark design={tetra} size={width} color={tint} />
    </span>
  )
})
