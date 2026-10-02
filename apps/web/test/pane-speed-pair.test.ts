import { describe, expect, it } from 'vitest'
import { comparePaneSpeedPair } from '../harness/pane-speed-pair'
const run = (value: number) => ({ click: Array(6).fill(value) as number[], 'issue-page-open': Array(6).fill(value) as number[] })
describe('same SHA pane speed comparison', () => {
  it('compares both fresh captures and rejects slower clicks or page opening at the fixed margin', () => {
    expect(comparePaneSpeedPair([run(100), run(100)], [run(80), run(80)])).toMatchObject({ passed: true, regressions: [] })
    const slow = comparePaneSpeedPair([run(100), run(100)], [run(120), run(120)])
    expect(slow).toMatchObject({ passed: false, regressions: ['click', 'issue-page-open'] })
    expect(slow.actions.click).toMatchObject({ legacy: { medianMs: 100 }, pool: { medianMs: 120 }, changePercent: 20 })
  })
  it('reports measured noise and refuses incomplete or mismatched captures', () => {
    expect(comparePaneSpeedPair([run(90), run(110)], [run(80), run(100)]).actions.click?.legacy.spreadPercent).toBe(20)
    expect(() => comparePaneSpeedPair([run(100)], [run(90), run(90)])).toThrow(/two/)
    expect(() => comparePaneSpeedPair([run(100), run(100)], [run(90), { click: [1] }])).toThrow(/six/)
    expect(() => comparePaneSpeedPair([run(100), run(100)], [run(NaN), run(90)])).toThrow(/finite/)
  })
})
