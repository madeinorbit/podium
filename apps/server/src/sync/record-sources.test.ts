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
  primeFirstAdminMember,
  RECORDS,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { SyncRepository } from '@podium/sync'
import {
  collectRecords,
  type RecordBuilder,
  RecordBuilderRegistry,
} from '@podium/sync/record-builders'
import { fixtureWriteScope } from '@podium/sync/testing'
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import * as schema from '../migrations/schema'
import { effectPublication } from '../modules/effects/published-input'
import { SessionRegistry } from '../relay'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import type { DriverSession } from '../store/executor/driver'
import { probeStatements, type StatementProbeHolder } from '../store/executor/statement-probe'
import type { StoreDrizzle } from '../store/executor/sync-drizzle'
import type { MessageRow } from '../store/types'
import { attachHostDaemon } from '../test-support/host-daemon'
import { openTestStore } from '../test-support/open-test-store'
import { testStoreEngine } from '../test-support/pg-test-database'
import { seedRows } from '../test-support/seed-rows'
import { quietShipping } from '../test-support/statement-count'
import type { WriteContexts } from '../write-contexts'
import frozen from './__fixtures__/one-row-oracles.json'
import { captureTriggerStatements, installChangeCapture } from './capture-triggers'
import { readKindTokens } from './kind-tokens'
import { type RecordReads, serverRecordBuilders } from './record-builders'
import {
  RECORD_SOURCES,
  type RecordSources,
  type SourceChange,
  sourceTableName,
  touchedRecords,
} from './record-sources'
import { ROW_RECORDS } from './row-records'

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
  const [first, second, third] = ids as [IssueId, IssueId, IssueId]
  await reg.issues.crud.update(writer, first, {
    description: 'A description',
    brief: 'A brief',
  } as never)
  await reg.issues.hierarchy.addDep(writer, second, first)
  await reg.issues.crud.markIssueRead(writer, third, undefined, owner)
  await reg.issues.crud.panelApply(writer, first, { op: 'todo-add', text: 'Task' })
  await reg.issues.crud.panelApply(writer, first, { op: 'deferred-add', text: 'Later' } as never)
  await reg.issues.crud.panelApply(writer, first, {
    op: 'artifact-add',
    path: 'review.html',
  })
  await reg.issues.crud.setState(writer, first, 'Where things stand')
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
  await store.messages.markDelivered(
    fixtureWriteScope(),
    'msg_done',
    sessionId,
    '2026-11-17T00:00:00.000Z',
  )
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
    await store.sessions.addPin(owner, 'issue', first, AT)
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
  // Two machine scans (POD-6941): a person's, on the feed, and the server's
  // own connect scan, which no device receives and the log never carries.
  const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  await seedRows(store, async () => {
    await db.run(sql`INSERT INTO automation_runs (workspace_id, id, on_behalf_of, automation_id, fired_at, session_id, outcome, detail)
      SELECT workspace_id, 'run-row-1', ${owner}, id, ${AT}, ${sessionId}, 'spawned', NULL FROM automations LIMIT 1`)
    await db.run(sql`INSERT INTO workflow_revisions (workspace_id, id, workflow_id, version, instructions, steps_json, created_by_kind, created_at)
      VALUES (${SELF_HOSTED_WORKSPACE_ID}, 'rev-row-1', 'wf-6920', 1, 'Review', '[{"id":"review","title":"Review"}]', 'operator', ${AT})`)
    await db.run(sql`INSERT INTO workflow_bindings (workspace_id, target_kind, target_id, revision_id, updated_by_kind, updated_at, owner_user_id)
      VALUES (${SELF_HOSTED_WORKSPACE_ID}, 'global', 'default', 'rev-row-1', 'operator', ${AT}, ${owner})`)
    await db.run(sql`INSERT INTO checkouts (workspace_id, machine_id, path, root, kind, branch, updated_at)
      VALUES (${SELF_HOSTED_WORKSPACE_ID}, ${store.hostMachineId}, '/row-checkout', '/row-checkout', 'repository', 'main', ${AT})`)
    await db.run(sql`INSERT INTO subscriptions (workspace_id, id, subscriber_kind, subscriber_id, event, source_kind, source_ref, deliver_nudge, deliver_notify, origin, enabled, created_at)
      VALUES (${SELF_HOSTED_WORKSPACE_ID}, 'sub-row-1', 'issue', ${first}, 'issue.closed', 'issue', ${second}, ${true}, ${false}, 'custom', ${true}, ${AT})`)
    for (const [id, createdBy] of [
      ['eff_person_scan', owner],
      ['eff_system_scan', null],
    ] as const) {
      await db.run(
        // The workspace has no default since the keys migration (POD-7024).
        sql`INSERT INTO effects (workspace_id, id, kind, target_kind, target_id, input_json, result_json, status, attempts, created_by, created_at, updated_at) VALUES ('local', ${id}, 'machine.scan', 'machine', ${store.hostMachineId}, '{"deep":false}', '{"repos":[]}', 'succeeded', 1, ${createdBy}, 1, 2)`,
      )
    }
  })
  await settle(reg)
  // The server stops here, so nothing writes between the checks' reads.
  const effects = reg.modules.effects
  if (effects === undefined) throw new Error('the registry has no effects module')
  const effectExecutors = effects.executors
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

