/**
 * One-row record bindings (POD-7091). The shared declaration supplies the
 * schema, identity and shape. The drizzle binding supplies capture keys and
 * columns; the repositories keep ownership of prepared SQL and row decoding.
 * Existing publisher codecs preserve field order, omissions and corrupt-row
 * behavior. There is no per-kind build/stream implementation here.
 */
import {
  type IssueUserState,
  instancePreferencesRecordOf,
  issueUserStateToWire,
  parseCheckoutRowId,
  parseIssueDepId,
  parseIssueUserStateRowId,
  parseLayoutRowId,
  parsePinRowId,
  parseReadPositionRowId,
  parseSubscriptionRowId,
  parseSuperagentThreadRowId,
  parseTabOrderRowId,
  parseWorkflowBindingRowId,
  type RecordKind,
  type RecordValue,
  recordOf,
  type UserId,
} from '@podium/model'
import {
  generatedRowBuilder,
  RECORD_PAGE_SIZE,
  type RowRecordReader,
} from '@podium/sync/record-builders'
import { type Column, getTableColumns, type Table } from 'drizzle-orm'
import { effectOnFeed, effectRecordOf } from '../modules/effects/feed'
import { SYSTEM_EFFECT_KINDS_OFF_FEED } from '../modules/effects/published-input'
import {
  issueBriefOf,
  issueDepToProjection,
  issueDescriptionOf,
  issueRowToProjection,
} from '../modules/issues/projection'
import { superagentThreadWireOf } from '../modules/superagent/thread-records'
import { checkoutWireOf } from '../store/checkout-record'
import { bindingFor } from '../store/executor/binding'
import type { RecordReads } from './record-builders'
import type { RecordSource } from './record-sources'
import { source as capturedSource } from './workspace-capture'

/** The tables these declarations name, from the store's binding (POD-6959: no
 *  table is imported from the schema module); names and columns are the same on
 *  both engines. */
const {
  agentProfiles,
  automationRuns,
  automations,
  checkouts,
  effects,
  issueDeps,
  issues,
  issueUserState,
  pins,
  subscriptions,
  superagentThreads,
  tabOrder,
  userLayout,
  userReadPosition,
  workflowBindings,
  workflowRevisions,
  workspaceMeta,
} = bindingFor('sqlite')

/** Ignore malformed composite record ids, as the old builders did. */
function parsed<T>(ids: readonly string[], parse: (id: string) => T | null | undefined): T[] {
  return ids.flatMap((id) => {
    try {
      const key = parse(id)
      return key === null || key === undefined ? [] : [key]
    } catch {
      return []
    }
  })
}
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const identity = <T>(value: T): T => value

/**
 * Capture key names are declaration field names, in the existing trigger's
 * order. An alias (entityId/issue_id, threadId/id) is written only here.
 * Capture watches all table columns unless explicitly narrowed: preserving
 * that conservative watch set keeps existing trigger text unchanged.
 */
function rowRecord<K extends RecordKind, Row>(
  kind: K,
  source: {
    readonly table: Table
    readonly key: Readonly<Record<string, Column>>
  } & Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived' | 'pg'>>,
  reader: RowRecordReader<RecordReads, Row>,
  projectRow: (row: Row, reads: RecordReads) => RecordValue<K> | undefined,
  options?: { readonly invalid?: 'omit'; readonly skipEmptyPages?: boolean },
) {
  const declaration = recordOf(kind)
  const { key, table, ...capture } = source
  const entries = Object.entries(key)
  const columns = new Set(Object.values(getTableColumns(source.table)))
  for (const [, column] of entries) {
    if (!columns.has(column)) throw new Error(`${kind}: capture key belongs to another table`)
  }
  const generated = generatedRowBuilder<RecordReads, Row, RecordValue<K>>(
    { ...declaration, rowKey: (value) => declaration.rowKey(value as never) },
    reader,
    projectRow,
    options,
  )
  // The capture keys lead with the row's workspace on a workspace table, and
  // the mapping reads the declared key without it (`workspace-capture.ts`).
  const sources: readonly RecordSource[] = [
    capturedSource(
      table,
      entries.map(([, column]) => column),
      (changes) =>
        unique(
          changes.flatMap((change) =>
            [change.old, change.new].flatMap((values) => {
              if (values === null) return []
              if (entries.length === 1 && entries[0]?.[0] === declaration.key && values[0] == null)
                return []
              const fields = Object.fromEntries(
                entries.map(([field], i) => [field, String(values[i])]),
              )
              return [declaration.rowKey(fields as never)]
            }),
          ),
        ),
      capture,
    ),
  ]
  return { ...generated, declaration, sources }
}

const issueRows = {
  byIds: async ({ store }: RecordReads, ids: readonly string[]) =>
    (await store.issues.getIssues(ids)).values(),
  all: ({ store }: RecordReads) => store.issues.issueRowPages(RECORD_PAGE_SIZE),
}

