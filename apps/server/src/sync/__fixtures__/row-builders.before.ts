/** Frozen pre-generation builders, used only by the byte-parity regression. */
import {
  checkoutRowId,
  INSTANCE_PREFERENCES_ROW_ID,
  type IssueBodyKind,
  type IssueProjection,
  instancePreferencesRecordOf,
  issueUserStateRowId,
  issueUserStateToWire,
  layoutRowId,
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
  pinRowId,
  readPositionRowId,
  subscriptionRowIdOf,
  superagentThreadRowId,
  tabOrderRowId,
  type UserId,
  workflowBindingRowId,
} from '@podium/model'
import {
  type BuiltRecord,
  pagesOf,
  RECORD_PAGE_SIZE,
  type RecordBuilder,
} from '@podium/sync/record-builders'
import { effectOnFeed, effectRecordOf } from '../../modules/effects/feed'
import type { EffectExecutorRegistry } from '../../modules/effects/registry'
import {
  issueBriefOf,
  issueDepToProjection,
  issueDescriptionOf,
  issueRowToProjection,
} from '../../modules/issues/projection'
import { superagentThreadWireOf } from '../../modules/superagent/thread-records'
import { checkoutWireOf } from '../../store/checkouts'
import type { IssueRow } from '../../store/types'
import type { RecordReads } from '../record-builders'

type Builder = RecordBuilder<RecordReads>
/** Parse each id with `parse`; an id the kind never composed is no record. */
function parsed<T>(ids: readonly string[], parse: (id: string) => T | null | undefined): T[] {
  const out: T[] = []
  for (const id of ids) {
    try {
      const key = parse(id)
      if (key !== null && key !== undefined) out.push(key)
    } catch {
      // Not this kind's id.
    }
  }
  return out
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

/** One body kind of each issue row (POD-6921): its record, or none when the
 *  field is empty or the row cannot be projected. */
function issueBodyBuilder(
  kind: IssueBodyKind,
  of: (projection: IssueProjection) => { id: string } | undefined,
): Builder {
  const records = (rows: Iterable<IssueRow>): BuiltRecord[] =>
    [...rows].flatMap((row) => {
      try {
        const value = of(issueRowToProjection(row, []))
        return value ? [{ id: row.id, value }] : []
      } catch {
        return []
      }
    })
  return {
    kind,
    shape: 'row',
    build: async ({ store }, ids) => records((await store.issues.getIssues(ids)).values()),
    async *streamAll({ store }) {
      for await (const page of store.issues.issueRowPages(RECORD_PAGE_SIZE)) yield records(page)
    },
  }
}

const issueBrief = issueBodyBuilder('issueBrief', issueBriefOf)
const issueDescription = issueBodyBuilder('issueDescription', issueDescriptionOf)

function depRecords(deps: Iterable<{ fromId: string; toId: string; type: string }>): BuiltRecord[] {
  return [...deps].flatMap((dep) => {
    try {
      const value = issueDepToProjection(dep)
      return [{ id: value.id, value }]
    } catch {
      return []
    }
  })
}

const issueDep: Builder = {
  kind: 'issueDep',
  shape: 'row',
  async build({ store }, ids) {
    const from = unique(parsed(ids, parseIssueDepId).map((key) => key.fromId))
    return depRecords(await store.issues.depsFromIssues(from))
  },
  streamAll: ({ store }) => pagesOf(store.issues.listAllIssueDeps().then(depRecords)),
}

const issueUserState: Builder = {
  kind: 'issueUserState',
  shape: 'row',
  async build({ store }, ids) {
    const pairs = parsed(ids, parseIssueUserStateRowId)
    const out: BuiltRecord[] = []
    const byUser = new Map<UserId, string[]>()
    for (const pair of pairs) {
      const list = byUser.get(pair.userId) ?? []
      list.push(pair.entityId)
      byUser.set(pair.userId, list)
    }
    // Asked together, so the people's rows are one batched read (the
    // repository's loader joins loads asked in the same tick): an issue write
    // names every member's record of the issue (POD-6769).
    const loaded = await Promise.all(
      [...byUser].map(
        async ([userId, issueIds]) =>
          [userId, await store.issues.loadIssueUserStates(userId, issueIds)] as const,
      ),
    )
    for (const [userId, states] of loaded) {
      for (const [issueId, state] of states) {
        if (state === undefined) continue
        const value = issueUserStateToWire({ userId, entityId: issueId as never, ...state })
        out.push({ id: issueUserStateRowId(userId, issueId as never), value })
      }
    }
    return out
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.issues.listIssueUserStateRows().then((states) =>
        states.map((state) => ({
          id: issueUserStateRowId(state.userId, state.entityId),
          value: issueUserStateToWire(state),
        })),
      ),
    ),
}

const subscription: Builder = {
  kind: 'subscription',
  shape: 'row',
  async build({ store }, ids) {
    const subscriptionIds = parsed(ids, (id) => parseSubscriptionRowId(id).id)
    return (await store.events.subscriptionsByIds(subscriptionIds)).map((value) => ({
      id: subscriptionRowIdOf(value),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.events
        .allSubscriptionsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: subscriptionRowIdOf(value), value }))),
    ),
}

