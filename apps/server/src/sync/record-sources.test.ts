/**
 * THE KIND DECLARATIONS HOLD THE BUILDERS TO THEIR SOURCES (POD-6253 design
 * §3, POD-6920).
 *
 * Writers name no records: the capture triggers generated from
 * `record-sources.ts` are the only way a write reaches the log. A builder
 * that reads a table or a column its kind did not declare would change a
 * record no capture names, and that change would never reach a device. So:
 *
 *  1. TABLES. Each kind's builder, run over a populated store, may issue SQL
 *     against its declared tables only.
 *  2. ROWS AND COLUMNS. For every row of every model table the corpus holds,
 *     changing any one column, or deleting the row, may change only records
 *     the capture of that change names. This is what finds an undeclared
 *     column, a row filter that is too narrow, and a window mapping that
 *     misses an entry or a leave.
 *  3. TEETH. With one declaration taken away, both checks fail.
 *
 * The corpus is written through the server's own paths (issues, a dependency,
 * markers, a session, an ask, chat traffic, an automation, layout, a read
 * mark, panel items) plus direct seeds for the kinds no path writes cheaply.
 */

import {
  actorUser,
  asMutationId,
  asThreadId,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import { fixtureWriteScope } from '@podium/sync/testing'
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import * as schema from '../migrations/schema'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import type { DriverSession } from '../store/executor/driver'
import type { StoreDrizzle } from '../store/executor/sync-drizzle'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../store/executor/statement-probe'
import type { MessageRow } from '../store/types'
import { attachHostDaemon } from '../test-support/host-daemon'
import { openTestStore } from '../test-support/open-test-store'
import { seedRows } from '../test-support/seed-rows'
import { quietShipping } from '../test-support/statement-count'
import type { WriteContexts } from '../write-contexts'
import { installChangeCapture } from './capture-triggers'
import { type RecordReads, serverRecordBuilders } from './record-builders'
import {
  RECORD_SOURCES,
  type RecordSources,
  sourceTableName,
  touchedRecords,
} from './record-sources'

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

const AT = '2026-11-13T12:00:00.000Z'

/** A person's chat message into a session, as the send path stores it. */
function chat(id: string, sessionId: SessionId, sender: UserId, n: number): MessageRow {
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'operator',
    fromSession: null,
    fromIssue: null,
    attribution: { actor: actorUser(sender), onBehalfOf: sender },
    toKind: 'session',
    toId: sessionId,
    kind: 'message',
    urgency: 'next-turn',
    lifecycle: 'wait',
    body: `text of ${id}`,
    expiresAt: null,
    createdAt: `2026-11-10T12:00:${String(n).padStart(2, '0')}.000Z`,
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
  }
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
}

interface Corpus {
  readonly store: SessionStore
  readonly reads: RecordReads
}

