/**
 * THE DERIVED-FAMILY GATE'S OWN TESTS (POD-314).
 *
 * `--probe` already runs planted fixtures through every check on every
 * invocation, so the gate cannot report green with a parser that has stopped
 * matching. This file exists because the PROBE IS NOT IN A LANE: it runs when
 * someone runs the audit, and the coordinator's rule is that a check nobody's CI
 * invokes proves nothing after the session ends. These cases put the same claims
 * where `bun run test` finds them.
 *
 * Each case asserts BOTH directions — the check fires on a violation and stays
 * silent on the clean shape — because a check that only ever fires is as useless
 * as one that never does.
 */

import { describe, expect, it } from 'vitest'
import {
  auditDerivedFamilies,
  foreignTableImports,
  GOVERNED,
  handRolledProcedures,
  importedSymbols,
  tablesExist,
} from './audit-derived-families'

const MODULES = 'apps/server/src/modules'
const PROBE_GOVERNED = [{ table: 'APPROVAL_COMMANDS_TRPC', module: 'approvals' }]
const ownArm = {
  file: `${MODULES}/approvals/trpc.ts`,
  source: "import { APPROVAL_COMMANDS_TRPC } from './registry'\n",
}

describe('the import parser', () => {
  it('reads the shapes biome actually produces', () => {
    const parsed = importedSymbols(
      "import { a, b as c } from './x'\nimport type { D } from './y'\nimport {\n  E,\n  F,\n} from './z'\n",
    )
    expect(parsed).toHaveLength(3)
    // `b as c` is the RENAME case: the gate must key on the exported name, or a
    // side door opens by importing the table under another identifier.
    expect(parsed[0]?.symbols).toEqual(['a', 'b'])
    expect(parsed[1]?.symbols).toEqual(['D'])
    // Multi-line is not an edge case here — it is what biome emits as soon as an
    // import list grows, and POD-301 hit exactly this class when a reflow made a
    // detector stop matching.
    expect(parsed[2]?.symbols).toEqual(['E', 'F'])
  })
})

describe('foreign-table-import', () => {
  it('fires when a file outside the family imports its joined table', () => {
    const found = foreignTableImports(
      [
        ownArm,
        {
          file: 'apps/server/src/sneaky.ts',
          source: "import { APPROVAL_COMMANDS_TRPC } from './modules/approvals/registry'\n",
        },
      ],
      PROBE_GOVERNED,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.where).toBe('apps/server/src/sneaky.ts')
  })

  it('stays silent when the family imports its OWN table', () => {
    // The direction that matters most: a check forbidding the legitimate use is
    // one that gets disabled the first time it inconveniences someone.
    expect(foreignTableImports([ownArm], PROBE_GOVERNED)).toEqual([])
  })

  it('catches the table imported under an alias', () => {
    const found = foreignTableImports(
      [
        {
          file: 'apps/server/src/sneaky.ts',
          source: "import { APPROVAL_COMMANDS_TRPC as T } from './modules/approvals/registry'\n",
        },
      ],
      PROBE_GOVERNED,
    )
    expect(found).toHaveLength(1)
  })
})

describe('hand-rolled-procedure', () => {
  it('fires when a derived arm builds a procedure itself', () => {
    const found = handRolledProcedures([
      {
        file: `${MODULES}/approvals/trpc.ts`,
        source: 'export const x = t.procedure.mutation(() => 1)\n',
      },
    ])
    expect(found).toHaveLength(1)
  })

  it('exempts the arms that predate the builder', () => {
    // Eight families landed their cutovers before POD-314 and are not its to
    // rewrite; three carry per-family rules the builder does not model.
    expect(
      handRolledProcedures([
        {
          file: `${MODULES}/sessions/trpc.ts`,
          source: 'export const x = t.procedure.mutation(() => 1)\n',
        },
      ]),
    ).toEqual([])
  })
})

describe('subject-present', () => {
  it('fires when a governed table no longer exists', () => {
    const found = tablesExist(PROBE_GOVERNED, () => 'export const SOMETHING_ELSE = {}')
    expect(found).toHaveLength(1)
    expect(found[0]?.check).toBe('subject-present')
  })

  it('short-circuits the absence checks, so a lost subject cannot read as green', () => {
    // THE POINT OF THE WHOLE FILE. Every other check is an ABSENCE claim, and an
    // absence claim about a table that does not exist is satisfied by anything —
    // so a missing subject must SUPPRESS them rather than be reported beside a
    // green they cannot justify.
    const found = auditDerivedFamilies(
      [
        {
          file: 'apps/server/src/sneaky.ts',
          source: "import { APPROVAL_COMMANDS_TRPC } from './modules/approvals/registry'\n",
        },
      ],
      PROBE_GOVERNED,
      () => 'export const SOMETHING_ELSE = {}',
    )
    expect(found.every((f) => f.check === 'subject-present')).toBe(true)
  })
})

describe('the governed list', () => {
  it('covers POD-314s eleven families', () => {
    // Pinned, because a list that silently shrank would take the gate's coverage
    // with it while every case above still passed.
    expect(GOVERNED).toHaveLength(11)
    expect(new Set(GOVERNED.map((g) => g.module)).size).toBe(9)
  })
})