/** Every model table's columns, by the table's SQL name. */
const TABLE_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map(
  (Object.values(schema) as unknown[]).flatMap((value) =>
    is(value, SQLiteTable)
      ? [[getTableName(value), Object.values(getTableColumns(value)).map((c) => c.name)] as const]
      : [],
  ),
)

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
  for (const match of statement.matchAll(
    /\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    const name = (match[1] ?? '').toLowerCase()
    if (MODEL_TABLES.includes(name) || name.startsWith('sync_')) out.push(name)
  }
  return out
}

/**
 * CHECK 1: the tables each builder's SQL touches, against its declaration.
 * One line per kind that read a table it did not declare.
 */
async function undeclaredTableReads(corpus: Corpus, sources: RecordSources): Promise<string[]> {
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
  if (typeof value === 'number')
    return Number.isInteger(value) && (value === 0 || value === 1) ? 1 - value : value + 1
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
/** A changed scalar, or undefined when `leaf` is not one. */
function changedScalar(leaf: unknown): unknown {
  if (typeof leaf === 'string') return `${leaf}~`
  if (typeof leaf === 'number') return leaf + 1
  if (typeof leaf === 'boolean') return !leaf
  return undefined
}

function perturbLeaf(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  const slots = node as Record<string, unknown>
  for (const key of Object.keys(slots)) {
    const changed = changedScalar(slots[key])
    if (changed !== undefined) {
      slots[key] = changed
      return true
    }
    if (perturbLeaf(slots[key])) return true
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
                missed.push(
                  `${edit.label}: a build failed (${String(error)}) and nothing was named`,
                )
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
  // The executor lives on the StoreDatabase the workspace's store belongs to.
  const executor = (
    store.database as unknown as {
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

/**
 * A case that probes SQLite's capture TRIGGERS: it writes below the repositories with raw
 * SQL (and reads `sqlite_master`), which a trigger catches. On Postgres there are no
 * triggers by design, so a raw statement captures nothing; the Postgres capture forms are
 * proved against SQLite's triggers and the oracle by `capture-pg.test.ts` (POD-6982), and
 * the declarations cases below run on both engines (POD-6994).
 */
const onSqliteTriggers = it.runIf(testStoreEngine() !== 'pg')

/** Where a frozen table's rows live now: the settings blob moved to `workspace_meta`. */
const replayedTable = (table: string): string => (table === 'meta' ? 'workspace_meta' : table)

/**
 * A capture trigger with the workspace's additions (POD-7021, POD-7013) taken out:
 * the key column, the test for a move between workspaces, each lookup's workspace
 * term, and the table the settings blob moved to.
 */
function withoutWorkspaceTerms(trigger: string): string {
  return trigger
    .replaceAll('OLD."workspace_id", ', '')
    .replaceAll('NEW."workspace_id", ', '')
    .replaceAll('OLD."workspace_id" IS NOT NEW."workspace_id" OR ', '')
    .replace(/"?workspace_id"? = (OLD|NEW)\."?workspace_id"? AND /g, '')
    .replace(/(\w+)\."workspace_id" = (OLD|NEW)\."workspace_id" AND /g, '')
    .replace(' ON "workspace_meta" ', ' ON "meta" ')
}

describe('record sources (POD-6920)', () => {
  let corpus: Corpus
  beforeAll(async () => {
    corpus = await buildCorpus()
  }, 60_000)
  afterAll(async () => {
    await corpus?.store.close()
  })

  // The frozen evidence was captured on SQLite (`__fixtures__/README.md`) and is
  // replayed with SQLite's deferred foreign keys: the group runs on SQLite. The
  // record bytes on Postgres are held by record-payloads.pg.test.ts (POD-7118).
  describe.runIf(testStoreEngine() !== 'pg')('one-row generation (POD-7091)', () => {
    const after = serverRecordBuilders()
    const kinds = Object.keys(frozen.records) as (keyof typeof frozen.records &
      keyof typeof ROW_RECORDS)[]
    // Declared after the oracle was frozen (POD-6881): it was never a hand-written row
    // builder to compare against; `store/notices.test.ts` and the isolation test cover it.
    const AFTER_THE_ORACLE: readonly string[] = ['inboxNotice']
    /**
     * WHAT CREDENTIAL MANAGEMENT CHANGED SINCE THE ORACLE (POD-6857), each named, so
     * everything else stays byte-equal to it. The instance record gained the daemon
     * link's trusted networks; the session rows gained their credential columns,
     * which its capture trigger watches; and the wire schemas of these kinds gained
     * fields, which moves their shape tokens.
     */
    const sinceTheOracle = (kind: string, recordBytes: string): string =>
      kind === 'instancePreferences'
        ? recordBytes.replaceAll(',"daemonLink.trustedNetworks":[]', '')
        : recordBytes
    const CREDENTIAL_COLUMNS_WATCHED =
      ' OR OLD."credential_id" IS NOT NEW."credential_id" OR OLD."effective_auth" IS NOT NEW."effective_auth" OR OLD."credential_mismatch" IS NOT NEW."credential_mismatch"'
    const SHAPES_CHANGED_SINCE_THE_ORACLE: Record<string, string> = {
      effect: 'a schema its wire value nests gained credential management fields',
      instancePreferences: "the daemon link's trusted networks",
      machineAccess: 'a schema its wire value nests gained credential management fields',
      session: 'the credential a session runs on, what it reported and the mismatch',
      userPreferences: "a person's credential defaults per harness",
      inboxNotice: 'declared after the oracle',
    }
    const withoutChangedShapes = (tokens: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(tokens).filter(([kind]) => !(kind in SHAPES_CHANGED_SINCE_THE_ORACLE)),
      )
    const bytes = (rows: readonly unknown[]) => JSON.stringify(rows)
    const byId = (streamed: string): string =>
      JSON.stringify(
        (JSON.parse(streamed) as { id: string }[]).sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      )
    let replay: Corpus

    beforeAll(async () => {
      const store = await openTestStore(':memory:')
      // openTestStore primes the ambient admin; the outer live corpus still
      // belongs to its original store. These row readers need no principal.
      primeFirstAdminMember(await firstAdminMemberId(corpus.store))
      try {
        const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
        const tables = Object.entries(frozen.tables) as [
          string,
          Record<string, string | number | null>[],
        ][]
        await seedRows(store, async () => {
          // The captured inputs are in parent-first order. Deferral also
          // allows self-referencing rows to be replayed in their stored order.
          // The frozen rows come from a store with no workspaces (POD-7118): each
          // is replayed into the self-hosted workspace, and `meta`'s settings blob
          // into `workspace_meta`, where the meta split moved it.
          await db.run(sql`PRAGMA defer_foreign_keys = ON`)
          for (const [table] of [...tables].reverse())
            await db.run(sql`DELETE FROM ${sql.identifier(replayedTable(table))}`)
          for (const [table, rows] of tables) {
            for (const row of rows) {
              const columns = Object.entries({ workspace_id: SELF_HOSTED_WORKSPACE_ID, ...row })
              await db.run(
                sql`INSERT INTO ${sql.identifier(replayedTable(table))} (${sql.join(
                  columns.map(([name]) => sql.identifier(name)),
                  sql`, `,
                )}) VALUES (${sql.join(
                  columns.map(([, value]) => sql`${value}`),
                  sql`, `,
                )})`,
              )
            }
          }
        })
        expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        replay = {
          store,
          reads: {
            store,
            effectExecutors: effectPublication(frozen.effectKinds),
            now: () => frozen.now,
          },
        }
      } catch (error) {
        await store.close()
        throw error
      }
    })
    afterAll(async () => {
      await replay?.store.close()
    })

    it('generates every row declaration and keeps genuinely joined kinds explicit', () => {
      const rowKinds = RECORDS.filter((record) => record.builderShape === 'row').map(
        (record) => record.kind,
      )
      expect(Object.keys(ROW_RECORDS).sort()).toEqual([...rowKinds].sort())
      expect([...kinds].sort()).toEqual(
        rowKinds.filter((kind) => !AFTER_THE_ORACLE.includes(kind)).sort(),
      )
      for (const binding of Object.values(ROW_RECORDS)) {
        expect(after.get(binding.declaration.kind)).toBe(binding.builder)
        expect(RECORD_SOURCES[binding.declaration.kind]).toBe(binding.sources)
      }
      for (const kind of [
        'workflow',
        'issuePanelTodo',
        'issuePanelArtifact',
        'issuePanelDeferred',
        'issuePanelState',
      ] as const)
        expect(after.get(kind).shape, kind).toBe('row-and-reads')
    })

    it('produces byte-equal builds and streams for every converted kind on SQLite', async () => {
      for (const kind of kinds) {
        const expected = frozen.records[kind]
        expect(
          JSON.parse(expected.streamBytes).length,
          `${kind}: frozen records must be nonempty`,
        ).toBeGreaterThan(0)
        // A stream is a set of records: the reads name no order, and the workspace
        // key leads SQLite through the key index instead of the table's row order
        // (POD-7118; Postgres has its own). Each record's bytes are compared, by id.
        expect(
          byId(
            sinceTheOracle(kind, bytes(await collectRecords(after.streamAll(replay.reads, kind)))),
          ),
          `${kind}: stream`,
        ).toBe(byId(expected.streamBytes))
        expect(
          sinceTheOracle(kind, bytes(await after.build(replay.reads, kind, expected.ids))),
          `${kind}: build`,
        ).toBe(expected.buildBytes)
        expect(bytes(await after.build(replay.reads, kind, [])), `${kind}: no ids`).toBe(
          expected.emptyBytes,
        )
        expect(
          bytes(await after.build(replay.reads, kind, ['no-such-record'])),
          `${kind}: missing`,
        ).toBe(expected.missingBytes)
      }
    })

    it('the byte comparison fails for a wrong generated answer', async () => {
      for (const kind of kinds) {
        const expected = frozen.records[kind]
        const original = after.get(kind)
        const wrong: RecordBuilder<RecordReads> = {
          ...original,
          build: async (reads, ids) =>
            (await original.build(reads, ids)).map((row) => ({
              ...row,
              value: { ...(row.value as object), wrong: true },
            })),
        }
        const mutated = new RecordBuilderRegistry([wrong])
        const wrongBytes = bytes(await mutated.build(replay.reads, kind, expected.ids))
        expect(() => expect(wrongBytes, kind).toBe(expected.buildBytes), kind).toThrow()
      }
    })

    // The frozen triggers predate the workspace (POD-7118): the integration's
    // capture keys lead with `workspace_id`, a move of a row's workspace is a
    // change, every lookup a filter makes matches the row's workspace, and the
    // settings blob is captured on `workspace_meta`. With exactly those taken out,
    // every trigger is the frozen text; and every trigger keys its row's workspace.
    it('keeps every generated capture trigger textually equal to before, with the workspace added', () => {
      const triggers = captureTriggerStatements()
      expect(
        triggers
          .filter((text) => !text.includes('"sync_capture__inboxNotice__'))
          .map((text) => withoutWorkspaceTerms(text).replace(CREDENTIAL_COLUMNS_WATCHED, '')),
      ).toEqual(frozen.triggers)
      // `meta` is an install table: its fleet keys capture no workspace.
      for (const trigger of triggers.filter((text) => !text.includes(' ON "meta" '))) {
        expect(trigger, trigger.slice(0, 80)).toMatch(/json_array\((OLD|NEW)\."workspace_id", /)
      }
    })

    it('keeps captured record identities for inserts, moves and deletes', async () => {
      for (const kind of kinds) {
        const source = ROW_RECORDS[kind].sources[0]
        if (!source) throw new Error(`${kind}: missing capture source`)
        const expected = frozen.captures[kind]
        // The captured keys lead with the row's workspace (POD-7118).
        const changes = (expected.changes as SourceChange[]).map((change) => ({
          ...change,
          old: change.old === null ? null : [SELF_HOSTED_WORKSPACE_ID, ...change.old],
          new: change.new === null ? null : [SELF_HOSTED_WORKSPACE_ID, ...change.new],
        }))
        expect([...(await source.ids(changes, replay.reads))], kind).toEqual(expected.ids)
      }
    })

    it('keeps all shape tokens unchanged', async () => {
      const sync = { readKindGenerations: async () => frozen.generations } as Pick<
        SyncRepository,
        'readKindGenerations'
      > as SyncRepository
      expect(withoutChangedShapes(await readKindTokens(sync, frozen.effectKinds))).toEqual(
        withoutChangedShapes(frozen.tokens),
      )
    })
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
      'effect',
    ]
    expect(covered.filter((kind) => !present.has(kind))).toEqual([])
  })

  it("builds a person's machine scan and not the server's own (POD-6941)", async () => {
    const records = await corpus.store.transact(async () => await snapshot(corpus.reads))
    const effects = [...records.keys()].filter((key) => key.startsWith('effect\u0000'))
    expect(effects).toEqual([recordKey('effect', 'eff_person_scan')])
  })

  it('each builder reads only the tables its kind declares', async () => {
    expect(await undeclaredTableReads(corpus, RECORD_SOURCES)).toEqual([])
  })

  onSqliteTriggers(
    'every change to a row a record reads is captured for that record',
    async () => {
      const { missed, tried, unread } = await missedChanges(corpus, RECORD_SOURCES)
      // Over-declaration costs redundant log rows, not lost changes: reported,
      // not failed. A row the corpus holds may simply not move the record's
      // value for this perturbation.
      console.log(
        'record-sources: captured without a record change',
        JSON.stringify(unread, null, 1),
      )
      expect(tried).toBeGreaterThan(100)
      expect(missed).toEqual([])
    },
    300_000,
  )

  onSqliteTriggers(
    'refuses a write of a synced row that no commit drains, and keeps nothing of it',
    async () => {
      const { store } = corpus
      const db = (store as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
      const before = (await db.all(sql`SELECT title FROM issues ORDER BY seq LIMIT 1`)) as {
        title: string
      }[]
      await expect(
        store.transact(async () => {
          await db.run(
            sql`UPDATE issues SET title = 'bypassed' WHERE seq = (SELECT min(seq) FROM issues)`,
          )
        }),
      ).rejects.toThrow(/outside a change-log commit/)
      await expect(
        db.run(sql`UPDATE issues SET title = 'bypassed' WHERE seq = (SELECT min(seq) FROM issues)`),
      ).rejects.toThrow()
      expect(await db.all(sql`SELECT title FROM issues ORDER BY seq LIMIT 1`)).toEqual(before)
      expect(await db.all(sql`SELECT id FROM sync_capture`)).toEqual([])
    },
  )

  onSqliteTriggers('a write that leaves every column as it was captures nothing', async () => {
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
      const columns = TABLE_COLUMNS.get(table) ?? []
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

  onSqliteTriggers(
    'fails both checks when a kind loses a declaration',
    async () => {
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
    },
    120_000,
  )
})
