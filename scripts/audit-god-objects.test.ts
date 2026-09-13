/**
 * The god-object audit's first sibling test — POD-3905.
 *
 * It had none. `--probe` plants a violation for every check on every run, which
 * is stronger than most tests, so this file deliberately does NOT re-run the
 * probe's cases. It covers the two things the probe cannot reach: that the
 * budgets are still shaped so `audit-committed-floors.ts` can read them out of
 * history, and that a raise to one is actually refused.
 *
 * Written against the real file, not a fixture. A fixture would prove the
 * parser works on a shape nobody ships; the question here is whether the shape
 * ON DISK is one the census can see, and only the real file answers it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { everyKeyIs, qualify } from './audit-committed-floors'
import {
  checkBudget,
  checkLedgerBudgets,
  GOD_OBJECT_BUDGET,
  GOD_OBJECT_LEDGER,
  type LedgerEntry,
  type Measurement,
} from './audit-god-objects'
import { checkBaseline, constantsInFile, REPO_ROOT } from './baseline-ratchet'

const SOURCE = 'scripts/audit-god-objects.ts'

const M = (over: Partial<Measurement>): Measurement => ({
  file: 'probe/module.ts',
  physical: 900,
  code: 700,
  runtimeExports: [],
  exportedClasses: [],
  hasInheritance: false,
  controlFlow: 0,
  imports: [],
  privateFields: [],
  privateStateFields: [],
  methodCount: 1,
  meanMethodLines: 10,
  maxMethodLines: 10,
  topLevelStatements: 0,
  ...over,
})

const ENTRY = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  file: 'probe/module.ts',
  kind: 'operation-surface',
  review: 'POD-3905',
  argument: 'x'.repeat(200),
  ...over,
})

describe('the budgets are readable out of history', () => {
  it('parses every budget out of the file text, without importing it', () => {
    // The census never imports a guarded script — it reads the commit the
    // branch started from, where there is no module to import. If the parser
    // and the module ever disagree about what the budgets are, the ratchet is
    // guarding numbers the audit does not use.
    expect(qualify(constantsInFile(SOURCE, 'GOD_OBJECT_BUDGET'), 'GOD_OBJECT_BUDGET')).toEqual(
      Object.fromEntries(
        Object.entries(GOD_OBJECT_BUDGET).map(([k, v]) => [`GOD_OBJECT_BUDGET.${k}`, v]),
      ),
    )
  })

  it('keys every budget by its module path, never by position in the ledger', () => {
    // An array index is not a stable key: inserting one entry renumbers every
    // budget after it, and the ratchet would report a raise on each. This is
    // the property that makes per-module keys usable at all.
    for (const key of Object.keys(GOD_OBJECT_BUDGET))
      expect(key).toMatch(/^apps\/server\/src\/.+\.ts$/)
  })

  it('leaves no budget written inline in a ledger entry', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Adding `budget: 1200` back to an
    // entry would put a raisable number somewhere the census cannot see, and
    // every other check here would stay green while it happened.
    const sf = ts.createSourceFile(
      SOURCE,
      readFileSync(join(REPO_ROOT, SOURCE), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const inlineBudgets: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sf) === 'budget' &&
        ts.isNumericLiteral(node.initializer)
      )
        inlineBudgets.push(node.initializer.text)
      ts.forEachChild(node, walk)
    }
    walk(sf)
    expect(inlineBudgets).toEqual([])
  })
})

describe('checkLedgerBudgets', () => {
  it('is clean when the ledger and the budgets describe the same modules', () => {
    expect(checkLedgerBudgets(GOD_OBJECT_LEDGER, GOD_OBJECT_BUDGET)).toEqual([])
  })

  it('fails an entry with no budget — nothing would bound its growth', () => {
    expect(checkLedgerBudgets([ENTRY()], {}).map((f) => f.check)).toEqual(['budget-missing'])
  })

  it('fails a budget with no entry — a guarded number no audit reads', () => {
    expect(checkLedgerBudgets([], { 'probe/module.ts': 1000 }).map((f) => f.check)).toEqual([
      'budget-orphaned',
    ])
  })
})

describe('checkBudget reads the record', () => {
  it('fires one line over, and not at the budget', () => {
    const budgets = { 'probe/module.ts': 1000 }
    expect(checkBudget([M({ physical: 1001 })], [ENTRY()], budgets).map((f) => f.check)).toEqual([
      'review-budget-exceeded',
    ])
    expect(checkBudget([M({ physical: 1000 })], [ENTRY()], budgets)).toEqual([])
  })

  it('says nothing about a module whose budget is missing — that is the other check', () => {
    // Two findings for one defect sends the reader after the wrong repair.
    expect(checkBudget([M({ physical: 99_999 })], [ENTRY()], {})).toEqual([])
  })
})

describe('a raise to a budget is refused', () => {
  const base = qualify(constantsInFile(SOURCE, 'GOD_OBJECT_BUDGET'), 'GOD_OBJECT_BUDGET')
  const directions = everyKeyIs(SOURCE, 'GOD_OBJECT_BUDGET', 'ceiling')
  const key = 'GOD_OBJECT_BUDGET.apps/server/src/server.ts'

  const run = (current: Record<string, number>) =>
    checkBaseline({
      instrument: 'audit-god-objects',
      current,
      base,
      authorisations: [],
      enforced: Object.keys(directions),
      directions,
      how: '<test>',
      requireBase: true,
    })

  it('has the key it is about, so this test cannot pass by naming nothing', () => {
    expect(Object.keys(base)).toContain(key)
  })

  it('refuses a budget edited upward with no authorisation', () => {
    const raised = { ...base, [key]: (base[key] ?? 0) + 1 }
    expect(run(raised).map((f) => ({ check: f.check, where: f.where }))).toEqual([
      { check: 'baseline-raised-without-authorisation', where: `audit-god-objects:${key}` },
    ])
  })

  it('lets a budget come DOWN for free — tightening is the outcome it wants', () => {
    expect(run({ ...base, [key]: (base[key] ?? 0) - 1 })).toEqual([])
  })

  it('is clean when nothing moved', () => {
    expect(run({ ...base })).toEqual([])
  })
})
