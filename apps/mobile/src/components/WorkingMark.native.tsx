import Svg, { Circle } from 'react-native-svg'
import { color } from '../theme/theme'
import { WORKING_MARK_DOTS, type WorkingMarkProps, workingMarkRadius } from './WorkingMark.shared'

/** A fully lit native status cell; it owns no UI-runtime clock or animation. */
export function WorkingMark({
  size = 12,
  tint = color.workingText,
  label = 'Working',
}: WorkingMarkProps) {
  const radius = workingMarkRadius(size)

  return (
    <Svg
      accessibilityRole={label === null ? 'none' : 'progressbar'}
      accessibilityLabel={label ?? undefined}
      viewBox="0 0 66 100"
      width={Math.round(size * 0.66)}
      height={size}
    >
      {WORKING_MARK_DOTS.map(([cx, cy]) => (
        <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={radius} fill={tint} />
      ))}
    </Svg>
  )
}
