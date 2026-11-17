/**
 * EVERY QUERY NAMES ITS WORKSPACE [POD-6959 design 2.5, part 3; POD-7014].
 *
 * The runtime half of the workspace proof, modelled on the query-plan audit. It opens a store,
 * reaches every registered query definition the way that audit does (the shared census,
 * `test-support/definition-census.ts`), builds each one with its kind on a drizzle instance that
 * records instead of running, and reads the SQL with the placeholder name behind each bound
 * value. It also reads every raw statement the raw SQL census plans. The checker
 * (`test-support/workspace-scope-check.ts`) then holds each statement to its kind:
 *
 *   - a WORKSPACE definition constrains every workspace table it touches (joins, subqueries and
 *     CTEs included) to the `workspaceId` placeholder, and an insert takes workspace_id from it;
 *   - a GLOBAL definition touches no workspace table, except the provisioning insert on the
 *     allowlist;
 *   - a CROSS-WORKSPACE definition is a SELECT, made with an entry of
 *     `cross-workspace-allowlist.ts`.
 *
 * PENDING MODE. The scoping tasks (phase B) land file by file. A definition file that carries the
 * marker comment `// workspace-scoped (POD-6959)` is checked strictly; the workspace findings of
 * every other file are reported as pending, not failed, with a count per file. Task C1
 * (POD-7024) removes the pending mode and turns on the ON CONFLICT target rule.
 *
 * What does not wait for the scoping: every statement must parse, every table must be
 * classified, and the global and cross-workspace rules hold everywhere already.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { type PreparedDefinition, preparedDefinitions } from '@podium/sync/adapters/sqlite/prepared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import {
  builtStatements,
  type KeyedDefinition,
  keyedDefinitions,
  RAW_SQL_PLANNED,
  REPO_ROOT,
  rawKey,
  rawSqlCensus,
  reachMethodDefinitions,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { openTestStore } from '../test-support/open-test-store'
import {
  type CheckedScope,
  checkWorkspaceScope,
  type ScopedStatement,
  type ScopeFinding,
  type TableKind,
} from '../test-support/workspace-scope-check'
import {
  CROSS_WORKSPACE_ALLOWLIST,
  type CrossWorkspaceAllowlistEntry,
} from './cross-workspace-allowlist'
import {
  param,
  prepared,
  preparedAcross,
  preparedGlobal,
  type StoreDrizzle,
  type StoreTables,
  WORKSPACE,
} from './executor/sync-drizzle'
import { classifyTable } from './workspace-manifest'

/** The comment a scoping task adds to each file it scopes. */
const MARKER = '// workspace-scoped (POD-6959)'

/**
 * Names SQLite itself answers for, which no migration creates: they hold no workspace's rows.
 * The manifest classifies every table a database of ours holds (`sqlite_sequence` included).
 */
const ENGINE_NAMES = new Map<string, string>([
  ['sqlite_master', 'the schema table: table and index definitions, no rows of any workspace'],
  ['sqlite_schema', 'the schema table under its newer name'],
  ['sqlite_temp_master', 'the temporary schema table'],
])

/**
 * Statements the checker cannot read, each with the reason, keyed `file:name`. Such a
 * statement is checked by hand. The list may only shrink.
 */
const SEARCH_DDL =
  'DDL, not a query: the full-text search schema the store creates or drops at boot when search is ' +
  'switched (PDM-25). It names no rows; B8 (POD-7022) scopes the triggers and the key table it creates.'
