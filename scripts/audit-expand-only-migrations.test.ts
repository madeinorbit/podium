import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  APPROVED_CONTRACT_STEPS,
  findDestructiveDdl,
  PROBES,
  probeFailures,
  runChecks,
  unadmitted,
} from './audit-expand-only-migrations'

it('admits exactly the preserving tenant feed re-keys', () => {
  const path = 'apps/server/src/migrations/drizzle/20261111141656_tenant-sync-feed/migration.sql'
  const sql = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  expect(findDestructiveDdl(sql).map((finding) => finding.kind)).toEqual([
    'table-rebuild',
    'table-rebuild',
  ])
  expect(unadmitted(path, findDestructiveDdl(sql))).toEqual([])
  expect(unadmitted(path, findDestructiveDdl(`${sql}\nDROP TABLE users;`))).toHaveLength(1)
})

describe.each([
  {
    migration: '20261110205811_issue-panel-records',
    issue: 'POD-6778',
    kinds: ['drop-table', 'drop-column', 'drop-column', 'drop-column'],
  },
  {
    migration: '20261111124333_sync-log-only',
    issue: 'POD-6771',
    kinds: ['drop-table'],
  },
])('POD-6253 contract step $migration', ({ migration, issue, kinds }) => {
  const path = `apps/server/src/migrations/drizzle/${migration}/migration.sql`
  const sql = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const findings = findDestructiveDdl(sql)

  it('admits its intended drops only in its own file, with the authorizing issue', () => {
    expect(findings.map((finding) => finding.kind)).toEqual(kinds)
    expect(APPROVED_CONTRACT_STEPS.get(path)?.reason).toContain('POD-6253')
    expect(APPROVED_CONTRACT_STEPS.get(path)?.reason).toContain(issue)
    expect(unadmitted(path, findings)).toEqual([])
    expect(unadmitted('elsewhere.sql', findings)).toEqual(findings)
  })

  it('still rejects every repeated drop and unrelated destructive DDL', () => {
    for (const finding of findings) {
      expect(unadmitted(path, [...findings, finding])).toEqual([finding])
    }
    const extra = findDestructiveDdl('ALTER TABLE issues DROP COLUMN brief; DROP TABLE issues;')
    expect(unadmitted(path, [...findings, ...extra])).toEqual(extra)
  })
})

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
    expect(findDestructiveDdl('ALTER TABLE machines RENAME COLUMN a TO b;')[0]?.kind).toBe('rename')
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
    expect(findDestructiveDdl('ALTER TABLE machines ADD COLUMN k text NOT NULL;')[0]?.kind).toBe(
      'not-null-without-default',
    )
  })

  it('distinguishes CHECK predicates from real NOT NULL column constraints', () => {
    expect(
      findDestructiveDdl(`ALTER TABLE machines ADD public_key text
      CHECK (kind = 'key' AND public_key IS NOT NULL);`),
    ).toEqual([])
    expect(
      findDestructiveDdl(`ALTER TABLE machines ADD public_key text
      CHECK (length(public_key) > 0) NOT NULL;`)[0]?.kind,
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
    expect(findDestructiveDdl("INSERT INTO notes (body) VALUES ('DROP TABLE machines');")).toEqual(
      [],
    )
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

describe('the expand-only gate probes', () => {
  it('has one planted violation for every individual check', () => {
    expect(PROBES.map((probe) => probe.expect)).toEqual([
      'drop-table',
      'drop-column',
      'rename',
      'table-rebuild',
      'not-null-without-default',
    ])
  })

  it('can fire every planted violation', () => {
    expect(probeFailures()).toEqual([])
  })

  it('spares the real migration tree after its historical allowlist', () => {
    expect(runChecks()).toEqual([])
  })
})

describe('an approved contract step', () => {
  const [path] = [...APPROVED_CONTRACT_STEPS.keys()]
  const rebuild = (table: string) => `--> statement-breakpoint
CREATE TABLE \`__new_${table}\` (id text PRIMARY KEY);
--> statement-breakpoint
INSERT INTO \`__new_${table}\` SELECT id FROM \`${table}\`;--> statement-breakpoint
DROP TABLE \`${table}\`;--> statement-breakpoint
ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`

  it('carries a written reason', () => {
    for (const step of APPROVED_CONTRACT_STEPS.values())
      expect(step.reason.length).toBeGreaterThan(20)
  })

  it('admits the one rebuild it names, in its own file only', () => {
    if (!path) throw new Error('expected an approved contract step')
    expect(unadmitted(path, findDestructiveDdl(rebuild('messages')))).toEqual([])
    expect(unadmitted('elsewhere.sql', findDestructiveDdl(rebuild('messages')))).toHaveLength(1)
  })

  it('still fails anything else destructive in that file', () => {
    if (!path) throw new Error('expected an approved contract step')
    // Another table rebuilt, a second rebuild of the same table, a dropped column.
    expect(unadmitted(path, findDestructiveDdl(rebuild('sessions'))).map((f) => f.kind)).toEqual([
      'table-rebuild',
    ])
    expect(
      unadmitted(path, findDestructiveDdl(`${rebuild('messages')}\n${rebuild('messages')}`)),
    ).toHaveLength(1)
    expect(
      unadmitted(
        path,
        findDestructiveDdl(`${rebuild('messages')}\nALTER TABLE messages DROP COLUMN body;`),
      ).map((f) => f.kind),
    ).toEqual(['drop-column'])
  })
})

describe('an approved contract step that drops (POD-6114)', () => {
  const path =
    'apps/server/src/migrations/drizzle/20261015030733_workflow-agent-profiles/migration.sql'
  const drops = `DROP TABLE \`execution_profiles\`;--> statement-breakpoint
ALTER TABLE \`workflow_run_steps\` DROP COLUMN \`execution_profile_id\`;--> statement-breakpoint
ALTER TABLE \`workflow_run_steps\` DROP COLUMN \`execution_profile_json\`;--> statement-breakpoint
ALTER TABLE \`sessions\` DROP COLUMN \`execution_profile_id\`;`

  it('admits exactly the table and the columns it names, in its own file only', () => {
    expect(findDestructiveDdl(drops).map((f) => f.kind)).toEqual([
      'drop-table',
      'drop-column',
      'drop-column',
      'drop-column',
    ])
    expect(unadmitted(path, findDestructiveDdl(drops))).toEqual([])
    expect(unadmitted('elsewhere.sql', findDestructiveDdl(drops))).toHaveLength(4)
  })

  it('still fails another drop in that file, and a second drop of the same column', () => {
    expect(
      unadmitted(
        path,
        findDestructiveDdl(
          `${drops}\nALTER TABLE \`sessions\` DROP COLUMN \`agent_profile_id\`;\nDROP TABLE \`agent_profiles\`;`,
        ),
      ).map((f) => f.kind),
    ).toEqual(['drop-column', 'drop-table'])
    expect(
      unadmitted(
        path,
        findDestructiveDdl(
          `${drops}\nALTER TABLE \`sessions\` DROP COLUMN \`execution_profile_id\`;`,
        ),
      ),
    ).toHaveLength(1)
  })
})
