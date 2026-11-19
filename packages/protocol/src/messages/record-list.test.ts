/**
 * THE GENERATED RECORD LIST EQUALS THE LAST HAND-WRITTEN ONE (POD-7084).
 *
 * `MetadataEntityKind` and `MetadataChange` were written out by hand in
 * `sync.ts` until they were generated from the record declarations in
 * `@podium/model`. The hand-written list is kept here, verbatim in order and
 * schema, as the fixture the generated one is compared with: same kinds, same
 * order, the same schema object per arm, the same wire digest. The last test
 * shows the comparison fails on a wrong list.
 */

import {
  AgentProfileWire,
  AutomationRunWire,
  AutomationWire,
  CheckoutWire,
  ConversationRecordWire,
  EffectRecordWire,
  InstancePreferencesWire,
  IssueBriefWire,
  IssueDepProjection,
  IssueDescriptionWire,
  IssueEventWire,
  IssueGitStateProjection,
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  IssuePanelStateWire,
  IssuePanelTodoWire,
  IssueUserStateWire,
  LayoutWire,
  MachineAccessWire,
  MachineProjection,
  MessageRecordWire,
  PinWire,
  ReadPositionWire,
  RepoProjection,
  SessionMeta,
  SessionUserStateWire,
  SlimIssueProjection,
  SubscriptionWire,
  SuperagentThreadWire,
  TabOrderWire,
  UserPreferencesWire,
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowWire,
} from '@podium/model'
import { ShipLaneProjection, ShipOrderProjection } from '@podium/model/shipping-projection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { schemaDigest } from '../schema-digest'
import { changeRowArm } from './change-row'
import { PendingInteractionWire } from './runtime-interactions'
import { MetadataChange, MetadataChangeOp, MetadataEntityKind } from './sync'

/** The hand-written list as it stood on 2026-11-17, in its order. */
const HAND_WRITTEN: readonly (readonly [string, z.ZodTypeAny])[] = [
  ['session', SessionMeta],
  ['issueProjection', SlimIssueProjection],
  ['issueDep', IssueDepProjection],
  ['repo', RepoProjection],
  ['shipOrder', ShipOrderProjection],
  ['shipLane', ShipLaneProjection],
  ['conversation', ConversationRecordWire],
  ['automation', AutomationWire],
  ['automationRun', AutomationRunWire],
  ['userLayout', LayoutWire],
  ['userReadPosition', ReadPositionWire],
  ['issueEvent', IssueEventWire],
  ['pendingInteraction', PendingInteractionWire],
  ['message', MessageRecordWire],
  ['issueUserState', IssueUserStateWire],
  ['sessionUserState', SessionUserStateWire],
  ['machine', MachineProjection],
  ['issueGitState', IssueGitStateProjection],
  ['effect', EffectRecordWire],
  ['pin', PinWire],
  ['tabOrder', TabOrderWire],
  ['userPreferences', UserPreferencesWire],
  ['superagentThread', SuperagentThreadWire],
  ['agentProfile', AgentProfileWire],
  ['workflow', WorkflowWire],
  ['workflowRevision', WorkflowRevisionWire],
  ['workflowBinding', WorkflowBindingWire],
  ['workflowRun', WorkflowRunRecord],
  ['subscription', SubscriptionWire],
  ['instancePreferences', InstancePreferencesWire],
  ['machineAccess', MachineAccessWire],
  ['checkout', CheckoutWire],
  ['issueBrief', IssueBriefWire],
  ['issueDescription', IssueDescriptionWire],
  ['issuePanelTodo', IssuePanelTodoWire],
  ['issuePanelArtifact', IssuePanelArtifactWire],
  ['issuePanelDeferred', IssuePanelDeferredWire],
  ['issuePanelState', IssuePanelStateWire],
]

/** The hand-written union, rebuilt from the fixture exactly as `sync.ts` built it. */
const handWrittenUnion = (list: readonly (readonly [string, z.ZodTypeAny])[]) =>
  z.discriminatedUnion(
    'entity',
    list.map(([kind, value]) =>
      changeRowArm('id', z.literal(kind), MetadataChangeOp, value),
    ) as unknown as [z.AnyZodObject, ...z.AnyZodObject[]],
  )

/** Every difference between a generated union and the fixture; empty when equal. */
function differences(
  generated: { options: readonly z.AnyZodObject[] },
  kinds: readonly string[],
  list: readonly (readonly [string, z.ZodTypeAny])[],
): string[] {
  const out: string[] = []
  const want = list.map(([kind]) => kind)
  if (JSON.stringify(kinds) !== JSON.stringify(want))
    out.push(`kind list ${kinds.join(',')} != ${want.join(',')}`)
  const arms = generated.options.map(
    (arm) =>
      [
        (arm.shape['entity'] as z.ZodLiteral<string>).value,
        // The arm carries the value as `value.optional()` (`change-row.ts`).
        (arm.shape['value'] as z.ZodOptional<z.ZodTypeAny>).unwrap(),
      ] as const,
  )
  if (arms.length !== list.length) out.push(`${arms.length} arms != ${list.length}`)
  list.forEach(([kind, value], at) => {
    const arm = arms[at]
    if (arm?.[0] !== kind) out.push(`arm ${at} is ${arm?.[0]}, was ${kind}`)
    else if (arm[1] !== value) out.push(`arm ${kind} parses another schema`)
  })
  const digest = (union: z.ZodTypeAny) => schemaDigest(union, '')
  if (digest(generated as unknown as z.ZodTypeAny) !== digest(handWrittenUnion(list)))
    out.push('the wire digests differ')
  return out
}

describe('the generated record list', () => {
  it('equals the last hand-written list: kinds, order, schemas and wire digest', () => {
    expect(differences(MetadataChange, MetadataEntityKind.options, HAND_WRITTEN)).toEqual([])
  })

  it('fails on a list that drops, reorders or retypes a kind', () => {
    const dropped = HAND_WRITTEN.filter(([kind]) => kind !== 'checkout')
    expect(differences(MetadataChange, MetadataEntityKind.options, dropped)).not.toEqual([])
    const swapped = [HAND_WRITTEN[1]!, HAND_WRITTEN[0]!, ...HAND_WRITTEN.slice(2)]
    expect(differences(MetadataChange, MetadataEntityKind.options, swapped)).not.toEqual([])
    const retyped = HAND_WRITTEN.map(([kind, value]) =>
      kind === 'repo'
        ? ([kind, RepoProjection.extend({ extra: z.string() })] as const)
        : ([kind, value] as const),
    )
    expect(differences(MetadataChange, MetadataEntityKind.options, retyped)).toEqual([
      'arm repo parses another schema',
      'the wire digests differ',
    ])
  })
})