async function buildCorpus(): Promise<Corpus> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: [] })
  const issueStore = reg.issues.reports.store
  await issueStore.commitRepoWrite(
    issueStore.serverWriter,
    async () => await store.repos.addRepo('/repo', store.hostMachineId),
  )
  await quietShipping(reg)
  const owner = await firstAdminMemberId(store)
  const writer = issueStore.serverWriter
  const ids: IssueId[] = []
  for (let i = 0; i < 3; i++) {
    const created = await reg.issues.crud.create(writer, {
      repoPath: '/repo',
      title: `Issue ${i}`,
      startNow: false,
      parentBranch: 'main',
    })
    ids.push(created.id)
  }
  await reg.issues.crud.update(writer, ids[0]!, {
    description: 'A description',
    brief: 'A brief',
  } as never)
  await reg.issues.hierarchy.addDep(writer, ids[1]!, ids[0]!)
  await reg.issues.crud.markIssueRead(writer, ids[2]!, undefined, owner)
  await reg.issues.crud.panelApply(writer, ids[0]!, { op: 'todo-add', text: 'Task' })
  await reg.issues.crud.panelApply(writer, ids[0]!, { op: 'deferred-add', text: 'Later' } as never)
  await reg.issues.crud.panelApply(writer, ids[0]!, {
    op: 'artifact-add',
    path: 'review.html',
  })
  await reg.issues.crud.setState(writer, ids[0]!, 'Where things stand')
  const { sessionId } = await reg.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/other/w1',
  })
  await reg.modules.sessions.state.markRead(
    reg.modules.sessions.serverWriter,
    await reg.modules.sessions.view.principalForTrustedUser(owner),
    sessionId,
  )
  await reg.modules.interactions.ask({
    interaction: {
      id: 'ixn_open',
      sessionId,
      kind: 'question',
      payload: {
        v: 1,
        questions: [{ question: 'Which?', multiSelect: false, previewLayout: false, options: [] }],
      },
      source: 'protocol',
      answerable: 'structured',
      fingerprint: 'fp-ixn_open',
    },
  })
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_done', sessionId, owner, 1))
  await store.messages.markDelivered(fixtureWriteScope(), 'msg_done', sessionId, 't')
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_open', sessionId, owner, 2))
  const writes = (reg as unknown as { writes: WriteContexts }).writes
  await reg.modules.automations.create(
    writes.sync(asMutationId('m-6920-automation')),
    {
      name: 'Nightly sweep',
      repoPath: '/repo',
      cron: '0 3 * * *',
      agentKind: 'claude-code',
      prompt: 'sweep',
      enabled: false,
    },
    userCommandPrincipal(owner, 'admin'),
  )
  await reg.modules.layout.set(
    writes.sync(asMutationId('m-6920-layout')),
    owner,
    { dockTab: 'chat' },
    AT,
  )
  await reg.modules.readPosition.advance(
    writes.sync(asMutationId('m-6920-read')),
    owner,
    'issueEvents',
    { lastEventId: 3, seenAt: AT },
    AT,
  )
  // Kinds no service path above writes, seeded below the commit layer.
  await seedRows(store, async () => {
    await store.sessions.addPin(owner, 'issue', ids[0]!, AT)
    await store.sessions.setTabOrder(owner, '/other/w1', [sessionId])
    await store.conversations.index.upsert(fixtureWriteScope(), [
      {
        id: 'conv-1',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        machineId: store.hostMachineId,
      },
    ])
    await store.agentProfiles.insert({
      id: 'agp_6920',
      name: 'reviewer',
      description: '',
      candidates: [{ harness: 'codex', model: 'gpt-5.6', effort: 'medium' }],
      machineId: null,
      instructions: '',
      actor: 'operator',
      now: AT,
    } as never)
    await store.workflows.insertWorkflow({
      id: 'wf-6920',
      name: 'Ship it',
      description: 'a workflow',
      scope: 'global',
      scopeRef: null,
      actor: { kind: 'operator', id: null },
      ownerUserId: owner,
      now: AT,
    } as never)
  })
  await settle(reg)
  // The server stops here, so nothing writes between the checks' reads.
  const effectExecutors = reg.modules.effects!.executors
  await reg.dispose()
  return { store, reads: { store, effectExecutors, now: () => Date.parse(AT) } }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Every model table: what the schema declares, less the log's own tables. */
const MODEL_TABLES: readonly string[] = (Object.values(schema) as unknown[])
  .flatMap((value) => (is(value, SQLiteTable) ? [getTableName(value)] : []))
  .filter((name) => !name.startsWith('sync_') && !name.startsWith('__'))

/** The schema export that declares a table, by the table's SQL name. */
function tableExport(name: string): keyof typeof schema {
  for (const [key, value] of Object.entries(schema)) {
    if (is(value, SQLiteTable) && getTableName(value) === name) return key as keyof typeof schema
  }
  throw new Error(`no schema export for table ${name}`)
}

