/**
 * THE GENERATED KIND TABLE EQUALS THE LAST HAND-WRITTEN ONE (POD-7084).
 *
 * `kinds.ts` wrote its entity → collection table and its row-key function out
 * by hand until both were generated from the record declarations in
 * `@podium/model`. The last hand-written table and row-key function are kept
 * here, verbatim, as the fixture: the same entities map to the same
 * collections, and the same rows get the same keys. The last test shows the
 * comparison fails on a wrong table or a wrong key.
 */

import {
  checkoutRowId,
  INSTANCE_PREFERENCES_ROW_ID,
  issueUserStateRowId,
  layoutRowId,
  machineAccessRowId,
  pinRowId,
  readPositionRowId,
  sessionUserStateRowId,
  subscriptionRowIdOf,
  superagentThreadRowId,
  tabOrderRowId,
  userPreferencesRowId,
  workflowBindingRowId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { ReplicaKind, ReplicaRows } from '../contract'
import { entityForKind, kindForEntity, retainReplicaEntity, rowKey } from './kinds'

/** The hand-written table as it stood on 2026-11-17. */
const HAND_WRITTEN_TABLE: Readonly<Record<string, ReplicaKind>> = {
  session: 'sessions',
  sessionUserState: 'sessionUserStates',
  machine: 'machines',
  issueProjection: 'issueProjections',
  issueUserState: 'issueUserStates',
  issueGitState: 'issueGitStates',
  issueBrief: 'issueBriefs',
  issueDescription: 'issueDescriptions',
  issuePanelTodo: 'issuePanelTodos',
  issuePanelArtifact: 'issuePanelArtifacts',
  issuePanelDeferred: 'issuePanelDeferreds',
  issuePanelState: 'issuePanelStates',
  issueDep: 'issueDeps',
  repo: 'repos',
  issueEvent: 'issueEvents',
  pendingInteraction: 'pendingInteractions',
  message: 'messageRecords',
  shipOrder: 'shipOrders',
  shipLane: 'shipLanes',
  conversation: 'conversations',
  automation: 'automations',
  automationRun: 'automationRuns',
  effect: 'effects',
  userLayout: 'userLayouts',
  pin: 'pins',
  tabOrder: 'tabOrders',
  userPreferences: 'userPreferences',
  userReadPosition: 'userReadPositions',
  superagentThread: 'superagentThreads',
  agentProfile: 'agentProfiles',
  workflow: 'workflows',
  workflowRevision: 'workflowRevisions',
  workflowBinding: 'workflowBindings',
  workflowRun: 'workflowRuns',
  subscription: 'subscriptions',
  instancePreferences: 'instancePreferences',
  machineAccess: 'machineAccess',
  checkout: 'checkouts',
}

/** The hand-written row key as it stood on 2026-11-17. */
function handWrittenRowKey<K extends ReplicaKind>(kind: K, row: ReplicaRows[K]): string {
  // A loose read of the row's identity fields, typed to fit any helper's brand.
  const f = (name: string): never => (row as unknown as Record<string, string>)[name] as never
  if (kind === 'sessions') return f('sessionId')
  if (kind === 'sessionUserStates') return sessionUserStateRowId(f('userId'), f('sessionId'))
  if (kind === 'issueUserStates') return issueUserStateRowId(f('userId'), f('entityId'))
  if (kind === 'userLayouts') return layoutRowId(f('userId'), f('key'))
  if (kind === 'pins') return pinRowId(f('userId'), f('kind'), f('entityId'))
  if (kind === 'tabOrders') return tabOrderRowId(f('userId'), f('entityId'))
  if (kind === 'userPreferences') return userPreferencesRowId(f('userId'))
  if (kind === 'machineAccess') return machineAccessRowId(f('userId'), f('machineId'))
  if (kind === 'checkouts') return checkoutRowId(f('machineId'), f('path'))
  if (kind === 'userReadPositions') return readPositionRowId(f('userId'), f('streamId'))
  if (kind === 'superagentThreads') return superagentThreadRowId(f('ownerUserId'), f('threadId'))
  if (kind === 'workflowBindings') return workflowBindingRowId(f('targetKind'), f('targetId'))
  if (kind === 'subscriptions') return subscriptionRowIdOf(row as never)
  if (kind === 'instancePreferences') return INSTANCE_PREFERENCES_ROW_ID
  return f('id')
}

/** A row carrying every identity field any kind keys on, with values that keep them apart. */
const ROW = {
  id: 'the-id',
  sessionId: 'the-session',
  userId: 'the-user',
  entityId: 'the-entity',
  key: 'the-key',
  kind: 'issue',
  machineId: 'the-machine',
  path: '/the/path',
  streamId: 'the-stream',
  ownerUserId: 'the-owner',
  threadId: 'the-thread',
  targetKind: 'issue',
  targetId: 'the-target',
  subscriberKind: 'session',
  subscriberId: 'the-subscriber',
}

function differences(
  table: Readonly<Record<string, ReplicaKind>>,
  key: (kind: ReplicaKind, row: never) => string,
): string[] {
  const out: string[] = []
  for (const [entity, kind] of Object.entries(table)) {
    if (kindForEntity(entity) !== kind)
      out.push(`${entity} lands in ${kindForEntity(entity)}, was ${kind}`)
    else if (entityForKind(kind) !== entity)
      out.push(`${kind} names ${entityForKind(kind)}, was ${entity}`)
    else if (rowKey(kind, ROW as never) !== key(kind, ROW as never))
      out.push(`${kind} keys a row differently`)
  }
  for (const entity of ['nope', 'issue', 'sessions']) {
    if (retainReplicaEntity(entity)) out.push(`${entity} is retained`)
  }
  return out
}

describe('the generated kind table', () => {
  it('equals the last hand-written table and row key', () => {
    expect(differences(HAND_WRITTEN_TABLE, handWrittenRowKey)).toEqual([])
    for (const entity of Object.keys(HAND_WRITTEN_TABLE))
      expect(retainReplicaEntity(entity), entity).toBe(true)
  })

  it('fails on a wrong collection or a wrong row key', () => {
    expect(
      differences(
        { ...HAND_WRITTEN_TABLE, automationRun: 'automationRunss' as ReplicaKind },
        handWrittenRowKey,
      ),
    ).toEqual(['automationRun lands in automationRuns, was automationRunss'])
    const wrongKey = (kind: ReplicaKind, row: never) =>
      kind === 'pins' ? 'not-the-pin-key' : handWrittenRowKey(kind, row)
    expect(differences(HAND_WRITTEN_TABLE, wrongKey)).toEqual(['pins keys a row differently'])
  })
})
