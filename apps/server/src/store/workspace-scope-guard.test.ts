/**
 * THE WORKSPACE RULE IN THE SOURCE [POD-6959 design 2.5, part 2; POD-7014].
 *
 * The source half of the workspace proof: what the type rule cannot see and the runtime audit
 * (`workspace-scope-audit.test.ts`) does not reach, read from the production source.
 *
 *   1. No file imports a table object from a schema module except the bindings, the migrations
 *      and tests. Every definition takes its tables from the binding (`prepared((db, t) => …)`),
 *      so a table import is a query the audit may never build: a fluent query outside `store/`
 *      (such as `modules/operations/store.ts`), which the prepared guard does not cover.
 *   2. `preparedGlobal` only in the files the manifest lists as global repositories
 *      (`GLOBAL_REPOSITORY_FILES`).
 *   3. `preparedAcross` only with an entry imported from `cross-workspace-allowlist.ts`.
 *   4. `asWorkspaceId(` only where a workspace id may be minted: the self-hosted composition,
 *      hosted routing (POD-6960, when it lands) and test support.
 *
 * The files that break rule 1 today are listed in PENDING with the task that removes the
 * violation; the list may only shrink, and an entry with no violation left fails it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { is, Table } from 'drizzle-orm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { type DirectTableReference, directTableReferences } from '../test-support/prepared-census'
import { GLOBAL_REPOSITORY_FILES } from './workspace-manifest'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/** The modules that declare store tables (the same list as `table-binding-census.test.ts`). */
const TABLE_MODULES = [
  'apps/server/src/migrations/schema.ts',
  'apps/server/src/migrations/identity-import-schema.ts',
  'packages/identity/src/schema/sqlite.ts',
  'packages/sync/src/adapters/sqlite/schema.ts',
] as const

/** Where tables are named on purpose: the bindings. */
const BINDING_FILES = new Set([
  'apps/server/src/store/executor/binding.ts',
  'packages/sync/src/adapters/sqlite/binding.ts',
])

/** The production source the guard reads. */
const SOURCE_DIRS = [
  'apps/server/src',
  'packages/sync/src',
  'packages/janitor/src',
  'packages/identity/src',
]

const ALLOWLIST_MODULE = 'apps/server/src/store/cross-workspace-allowlist.ts'

/**
 * Where `asWorkspaceId(` may be called outside tests and test support, with the reason. Hosted
 * routing (POD-6960) adds its file when it lands.
 */
const WORKSPACE_MINTERS = new Map<string, string>([
  [
    'apps/server/src/self-hosted-workspace.ts',
    "the self-hosted composition (POD-7010): the one workspace 'local' of a self-hosted install",
  ],
])

/**
 * Files that import a table today, each with the task that removes the import (design section
 * 5). The list may only shrink.
 */
const PENDING = new Map<string, string>([
  [
    'apps/server/src/store/identity-upgrade.ts',
    'LEGACY boot import of the pre-identity tables (identity-import-schema), removed with its LEGACY date; B5 (POD-7019) scopes the file',
  ],
  [
    'apps/server/src/modules/updates/recovery-store.ts',
    'B9 (POD-7023): update recovery moves onto the binding as a global repository',
  ],
  [
    'apps/server/src/sync/record-sources.ts',
    'B7 (POD-7021): the record sources name their tables for change capture; they take them from the binding when B7 adds workspace_id to their keys and POD-6958 adds their Postgres forms',
  ],
  [
    'apps/server/src/modules/operations/store.ts',
    'B9 (POD-7023): its fluent queries become prepared definitions on the binding',
  ],
])

const toPosix = (path: string): string => path.split('\\').join('/')

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
    toPosix(relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))),
  )
}

const isTest = (path: string): boolean =>
  path.includes('.test.') ||
  path.includes('.type-test.') ||
  path.includes('/test-support/') ||
  path.endsWith('/test-support.ts') ||
  path.endsWith('/testing.ts') ||
  path.includes('/testing/')

/** Every production source file the guard reads. */
function productionSources(): string[] {
  return SOURCE_DIRS.flatMap(sourcesUnder)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .filter(
      (path) => !isTest(path) && !path.includes('/spike/') && !path.includes('/node_modules/'),
    )
    .sort()
}

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')