/** Group parsed keys by their person. */
function byUser<K extends { userId: UserId }>(keys: readonly K[]): Map<UserId, K[]> {
  const out = new Map<UserId, K[]>()
  for (const key of keys) {
    const list = out.get(key.userId) ?? []
    list.push(key)
    out.set(key.userId, list)
  }
  return out
}

const userLayout: Builder = {
  kind: 'userLayout',
  shape: 'row',
  async build({ store }, ids) {
    const out: BuiltRecord[] = []
    // A person's layout is a handful of keys: read the person's snapshot.
    for (const userId of byUser(parsed(ids, parseLayoutRowId)).keys()) {
      for (const [key, value] of Object.entries(await store.layout.getSnapshot(userId))) {
        out.push({ id: layoutRowId(userId, key), value: { userId, key, value } })
      }
    }
    return out
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.layout
        .allForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: layoutRowId(value.userId, value.key), value }))),
    ),
}

const userReadPosition: Builder = {
  kind: 'userReadPosition',
  shape: 'row',
  async build({ store }, ids) {
    const out: BuiltRecord[] = []
    for (const userId of byUser(parsed(ids, parseReadPositionRowId)).keys()) {
      for (const [streamId, cursor] of Object.entries(
        await store.readPositions.getSnapshot(userId),
      )) {
        out.push({
          id: readPositionRowId(userId, streamId),
          value: { userId, streamId, lastEventId: cursor.lastEventId, seenAt: cursor.seenAt },
        })
      }
    }
    return out
  },
  async *streamAll({ store }) {
    for await (const page of store.readPositions.allPositionPages(RECORD_PAGE_SIZE)) {
      yield page.map((row) => ({
        id: readPositionRowId(row.userId, row.streamId),
        value: {
          userId: row.userId,
          streamId: row.streamId,
          lastEventId: row.lastEventId,
          seenAt: row.seenAt,
        },
      }))
    }
  },
}

