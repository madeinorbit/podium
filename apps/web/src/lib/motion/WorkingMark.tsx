/**
 * The same working mark on every surface. Callers gate it on an agent computing
 * (or a message in transport); the neighbouring label or timer carries the state
 * for assistive tech. The package handles reduced motion and idle pausing.
 */
import { tetra } from '@podium/working-mark/designs'
import { WorkingMark as AnimatedWorkingMark } from '@podium/working-mark/react'
import { type JSX, memo } from 'react'
import { cn } from '@/lib/utils'

function WorkingMarkCell({
  size = 12,
  className,
}: {
  /** Square box in px: 11 badge, 12–13 rows, 15 tabs, 24 feed tail. */
  size?: number
  className?: string
}): JSX.Element {
  return <AnimatedWorkingMark design={tetra} size={size} className={cn('pod-mark', className)} />
}

/** Timer ticks must not reconcile the mark. */
export const WorkingMark = memo(WorkingMarkCell)
WorkingMark.displayName = 'WorkingMark'