function sourceExists(path: string): boolean {
  try {
    readFileSync(join(REPO_ROOT, path))
    return true
  } catch {
    return false
  }
}

/** A relative or `@podium/<package>[/<sub>]` specifier as a repository path. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = toPosix(join(dirname(from), specifier))
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
    manifest = JSON.parse(read(`${packageDir}/package.json`))
  } catch {
    return undefined
  }
  const entry = manifest.exports?.[`.${match[2] ?? ''}`]
  const target = typeof entry === 'string' ? entry : entry?.['@podium/source']
  return target === undefined ? undefined : toPosix(join(packageDir, target))
}

async function tableModules(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const path of TABLE_MODULES) {
    const module = (await import(join(REPO_ROOT, path))) as Record<string, unknown>
    out.set(
      path,
      new Set(
        Object.entries(module)
          .filter(([, value]) => is(value, Table))
          .map(([name]) => name),
      ),
    )
  }
  return out
}

/** May this file name tables? The bindings, the table modules, the migrations. */
const mayImportTables = (file: string): boolean =>
  BINDING_FILES.has(file) ||
  TABLE_MODULES.includes(file as never) ||
  file.startsWith('apps/server/src/migrations/')

/** Rule 1 over `files`: every value import of a table outside the allowed files. */
async function tableImports(
  files: readonly { file: string; source: string }[],
): Promise<DirectTableReference[]> {
  const modules = await tableModules()
  return files
    .filter(({ file }) => !mayImportTables(file))
    .flatMap(({ file, source }) => directTableReferences(file, source, modules, resolveSpecifier))
}

/** One call of a guarded function in the source. */
interface GuardedCall {
  readonly file: string
  readonly line: number
  readonly callee: 'preparedGlobal' | 'preparedAcross' | 'asWorkspaceId'
  /** For `preparedAcross`: the module its entry argument was imported from, if any. */
  readonly entryModule?: string
}

const GUARDED = new Set(['preparedGlobal', 'preparedAcross', 'asWorkspaceId'])

