import { describe, expect, it } from 'vitest'
import {
  adjudicate,
  findTighteningDdl,
  lossBetween,
  PROBES,
  parseContractDeclaration,
  probeFailures,
  runChecks,
  type SchemaShape,
} from './audit-expand-only-migrations'

const shape = (tables: Record<string, string[]>): SchemaShape =>
  new Map(Object.entries(tables).map(([table, columns]) => [table, new Set(columns)]))

const earlier = new Set(['20260101000000_the-expand'])

describe('lossBetween — what a migration actually destroyed', () => {
  it('sees nothing lost when a column is added', () => {
    expect(lossBetween(shape({ t: ['a'] }), shape({ t: ['a', 'b'] }))).toEqual([])
  })

  it('sees nothing lost when a whole table is added', () => {
    expect(lossBetween(shape({ t: ['a'] }), shape({ t: ['a'], u: ['a'] }))).toEqual([])
  })

  it('names a dropped column', () => {
    expect(lossBetween(shape({ t: ['a', 'b'] }), shape({ t: ['a'] }))).toEqual(['t.b'])
  })

  it('names a dropped table once, not once per column', () => {
    expect(lossBetween(shape({ t: ['a', 'b', 'c'] }), shape({}))).toEqual(['table t'])
  })

  it('is blind to the order the columns are declared in', () => {
    // A rebuild reorders columns constantly; that is not a loss.
    expect(lossBetween(shape({ t: ['a', 'b'] }), shape({ t: ['b', 'a'] }))).toEqual([])
  })
})

describe('findTighteningDdl — the check replay cannot make', () => {
  it('catches NOT NULL with no default, which is additive in name only', () => {
    // The old binary does not know the column, so it cannot insert. The rollback
    // breaks writes even though nothing was dropped.
    expect(findTighteningDdl('ALTER TABLE machines ADD COLUMN k text NOT NULL;')).toHaveLength(1)
  })

  it('passes NOT NULL WITH a default', () => {
    expect(
      findTighteningDdl("ALTER TABLE machines ADD COLUMN k text NOT NULL DEFAULT '';"),
    ).toEqual([])
  })

  it('passes a plain additive column', () => {
    expect(findTighteningDdl('ALTER TABLE machines ADD COLUMN app_version text;')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(findTighteningDdl('alter table machines add column k text not null;')).toHaveLength(1)
  })

  it('ignores the words inside a comment', () => {
    expect(findTighteningDdl('-- ADD COLUMN k text NOT NULL one day\nSELECT 1;')).toEqual([])
  })

  it('ignores the words inside a string literal', () => {
    expect(
      findTighteningDdl("INSERT INTO notes (body) VALUES ('ADD COLUMN k text NOT NULL');"),
    ).toEqual([])
  })

  it('reports the offending statement so a human can see what it caught', () => {
    expect(findTighteningDdl('ALTER TABLE machines ADD COLUMN k text NOT NULL;')[0]).toContain(
      'NOT NULL',
    )
  })
})

describe('parseContractDeclaration', () => {
  it('is absent unless the migration says so', () => {
    expect(parseContractDeclaration('ALTER TABLE t DROP COLUMN c;')).toBeNull()
  })

  it('reads the whole declaration', () => {
    const sql = `-- expand-only: contract-step
-- retires: issues.assignee
-- expanded-in: 20260101000000_the-expand
-- reason: the backfill adjudicated every value
ALTER TABLE issues DROP COLUMN assignee;`
    expect(parseContractDeclaration(sql)).toEqual({
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: 'the backfill adjudicated every value',
    })
  })

  it('reads several retired names, however they are spelled across lines', () => {
    const sql = `-- expand-only: contract-step
-- retires: t.a, t.b
-- retires: table u
-- expanded-in: 20260101000000_the-expand
-- reason: because
DROP TABLE u;`
    expect(parseContractDeclaration(sql)?.retires).toEqual(['t.a', 't.b', 'table u'])
  })
})

describe('adjudicate — measurement against declaration', () => {
  it('says nothing when nothing was destroyed', () => {
    expect(adjudicate({ lost: [], declaration: null, earlier })).toEqual([])
  })

  it('reports an undeclared drop', () => {
    const findings = adjudicate({ lost: ['issues.assignee'], declaration: null, earlier })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('column-dropped')
    expect(findings[0]?.detail).toContain('issues.assignee')
  })

  it('distinguishes a dropped table from a dropped column', () => {
    expect(adjudicate({ lost: ['table u'], declaration: null, earlier })[0]?.kind).toBe(
      'table-dropped',
    )
  })

  it('accepts a declaration that accounts for the loss exactly', () => {
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: 'the backfill adjudicated every value',
    }
    expect(adjudicate({ lost: ['issues.assignee'], declaration, earlier })).toEqual([])
  })

  it('refuses a declaration that smuggles a second drop past it', () => {
    // The load-bearing half: a declaration is a receipt for named items, never a
    // blanket pardon for whatever else the migration happens to destroy.
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: 'because',
    }
    const findings = adjudicate({
      lost: ['issues.assignee', 'issues.owner_user_id'],
      declaration,
      earlier,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('undeclared-loss')
    expect(findings[0]?.detail).toContain('issues.owner_user_id')
  })

  it('refuses a declaration that retires something it does not destroy', () => {
    // A stale declaration copied from the migration next door reads as authority
    // it has not earned.
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: 'because',
    }
    expect(adjudicate({ lost: [], declaration, earlier })[0]?.kind).toBe(
      'declaration-retires-nothing',
    )
  })

  it('refuses an expand that does not exist', () => {
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '99999999999999_never-happened',
      reason: 'because',
    }
    expect(adjudicate({ lost: ['issues.assignee'], declaration, earlier })[0]?.kind).toBe(
      'unknown-expand',
    )
  })

  it('refuses an expand that is not among the migrations running before this one', () => {
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: 'because',
    }
    expect(
      adjudicate({ lost: ['issues.assignee'], declaration, earlier: new Set<string>() })[0]?.kind,
    ).toBe('unknown-expand')
  })

  it('refuses a declaration with no reason for the reviewer', () => {
    const declaration = {
      retires: ['issues.assignee'],
      expandedIn: '20260101000000_the-expand',
      reason: null,
    }
    const findings = adjudicate({ lost: ['issues.assignee'], declaration, earlier })
    expect(findings.map((finding) => finding.detail.includes('reason'))).toContain(true)
  })
})

