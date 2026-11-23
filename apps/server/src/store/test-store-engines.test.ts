/**
 * `apps/server/test-store-engines.json` names only store-shard files, gives every
 * SQLite-only file a reason, and lists no file twice [POD-6980]. Database-free.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PG_LEG_SELECTION_ENV,
  postgresLegFiles,
  readTestStoreEngines,
  storeShardFiles,
  testStoreEngineProblems,
} from '../test-support/test-store-engines'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('test-store-engines.json', () => {
  it('names only store-shard files, each SQLite-only one with a reason, none twice', () => {
    const engines = readTestStoreEngines()
    expect(
      testStoreEngineProblems(engines, storeShardFiles(repositoryRoot), (file) =>
        existsSync(join(repositoryRoot, file)),
      ),
    ).toEqual([])
  })

  it('leaves the Postgres leg the store shard minus both lists, plus beyondStoreShard', () => {
    const leg = postgresLegFiles(repositoryRoot)
    expect(leg).toContain('apps/server/src/store/test-store-engines.test.ts')
    expect(leg).toContain('apps/server/src/store/pg-test-database.test.ts')
    // A Postgres audit from another shard (POD-6992).
    expect(leg).toContain('apps/server/src/store/query-plan-audit.pg.test.ts')
    const engines = readTestStoreEngines()
    for (const file of leg) {
      expect(engines.pending).not.toContain(file)
      expect(Object.keys(engines.sqliteOnly)).not.toContain(file)
    }
    for (const file of Object.keys(engines.beyondStoreShard)) expect(leg).toContain(file)
  })

  it('runs only the pending files when asked to', () => {
    const engines = readTestStoreEngines()
    expect(
      postgresLegFiles(repositoryRoot, engines, { [PG_LEG_SELECTION_ENV]: 'pending' }),
    ).toEqual([...engines.pending])
  })

  it('reports a stale entry, a missing reason and a file in both lists', () => {
    const problems = testStoreEngineProblems(
      {
        sqliteOnly: { 'a.test.ts': 'short', 'gone.test.ts': 'a reason long enough to count' },
        pending: ['a.test.ts', 'b.test.ts', 'b.test.ts'],
        beyondStoreShard: {
          'b.test.ts': 'a reason long enough to count',
          'missing.test.ts': 'a reason long enough to count',
          'boot.test.ts': 'short',
        },
      },
      ['a.test.ts', 'b.test.ts'],
      (file) => file !== 'missing.test.ts',
    )
    expect(problems).toEqual([
      'sqliteOnly a.test.ts needs a reason',
      'sqliteOnly names gone.test.ts, which is not a store-shard file',
      'a.test.ts is both sqliteOnly and pending',
      'pending lists b.test.ts twice',
      'beyondStoreShard names b.test.ts, which is a store-shard file',
      'beyondStoreShard names missing.test.ts, which does not exist',
      'beyondStoreShard boot.test.ts needs a reason',
    ])
  })
})