const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`

/** Every record of every kind, as JSON, keyed by kind and id. */
async function snapshot(reads: RecordReads): Promise<Map<string, string>> {
  const registry = serverRecordBuilders()
  const out = new Map<string, string>()
  for (const kind of registry.kinds()) {
    for await (const page of registry.streamAll(reads, kind)) {
      for (const record of page) out.set(recordKey(kind, record.id), JSON.stringify(record.value))
    }
  }
  return out
}

/** The tables a statement reads or writes, by name. */
function tablesOf(statement: string): string[] {
  const out: string[] = []
  for (const match of statement.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
    const name = match[1]!.toLowerCase()
    if (MODEL_TABLES.includes(name) || name.startsWith('sync_')) out.push(name)
  }
  return out
}

/**
 * CHECK 1: the tables each builder's SQL touches, against its declaration.
 * One line per kind that read a table it did not declare.
 */
async function undeclaredTableReads(
  corpus: Corpus,
  sources: RecordSources,
): Promise<string[]> {
  const registry = serverRecordBuilders()
  const violations: string[] = []
  for (const kind of registry.kinds()) {
    const declared = new Set((sources[kind] ?? []).map(sourceTableName))
    const read = new Set<string>()
    const detach = probeStatements(corpus.store as unknown as StatementProbeHolder, (row) => {
      for (const table of tablesOf(row.sql)) read.add(table)
    })
    try {
      const builder = registry.get(kind)
      const ids: string[] = []
      for await (const page of builder.streamAll(corpus.reads)) ids.push(...page.map((r) => r.id))
      await builder.build(corpus.reads, [...ids, 'no-such-record'])
    } finally {
      detach()
    }
    for (const table of read) {
      if (!declared.has(table)) violations.push(`${kind} reads ${table}`)
    }
  }
  return violations
}

class Rollback extends Error {}

/** A different value of the same kind, or undefined when there is none to try. */
function perturbed(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') return Number.isInteger(value) && (value === 0 || value === 1) ? 1 - value : value + 1
  if (typeof value === 'bigint') return value + 1n
  if (typeof value !== 'string') return undefined
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)))
    return new Date(Date.parse(value) + 1_000).toISOString()
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object') {
      const changed = perturbLeaf(parsed)
      return changed ? JSON.stringify(parsed) : undefined
    }
  } catch {
    // Not JSON: a plain string.
  }
  return `${value}~`
}

/** Change the first string, number or boolean leaf in place. */
function perturbLeaf(node: unknown): boolean {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const leaf = node[i]
      if (typeof leaf === 'string') return ((node[i] = `${leaf}~`), true)
      if (typeof leaf === 'number') return ((node[i] = leaf + 1), true)
      if (typeof leaf === 'boolean') return ((node[i] = !leaf), true)
      if (perturbLeaf(leaf)) return true
    }
    return false
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const leaf = record[key]
      if (typeof leaf === 'string') return ((record[key] = `${leaf}~`), true)
      if (typeof leaf === 'number') return ((record[key] = leaf + 1), true)
      if (typeof leaf === 'boolean') return ((record[key] = !leaf), true)
      if (perturbLeaf(leaf)) return true
    }
  }
  return false
}

/**
 * CHECK 2: change one column of one row (or delete the row), in a
 * transaction that is rolled back, and compare every record against the
 * baseline. A record that changed and that the capture did not name is a
 * missed change. One line per miss.
 */
async function missedChanges(
  corpus: Corpus,
  sources: RecordSources,
  tables: readonly string[] = MODEL_TABLES,
  rowsPerTable = 3,
): Promise<{ missed: string[]; tried: number; unread: string[] }> {
  const { store, reads } = corpus
  const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  const baseline = await store.transact(async () => await snapshot(reads))
  const missed: string[] = []
  /** Kinds a column's change was captured for without changing any of their records. */
  const unread = new Set<string>()
  let tried = 0
  for (const table of tables) {
    let rows: Record<string, unknown>[]
    try {
      rows = (await db.all(
        sql`SELECT rowid AS "__rowid", * FROM ${sql.identifier(table)} LIMIT ${rowsPerTable}`,
      )) as Record<string, unknown>[]
    } catch {
      continue // WITHOUT ROWID
    }
    for (const row of rows) {
      const rowid = row.__rowid
      const edits: { label: string; statement: ReturnType<typeof sql> }[] = []
      for (const [column, value] of Object.entries(row)) {
        if (column === '__rowid') continue
        const next = perturbed(value)
        if (next === undefined) continue
        edits.push({
          label: `${table}.${column}`,
          statement: sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${next} WHERE rowid = ${rowid}`,
        })
      }
      edits.push({
        label: `${table} delete`,
        statement: sql`DELETE FROM ${sql.identifier(table)} WHERE rowid = ${rowid}`,
      })
      for (const edit of edits) {
        try {
          await store.transact(async () => {
            try {
              await db.run(edit.statement)
            } catch {
              throw new Rollback('constraint') // a value the schema refuses
            }
            tried++
            const touched = await touchedRecords(
              await store.sync.drainCapture(),
              reads,
              undefined,
              sources,
            )
            const named = new Set<string>()
            for (const [kind, ids] of touched) for (const id of ids) named.add(recordKey(kind, id))
            let after: Map<string, string> | undefined
            try {
              after = await snapshot(reads)
            } catch (error) {
              if (named.size === 0)
                missed.push(`${edit.label}: a build failed (${String(error)}) and nothing was named`)
            }
            if (after !== undefined) {
              for (const key of new Set([...baseline.keys(), ...after.keys()])) {
                if (baseline.get(key) === after.get(key) || named.has(key)) continue
                missed.push(`${edit.label} -> ${key.replace('\u0000', '/')}`)
              }
              if (!edit.label.endsWith(' delete')) {
                for (const [kind, ids] of touched) {
                  const changed = ids.some((id) => {
                    const key = recordKey(kind, id)
                    return baseline.get(key) !== after?.get(key)
                  })
                  if (!changed) unread.add(`${edit.label} -> ${kind}`)
                }
              }
            }
            throw new Rollback('done')
          })
        } catch (error) {
          if (!(error instanceof Rollback)) throw error
        }
      }
    }
  }
  return { missed, tried, unread: [...unread].sort() }
}

