import type { IssueStage } from '@podium/model'
import Svg, { Circle, Path, Rect } from 'react-native-svg'
import { STAGE_LABEL, STAGE_UNKNOWN, stageColor } from '../theme/stage'
import { color } from '../theme/theme'

/**
 * The Linear-style workflow-state glyph, on the phone — a literal transcription
 * of `apps/web/src/features/issues/issue-glyphs.tsx`, geometry and all: dashed
 * circle (backlog), open circle (proposed/planning), a pie filled 1/3 and 2/3
 * (in progress / review), and a filled circle with a check punched out of it
 * (done). Same 14-unit viewBox, same r=6 ring at 1.6 stroke, same 3.2 pie
 * radius, so the two platforms draw the same shape at the same optical weight.
 *
 * Reproduced rather than shared because the web draws into the DOM and this
 * draws into react-native-svg; the VALUES it colours with are shared, from
 * ../theme/stage.
 */
const STAGE_FILL: Record<IssueStage, number> = {
  proposed: 0,
  backlog: 0,
  planning: 0,
  in_progress: 1 / 3,
  review: 2 / 3,
  shipping: 5 / 6,
  done: 1,
}

export function StageGlyph({
  stage,
  size = 14,
  /** The surface the done-check is punched out of. */
  ground = color.bg,
  tint,
}: {
  stage: IssueStage
  size?: number
  ground?: string
  /** Override the stage hue — e.g. a chip that already carries the colour. */
  tint?: string
}) {
  const ink = tint ?? stageColor(stage)
  if (stage === 'done') {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        accessibilityRole="image"
        accessibilityLabel={STAGE_LABEL[stage]}
      >
        <Circle cx="7" cy="7" r="6" fill={ink} />
        <Path
          d="M4.5 7.2 6.3 9l3.2-3.6"
          stroke={ground}
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    )
  }
  const fill = STAGE_FILL[stage]
  const angle = 2 * Math.PI * fill
  const x = 7 + 3.2 * Math.sin(angle)
  const y = 7 - 3.2 * Math.cos(angle)
  const largeArc = fill > 0.5 ? 1 : 0
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      accessibilityRole="image"
      accessibilityLabel={STAGE_LABEL[stage]}
    >
      <Circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke={ink}
        strokeWidth="1.6"
        {...(stage === 'backlog' ? { strokeDasharray: '2.2 2.2' } : {})}
      />
      {fill > 0 ? <Path d={`M7 7 L7 3.8 A3.2 3.2 0 ${largeArc} 1 ${x} ${y} Z`} fill={ink} /> : null}
    </Svg>
  )
}

/**
 * A ref this client cannot answer for — the phone's copy of the web's
 * `UnknownRefGlyph` (POD-676), same 14-unit viewBox and r=6 ring.
 *
 * The phone previously drew NO glyph at all for an unresolved ref, so the only
 * thing separating it from a real task was the grey — and `backlog` is grey. A
 * ring carrying a question mark is a shape no stage has.
 */
export function UnknownRefGlyph({ size = 14, tint }: { size?: number; tint?: string }) {
  const ink = tint ?? STAGE_UNKNOWN
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      accessibilityRole="image"
      accessibilityLabel="Unknown"
    >
      <Circle cx="7" cy="7" r="6" fill="none" stroke={ink} strokeWidth="1.6" />
      <Path
        d="M5.3 5.0a1.75 1.75 0 0 1 3.4 0.58c0 1.17-1.75 1.75-1.75 1.75"
        fill="none"
        stroke={ink}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx="7" cy="9.7" r="0.85" fill={ink} />
    </Svg>
  )
}

/** Priority, in the board's own glyph: a filled box for P0, signal bars below. */
export function PriorityGlyph({ priority, size = 14 }: { priority: number; size?: number }) {
  if (priority === 0) {
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        accessibilityRole="image"
        accessibilityLabel="P0"
      >
        <Rect x="1" y="1" width="12" height="12" rx="3" fill={color.danger} />
        <Path d="M7 3.6v4.2" stroke={color.bg} strokeWidth="1.8" strokeLinecap="round" />
        <Circle cx="7" cy="10.4" r="1" fill={color.bg} />
      </Svg>
    )
  }
  const lit = Math.max(0, 4 - priority)
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      accessibilityRole="image"
      accessibilityLabel={`P${priority}`}
    >
      {[0, 1, 2].map((i) => (
        <Rect
          key={i}
          x={1.5 + i * 4}
          y={9 - i * 3}
          width="2.6"
          height={3 + i * 3}
          rx="1"
          fill={color.textDim}
          opacity={i < lit ? 1 : 0.25}
        />
      ))}
    </Svg>
  )
}
