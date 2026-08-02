/**
 * The god-object audit, run as a test so CI executes it — `bun run test` is what
 * CI runs, and an auditor nobody invokes is an auditor that proves nothing.
 *
 * THE POINT OF THIS FILE IS THE REFUSALS, NOT THE PASS. An auditor whose only
 * test is "today's tree is clean" goes green forever the day somebody breaks its
 * glob, mistypes a path, or widens a predicate until nothing can fail it. So
 * every check below is asserted in BOTH directions: pointed at a tree or a
 * ledger that violates it, and pointed at one that does not.
 */

import { describe, expect, it } from 'vitest'
import {
  auditRepo,
  checkArgument,
  checkBudget,
  checkPredicate,
  checkStale,
  checkUnexplained,
  GOD_OBJECT_LEDGER,
  type LedgerEntry,
  type Measurement,
  measure,
  probe,
  screen,
  stripComments,
  THRESHOLD,
} from './audit-god-objects'

const M = (over: Partial<Measurement> = {}): Measurement => ({
  file: 'probe/module.ts',
  physical: 900,
  code: 700,
  runtimeExports: [],
  exportedClasses: ['One'],
  hasInheritance: false,
  controlFlow: 0,
  imports: [],
  privateFields: [],
  privateStateFields: [],
  methodCount: 10,
  meanMethodLines: 20,
  maxMethodLines: 40,
  topLevelStatements: 0,
  ...over,
})

const ENTRY = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  file: 'probe/module.ts',
  kind: 'operation-surface',
  budget: 1000,
  review: 'POD-1385',
  argument:
    'A fixture argument long enough to clear the length floor so that the length check is not what these cases are accidentally measuring when they expect a clean result from some other check entirely.',
  ...over,
})

describe('the instrument can say YES', () => {
  it('finds every planted fixture and spares every clean one', () => {
    expect(probe()).toEqual([])
  })
})

describe('it refuses a tree that violates the ceiling', () => {
  it('reports a module over the threshold that no ledger entry answers for', () => {
    const findings = checkUnexplained([M({ file: 'apps/server/src/huge.ts', physical: 2955 })], [])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.check).toBe('unexplained-god-object')
    expect(findings[0]?.where).toBe('apps/server/src/huge.ts')
  })

  it('does NOT report the same module once an entry answers for it', () => {
    expect(
      checkUnexplained(
        [M({ file: 'apps/server/src/huge.ts', physical: 2955 })],
        [ENTRY({ file: 'apps/server/src/huge.ts' })],
      ),
    ).toEqual([])
  })

  /**
   * The failure this whole design exists to prevent: an exception that outlives
   * the argument that justified it. Each case mutates ONE fact about the file
   * and requires the audit to notice.
   */
  it.each([
    {
      what: 'a type-only module that grew a runtime export',
      m: M({ runtimeExports: ['nowItRuns'] }),
      e: ENTRY({ kind: 'type-declarations' }),
    },
    {
      what: 'a declaration table that also started shipping a class',
      m: M({ exportedClasses: ['Dispatcher'], runtimeExports: ['TABLE', 'Dispatcher'] }),
      e: ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
    },
    {
      what: 'a documented module whose CODE crossed the line',
      m: M({ code: THRESHOLD + 1 }),
      e: ENTRY({ kind: 'documented' }),
    },
    {
      what: 'a surface that accumulated shared state',
      m: M({ privateStateFields: ['a', 'b', 'c'] }),
      e: ENTRY({ kind: 'operation-surface' }),
    },
    {
      what: 'a surface hiding one very long method',
      m: M({ maxMethodLines: 400 }),
      e: ENTRY({ kind: 'operation-surface' }),
    },
    {
      what: 'an owner holding state its entry never declared',
      m: M({ privateFields: ['named', 'hidden'], privateStateFields: ['named', 'hidden'] }),
      e: ENTRY({ kind: 'cohesive-owner', protectedState: ['named'] }),
    },
    {
      what: 'a capability composition that grew an inheritance chain',
      m: M({ hasInheritance: true, imports: ['./a', './b'] }),
      e: ENTRY({ kind: 'capability-composition', capabilities: ['./a', './b'] }),
    },
  ])('refuses $what', ({ m, e }) => {
    const findings = checkPredicate([m], [e], true, 'apps/server/src/relay.ts')
    expect(findings.map((f) => f.check)).toContain('exception-predicate-failed')
  })

  it('refuses a module that outgrew its reviewed budget', () => {
    expect(checkBudget([M({ physical: 1001 })], [ENTRY({ budget: 1000 })])).toHaveLength(1)
    expect(checkBudget([M({ physical: 1000 })], [ENTRY({ budget: 1000 })])).toEqual([])
  })

  it('refuses an entry whose file no longer needs one', () => {
    expect(checkStale([], [ENTRY()])).toHaveLength(1)
  })

  it('refuses an argument that is a shrug', () => {
    expect(checkArgument([ENTRY({ argument: 'this file is big' })])).toHaveLength(1)
  })

  /**
   * The composition root's predicate depends on evidence generated OUTSIDE this
   * instrument. If the construction-order record stops reporting zeros, the root
   * loses its exception — it does not keep it because the file did not change.
   */
  it('refuses the composition root when the construction record is not clean', () => {
    const root = 'apps/server/src/relay.ts'
    const asClean = checkPredicate(
      [M({ file: root })],
      [ENTRY({ file: root, kind: 'composition-root' })],
      true,
      root,
    )
    const asDirty = checkPredicate(
      [M({ file: root })],
      [ENTRY({ file: root, kind: 'composition-root' })],
      false,
      root,
    )
    expect(asClean).toEqual([])
    expect(asDirty).toHaveLength(1)
  })
})

describe('the measurement itself', () => {
  it('does not count comments or blank lines as code', () => {
    const m = measure('x.ts', '/* a\n b */\n// c\nconst x = 1\n\nconst y = 2\n')
    expect(m.physical).toBe(6)
    expect(m.code).toBe(2)
  })

  it('keeps a // inside a string from blanking the rest of the line', () => {
    expect(stripComments(`const u = 'http://x' // gone\n`)).toBe(`const u = 'http://x' \n`)
  })

  it('separates injected collaborators from owned state', () => {
    const m = measure(
      'x.ts',
      'class A {\n  private readonly dep: Dep\n  private readonly cache = new Map()\n  private cursor = 0\n}\n',
    )
    expect(m.privateStateFields).toContain('cache')
    expect(m.privateStateFields).toContain('cursor')
    expect(m.privateStateFields).not.toContain('dep')
  })
})

describe('the ledger describes the tree it is committed with', () => {
  it('carries no entry for a module that is not over the threshold', () => {
    // Catches the ledger rotting after a decomposition lands: the argument for a
    // file that no longer needs one is not evidence, it is noise.
    expect(checkStale(screen(), GOD_OBJECT_LEDGER)).toEqual([])
  })

  it('every accepted exception still satisfies its structural claim', () => {
    const measured = screen()
    const known = new Set(GOD_OBJECT_LEDGER.map((e) => e.file))
    const findings = auditRepo().filter((f) => f.check !== 'unexplained-god-object')
    expect(findings).toEqual([])
    // And the entries are about modules that exist.
    for (const entry of GOD_OBJECT_LEDGER)
      expect(
        measured.some((m) => m.file === entry.file),
        `${entry.file} is not in the screen`,
      ).toBe(true)
    expect(known.size).toBe(GOD_OBJECT_LEDGER.length)
  })
})
