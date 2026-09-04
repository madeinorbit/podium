import { describe, expect, it } from 'vitest'
import { compareAgainstBaseline } from './measure-hot-paths'

/**
 * THE GATE'S REFUSALS [POD-3407].
 *
 * `compareAgainstBaseline` is the whole of the hot-path budget, and its
 * interesting behaviour is not the comparison — it is the four cases where it
 * refuses rather than compares. Those had no test, which is how the blind-probe
 * case below got as far as POD-3397 unnoticed.
 */

type Report = Parameters<typeof compareAgainstBaseline>[0]

const report = (
  metrics: Record<string, { value: number; control: number }>,
  scale = { sessions: 50, issues: 30 },
): Report =>
  ({
    suite: 'queries',
    at: '2026-01-01T00:00:00.000Z',
    scale,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, { value, control }]) => [
        name,
        {
          value,
          control,
          controlOf: 'rows the frame actually resolved',
          unit: 'queries-per-request' as const,
        },
      ]),
    ),
  }) as Report

describe('the hot-path budget', () => {
  it('holds when a count falls, and fails when one rises', () => {
    const before = report({ 'issueFrameReads.queriesPerRequest': { value: 253, control: 80 } })
    expect(
      compareAgainstBaseline(
        before,
        report({ 'issueFrameReads.queriesPerRequest': { value: 200, control: 80 } }),
      ),
    ).toEqual([])
    expect(
      compareAgainstBaseline(
        before,
        report({ 'issueFrameReads.queriesPerRequest': { value: 254, control: 80 } }),
      ),
    ).toEqual([expect.stringContaining('253 → 254')])
  })

  /**
   * THE ONE THE BUDGET CANNOT SEE ON ITS OWN.
   *
   * A probe that observes nothing reports `value: 0`, which "no increase" reads
   * as the largest possible improvement. The CONTROL does not catch it, because
   * the control is measured from the frames and rows the window produced rather
   * than from the probe — so it stays healthy while the instrument is dead.
   * POD-3397 is this exact shape (a converted repository issuing statements past
   * the patched handle), and POD-3407 reproduced it a second way by counting the
   * same window through a drizzle logger.
   */
  it('refuses a zero the baseline says should be a number, control notwithstanding', () => {
    const failures = compareAgainstBaseline(
      report({
        'feedBootstrap.queriesPerRequest': { value: 44, control: 1 },
        'issueFrameReads.queriesPerRequest': { value: 253, control: 80 },
      }),
      report({
        'feedBootstrap.queriesPerRequest': { value: 0, control: 1 },
        'issueFrameReads.queriesPerRequest': { value: 0, control: 80 },
      }),
    )
    expect(failures).toHaveLength(2)
    for (const failure of failures) expect(failure).toContain('instrument saw nothing')
    // And the control being healthy is the point: it did not fire.
    for (const failure of failures) expect(failure).not.toContain('Nothing was measured')
  })

  it('still compares a metric whose baseline is legitimately zero', () => {
    expect(
      compareAgainstBaseline(
        report({ 'someLane.queriesPerRequest': { value: 0, control: 4 } }),
        report({ 'someLane.queriesPerRequest': { value: 0, control: 4 } }),
      ),
    ).toEqual([])
  })

  it('refuses a dead control, and a metric the run did not measure at all', () => {
    expect(
      compareAgainstBaseline(
        report({ 'a.queriesPerRequest': { value: 44, control: 1 } }),
        report({ 'a.queriesPerRequest': { value: 44, control: 0 } }),
      ),
    ).toEqual([expect.stringContaining('control is 0')])
    expect(
      compareAgainstBaseline(
        report({ 'a.queriesPerRequest': { value: 44, control: 1 } }),
        report({}),
      ),
    ).toEqual([expect.stringContaining('did not measure it')])
  })

  it('refuses two runs measured at different fixture scale', () => {
    expect(
      compareAgainstBaseline(
        report({ 'a.queriesPerRequest': { value: 44, control: 1 } }),
        report({ 'a.queriesPerRequest': { value: 20, control: 1 } }, { sessions: 5, issues: 3 }),
      ),
    ).toEqual([expect.stringContaining('not comparable')])
  })
})