export const ROW_RECORDS = {
  issueBrief: rowRecord(
    'issueBrief',
    {
      table: issues,
      key: { id: issues.id },
      reads: [issues.brief],
      rows: `coalesce({row}.${issues.brief.name}, '') <> ''`,
    },
    issueRows,
    (row) => issueBriefOf(issueRowToProjection(row, [])),
    { invalid: 'omit' },
  ),
  issueDescription: rowRecord(
    'issueDescription',
    {
      table: issues,
      key: { id: issues.id },
      reads: [issues.description],
      rows: `coalesce({row}.${issues.description.name}, '') <> ''`,
    },
    issueRows,
    (row) => issueDescriptionOf(issueRowToProjection(row, [])),
    { invalid: 'omit' },
  ),
  issueDep: rowRecord(
    'issueDep',
    {
      table: issueDeps,
      key: { fromId: issueDeps.fromId, toId: issueDeps.toId, type: issueDeps.type },
    },
    {
      byIds: ({ store }, ids) =>
        store.issues.depsFromIssues(unique(parsed(ids, parseIssueDepId).map((key) => key.fromId))),
      all: ({ store }) => store.issues.listAllIssueDeps(),
    },
    issueDepToProjection,
    { invalid: 'omit' },
  ),
  issueUserState: rowRecord(
    'issueUserState',
    {
      table: issueUserState,
      key: { userId: issueUserState.userId, entityId: issueUserState.issueId },
    },
    {
      async byIds({ store }, ids) {
        const groups = new Map<UserId, string[]>()
        for (const { userId, entityId } of parsed(ids, parseIssueUserStateRowId)) {
          const issueIds = groups.get(userId) ?? []
          issueIds.push(entityId)
          groups.set(userId, issueIds)
        }
        return (
          await Promise.all(
            [...groups].map(async ([userId, keys]) =>
              [...(await store.issues.loadIssueUserStates(userId, keys))].flatMap(
                ([entityId, state]) =>
                  state === undefined ? [] : [{ userId, entityId, ...state } as IssueUserState],
              ),
            ),
          )
        ).flat()
      },
      all: ({ store }) => store.issues.listIssueUserStateRows(),
    },
    issueUserStateToWire,
  ),
  subscription: rowRecord(
    'subscription',
    {
      table: subscriptions,
      key: {
        subscriberKind: subscriptions.subscriberKind,
        subscriberId: subscriptions.subscriberId,
        id: subscriptions.id,
      },
    },
    {
      byIds: ({ store }, ids) =>
        store.events.subscriptionsByIds(parsed(ids, (id) => parseSubscriptionRowId(id).id)),
      all: ({ store }) => store.events.allSubscriptionsForBootReconcile(),
    },
    identity,
  ),
  automation: rowRecord(
    'automation',
    {
      table: automations,
      key: { id: automations.id },
      rows: `{row}.${automations.deletedAt.name} IS NULL`,
    },
    {
      byIds: ({ store }, ids) => store.automations.getMany(ids),
      all: ({ store }) => store.automations.list(),
    },
    identity,
  ),
  automationRun: rowRecord(
    'automationRun',
    {
      table: automationRuns,
      key: { id: automationRuns.id },
      rows: `{row}.${automationRuns.deletedAt.name} IS NULL`,
    },
    {
      byIds: ({ store }, ids) => store.automations.getRuns(ids),
      all: ({ store }) => store.automations.listAllRuns(),
    },
    identity,
  ),
  userLayout: rowRecord(
    'userLayout',
    {
      table: userLayout,
      key: { userId: userLayout.userId, key: userLayout.key },
      reads: { allBut: [userLayout.updatedAt] },
    },
    {
      async byIds({ store }, ids) {
        const rows = []
        for (const userId of unique(parsed(ids, parseLayoutRowId).map((key) => key.userId)))
          for (const [key, value] of Object.entries(await store.layout.getSnapshot(userId)))
            rows.push({ userId, key, value })
        return rows
      },
      all: ({ store }) => store.layout.allForBootReconcile(),
    },
    identity,
  ),
  userReadPosition: rowRecord(
    'userReadPosition',
    {
      table: userReadPosition,
      key: { userId: userReadPosition.userId, streamId: userReadPosition.streamId },
      reads: { allBut: [userReadPosition.updatedAt] },
    },
    {
      async byIds({ store }, ids) {
        const rows = []
        for (const userId of unique(parsed(ids, parseReadPositionRowId).map((key) => key.userId)))
          for (const [streamId, cursor] of Object.entries(
            await store.readPositions.getSnapshot(userId),
          ))
            rows.push({ userId, streamId, lastEventId: cursor.lastEventId, seenAt: cursor.seenAt })
        return rows
      },
      all: ({ store }) => store.readPositions.allPositionPages(RECORD_PAGE_SIZE),
    },
    ({ userId, streamId, lastEventId, seenAt }) => ({ userId, streamId, lastEventId, seenAt }),
  ),
  pin: rowRecord(
    'pin',
    {
      table: pins,
      key: { userId: pins.userId, kind: pins.kind, entityId: pins.id },
    },
    {
      byIds: ({ store }, ids) =>
        store.sessions.pinsOfUsers(unique(parsed(ids, parsePinRowId).map((key) => key.userId))),
      all: ({ store }) => store.sessions.allPinsForBootReconcile(),
    },
    identity,
  ),
  tabOrder: rowRecord(
    'tabOrder',
    {
      table: tabOrder,
      key: { userId: tabOrder.userId, entityId: tabOrder.worktree },
      reads: { allBut: [tabOrder.updatedAt] },
    },
    {
      byIds: ({ store }, ids) =>
        store.sessions.tabOrdersOfUsers(
          unique(parsed(ids, parseTabOrderRowId).map((key) => key.userId)),
        ),
      all: ({ store }) => store.sessions.allTabOrdersForBootReconcile(),
    },
    identity,
  ),
  superagentThread: rowRecord(
    'superagentThread',
    {
      table: superagentThreads,
      key: { ownerUserId: superagentThreads.ownerUserId, threadId: superagentThreads.id },
      reads: {
        allBut: [
          superagentThreads.watermarkItemId,
          superagentThreads.watermarkTs,
          superagentThreads.harnessSessionId,
          superagentThreads.terminalSessionId,
        ],
      },
      derived: [`{row}.${superagentThreads.harnessSessionId.name} IS NOT NULL`],
    },
    {
      byIds: ({ store }, ids) =>
        store.superagent.superagentThreadsByIds(
          parsed(ids, parseSuperagentThreadRowId).map((key) => key.threadId),
        ),
      all: ({ store }) => store.superagent.allThreadsForBootReconcile(),
    },
    superagentThreadWireOf,
  ),
  agentProfile: rowRecord(
    'agentProfile',
    {
      table: agentProfiles,
      key: { id: agentProfiles.id },
    },
    {
      async byIds({ store }, ids) {
        const asked = new Set(ids)
        return (await store.agentProfiles.list()).filter((value) => asked.has(value.id))
      },
      all: ({ store }) => store.agentProfiles.list(),
    },
    identity,
  ),
  workflowRevision: rowRecord(
    'workflowRevision',
    {
      table: workflowRevisions,
      key: { id: workflowRevisions.id },
    },
    {
      byIds: ({ store }, ids) => store.workflows.revisionsByIds(ids),
      all: ({ store }) => store.workflows.allRevisionsForBootReconcile(),
    },
    identity,
  ),
  workflowBinding: rowRecord(
    'workflowBinding',
    {
      table: workflowBindings,
      key: { targetKind: workflowBindings.targetKind, targetId: workflowBindings.targetId },
    },
    {
      async byIds({ store }, ids) {
        const declaration = recordOf('workflowBinding')
        const asked = new Set(
          parsed(ids, parseWorkflowBindingRowId).map((key) => declaration.rowKey(key as never)),
        )
        return (await store.workflows.listBindings()).filter((value) =>
          asked.has(declaration.rowKey(value)),
        )
      },
      all: ({ store }) => store.workflows.listBindings(),
    },
    identity,
  ),
  instancePreferences: rowRecord(
    'instancePreferences',
    {
      // The settings blob is a workspace key: it moved from `meta` to
      // `workspace_meta` with the meta split (POD-7013).
      table: workspaceMeta,
      key: { key: workspaceMeta.key },
      rows: `{row}.${workspaceMeta.key.name} = 'settings'`,
    },
    {
      byIds: async ({ store }, ids) =>
        ids.includes(recordOf('instancePreferences').rowKey({} as never))
          ? [await store.settings.getSettings()]
          : [],
      all: async ({ store }) => [await store.settings.getSettings()],
    },
    instancePreferencesRecordOf,
  ),
  effect: rowRecord(
    'effect',
    {
      table: effects,
      key: { id: effects.id },
      rows: `{row}.${effects.deletedAt.name} IS NULL AND ({row}.${effects.createdBy.name} IS NOT NULL OR {row}.${effects.kind.name} NOT IN (${SYSTEM_EFFECT_KINDS_OFF_FEED.map((kind) => `'${kind}'`).join(', ')}))`,
    },
    {
      byIds: ({ store }, ids) => store.effects.liveByIds(ids),
      all: ({ store }) => store.effects.livePages(RECORD_PAGE_SIZE),
    },
    (row, reads) => (effectOnFeed(row) ? effectRecordOf(row, reads.effectExecutors) : undefined),
    { skipEmptyPages: true },
  ),
  checkout: rowRecord(
    'checkout',
    {
      table: checkouts,
      key: { machineId: checkouts.machineId, path: checkouts.path },
    },
    {
      byIds: ({ store }, ids) =>
        store.checkouts.ofMachines(
          unique(parsed(ids, parseCheckoutRowId).map((key) => key.machineId)),
        ),
      all: ({ store }) => store.checkouts.all(),
    },
    checkoutWireOf,
  ),
} as const
