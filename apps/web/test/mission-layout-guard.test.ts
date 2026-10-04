import { describe, expect, it } from 'vitest'
import { assertNoMissionReflows, type LayoutTraceEvent, missionOpenLayout } from '../harness/mission-layout-guard'

const event = (name: string, ts: number, dur?: number, pid = 10, tid = 10): LayoutTraceEvent =>
  ({ name, ts, dur, pid, tid, ph: dur === undefined ? 'I' : 'X' })
const natural = () => [
  event('switch:input', 1000),
  event('EventDispatch', 900, 2100),
  event('switch:dom', 2800),
  event('RunTask', 3000, 6000),
  event('Layout', 4000, 2000),
  event('Paint', 6500, 500),
  event('mission:trace-settled', 108000),
]

describe('mission-open forced reflow guard', () => {
  it('accepts natural layout inside a rendering task, excluding another renderer and pre-input layout', () => {
    const trace = [...natural(), event('Layout', 500, 50), event('FunctionCall', 9500, 6000, 11), event('Layout', 10000, 1000, 11)]
    expect(assertNoMissionReflows(trace)).toMatchObject({ forcedReflows: 0, layouts: 1 })
  })

  it('rejects a layout pulled forward into a JavaScript commit', () => {
    const trace = [...natural(), event('FunctionCall', 3500, 3000)]
    expect(missionOpenLayout(trace)).toMatchObject({ forcedReflows: 1, forcedLayoutMs: 2 })
    expect(() => assertNoMissionReflows(trace)).toThrow('forced 1 reflows')
  })

  it('rejects reflows deferred beyond the first Paint, including zero-duration reflows', () => {
    const trace = [...natural(), event('FunctionCall', 20000, 2000), event('Layout', 21000, 0)]
    expect(missionOpenLayout(trace)).toMatchObject({ forcedReflows: 1, forcedAfterPaint: 1 })
    expect(() => assertNoMissionReflows(trace)).toThrow('1 after Paint')
  })

  it('does not let an unrelated thread turn ordinary layout into a forced one', () => {
    expect(assertNoMissionReflows([...natural(), event('FunctionCall', 3500, 3000, 10, 12)]).forcedReflows).toBe(0)
  })

  it.each(['switch:input', 'switch:dom', 'mission:trace-settled', 'Paint', 'Layout', 'EventDispatch'])(
    'refuses incomplete evidence without %s', (name) => {
      expect(() => assertNoMissionReflows(natural().filter((entry) => entry.name !== name))).toThrow()
    },
  )

  it('refuses a recording that stops at first Paint', () => {
    const trace = natural().map((entry) => entry.name === 'mission:trace-settled' ? { ...entry, ts: 7100 } : entry)
    expect(() => assertNoMissionReflows(trace)).toThrow('100 ms of settling')
  })
})
