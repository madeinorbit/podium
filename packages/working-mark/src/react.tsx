/**
 * `<WorkingMark design={tetra} />`: the working mark as a React component, drawn the cheapest way measured for the
 * browser it runs in (see mark.ts). It renders an inline box of the mark's size, hidden from assistive tech: gate it
 * on "an agent is working" and let the label or timer beside it say so.
 */
import { type CSSProperties, type JSX, memo, useLayoutEffect, useRef } from 'react'
import {
  mountWorkingMark,
  type WorkingMarkHandle,
  type WorkingMarkMethod,
  workingMarkBox,
} from './mark'
import type { Design } from './types'

export interface WorkingMarkProps {
  design: Design
  /** Height in CSS px. Default 12. */
  size?: number
  /** Frames per second, or 'smooth' for the design's own lowest smooth rate. Default 15. */
  fps?: number | 'smooth'
  /** Default 'auto': the measured best for this browser. */
  method?: WorkingMarkMethod
  /** A CSS colour; default the element's CSS `color` (set it with `className` or `style`). */
  color?: string
  className?: string
  style?: CSSProperties
}

function WorkingMarkBox({
  design,
  size = 12,
  fps,
  method,
  color,
  className,
  style,
}: WorkingMarkProps): JSX.Element {
  const host = useRef<HTMLSpanElement>(null)
  const handle = useRef<WorkingMarkHandle | null>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    handle.current = mountWorkingMark(el, design, { size, fps, method, color })
    return () => {
      handle.current?.destroy()
      handle.current = null
    }
  }, [design, size, fps, method, color])
  const box = workingMarkBox(design, size)
  return (
    <span
      ref={host}
      aria-hidden="true"
      data-testid="working-mark"
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        flex: 'none',
        verticalAlign: 'middle',
        width: box.width,
        height: box.height,
        ...style,
      }}
    />
  )
}

/** Memoised: a ticking timer beside the mark doesn't re-render it. */
export const WorkingMark = memo(WorkingMarkBox)
WorkingMark.displayName = 'WorkingMark'