async function withSources<T>(
  store: SessionStore,
  sources: RecordSources,
  run: () => Promise<T>,
): Promise<T> {
  const executor = (
    store as unknown as {
      executor: { exclusive<R>(fn: (session: DriverSession) => Promise<R>): Promise<R> }
    }
  ).executor
  await executor.exclusive(async (session) => await installChangeCapture(session, sources))
  try {
    return await run()
  } finally {
    await executor.exclusive(async (session) => await installChangeCapture(session))
  }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('record sources (POD-6920)', () => {
  let corpus: Corpus
  beforeAll(async () => {
    corpus = await buildCorpus()
  }, 60_000)
  afterAll(async () => {
    await corpus?.store.close()
  })

  it('declares every kind the server builds, with at least one source', () => {
    const kinds = serverRecordBuilders().kinds()
    expect(Object.keys(RECORD_SOURCES).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) expect(RECORD_SOURCES[kind].length, kind).toBeGreaterThan(0)
  })

  it('the corpus holds records of the kinds it means to cover', async () => {
    const records = await corpus.store.transact(async () => await snapshot(corpus.reads))
    const present = new Set([...records.keys()].map((key) => key.split('\u0000')[0]))
    const covered: MetadataEntityKind[] = [
      'repo',
      'machine',
      'machineAccess',
      'issueProjection',
      'issueBrief',
      'issueDescription',
      'issueDep',
      'issueUserState',
      'issuePanelTodo',
      'issuePanelDeferred',
      'issuePanelArtifact',
      'issuePanelState',
      'issueEvent',
      'session',
      'sessionUserState',
      'pendingInteraction',
      'message',
      'automation',
      'userLayout',
      'userReadPosition',
      'pin',
      'tabOrder',
      'conversation',
      'agentProfile',
      'workflow',
      'instancePreferences',
      'superagentThread',
    ]
    expect(covered.filter((kind) => !present.has(kind))).toEqual([])
  })

  it('each builder reads only the tables its kind declares', async () => {
    expect(await undeclaredTableReads(corpus, RECORD_SOURCES)).toEqual([])
  })

  it('every change to a row a record reads is captured for that record', async () => {
    const { missed, tried, unread } = await missedChanges(corpus, RECORD_SOURCES)
    // Over-declaration costs redundant log rows, not lost changes: reported,
    // not failed. A row the corpus holds may simply not move the record's
    // value for this perturbation.
    console.log('record-sources: captured without a record change', JSON.stringify(unread, null, 1))
    expect(tried).toBeGreaterThan(100)
    expect(missed).toEqual([])
  }, 300_000)

  it('refuses a write of a synced row that no commit drains, and keeps nothing of it', async () => {
    const { store } = corpus
    const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
    const before = (await db.all(sql`SELECT title FROM issues ORDER BY seq LIMIT 1`)) as {
      title: string
    }[]
    await expect(
      store.transact(async () => {
        await db.run(sql`UPDATE issues SET title = 'bypassed' WHERE seq = (SELECT min(seq) FROM issues)`)
      }),
    ).rejects.toThrow(/outside a change-log commit/)
    await expect(
      db.run(sql`UPDATE issues SET title = 'bypassed' WHERE seq = (SELECT min(seq) FROM issues)`),
    ).rejects.toThrow()
    expect(await db.all(sql`SELECT title FROM issues ORDER BY seq LIMIT 1`)).toEqual(before)
    expect(await db.all(sql`SELECT id FROM sync_capture`)).toEqual([])
  })

  it('a write that leaves every column as it was captures nothing', async () => {
    const { store } = corpus
    const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
    const captured: string[] = []
    let rewritten = 0
    for (const table of MODEL_TABLES) {
      let rows: Record<string, unknown>[]
      try {
        rows = (await db.all(
          sql`SELECT rowid AS "__rowid", * FROM ${sql.identifier(table)} LIMIT 3`,
        )) as Record<string, unknown>[]
      } catch {
        continue
      }
      const columns = Object.values(
        getTableColumns(schema[tableExport(table)] as unknown as SQLiteTable),
      ).map((column) => column.name)
      for (const row of rows) {
        await store.transact(async () => {
          await db.run(
            sql`UPDATE ${sql.identifier(table)} SET ${sql.join(
              columns.map((column) => sql`${sql.identifier(column)} = ${sql.identifier(column)}`),
              sql`, `,
            )} WHERE rowid = ${row.__rowid}`,
          )
          rewritten++
          for (const change of await store.sync.drainCapture())
            captured.push(`${table}: ${change.kind}`)
        })
      }
    }
    expect(rewritten).toBeGreaterThan(30)
    expect(captured).toEqual([])
  })

  it('fails both checks when a kind loses a declaration', async () => {
    // issueDep without its own table: its builder reads `issue_deps`, and a
    // change to an edge is captured for no record.
    const without: RecordSources = { ...RECORD_SOURCES, issueDep: [] }
    expect(await undeclaredTableReads(corpus, without)).toContain('issueDep reads issue_deps')
    const { missed } = await withSources(
      corpus.store,
      without,
      async () => await missedChanges(corpus, without, ['issue_deps']),
    )
    expect(missed.some((line) => line.includes('-> issueDep/'))).toBe(true)
  }, 120_000)
})
