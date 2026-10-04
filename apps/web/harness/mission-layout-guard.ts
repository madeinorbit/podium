import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface LayoutTraceEvent {
  name: string
  ph: string
  ts: number
  pid: number
  tid: number
  dur?: number
}

// RunTask also contains the browser's ordinary rendering work. Only a layout
// nested inside JavaScript execution is a synchronous, forced reflow.
const JAVASCRIPT = new Set([
  'FunctionCall',
  'EvaluateScript',
  'EventDispatch',
  'RunMicrotasks',
  'V8.Execute',
])

export function missionOpenLayout(events: readonly LayoutTraceEvent[]) {
  const mark = (name: string) => {
    const found = events.filter((event) => event.name === name)
    if (found.length !== 1) throw new Error(`Missing or duplicate ${name} mark`)
    return found[0]!
  }
  const input = mark('switch:input')
  const dom = mark('switch:dom')
  const settled = mark('mission:trace-settled')
  const sameThread = (event: LayoutTraceEvent) => event.pid === input.pid && event.tid === input.tid
  if (!sameThread(dom) || !sameThread(settled) || dom.ts < input.ts)
    throw new Error('Mission trace marks disagree about input, DOM or renderer thread')
  const paint = events
    .filter((event) => sameThread(event) && event.name === 'Paint' && event.ph === 'X' && event.ts >= dom.ts)
    .sort((a, b) => a.ts - b.ts)[0]
  if (!paint || settled.ts < paint.ts + (paint.dur ?? 0) + 100_000)
    throw new Error('Mission trace must retain Paint and at least 100 ms of settling')
  const main = events.filter(sameThread)
  const javascript = main.filter((event) => event.ph === 'X' && JAVASCRIPT.has(event.name))
  if (!javascript.length) throw new Error('Mission trace has no JavaScript execution events')
  const layouts = main.filter((event) => event.name === 'Layout' && event.ts >= input.ts && event.ts <= settled.ts)
  if (!layouts.length || layouts.some((event) => event.ph !== 'X' || event.dur === undefined))
    throw new Error('Mission trace has no complete layout events')
  const forced = layouts.filter((layout) => javascript.some((call) =>
    call.ts <= layout.ts && call.ts + (call.dur ?? 0) >= layout.ts + layout.dur!,
  ))
  return {
    layouts: layouts.length,
    forcedReflows: forced.length,
    forcedLayoutMs: forced.reduce((total, event) => total + event.dur!, 0) / 1000,
    forcedAfterPaint: forced.filter((event) => event.ts >= paint.ts + (paint.dur ?? 0)).length,
    inputToPaintMs: (paint.ts + (paint.dur ?? 0) - input.ts) / 1000,
  }
}

export function assertNoMissionReflows(events: readonly LayoutTraceEvent[]) {
  const result = missionOpenLayout(events)
  if (result.forcedReflows)
    throw new Error(`Mission open forced ${result.forcedReflows} reflows (${result.forcedLayoutMs.toFixed(3)} ms; ${result.forcedAfterPaint} after Paint)`)
  return result
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: bun apps/web/harness/mission-layout-guard.ts <profiles directory>')
  const files = (await readdir(directory)).filter((file) => /^mission-switch-on-\d+\.trace\.json$/.test(file)).sort()
  if (!files.length) throw new Error('No ON mission-open traces found')
  const results = []
  for (const file of files) {
    const trace = JSON.parse(await readFile(resolve(directory, file), 'utf8')) as { traceEvents: LayoutTraceEvent[] }
    results.push({ file, ...assertNoMissionReflows(trace.traceEvents) })
  }
  console.log(JSON.stringify({ missionOpenTraces: results.length, forcedReflows: 0, results }, null, 2))
}
