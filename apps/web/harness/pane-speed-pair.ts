const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const round = (value: number) => Math.round(value * 1000) / 1000
export type PaneSamples = Record<string, readonly number[]>

/** The same production SHA, machine and targets are enforced by the caller.
 * Each arm needs two fresh-browser captures; six samples per action per run. */
export function comparePaneSpeedPair(legacy: readonly PaneSamples[], pool: readonly PaneSamples[]) {
  if (legacy.length !== 2 || pool.length !== 2) throw new Error('Pane comparison requires two captures per arm')
  const actions = Object.keys(legacy[0]!).sort()
  if (!actions.length) throw new Error('Pane comparison needs action samples')
  for (const run of [...legacy, ...pool]) {
    if (JSON.stringify(Object.keys(run).sort()) !== JSON.stringify(actions) ||
      actions.some(action => run[action]!.length !== 6 || run[action]!.some(value => !Number.isFinite(value) || value <= 0))) {
      throw new Error('Pane comparison needs identical actions and six finite samples per capture')
    }
  }
  const metrics = Object.fromEntries(actions.map(action => {
    const before = legacy.flatMap(run => [...run[action]!]), after = pool.flatMap(run => [...run[action]!])
    const arm = (runs: readonly PaneSamples[], samples: number[]) => {
      const medians = runs.map(run => median(run[action]!))
      return { medianMs: round(median(samples)), worstMs: round(Math.max(...samples)),
        captureMediansMs: medians.map(round), spreadPercent: round((Math.max(...medians) - Math.min(...medians)) / median(medians) * 100) }
    }
    return [action, { legacy: arm(legacy, before), pool: arm(pool, after),
      changePercent: round((median(after) / median(before) - 1) * 100),
      passed: median(after) <= median(before) * 1.1 }]
  }))
  return { capturesPerArm: 2, samplesPerCapture: 6, marginPercent: 10, actions: metrics,
    regressions: actions.filter(action => !metrics[action]!.passed), passed: actions.every(action => metrics[action]!.passed) }
}
