/**
 * No file `apps/server/test-store-engines.json` leaves on the Postgres leg opens a store
 * that cannot boot there yet [POD-7098]. Database-free.
 *
 * It reads every leg file's source and the test-support helpers, so it lives apart from
 * `test-store-engines.test.ts`: a test that scans repository source belongs to the broad
 * `boundary` shard (scripts/server-test-shards.ts, rule 2), while the lists' own check stays
 * a store-shard file that the leg runs.
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
import { postgresLegFiles } from '../test-support/test-store-engines'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('the Postgres leg of the store shard', () => {
  // Until a Postgres store can boot (POD-6994; this case goes with it), a full store open
  // on the leg fails with PostgresStoreBootError. The lists alone could not see that: six
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
})