const UNREADABLE: ReadonlyMap<string, string> = new Map([
  ['apps/server/src/store/conversations/index.ts:createFtsTable', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:createFtsInsertTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:createFtsDeleteTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:createFtsUpdateTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:dropFtsInsertTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:dropFtsDeleteTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/index.ts:dropFtsUpdateTrigger', SEARCH_DDL],
  ['apps/server/src/store/conversations/transcript-index.ts:createTranscriptFts', SEARCH_DDL],
  ['apps/server/src/store/conversations/transcript-index.ts:createTranscriptKeys', SEARCH_DDL],
  ['apps/server/src/store/conversations/transcript-index.ts:createTranscriptKeysIndex', SEARCH_DDL],
])

const tableKind = (table: string): TableKind | undefined => {
  if (ENGINE_NAMES.has(table)) return 'shared'
  const entry = classifyTable(table)
  if (entry === undefined) return undefined
  return entry.class === 'workspace' ? 'workspace' : 'shared'
}

/** One statement the audit checks, with what decides its rules. */
interface AuditEntry {
  readonly key: string
  readonly file: string
  readonly shape: string | number | undefined
  readonly scope: CheckedScope
  readonly entry: PreparedDefinition['entry']
  readonly statement: ScopedStatement
}

interface Verdict {
  /** Findings that fail the audit now. */
  readonly failures: string[]
  /** Workspace findings of unmarked files, by file: statements with at least one finding. */
  readonly pending: Map<string, number>
  /** Statements checked, by kind. */
  readonly checked: Record<CheckedScope, number>
}

const fileOf = (key: string): string => key.slice(0, key.indexOf(':'))

/** Hold each statement to its kind. `isMarked` says which files are scoped already. */
function judge(entries: readonly AuditEntry[], isMarked: (file: string) => boolean): Verdict {
  const failures: string[] = []
  const pending = new Map<string, number>()
  const checked: Record<CheckedScope, number> = { workspace: 0, global: 0, across: 0 }
  const fail = (entry: AuditEntry, what: string) =>
    failures.push(`${entry.key} [${String(entry.shape ?? '')}] (${entry.scope}): ${what}`)
  for (const entry of entries) {
    checked[entry.scope] += 1
    const allowed = CROSS_WORKSPACE_ALLOWLIST.find(
      (listed) => `${listed.file}:${listed.name}` === entry.key,
    )
    const findings = checkWorkspaceScope(entry.statement, entry.scope, {
      tableKind,
      conflictTargets: false,
    })
    const describe = (found: readonly ScopeFinding[]) =>
      `${found.map((finding) => `${finding.rule}: ${finding.detail}`).join('; ')} :: ${entry.statement.sql.slice(0, 400)}`
    // Every statement must be readable and every table classified, scoped or not.
    const unreadable = findings.filter(
      (finding) => finding.rule === 'unparseable' || finding.rule === 'unknown-table',
    )
    if (unreadable.length > 0 && !UNREADABLE.has(entry.key)) fail(entry, describe(unreadable))
    const rules = findings.filter((finding) => !unreadable.includes(finding))
    if (entry.scope === 'global') {
      if (rules.length > 0 && allowed?.use !== 'provisioning') fail(entry, describe(rules))
      continue
    }
    if (entry.scope === 'across') {
      if (rules.length > 0) fail(entry, describe(rules))
      const listed = CROSS_WORKSPACE_ALLOWLIST.find(
        (candidate) => candidate.file === entry.entry?.file && candidate.name === entry.entry?.name,
      )
      if (listed === undefined || listed.use !== 'read') {
        fail(entry, 'a cross-workspace definition whose entry is not a read on the allowlist')
      } else if (`${listed.file}:${listed.name}` !== entry.key) {
        fail(entry, `its allowlist entry names ${listed.file}:${listed.name}`)
      }
      continue
    }
    if (rules.length === 0) continue
    if (isMarked(entry.file)) fail(entry, describe(rules))
    else pending.set(entry.file, (pending.get(entry.file) ?? 0) + 1)
  }
  return { failures, pending, checked }
}

/**
 * The repository as this audit reads it. It reads source it does not import (every
 * definition site, every raw statement), so it sits in the shard keyed on the whole tree.
 */
const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

let store: SessionStore
let database: SqlDatabase

beforeAll(async () => {
  store = await openTestStore(':memory:')
  database = (store as unknown as { db: SqlDatabase }).db
  await reachMethodDefinitions(store, database)
})

afterAll(async () => {
  await store?.close()
})

/** Every statement of the given definitions, built at each shape, as audit entries. */
function entriesOf(keyed: readonly KeyedDefinition[]): {
  entries: AuditEntry[]
  buildErrors: string[]
  missingShapes: string[]
} {
  const { built, buildErrors, missingShapes } = builtStatements(keyed)
  const entries = built.map(({ key, shape, definition, statement }) => ({
    key,
    file: fileOf(key),
    shape,
    scope: definition.scope,
    entry: definition.entry,
    statement: { sql: statement.sql, placeholders: statement.placeholders },
  }))
  return { entries, buildErrors, missingShapes }
}

/** Every planned raw statement: checked as a workspace statement of its file. */
function rawEntries(): AuditEntry[] {
  return rawSqlCensus(SOURCE)
    .filter((site) => RAW_SQL_PLANNED.has(rawKey(site)))
    .map((site) => ({
      key: rawKey(site),
      file: site.file,
      shape: undefined,
      scope: 'workspace' as const,
      entry: undefined,
      // A raw statement binds by position; it names its workspace as `:workspaceId`.
      statement: { sql: site.sql, placeholders: [] },
    }))
}

const markedFiles = new Map<string, boolean>()
function isMarked(file: string): boolean {
  let marked = markedFiles.get(file)
  if (marked === undefined) {
    marked = SOURCE.read(file).includes(MARKER)
    markedFiles.set(file, marked)
  }
  return marked
}

function auditAll() {
  const keyedResult = keyedDefinitions(trackedSources(SOURCE), SOURCE)
  const built = entriesOf(keyedResult.keyed)
  const entries = [...built.entries, ...rawEntries()]
  return { ...keyedResult, ...built, entries, verdict: judge(entries, isMarked) }
}

/** The audit of the whole census, made once per file (the armed tests plant their own). */
let audited: ReturnType<typeof auditAll> | undefined
const audit = () => {
  audited ??= auditAll()
  return audited
}

describe('POD-7014 — every query names its workspace', () => {
  it('builds every definition with its kind, and every planned raw statement', () => {
    const { sites, keyed, unregisteredSites, unmapped, entries, buildErrors, missingShapes } =
      audit()
    // A census that read nothing would pass; the covered set is hundreds of definitions.
    expect(sites.length).toBeGreaterThan(500)
    expect(unmapped).toEqual([])
    expect(unregisteredSites).toEqual([])
    expect(missingShapes).toEqual([])
    expect(buildErrors).toEqual([])
    expect(entries.length).toBeGreaterThan(keyed.length)
    expect(new Set(entries.map((entry) => entry.scope))).toContain('workspace')
  })

  it('holds every statement to its kind; unmarked files are pending (the report)', () => {
    const { entries, verdict } = audit()
    const marked = [...new Set(entries.map((entry) => entry.file))].filter(isMarked).sort()
    const pendingStatements = [...verdict.pending.values()].reduce((sum, count) => sum + count, 0)
    // THE REPORT: what was checked, what is scoped, what is still pending, per file.
    console.log(
      `workspace-scope audit: ${entries.length} statements (${verdict.checked.workspace} workspace, ` +
        `${verdict.checked.global} global, ${verdict.checked.across} cross-workspace); ` +
        `${marked.length} files marked scoped; ${pendingStatements} statements pending in ` +
        `${verdict.pending.size} files`,
    )
    for (const [file, count] of [...verdict.pending].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  PENDING ${count.toString().padStart(4)}  ${file}`)
    }
    for (const failure of verdict.failures) console.log(`SCOPE ${failure}`)
    expect(verdict.failures).toEqual([])
  })

  it('keeps no stale entry: every unreadable key still is one, every allowlist entry is live or planned', () => {
    const { entries, keyed } = audit()
    const keys = new Set(entries.map((entry) => entry.key))
    expect([...UNREADABLE.keys()].filter((key) => !keys.has(key))).toEqual([])
    const defined = new Map(keyed.map(({ key, definition }) => [key, definition]))
    for (const listed of CROSS_WORKSPACE_ALLOWLIST) {
      const key = `${listed.file}:${listed.name}`
      if (listed.use === 'raw-read') {
        // A raw read outside the registry (POD-7021): its text is in its file, and it is a read.
        expect(listed.sql?.length ?? 0).toBeGreaterThan(10)
        expect({ key, inFile: SOURCE.read(listed.file).includes(listed.sql ?? '\u0000') }).toEqual({
          key,
          inFile: true,
        })
        expect(
          checkWorkspaceScope({ sql: listed.sql ?? '', placeholders: [] }, 'across', {
            tableKind,
            conflictTargets: false,
          }),
        ).toEqual([])
        continue
      }
      const definition = defined.get(key)
      if (listed.plannedBy !== undefined) {
        // Once the definition lands, its task removes `plannedBy`.
        expect({ key, defined: definition !== undefined }).toEqual({ key, defined: false })
        continue
      }
      expect({ key, scope: definition?.scope }).toEqual({
        key,
        scope: listed.use === 'read' ? 'across' : 'global',
      })
    }
    for (const listed of CROSS_WORKSPACE_ALLOWLIST) {
      for (const field of ['reason', 'index', 'issue'] as const) {
        expect(listed[field].trim().length).toBeGreaterThan(field === 'reason' ? 20 : 3)
      }
    }
    for (const reason of [...UNREADABLE.values(), ...ENGINE_NAMES.values()]) {
      expect(reason.trim().length).toBeGreaterThan(20)
    }
  })

  describe('is armed', () => {
    const PLANTED = 'apps/server/src/store/planted.ts'
    type Build = (db: StoreDrizzle, t: StoreTables) => unknown

    /** Audit entries for a definition made here, as if it sat in the planted file. */
    function planted(name: string, definition: PreparedDefinition): AuditEntry[] {
      return entriesOf([{ key: `${PLANTED}:${name}`, definition }]).entries
    }
    const newest = (): PreparedDefinition => preparedDefinitions().at(-1)!

    const unscopedRead: Build = (db, t) =>
      db
        .select({ name: t.locks.name })
        .from(t.locks)
        .where(eq(t.locks.repoId, param(t.locks.repoId, 'repoId')))
        .prepare()
    // The column arrives with A4 (POD-7012); the audit reads SQL, so the term is written out.
    const scopedRead: Build = (db, t) =>
      db
        .select({ name: t.locks.name })
        .from(t.locks)
        .where(
          sql`${t.locks}."workspace_id" = ${WORKSPACE} and ${eq(t.locks.repoId, param(t.locks.repoId, 'repoId'))}`,
        )
        .prepare()

    it('a planted unscoped definition fails in a marked file and is pending in an unmarked one', () => {
      prepared(unscopedRead)
      const entries = planted('unscopedRead', newest())
      expect(entries).toHaveLength(1)
      const strict = judge(entries, () => true)
      expect(strict.failures).toHaveLength(1)
      expect(strict.failures[0]).toContain('unconstrained')
      const lenient = judge(entries, () => false)
      expect(lenient.failures).toEqual([])
      expect([...lenient.pending]).toEqual([[PLANTED, 1]])
    })

    it('a planted definition held to its workspace passes in a marked file', () => {
      prepared(scopedRead)
      const entries = planted('scopedRead', newest())
      expect(entries[0]!.statement.placeholders).toEqual(['workspaceId', 'repoId'])
      expect(judge(entries, () => true).failures).toEqual([])
    })

    it('a planted global definition that names a workspace table fails, marked or not', () => {
      // The type rule refuses this at compile time; the audit must refuse it too.
      preparedGlobal((db, t) => unscopedRead(db, t as unknown as StoreTables))
      const verdict = judge(planted('globalOnWorkspace', newest()), () => false)
      expect(verdict.failures).toHaveLength(1)
      expect(verdict.failures[0]).toContain('global-workspace-table')
    })

    it('a planted cross-workspace definition fails off the allowlist, and when it writes', () => {
      const offList: CrossWorkspaceAllowlistEntry = {
        use: 'read',
        file: PLANTED,
        name: 'acrossOffList',
        reason: 'planted',
        index: 'none',
        issue: 'POD-7014',
      }
      preparedAcross(offList, (db, t) =>
        db.select({ id: t.sessions.id }).from(t.sessions).prepare(),
      )
      const read = judge(planted('acrossOffList', newest()), () => false)
      expect(read.failures).toHaveLength(1)
      expect(read.failures[0]).toContain('not a read on the allowlist')

      preparedAcross({ ...offList, name: 'acrossWrite' }, (db, t) =>
        db
          .delete(t.sessions)
          .where(eq(t.sessions.id, param(t.sessions.id, 'id')))
          .prepare(),
      )
      const write = judge(planted('acrossWrite', newest()), () => false)
      expect(write.failures.some((failure) => failure.includes('across-write'))).toBe(true)
    })
  })
})
