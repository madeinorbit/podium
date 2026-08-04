import { describe, expect, it } from 'vitest'
import { findDestructiveDdl } from './audit-expand-only-migrations'

describe('findDestructiveDdl', () => {
  it('passes a plain additive column', () => {
    expect(findDestructiveDdl('ALTER TABLE machines ADD COLUMN app_version text;')).toEqual([])
  })

  it('passes several additive columns', () => {
    const sql = `ALTER TABLE machines ADD COLUMN a text;
ALTER TABLE machines ADD COLUMN b text;`
    expect(findDestructiveDdl(sql)).toEqual([])
  })

  it('passes a new table and a new index', () => {
    const sql = `CREATE TABLE t (id text PRIMARY KEY);
CREATE INDEX t_idx ON t (id);`
    expect(findDestructiveDdl(sql)).toEqual([])
  })

  it('catches DROP TABLE', () => {
    expect(findDestructiveDdl('DROP TABLE machines;')[0]?.kind).toBe('drop-table')
  })

  it('catches DROP COLUMN', () => {
    expect(findDestructiveDdl('ALTER TABLE machines DROP COLUMN app_version;')[0]?.kind).toBe(
      'drop-column',
    )
  })

  it('catches a RENAME', () => {
    expect(
      findDestructiveDdl('ALTER TABLE machines RENAME COLUMN a TO b;')[0]?.kind,
    ).toBe('rename')
  })

  it('catches the SQLite table-rebuild dance', () => {
    // drizzle emits this for changes SQLite cannot do in place. It is a full
    // rewrite wearing three innocent statements.
    const sql = `CREATE TABLE __new_machines (id text PRIMARY KEY);
INSERT INTO __new_machines SELECT id FROM machines;
DROP TABLE machines;
ALTER TABLE __new_machines RENAME TO machines;`
    expect(findDestructiveDdl(sql).map((f) => f.kind)).toContain('table-rebuild')
  })

  it('catches NOT NULL with no default, which is additive in name only', () => {
    // The old binary does not know the column, so it cannot insert. The rollback
    // breaks writes even though nothing was dropped.
    expect(
      findDestructiveDdl('ALTER TABLE machines ADD COLUMN k text NOT NULL;')[0]?.kind,
    ).toBe('not-null-without-default')
  })

  it('passes NOT NULL WITH a default', () => {
    expect(
      findDestructiveDdl("ALTER TABLE machines ADD COLUMN k text NOT NULL DEFAULT '';"),
    ).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(findDestructiveDdl('drop table machines;')[0]?.kind).toBe('drop-table')
  })

  it('ignores the words inside a comment', () => {
    expect(findDestructiveDdl('-- we will DROP TABLE machines one day\nSELECT 1;')).toEqual([])
  })

  it('ignores the words inside a string literal', () => {
    expect(
      findDestructiveDdl("INSERT INTO notes (body) VALUES ('DROP TABLE machines');"),
    ).toEqual([])
  })

  it('reports the offending statement so a human can see what it caught', () => {
    const f = findDestructiveDdl('ALTER TABLE machines DROP COLUMN app_version;')[0]
    expect(f?.statement).toContain('DROP COLUMN')
  })

  it('reports every finding, not just the first', () => {
    const sql = `DROP TABLE a;
ALTER TABLE b DROP COLUMN c;`
    expect(findDestructiveDdl(sql)).toHaveLength(2)
  })
})
