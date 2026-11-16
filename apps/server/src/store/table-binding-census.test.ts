/**
 * EVERY QUERY DEFINITION TAKES ITS TABLES FROM THE BINDING [POD-6977, POD-6958
 * design §2.1, contract C2 (1)].
 *
 * A definition is `prepared((db, t) => … t.issues …)`: `t` is the table set
 * bound to the store's drizzle instance (`executor/binding.ts`), so the same
 * source builds on another engine's tables. A definition that imported a table
 * instead would keep building on the SQLite one. This census reads every file
 * that defines queries and fails on any value import of a table from a table
 * module (`directTableReferences` in `test-support/prepared-census.ts`).
 *
 * The rendered SQL is unchanged by the binding on SQLite; the query-plan audit
 * (`query-plan-audit.test.ts`) builds every definition through it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is, Table } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from '../migrations/schema'
import {
  censusScope,
  type DirectTableReference,
  directTableReferences,
  rawSqlScope,
} from '../test-support/prepared-census'
import { bindingFor } from './executor/binding'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/**
 * The modules that declare store tables, as repository paths. The census
 * refuses a value import of a table from any of them; the completeness test
 * below keeps the list whole.
 */
const TABLE_MODULES = [
  'apps/server/src/migrations/schema.ts',
  'apps/server/src/migrations/identity-import-schema.ts',
  'packages/identity/src/schema/sqlite.ts',
  'packages/sync/src/adapters/sqlite/schema.ts',
] as const

/** Sources that declare tables which are no store tables, each with its reason. */
const NOT_STORE_TABLES = new Map<string, string>([
  ['apps/server/src/store/spike/turso-append/schema.ts', 'a spike; nothing in the store reads it'],
])

/** Where the tables are named on purpose: the bindings themselves. */
const BINDING_FILES = new Set([
  'apps/server/src/store/executor/binding.ts',
  'packages/sync/src/adapters/sqlite/binding.ts',
])

/**
 * Files that still import tables, each with its reason. Every entry must still
 * have a finding (see "keeps no stale entry").
 */
const EXEMPT = new Map<string, string>([
  [
    'apps/server/src/store/identity-upgrade.ts',
    'LEGACY boot import of pre-identity SQLite tables (identity-import-schema); SQLite only, removed with its LEGACY date',
  ],
  [
    'apps/server/src/modules/updates/recovery-store.ts',
    'outside POD-6977 (store/** and the sync adapter); converts with its own task',
  ],
])

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true })
    .map((entry) => relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry))))
    .map((path) => path.split('\\').join('/'))
}

