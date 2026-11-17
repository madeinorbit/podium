/**
 * `apps/server/test-store-engines.json` names only store-shard files, gives every
 * SQLite-only file a reason, and lists no file twice [POD-6980]; no file it leaves on the
 * Postgres leg opens a store that cannot boot there yet [POD-7098]. Database-free.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  serverSupportFiles,
  storeOpeners,
  storeOpeningFiles,
} from '../test-support/store-opening-files'
import {
  postgresLegFiles,
  readTestStoreEngines,
  storeShardFiles,
  testStoreEngineProblems,
} from '../test-support/test-store-engines'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('test-store-engines.json', () => {
  it('names only store-shard files, each SQLite-only one with a reason, none twice', () => {
    const engines = readTestStoreEngines()
    expect(testStoreEngineProblems(engines, storeShardFiles(repositoryRoot))).toEqual([])
  })

  it('leaves the Postgres leg the store shard minus both lists, including this file', () => {
    const leg = postgresLegFiles(repositoryRoot)
    expect(leg).toContain('apps/server/src/store/test-store-engines.test.ts')
    expect(leg).toContain('apps/server/src/store/pg-test-database.test.ts')
    const engines = readTestStoreEngines()
    for (const file of leg) {
      expect(engines.pending).not.toContain(file)
      expect(Object.keys(engines.sqliteOnly)).not.toContain(file)
    }
  })

  // Until a Postgres store can boot (POD-6994; this case goes with it), a full store open
  // on the leg fails with PostgresStoreBootError. The lists alone could not see that: seven
  // files that open a store reached the leg unlisted (POD-7098).
  it('runs no file on the Postgres leg that opens a store without reading the engine', () => {
    const openers = storeOpeners(serverSupportFiles(repositoryRoot))
    // The helpers are found by reading their bodies, one through another.
    expect(openers).toContain('openWorkspaceStores')
    expect(openers).toContain('makeOracle')
    expect(openers).not.toContain('waitFor')
    const leg = postgresLegFiles(repositoryRoot).map((file) => ({
      file,
      source: readFileSync(join(repositoryRoot, file), 'utf8'),
    }))
    expect(storeOpeningFiles(leg, openers)).toEqual([])
  })

  it('reports a planted store open, through a helper too, and trusts a file that reads the engine', () => {
    const openers = storeOpeners([
      {
        file: 'apps/server/src/test-support/planted.ts',
        source:
          "import { openTestStore } from './open-test-store'\n" +
          'export async function plantedStores() { return [await openTestStore()] }\n' +
          'export const plantedOther = async () => await plantedStores()\n' +
          'export function plantedPure() { return 1 }\n',
      },
    ])
    expect([...openers].filter((name) => name.startsWith('planted')).sort()).toEqual([
      'plantedOther',
      'plantedStores',
    ])
    expect(
      storeOpeningFiles(
        [
          { file: 'a.test.ts', source: "it('x', async () => { await openTestStore(':memory:') })" },
          {
            file: 'b.test.ts',
            source: 'const s = await plantedOther()\nconst t = SessionStore.open()',
          },
          { file: 'c.test.ts', source: 'plantedPure()' },
          {
            file: 'd.test.ts',
            source: "const skip = testStoreEngine() === 'pg'\nawait openTestStore()",
          },
        ],
        openers,
      ),
    ).toEqual([
      'a.test.ts opens a store (openTestStore)',
      'b.test.ts opens a store (SessionStore.open, plantedOther)',
    ])
  })

  it('reports a stale entry, a missing reason and a file in both lists', () => {
    const problems = testStoreEngineProblems(
      {
        sqliteOnly: { 'a.test.ts': 'short', 'gone.test.ts': 'a reason long enough to count' },
        pending: ['a.test.ts', 'b.test.ts', 'b.test.ts'],
      },
      ['a.test.ts', 'b.test.ts'],
    )
    expect(problems).toEqual([
      'sqliteOnly a.test.ts needs a reason',
      'sqliteOnly names gone.test.ts, which is not a store-shard file',
      'a.test.ts is both sqliteOnly and pending',
      'pending lists b.test.ts twice',
    ])
  })
})
