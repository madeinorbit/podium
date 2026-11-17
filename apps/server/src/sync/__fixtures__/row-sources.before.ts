/** Frozen capture declarations from before row generation; test oracle only. */
import {
  checkoutRowId,
  INSTANCE_PREFERENCES_ROW_ID,
  type IssueId,
  issueDepId,
  issueUserStateRowId,
  layoutRowId,
  type MachineId,
  pinRowId,
  readPositionRowId,
  subscriptionRowId,
  superagentThreadRowId,
  tabOrderRowId,
  type UserId,
  workflowBindingRowId,
} from '@podium/model'
import type { Column, Table } from 'drizzle-orm'
import {
  agentProfiles,
  automationRuns,
  automations,
  checkouts,
  effects,
  issueDeps,
  issues,
  issueUserState,
  meta,
  pins,
  subscriptions,
  superagentThreads,
  tabOrder,
  userLayout,
  userReadPosition,
  workflowBindings,
  workflowRevisions,
} from '../../migrations/schema'
import { SYSTEM_EFFECT_KINDS_OFF_FEED } from '../../modules/effects/published-input'
import type { RecordSource, RecordSources, SourceChange } from '../record-sources'

const str = (value: unknown): string => String(value)
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]
const keysOf = (changes: readonly SourceChange[]) =>
  changes.flatMap((change) =>
    [change.old, change.new].flatMap((key) => (key === null ? [] : [key])),
  )
/** A table whose row IS the record: the record id is a function of the key. */
function own(
  table: Table,
  keys: readonly Column[],
  idOf: (key: readonly unknown[]) => string | null,
  more: Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived'>> = {},
): RecordSource {
  return {
    table,
    keys,
    ...more,
    ids: (changes) =>
      unique(
        keysOf(changes).flatMap((key) => {
          const id = idOf(key)
          return id === null ? [] : [id]
        }),
      ),
  }
}

/** A table keyed by the record's own id in its first key column. */
const byId = (
  table: Table,
  key: Column,
  more: Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived'>> = {},
): RecordSource => own(table, [key], (k) => (k[0] == null ? null : str(k[0])), more)

const notTombstoned = (deletedAt: Column): string => `{row}.${deletedAt.name} IS NULL`

/**
 * An effect the server started for no one stays off the feed (`effectOnFeed`,
 * POD-6941): the connect scan's records reach no device, so their four moves
 * a scan are not captured. `created_by` and `kind` never change on a row.
 */
const EFFECT_ON_FEED = `({row}.${effects.createdBy.name} IS NOT NULL OR {row}.${effects.kind.name} NOT IN (${SYSTEM_EFFECT_KINDS_OFF_FEED.map((kind) => `'${kind}'`).join(', ')}))`

export const BEFORE_ROW_SOURCES = {
  issueBrief: [
    byId(issues, issues.id, {
      reads: [issues.brief],
      rows: `coalesce({row}.${issues.brief.name}, '') <> ''`,
    }),
  ],
  issueDescription: [
    byId(issues, issues.id, {
      reads: [issues.description],
      rows: `coalesce({row}.${issues.description.name}, '') <> ''`,
    }),
  ],
  issueDep: [
    own(issueDeps, [issueDeps.fromId, issueDeps.toId, issueDeps.type], (key) =>
      issueDepId(str(key[0]), str(key[1]), str(key[2])),
    ),
  ],
  issueUserState: [
    own(issueUserState, [issueUserState.userId, issueUserState.issueId], (key) =>
      issueUserStateRowId(key[0] as UserId, key[1] as IssueId),
    ),
  ],
  subscription: [
    own(
      subscriptions,
      [subscriptions.subscriberKind, subscriptions.subscriberId, subscriptions.id],
      (key) => subscriptionRowId(key[0] as never, str(key[1]), str(key[2])),
    ),
  ],
  automation: [byId(automations, automations.id, { rows: notTombstoned(automations.deletedAt) })],
  automationRun: [
    byId(automationRuns, automationRuns.id, { rows: notTombstoned(automationRuns.deletedAt) }),
  ],
  userLayout: [
    own(
      userLayout,
      [userLayout.userId, userLayout.key],
      (key) => layoutRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [userLayout.updatedAt] } },
    ),
  ],
  userReadPosition: [
    own(
      userReadPosition,
      [userReadPosition.userId, userReadPosition.streamId],
      (key) => readPositionRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [userReadPosition.updatedAt] } },
    ),
  ],
  pin: [
    own(pins, [pins.userId, pins.kind, pins.id], (key) =>
      pinRowId(key[0] as UserId, key[1] as never, str(key[2])),
    ),
  ],
  tabOrder: [
    own(
      tabOrder,
      [tabOrder.userId, tabOrder.worktree],
      (key) => tabOrderRowId(key[0] as UserId, str(key[1])),
      { reads: { allBut: [tabOrder.updatedAt] } },
    ),
  ],
  superagentThread: [
    // Never on the record: the watermarks, the harness's own session id (the
    // record says only whether there is one) and the terminal lock.
    own(
      superagentThreads,
      [superagentThreads.ownerUserId, superagentThreads.id],
      (key) => superagentThreadRowId(key[0] as UserId, str(key[1])),
      {
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
    ),
  ],
  agentProfile: [byId(agentProfiles, agentProfiles.id)],
  workflowRevision: [byId(workflowRevisions, workflowRevisions.id)],
  workflowBinding: [
    own(workflowBindings, [workflowBindings.targetKind, workflowBindings.targetId], (key) =>
      workflowBindingRowId(key[0] as never, str(key[1])),
    ),
  ],
  instancePreferences: [
    own(meta, [meta.key], () => INSTANCE_PREFERENCES_ROW_ID, {
      rows: `{row}.${meta.key.name} = 'settings'`,
    }),
  ],
  effect: [
    byId(effects, effects.id, {
      rows: `${notTombstoned(effects.deletedAt)} AND ${EFFECT_ON_FEED}`,
    }),
  ],
  checkout: [
    own(checkouts, [checkouts.machineId, checkouts.path], (key) =>
      checkoutRowId(key[0] as MachineId, str(key[1])),
    ),
  ],
} satisfies Partial<RecordSources>