/** Every call of `preparedGlobal`, `preparedAcross` and `asWorkspaceId` in one file. */
function guardedCalls(file: string, source: string): GuardedCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const importedFrom = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const module = resolveSpecifier(file, statement.moduleSpecifier.text)
    const bindings = statement.importClause?.namedBindings
    if (module === undefined || !bindings) continue
    if (ts.isNamespaceImport(bindings)) importedFrom.set(bindings.name.text, module)
    else for (const element of bindings.elements) importedFrom.set(element.name.text, module)
  }
  const rootName = (expression: ts.Expression): string | undefined => {
    let current = expression
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
    }
    return ts.isIdentifier(current) ? current.text : undefined
  }
  const found: GuardedCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      if (name !== undefined && GUARDED.has(name)) {
        const call: GuardedCall = {
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          callee: name as GuardedCall['callee'],
        }
        const entry = node.arguments[0]
        const root = entry === undefined ? undefined : rootName(entry)
        const entryModule = root === undefined ? undefined : importedFrom.get(root)
        found.push(
          name === 'preparedAcross' && entryModule !== undefined ? { ...call, entryModule } : call,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Rules 2 to 4 over `files`: each call where its rule does not allow it. */
function misplacedCalls(files: readonly { file: string; source: string }[]): string[] {
  return files
    .flatMap(({ file, source }) => guardedCalls(file, source))
    .filter((call) => {
      if (call.callee === 'preparedGlobal') return !GLOBAL_REPOSITORY_FILES.has(call.file)
      if (call.callee === 'preparedAcross') return call.entryModule !== ALLOWLIST_MODULE
      return !WORKSPACE_MINTERS.has(call.file)
    })
    .map((call) => `${call.file}:${call.line} ${call.callee}`)
}

const describeReference = (found: DirectTableReference): string =>
  `${found.file}:${found.line} ${found.table} from ${found.module}`

const production = () => productionSources().map((file) => ({ file, source: read(file) }))

describe('POD-7014 — the workspace rule in the source', () => {
  it('reads the production source', () => {
    // A guard that read nothing would pass; the server alone has hundreds of files.
    expect(productionSources().length).toBeGreaterThan(300)
    expect(productionSources()).toContain('apps/server/src/store/issues.ts')
  })

  it('finds no table imported outside the bindings, the migrations and tests', async () => {
    const found = (await tableImports(production())).filter(
      (reference) => !PENDING.has(reference.file),
    )
    expect(found.map(describeReference)).toEqual([])
  })

  it('keeps no stale pending entry', async () => {
    const files = new Set((await tableImports(production())).map((reference) => reference.file))
    console.log(
      `workspace-scope guard: ${PENDING.size} files import tables, pending: ${[...PENDING.keys()].join(', ')}`,
    )
    expect([...PENDING.keys()].filter((file) => !files.has(file))).toEqual([])
    for (const reason of PENDING.values()) expect(reason).toMatch(/POD-\d+|LEGACY/)
  })

  it('finds preparedGlobal only in global repositories, preparedAcross only with an allowlist entry, asWorkspaceId only where a workspace is minted', () => {
    expect(misplacedCalls(production())).toEqual([])
  })

  it('keeps no stale list entry: every listed file exists, or names the task that adds it', () => {
    const lists = [
      ...[...GLOBAL_REPOSITORY_FILES].map(([file, { plannedBy }]) => ({ file, plannedBy })),
      ...[...WORKSPACE_MINTERS.keys()].map((file) => ({
        file,
        // The self-hosted composition arrives with POD-7010.
        plannedBy: file === 'apps/server/src/self-hosted-workspace.ts' ? 'POD-7010' : undefined,
      })),
    ]
    for (const { file, plannedBy } of lists) {
      // A planned file that exists has landed: its task removes `plannedBy` (or this line).
      expect({ file, exists: sourceExists(file) }).toEqual({
        file,
        exists: plannedBy === undefined,
      })
    }
    expect(sourceExists(ALLOWLIST_MODULE)).toBe(true)
  })

  describe('is armed', () => {
    const plant = (file: string, source: string) => [{ file, source }]

    it('fails a planted schema-table import, and allows a type-only one', async () => {
      const file = 'apps/server/src/modules/planted/store.ts'
      expect(
        (await tableImports(plant(file, `import { issues } from '../../migrations/schema'\n`))).map(
          describeReference,
        ),
      ).toEqual([`${file}:1 issues from apps/server/src/migrations/schema.ts`])
      expect(
        await tableImports(plant(file, `import type { issues } from '../../migrations/schema'\n`)),
      ).toEqual([])
      // The migrations and the bindings may name tables.
      expect(
        await tableImports(
          plant('apps/server/src/migrations/planted.ts', `import { issues } from './schema'\n`),
        ),
      ).toEqual([])
    })

    it('fails a planted preparedGlobal outside a global repository', () => {
      const source = `import { preparedGlobal } from './executor/sync-drizzle'\nconst q = preparedGlobal((db, t) => db.select().from(t.meta).prepare())\n`
      expect(misplacedCalls(plant('apps/server/src/store/planted.ts', source))).toEqual([
        'apps/server/src/store/planted.ts:2 preparedGlobal',
      ])
      const [globalFile] = [...GLOBAL_REPOSITORY_FILES.keys()]
      expect(misplacedCalls(plant(globalFile!, source))).toEqual([])
    })

    it('fails a planted preparedAcross whose entry is not from the allowlist', () => {
      const call = `preparedAcross(ENTRY, (db, t) => db.select().from(t.sessions).prepare())\n`
      const file = 'apps/server/src/store/planted.ts'
      expect(
        misplacedCalls(
          plant(
            file,
            `const ENTRY = { file: 'x', name: 'y', reason: 'z', index: 'i', issue: 'POD-1' }\n${call}`,
          ),
        ),
      ).toEqual([`${file}:2 preparedAcross`])
      expect(
        misplacedCalls(plant(file, `import { ENTRY } from './cross-workspace-allowlist'\n${call}`)),
      ).toEqual([])
    })

    it('fails a planted asWorkspaceId outside the minting files', () => {
      const source = `import { asWorkspaceId } from '@podium/model'\nexport const ws = asWorkspaceId(request.header)\n`
      expect(misplacedCalls(plant('apps/server/src/routes/planted.ts', source))).toEqual([
        'apps/server/src/routes/planted.ts:2 asWorkspaceId',
      ])
      expect(misplacedCalls(plant('apps/server/src/self-hosted-workspace.ts', source))).toEqual([])
    })
  })
})
