/** Process-local diagnostics only. No rows, URLs, credentials or persisted state.
 * Silent until the first native Work list appears and the launch overlay leaves.
 * Enabled in Release too: one pair of reports per runtime. Search gets a short
 * separate line because the unified log truncates the full report near 1KB.
 * Times start at this module's evaluation, not at the OS process launch. */
export function createStartupTiming(
  now: () => number = () => performance.now(),
  write: (line: string) => void = (line) => console.info(line),
) {
  const started = now()
  const marks = new Map<string, number>()
  let finished = false
  function mark(name: string): void {
    if (finished || marks.has(name) || marks.size >= 80) return
    marks.set(name, Math.round((now() - started) * 10) / 10)
    if (marks.has('work.native-list-appear') && marks.has('launch.overlay-hidden')) {
      finished = true
      const search = [...marks].filter(
        ([name]) =>
          name === 'launch.search-budget-start' ||
          name === 'launch.search-ready' ||
          name === 'launch.search-expired',
      )
      write(
        `[podium-startup-search] ${JSON.stringify({ version: 1, runtimeEntryMs: Math.round(started), marks: Object.fromEntries(search) })}`,
      )
      write(
        `[podium-startup] ${JSON.stringify({ version: 1, runtimeEntryMs: Math.round(started), marks: Object.fromEntries(marks) })}`,
      )
      marks.clear()
    }
  }
  async function measure<T>(name: string, run: () => Promise<T>): Promise<T> {
    mark(`${name}.start`)
    try {
      const result = await run()
      mark(`${name}.end`)
      return result
    } catch (error) {
      mark(`${name}.error`)
      throw error
    }
  }
  mark('js.entry')
  return { mark, measure }
}

export const startupTiming = createStartupTiming()
