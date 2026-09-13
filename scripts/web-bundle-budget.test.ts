/**
 * The web bundle gate's first sibling test — POD-3905.
 *
 * IT CANNOT IMPORT THE GATE, and that is the whole reason it never had a test.
 * `web-bundle-budget.ts` reads `apps/web/dist` at module scope, so importing
 * anything from it requires a built website standing by; the gate's own header
 * records that this is how it came to have no test of its own ability to
 * refuse, with the only proof being a dist in a sibling worktree that was
 * deleted with the worktree (POD-2530).
 *
 * So this file reads the gate the way `audit-committed-floors.ts` does: with
 * the TypeScript parser, over the file's text. That is not a workaround, it is
 * the same mechanism under test — if the ceilings are not parseable out of the
 * source, the census cannot read them out of the base commit either, and the
 * ratchet on them is decoration.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { COMMITTED_BASELINES, qualify } from './audit-committed-floors'
import { checkBaseline, constantsInFile, REPO_ROOT } from './baseline-ratchet'

const SOURCE = 'scripts/web-bundle-budget.ts'
const ceilings = () => qualify(constantsInFile(SOURCE, 'WEB_BUNDLE_BUDGET'), 'WEB_BUNDLE_BUDGET')

describe('the eight ceilings have a name the census can read', () => {
  it('parses all eight, one per graph per lens', () => {
    expect(Object.keys(ceilings()).sort()).toEqual(
      [
        'WEB_BUNDLE_BUDGET.eager.brotli',
        'WEB_BUNDLE_BUDGET.eager.gzip',
        'WEB_BUNDLE_BUDGET.eager.raw',
        'WEB_BUNDLE_BUDGET.eager.sourceBytes',
        'WEB_BUNDLE_BUDGET.settings.brotli',
        'WEB_BUNDLE_BUDGET.settings.gzip',
        'WEB_BUNDLE_BUDGET.settings.raw',
        'WEB_BUNDLE_BUDGET.settings.sourceBytes',
      ].sort(),
    )
  })

  it('parses them as numbers, not as the underscore spelling', () => {
    // `1_650_000` is a numeric literal whose `.text` is '1650000'; a parser that
    // returned the source spelling would compare strings and never see a raise.
    for (const [key, value] of Object.entries(ceilings()))
      expect({ key, number: Number.isFinite(value) && value > 0 }).toEqual({ key, number: true })
  })

  it('is the declaration the census registers, spelled the same way', () => {
    const entry = COMMITTED_BASELINES.find((b) => b.relativePath === SOURCE)
    expect(entry?.exportName).toBe('WEB_BUNDLE_BUDGET')
    expect(Object.keys(entry?.directions ?? {}).sort()).toEqual(Object.keys(ceilings()).sort())
  })
})

describe('no ceiling is written back inline', () => {
  it('passes every atMost() its budget by name', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A ninth ceiling added as
    // `atMost('...', x, 900_000)` would gate the build while being invisible to
    // the census, which is exactly the state the eight were in before POD-3905
    // — and nothing else in the repository would have an opinion about it.
    const sf = ts.createSourceFile(
      SOURCE,
      readFileSync(join(REPO_ROOT, SOURCE), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const inline: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(sf) === 'atMost' &&
        node.arguments[2] !== undefined &&
        ts.isNumericLiteral(node.arguments[2])
      )
        inline.push(node.arguments[0]?.getText(sf) ?? '<unnamed>')
      ts.forEachChild(node, walk)
    }
    walk(sf)
    expect(inline).toEqual([])
  })

  it('finds the atMost calls at all, so the check above cannot pass by matching nothing', () => {
    const sf = ts.createSourceFile(
      SOURCE,
      readFileSync(join(REPO_ROOT, SOURCE), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    let calls = 0
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(sf) === 'atMost') calls += 1
      ts.forEachChild(node, walk)
    }
    walk(sf)
    expect(calls).toBe(8)
  })
})

describe('a raise to a ceiling is refused', () => {
  const base = ceilings()
  const directions = Object.fromEntries(Object.keys(base).map((k) => [k, 'ceiling' as const]))
  const key = 'WEB_BUNDLE_BUDGET.eager.sourceBytes'

  const run = (current: Record<string, number>) =>
    checkBaseline({
      instrument: 'web-bundle-budget',
      current,
      base,
      authorisations: [],
      enforced: Object.keys(directions),
      directions,
      how: '<test>',
      requireBase: true,
    })

  it('refuses the source ceiling edited upward with no authorisation', () => {
    // The move this ceiling has actually made seven times, each argued for only
    // in a comment beside it.
    expect(run({ ...base, [key]: (base[key] ?? 0) + 100_000 }).map((f) => f.check)).toEqual([
      'baseline-raised-without-authorisation',
    ])
  })

  it('accepts a paydown that brings it down', () => {
    expect(run({ ...base, [key]: (base[key] ?? 0) - 100_000 })).toEqual([])
  })

  it('accepts a raise that is argued for, and not one argued from the wrong number', () => {
    const from = base[key] ?? 0
    const to = from + 100_000
    const authorisation = {
      key,
      from,
      to,
      issue: 'POD-3905',
      reason: 'a test fixture reason written long enough to clear the minimum the ratchet requires',
    }
    expect(
      checkBaseline({
        instrument: 'web-bundle-budget',
        current: { ...base, [key]: to },
        base,
        authorisations: [authorisation],
        enforced: Object.keys(directions),
        directions,
        how: '<test>',
        requireBase: true,
      }),
    ).toEqual([])
    // The number an author cannot write from memory is the entire mechanism.
    expect(
      checkBaseline({
        instrument: 'web-bundle-budget',
        current: { ...base, [key]: to },
        base,
        authorisations: [{ ...authorisation, from: from - 1 }],
        enforced: Object.keys(directions),
        directions,
        how: '<test>',
        requireBase: true,
      }).map((f) => f.check),
    ).toEqual(['baseline-raised-without-authorisation'])
  })
})
