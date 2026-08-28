import { color } from '../theme/theme'
import { WORKING_MARK_DOTS, type WorkingMarkProps, workingMarkRadius } from './WorkingMark.shared'
import './WorkingMark.web.css'

/** Mobile-web status mark. CSS keeps the wave on the browser compositor. */
export function WorkingMark({
  size = 12,
  tint = color.working,
  label = 'Working',
}: WorkingMarkProps) {
  const radius = workingMarkRadius(size)
  return (
    <svg
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
      role={label === null ? undefined : 'progressbar'}
      focusable="false"
      data-testid="working-mark"
      viewBox="0 0 66 100"
      width={Math.round(size * 0.66)}
      height={size}
      className="podium-mobile-working-mark"
    >
      {WORKING_MARK_DOTS.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={radius} fill={tint} />
      ))}
    </svg>
  )
}

export { DELAYS_MS, wavePhase } from './WorkingMark.shared'