const pin: Builder = {
  kind: 'pin',
  shape: 'row',
  async build({ store }, ids) {
    const users = [...byUser(parsed(ids, parsePinRowId)).keys()]
    return (await store.sessions.pinsOfUsers(users)).map((value) => ({
      id: pinRowId(value.userId as UserId, value.kind, value.entityId),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.sessions.allPinsForBootReconcile().then((pins) =>
        pins.map((value) => ({
          id: pinRowId(value.userId as UserId, value.kind, value.entityId),
          value,
        })),
      ),
    ),
}

const tabOrder: Builder = {
  kind: 'tabOrder',
  shape: 'row',
  async build({ store }, ids) {
    const users = [...byUser(parsed(ids, parseTabOrderRowId)).keys()]
    return (await store.sessions.tabOrdersOfUsers(users)).map((value) => ({
      id: tabOrderRowId(value.userId as UserId, value.entityId),
      value,
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.sessions.allTabOrdersForBootReconcile().then((orders) =>
        orders.map((value) => ({
          id: tabOrderRowId(value.userId as UserId, value.entityId),
          value,
        })),
      ),
    ),
}

const superagentThread: Builder = {
  kind: 'superagentThread',
  shape: 'row',
  async build({ store }, ids) {
    const threadIds = parsed(ids, parseSuperagentThreadRowId).map((key) => key.threadId)
    return (await store.superagent.superagentThreadsByIds(threadIds)).map((row) => ({
      id: superagentThreadRowId(row.ownerUserId, row.id),
      value: superagentThreadWireOf(row),
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.superagent.allThreadsForBootReconcile().then((rows) =>
        rows.map((row) => ({
          id: superagentThreadRowId(row.ownerUserId, row.id),
          value: superagentThreadWireOf(row),
        })),
      ),
    ),
}

const automation: Builder = {
  kind: 'automation',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.automations.getMany(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.automations.list().then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const automationRun: Builder = {
  kind: 'automationRun',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.automations.getRuns(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.automations
        .listAllRuns()
        .then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const effect: Builder = {
  kind: 'effect',
  shape: 'row',
  build: async ({ store, effectExecutors }, ids) =>
    (await store.effects.liveByIds(ids)).filter(effectOnFeed).map((row) => ({
      id: row.id,
      value: effectRecordOf(row, effectExecutors as EffectExecutorRegistry),
    })),
  async *streamAll({ store, effectExecutors }) {
    for await (const page of store.effects.livePages(RECORD_PAGE_SIZE)) {
      const onFeed = page.filter(effectOnFeed)
      if (onFeed.length === 0) continue
      yield onFeed.map((row) => ({
        id: row.id,
        value: effectRecordOf(row, effectExecutors as EffectExecutorRegistry),
      }))
    }
  },
}

const checkout: Builder = {
  kind: 'checkout',
  shape: 'row',
  async build({ store }, ids) {
    const machines = unique(parsed(ids, parseCheckoutRowId).map((key) => key.machineId))
    return (await store.checkouts.ofMachines(machines)).map((row) => ({
      id: checkoutRowId(row.machineId, row.path),
      value: checkoutWireOf(row),
    }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.checkouts.all().then((rows) =>
        rows.map((row) => ({
          id: checkoutRowId(row.machineId, row.path),
          value: checkoutWireOf(row),
        })),
      ),
    ),
}

const agentProfile: Builder = {
  kind: 'agentProfile',
  shape: 'row',
  // The profile library is configuration-sized; "these ids" filters it.
  build: async ({ store }, ids) => {
    const asked = new Set(ids)
    return (await store.agentProfiles.list())
      .filter((value) => asked.has(value.id))
      .map((value) => ({ id: value.id, value }))
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.agentProfiles.list().then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const workflowRevision: Builder = {
  kind: 'workflowRevision',
  shape: 'row',
  build: async ({ store }, ids) =>
    (await store.workflows.revisionsByIds(ids)).map((value) => ({ id: value.id, value })),
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows
        .allRevisionsForBootReconcile()
        .then((rows) => rows.map((value) => ({ id: value.id, value }))),
    ),
}

const workflowBinding: Builder = {
  kind: 'workflowBinding',
  shape: 'row',
  // One binding per bound target, configuration-sized; "these ids" filters it.
  build: async ({ store }, ids) => {
    const asked = new Set(
      parsed(ids, parseWorkflowBindingRowId).map((key) =>
        workflowBindingRowId(key.targetKind, key.targetId),
      ),
    )
    return (await store.workflows.listBindings()).flatMap((value) => {
      const id = workflowBindingRowId(value.targetKind, value.targetId)
      return asked.has(id) ? [{ id, value }] : []
    })
  },
  streamAll: ({ store }) =>
    pagesOf(
      store.workflows.listBindings().then((rows) =>
        rows.map((value) => ({
          id: workflowBindingRowId(value.targetKind, value.targetId),
          value,
        })),
      ),
    ),
}

async function instancePreferencesRecord({ store }: RecordReads): Promise<BuiltRecord[]> {
  return [
    {
      id: INSTANCE_PREFERENCES_ROW_ID,
      value: instancePreferencesRecordOf(await store.settings.getSettings()),
    },
  ]
}

const instancePreferences: Builder = {
  kind: 'instancePreferences',
  shape: 'row',
  build: async (reads, ids) =>
    ids.includes(INSTANCE_PREFERENCES_ROW_ID) ? await instancePreferencesRecord(reads) : [],
  streamAll: (reads) => pagesOf(instancePreferencesRecord(reads)),
}

export const BEFORE_ROW_BUILDERS: readonly Builder[] = [
  issueBrief,
  issueDescription,
  issueDep,
  issueUserState,
  subscription,
  automation,
  automationRun,
  userLayout,
  userReadPosition,
  pin,
  tabOrder,
  superagentThread,
  agentProfile,
  workflowRevision,
  workflowBinding,
  instancePreferences,
  effect,
  checkout,
]