describe('the expand-only gate probes', () => {
  it('fires every planted violation and spares every planted innocent', () => {
    expect(probeFailures()).toEqual([])
  })

  it('keeps a probe that asserts SILENCE for a column-preserving rebuild', () => {
    // This is the negative control, and it is the one that must never be deleted.
    // Twenty of this gate's twenty-two findings were column-preserving rebuilds —
    // drizzle's mechanical workaround for the ALTERs SQLite cannot do in place.
    // Re-broadening the gate back to "every rebuild is destructive" turns this
    // probe red instead of turning the whole tree red for a month (PDM-298).
    const preserving = PROBES.find((probe) => probe.name.includes('PRESERVES every column'))
    expect(preserving?.expect).toEqual([])
  })

  it('proves a declaration cannot launder an undeclared drop', () => {
    const smuggler = PROBES.find((probe) => probe.name.includes('smuggles'))
    expect(smuggler?.expect).toEqual(['undeclared-loss'])
  })
})

/**
 * The real tree, and the two migrations that genuinely destroy data without
 * declaring a contract step. Both drop a column in the SAME release as the change
 * that replaced it, which is precisely what expand-only forbids; both are filed
 * rather than fixed here, because adjudicating them is a schema decision and this
 * issue was about the instrument (PDM-298).
 *
 * This roster is a ratchet, not an allowlist: a NEW destructive migration fails
 * this test by name. Shrink it when one is resolved; never extend it to make a
 * red go away.
 */
const KNOWN_UNDECLARED_DROPS = [
  'apps/server/src/migrations/drizzle/20260826195939_supervisor-machine-presence/migration.sql',
  'apps/server/src/migrations/drizzle/20260912164255_a2-retire-issue-assignee/migration.sql',
]

describe('the real migration tree', () => {
  it('destroys nothing beyond the two known undeclared drops', () => {
    expect(
      runChecks()
        .map((finding) => finding.where)
        .sort(),
    ).toEqual(KNOWN_UNDECLARED_DROPS)
  })

  it('names what each one destroys, so the finding is the record', () => {
    expect(runChecks().map((finding) => finding.detail)).toEqual([
      'machines.supervised is destroyed with no contract-step declaration',
      'issues.assignee is destroyed with no contract-step declaration',
    ])
  })
})
