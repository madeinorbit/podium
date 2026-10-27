// @vitest-environment happy-dom
/**
 * The pool screens' work ratios (`speed:structural`): every scripted click
 * and delta on every pool screen and app reader, counted from outside
 * (`work-meter.ts`) at 1x and 4x, must stay within its neighbourhood bound.
 * A known violation is a NAMED expected failure
 * (`screen-work.expected-failures.json`: the issue that fixes it and its exact
 * counts); one whose count passes fails the suite, so a fix takes its entry
 * with it. The cells go to the git-ignored results folder.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import screenWorkExceptions from './screen-work.expected-failures.json'
import {
  assertScreenWork,
  classifyScreenWork,
  SCREEN_ACTIONS,
  type ScreenWorkCell,
  type ScreenWorkVerdict,
  screenWorkVerdicts,
} from './screen-work-ratios'

describe('pool screens work ratios', () => {
  it('counts every scripted click/delta for every pool screen and app reader at 1x/4x', async () => {
    const partial = { at1x: [] as ScreenWorkCell[], at4x: [] as ScreenWorkCell[] }
    const capture = (key: keyof typeof partial) => (cell: ScreenWorkCell) => {
      partial[key].push(cell)
      writeCells('work-pool-screens-progress.json', partial)
    }
    const at1x = await poolScreenCellsAt(1, capture('at1x'))
    const at4x = await poolScreenCellsAt(4, capture('at4x'))
    expect(at4x.readers).toEqual(at1x.readers)
    expect(at4x.corpus.issues).toBeGreaterThan(at1x.corpus.issues * 3)
    expect(at4x.corpus.sessions).toBeGreaterThan(at1x.corpus.sessions * 3)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    const exceptions = screenWorkExceptions.flatMap(({ issue, readers }) =>
      readers.flatMap(({ reader, actions }) =>
        Object.entries(actions).flatMap(([action, kinds]) =>
          (kinds ?? []).map((kind: string) => ({ action, kind, reader, issue })),
        ),
      ),
    )
    const { expectedFailures, unexpected, resolved } = classifyScreenWork(verdicts, exceptions)
    writeCells('work-pool-screens.json', {
      at1x,
      at4x,
      verdicts,
      expectedFailures,
      unexpected,
      resolved,
    })
    console.info(
      `[screen work] ${at1x.readers.length} readers × ${SCREEN_ACTIONS.length} clicks/deltas × 2 scales; ${verdicts.length} counters; ${expectedFailures.length} expected failures; ${resolved.length} fixed counts green; ${unexpected.length} unexpected`,
    )
    for (const issue of new Set(expectedFailures.map((verdict) => verdict.issue))) {
      const owned = expectedFailures.filter((verdict) => verdict.issue === issue)
      const worst = [...owned].sort((a, b) => b.at4x - b.at1x - (a.at4x - a.at1x))[0]!
      console.info(
        `[screen work] expected failure ${issue}: ${owned.length} counts; ${worst.action} ${worst.reader} ${worst.kind} ${worst.at1x} → ${worst.at4x}; neighbourhood ${worst.neighbourhood1x} → ${worst.neighbourhood4x}`,
      )
    }
    // A new reader or unnamed mechanism does not silently inherit another screen's exception.
    assertScreenWork(unexpected)
    expect(at1x.cells.some((cell) => cell.work.rows! > 0 && cell.work.derivations > 0)).toBe(true)
    // A loaded host (or one core) may take over 30 min; the counts must not depend on it.
  }, 7_200_000)

  it('rejects a planted scan in any reader, even beside a much larger constant reader', () => {
    const cells = (): ScreenWorkCell[] =>
      SCREEN_ACTIONS.map((action) => ({
        action,
        neighbourhood: ['issue:visible'],
        work: {
          derivations: 1,
          derivationsBy: { cheap: 1 },
          rows: 1000,
          rowsBy: { expensiveButConstant: 1000 },
          elements: 0,
          elementsBy: {},
          visits: 0,
        },
      }))
    expect(() => assertScreenWork(screenWorkVerdicts(cells(), cells()))).not.toThrow()
    const growingNeighbourhood = cells()
    growingNeighbourhood[0]!.neighbourhood = ['issue:1', 'issue:2', 'issue:3', 'issue:4']
    growingNeighbourhood[0]!.work.rowsBy!.expensiveButConstant = 4000
    expect(() => assertScreenWork(screenWorkVerdicts(cells(), growingNeighbourhood))).not.toThrow()
    for (const action of SCREEN_ACTIONS)
      for (const kind of ['rows', 'derivations', 'elements'] as const) {
        const first = cells(),
          second = cells()
        const a = first.find((cell) => cell.action === action)!.work
        const b = second.find((cell) => cell.action === action)!.work
        const left =
          kind === 'rows' ? a.rowsBy! : kind === 'derivations' ? a.derivationsBy : a.elementsBy
        const right =
          kind === 'rows' ? b.rowsBy! : kind === 'derivations' ? b.derivationsBy : b.elementsBy
        left.planted = 1
        right.planted = 4
        expect(
          () => assertScreenWork(screenWorkVerdicts(first, second)),
          `${action} ${kind}`,
        ).toThrow(/planted/)
      }
    const zero = cells(),
      positive = cells()
    positive[0]!.work.rowsBy!.newReader = 1
    expect(() => assertScreenWork(screenWorkVerdicts(zero, positive))).toThrow(/newReader/)
    expect(() => screenWorkVerdicts(zero.slice(1), positive)).toThrow(/every click/)
    // A focused scenario declares its scope. It still rejects new scans,
    // missing cells and duplicate actions; omitting the scope stays strict.
    const action = SCREEN_ACTIONS[0],
      first = [zero[0]!],
      second = [positive[0]!]
    expect(() => screenWorkVerdicts(first, first)).toThrow(/every click/)
    expect(() => assertScreenWork(screenWorkVerdicts(first, first, [action]))).not.toThrow()
    expect(() => assertScreenWork(screenWorkVerdicts(first, second, [action]))).toThrow(/newReader/)
    expect(() => screenWorkVerdicts([], [], [])).toThrow(/every click/)
    expect(() => screenWorkVerdicts(first, [], [action])).toThrow(/every click/)
    expect(() =>
      screenWorkVerdicts([...first, ...first], [...first, ...first], [action, action]),
    ).toThrow(/every click/)
  })

  it('limits expected failures to exact issue-linked counts and reports fixed counts green', () => {
    const bad: ScreenWorkVerdict = {
      action: 'select',
      kind: 'rows',
      reader: 'consumer:known',
      at1x: 1,
      at4x: 4,
      neighbourhood1x: 1,
      neighbourhood4x: 1,
      passed: false,
    }
    const exception = { action: bad.action, kind: bad.kind, reader: bad.reader, issue: 'POD-5421' }
    const classified = classifyScreenWork(
      [
        bad,
        { ...bad, kind: 'derivations' },
        { ...bad, action: 'open-menu' },
        { ...bad, reader: `${bad.reader}/newScan` },
      ],
      [exception],
    )
    expect(classified.expectedFailures).toEqual([{ ...bad, issue: exception.issue }])
    expect(classified.unexpected).toHaveLength(3)
    expect(() => assertScreenWork(classified.unexpected)).toThrow(/newScan/)
    const fixed = classifyScreenWork([{ ...bad, at4x: 1, passed: true }], [exception])
    expect(fixed.expectedFailures).toEqual([])
    expect(fixed.resolved).toEqual([exception])
    expect(() => classifyScreenWork([bad], [{ ...exception, issue: '' }])).toThrow(/Invalid/)
    expect(() => classifyScreenWork([bad], [exception, exception])).toThrow(/duplicate/)
  })
})

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead.
const PACKAGE_DIR = process.cwd().endsWith(join('tests', 'worklist'))
  ? process.cwd()
  : join(process.cwd(), 'tests', 'worklist')

function writeCells(name: string, body: object): void {
  const dir = join(PACKAGE_DIR, 'harness', 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`)
}
