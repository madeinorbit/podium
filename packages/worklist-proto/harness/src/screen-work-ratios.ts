/** Ratio guards intentionally differ from the worklist's older additive budget. */
import type { WorkCounts } from './work-meter'

export const SCREEN_ACTIONS = [
  'select',
  'stage-change',
  'pane-switch',
  'open-menu',
  'long-press',
  'navigate-by-ref',
  'heartbeat',
  'machine-flip',
  'lane-change',
] as const
export type ScreenAction = (typeof SCREEN_ACTIONS)[number]
export interface ScreenWorkCell {
  action: ScreenAction
  /** The drawn rows plus their addressed neighbours, measured outside the window. */
  neighbourhood: readonly string[]
  work: WorkCounts
}
export interface ScreenWorkVerdict {
  action: ScreenAction
  kind: 'rows' | 'derivations' | 'elements'
  reader: string
  at1x: number
  at4x: number
  neighbourhood1x: number
  neighbourhood4x: number
  passed: boolean
}

export function screenWorkVerdicts(
  at1x: readonly ScreenWorkCell[],
  at4x: readonly ScreenWorkCell[],
): ScreenWorkVerdict[] {
  if (at1x.length !== SCREEN_ACTIONS.length || at4x.length !== SCREEN_ACTIONS.length) {
    throw new Error('Screen work guard needs every click and single-row delta at both scales')
  }
  const verdicts: ScreenWorkVerdict[] = []
  for (const action of SCREEN_ACTIONS) {
    const left = at1x.filter((cell) => cell.action === action),
      right = at4x.filter((cell) => cell.action === action)
    if (left.length !== 1 || right.length !== 1)
      throw new Error(`Missing or duplicate screen action: ${action}`)
    const a = left[0]!,
      b = right[0]!
    if (a.neighbourhood.length === 0 || b.neighbourhood.length === 0)
      throw new Error(`Empty neighbourhood: ${action}`)
    for (const kind of ['rows', 'derivations', 'elements'] as const) {
      const first =
        kind === 'rows'
          ? a.work.rowsBy
          : kind === 'derivations'
            ? a.work.derivationsBy
            : a.work.elementsBy
      const second =
        kind === 'rows'
          ? b.work.rowsBy
          : kind === 'derivations'
            ? b.work.derivationsBy
            : b.work.elementsBy
      if (!first || !second) throw new Error(`Unmetered ${kind}: ${action}`)
      for (const reader of new Set([...Object.keys(first), ...Object.keys(second)])) {
        const one = first[reader] ?? 0,
          four = second[reader] ?? 0
        verdicts.push({
          action,
          kind,
          reader,
          at1x: one,
          at4x: four,
          neighbourhood1x: a.neighbourhood.length,
          neighbourhood4x: b.neighbourhood.length,
          // Cross multiplication handles 0→0 and 0→positive without rounding or slack.
          passed: four * a.neighbourhood.length <= one * b.neighbourhood.length,
        })
      }
    }
  }
  return verdicts
}

export function assertScreenWork(verdicts: readonly ScreenWorkVerdict[]): void {
  const failing = verdicts.filter((verdict) => !verdict.passed)
  if (failing.length)
    throw new Error(
      'Per-click work grew with total data:\n' +
        failing
          .map(
            (v) =>
              `${v.action} ${v.kind} ${v.reader}: ${v.at1x} → ${v.at4x}; visible neighbourhood ${v.neighbourhood1x} → ${v.neighbourhood4x}`,
          )
          .join('\n'),
    )
}
