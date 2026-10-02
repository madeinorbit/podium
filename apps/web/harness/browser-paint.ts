/** Chromium timeline boundary shared with the selection runtime capture. */
import type { CDPSession } from '@playwright/test'

type TraceEvent = { name: string; ph: string; ts: number; pid: number; dur?: number }

export async function traceStart(cdp: CDPSession) {
  const events: TraceEvent[] = []
  const receive = ({ value }: { value: unknown[] }) => {
    events.push(...(value as TraceEvent[]))
  }
  cdp.on('Tracing.dataCollected', receive)
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing',
    transferMode: 'ReportEvents',
  })
  return async () => {
    const complete = new Promise<void>((done) => cdp.once('Tracing.tracingComplete', () => done()))
    await cdp.send('Tracing.end')
    await complete
    cdp.off('Tracing.dataCollected', receive)
    return events
  }
}

export function paintOf(
  events: TraceEvent[],
  inputMark = 'acceptance:input',
  domMark = 'acceptance:selected-dom',
) {
  const input = events.filter((e) => e.name === inputMark)
  const selected = events.filter((e) => e.name === domMark)
  if (input.length !== 1 || selected.length !== 1)
    throw new Error('Missing or duplicate input/DOM marks')
  if (selected[0]!.ts < input[0]!.ts) throw new Error('DOM change preceded the input')
  const paint = events
    .filter(
      (e) =>
        e.name === 'Paint' && e.ph === 'X' && e.ts >= selected[0]!.ts && e.pid === input[0]!.pid,
    )
    .sort((a, b) => a.ts - b.ts)[0]
  if (!paint) throw new Error('No actual Chromium Paint after the expected DOM change')
  return {
    inputToPaintMs: (paint.ts + (paint.dur ?? 0) - input[0]!.ts) / 1000,
    selectedDomMs: (selected[0]!.ts - input[0]!.ts) / 1000,
  }
}