/** Every file the census reads: the repositories, and any other file that defines a query. */
function censusFiles(): string[] {
  const repositories = censusScope([
    ...sourcesUnder('apps/server/src/store'),
    ...sourcesUnder('packages/sync/src/adapters/sqlite'),
  ])
  const definers = rawSqlScope([
    ...sourcesUnder('apps/server/src'),
    ...sourcesUnder('packages/sync/src'),
  ]).filter((path) =>
    /\b(prepared|preparedFamily)\(/.test(readFileSync(join(REPO_ROOT, path), 'utf8')),
  )
  return [...new Set([...repositories, ...definers])]
    .filter((path) => !BINDING_FILES.has(path) && !TABLE_MODULES.includes(path as never))
    .filter((path) => !path.includes('/spike/'))
    .sort()
}

/** A relative or `@podium/<package>[/<sub>]` specifier as a repository path. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = join(dirname(from), specifier).split('\\').join('/')
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
      if (candidate.endsWith('.ts') && sourceExists(candidate)) return candidate
    }
    return undefined
  }
  const match = /^@podium\/([^/]+)(\/.+)?$/.exec(specifier)
  if (!match) return undefined
  const packageDir = `packages/${match[1]}`
  let manifest: { exports?: Record<string, { '@podium/source'?: string } | string> }
  try {
    manifest = JSON.parse(readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const entry = manifest.exports?.[`.${match[2] ?? ''}`]
  const target = typeof entry === 'string' ? entry : entry?.['@podium/source']
  return target === undefined ? undefined : join(packageDir, target).split('\\').join('/')
}

function sourceExists(path: string): boolean {
  try {
    readFileSync(join(REPO_ROOT, path))
    return true
  } catch {
    return false
  }
}

async function tableModules(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const path of TABLE_MODULES) {
    const module = (await import(join(REPO_ROOT, path))) as Record<string, unknown>
    const names = new Set(
      Object.entries(module)
        .filter(([, value]) => is(value, Table))
        .map(([name]) => name),
    )
    out.set(path, names)
  }
  return out
}

async function census(): Promise<DirectTableReference[]> {
  const modules = await tableModules()
  return censusFiles().flatMap((file) =>
    directTableReferences(
      file,
      readFileSync(join(REPO_ROOT, file), 'utf8'),
      modules,
      resolveSpecifier,
    ),
  )
}

const describeReference = (found: DirectTableReference): string =>
  `${found.file}:${found.line} ${found.table} from ${found.module}`

describe('POD-6977 — query definitions take their tables from the binding', () => {
  it('finds no definition file that imports a table as a value', async () => {
    const files = censusFiles()
    // A census that read nothing would pass; the store has dozens of repository files.
    expect(files.length).toBeGreaterThan(40)
    const found = (await census()).filter((reference) => !EXEMPT.has(reference.file))
    expect(found.map(describeReference)).toEqual([])
  })

  it('keeps no stale exemption', async () => {
    const exempt = new Set((await census()).map((reference) => reference.file))
    expect([...EXEMPT.keys()].filter((file) => !exempt.has(file))).toEqual([])
  })

  it('knows every module that declares a store table', () => {
    const declaring = [...sourcesUnder('apps/server/src'), ...sourcesUnder('packages')].filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.includes('node_modules') &&
        !path.includes('.test.') &&
        !path.includes('.type-test.') &&
        !path.includes('test-support') &&
        /\bsqliteTable\(/.test(readFileSync(join(REPO_ROOT, path), 'utf8')),
    )
    const unknown = declaring.filter(
      (path) => !TABLE_MODULES.includes(path as never) && !NOT_STORE_TABLES.has(path),
    )
    expect(unknown).toEqual([])
    expect(declaring.length).toBeGreaterThanOrEqual(TABLE_MODULES.length)
  })

  it('binds the very table objects of the SQLite schema and the sync tables', async () => {
    const t = bindingFor('sqlite') as unknown as Record<string, unknown>
    for (const [name, table] of Object.entries(schema)) expect(t[name]).toBe(table)
    const sync = (await import('@podium/sync/adapters/sqlite/sync-repository')).sqliteSyncTables
    for (const [name, table] of Object.entries(sync)) expect(t[name]).toBe(table)
    expect(Object.keys(t).length).toBe(Object.keys(schema).length + Object.keys(sync).length)
  })

  it('fails on a planted direct table import, and allows a type-only one', async () => {
    const modules = await tableModules()
    const plant = (imports: string, file = 'apps/server/src/store/planted.ts') =>
      directTableReferences(
        file,
        `${imports}\nconst q = prepared((db, t) => db.select().from(issues).prepare())\n`,
        modules,
        resolveSpecifier,
      ).map(describeReference)
    expect(plant(`import { issues } from '../migrations/schema'`)).toEqual([
      'apps/server/src/store/planted.ts:1 issues from apps/server/src/migrations/schema.ts',
    ])
    expect(plant(`import { issues as issueTable } from '../migrations/schema'`)).toHaveLength(1)
    expect(plant(`import * as schema from '../migrations/schema'`)).toEqual([
      'apps/server/src/store/planted.ts:1 * as schema from apps/server/src/migrations/schema.ts',
    ])
    expect(
      plant(`import { changes } from './schema'`, 'packages/sync/src/adapters/sqlite/planted.ts'),
    ).toEqual([
      'packages/sync/src/adapters/sqlite/planted.ts:1 changes from packages/sync/src/adapters/sqlite/schema.ts',
    ])
    expect(plant(`import { identityUser } from '@podium/identity/schema/sqlite'`)).toEqual([
      'apps/server/src/store/planted.ts:1 identityUser from packages/identity/src/schema/sqlite.ts',
    ])
    expect(plant(`import type { issues } from '../migrations/schema'`)).toEqual([])
    expect(plant(`import { type issues } from '../migrations/schema'`)).toEqual([])
    expect(plant(`import { issueSchemaVersion } from '../migrations/schema'`)).toEqual([])
  })
})
