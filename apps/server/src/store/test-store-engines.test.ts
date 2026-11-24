/**
 * `apps/server/test-store-engines.json` names only server-shard files, gives every
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
  serverShardFiles,
  storeShardFiles,
  testStoreEngineProblems,
} from '../test-support/test-store-engines'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('test-store-engines.json', () => {
  it('names only server-shard files, each SQLite-only one with a reason, none twice', () => {
    const engines = readTestStoreEngines()
    expect(
      testStoreEngineProblems(
        engines,
        storeShardFiles(repositoryRoot),
        serverShardFiles(repositoryRoot),
        (file) => existsSync(join(repositoryRoot, file)),
      ),
    ).toEqual([])
  })

  it('leaves the Postgres leg the store shard minus both lists, plus beyondStoreShard', () => {
    const leg = postgresLegFiles(repositoryRoot)
    expect(leg).toContain('apps/server/src/store/test-store-engines.test.ts')
    expect(leg).toContain('apps/server/src/store/pg-test-database.test.ts')
    // A Postgres audit from another shard (POD-6992).
    expect(leg).toContain('apps/server/src/store/query-plan-audit.pg.test.ts')
    // Composition imports moved these out of the cache's store shard [POD-7559].
    for (const file of [
      'apps/server/src/auth-route.test.ts',
      'apps/server/src/modules/agent-profiles/service.test.ts',
      'apps/server/src/mail-send.statement-count.test.ts',
      'apps/server/src/session-companions.test.ts',
      'apps/server/src/modules/sessions/oracle-decomposition.test.ts',
    ])
      expect(leg).toContain(file)
    expect(new Set(leg).size).toBe(leg.length)
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

  it('keeps SQLite-only and pending exclusions after files move out of the store shard', () => {
    const engines = readTestStoreEngines()
    const file = 'apps/server/src/auth-route.test.ts'
    expect(storeShardFiles(repositoryRoot)).not.toContain(file)
    expect(postgresLegFiles(repositoryRoot)).toContain(file)
    expect(
      postgresLegFiles(repositoryRoot, {
        ...engines,
        sqliteOnly: {
          ...engines.sqliteOnly,
          [file]: 'SQLite-specific fixture in another cache shard',
        },
      }),
    ).not.toContain(file)
    expect(
      postgresLegFiles(repositoryRoot, {
        ...engines,
        pending: [file],
      }),
    ).not.toContain(file)
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
      ['a.test.ts', 'b.test.ts', 'missing.test.ts', 'boot.test.ts'],
      (file) => file !== 'missing.test.ts',
    )
    expect(problems).toEqual([
      'sqliteOnly a.test.ts needs a reason',
      'sqliteOnly names gone.test.ts, which is not a server-shard file',
      'a.test.ts is both sqliteOnly and pending',
      'pending lists b.test.ts twice',
      'beyondStoreShard names b.test.ts, which is a store-shard file',
      'b.test.ts is both beyondStoreShard and excluded from the Postgres leg',
      'beyondStoreShard names missing.test.ts, which does not exist',
      'beyondStoreShard boot.test.ts needs a reason',
    ])
  })
})
