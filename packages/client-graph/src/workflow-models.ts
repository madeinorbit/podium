/**
 * AGENT PROFILES, WORKFLOWS AND TRIGGER SUBSCRIPTIONS AS SHARED MODELS
 * (POD-6676, ADR 12 D1; design POD-5620 §1.9-1.11).
 *
 * Each is a synced record the feed delivers to whoever may read it, so every
 * screen that shows one reads the same model, and a change made on another
 * device moves it without a request. Stored fields are schema-installed from
 * the replica row; what a screen derives from them is a `@lazy` getter here,
 * never a cell written into a row.
 *
 * Every row is keyed by its feed id (the id a generic edit names): a binding by
 * its target, a subscription by its subscriber and its stored id, which the row
 * source stamps as `subscriptionId`.
 */

import { lazy } from '@podium/mobx-helpers'
import type {
  AgentProfileWire,
  SubscriptionWire,
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowRunStepWire,
  WorkflowWire,
} from '@podium/model'
import { here } from './lookup'
import { EntityModel, type ModelHost, registerModels } from './models'
import type { FieldSource, FieldSpec, FieldType, ModelSchema } from './shared/schema'

type Arrival =
  | 'replica:agentProfiles'
  | 'replica:workflows'
  | 'replica:workflowRevisions'
  | 'replica:workflowBindings'
  | 'replica:workflowRuns'
  | 'replica:subscriptions'

/** One synced record kind's schema: keyed by its feed id, always resident. */
function record(
  schema: FieldSource['schema'],
  arrivesOn: Arrival,
  why: string,
  fields: Readonly<
    Record<
      string,
      { type: FieldType; note: string; nullable?: true; optional?: true; stamped?: true }
    >
  >,
) {
  return {
    key: 'id',
    why,
    components: {},
    fields: {
      id: {
        type: 'id' as const,
        source: { schema: 'RequestRecordKey' as const, arrivesOn },
        note: 'Its feed id, the id a generic edit names (a binding’s and a subscription’s stamped by the row source).',
      },
      ...Object.fromEntries(
        Object.entries(fields).map(([name, f]): [string, FieldSpec] => [
          name,
          {
            type: f.type,
            ...(f.nullable ? { nullable: true } : {}),
            ...(f.optional ? { optional: true } : {}),
            // A cell the row source stamps is on no wire schema.
            source: f.stamped
              ? { schema: 'RequestRecordKey' as const, property: 'id', arrivesOn }
              : { schema, arrivesOn },
            note: f.note,
          },
        ]),
      ),
    },
    relations: {},
    cold: {
      kind: 'never' as const,
      why: 'An instance holds tens of these, not thousands: always resident.',
    },
  }
}

/** A named agent setup (design §1.9): instance substrate, every member reads it. */
export class AgentProfileModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('agentProfile', id, host)
  }
  /** The machine its sessions run on, by name, when the machine is known. */
  @lazy get machineName(): string | null {
    if (!this.machineId) return null
    const machine = here(this.host.model('machine', this.machineId))
    return machine?.name ?? null
  }
}
export interface AgentProfileModel extends Readonly<Omit<AgentProfileWire, 'id'>> {}

/** A workflow definition (design §1.10). */
export class WorkflowModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('workflow', id, host)
  }
  @lazy get archived(): boolean {
    return this.archivedAt !== null
  }
}
export interface WorkflowModel extends Readonly<Omit<WorkflowWire, 'id'>> {}

/** One revision of a workflow, immutable once published. */
export class WorkflowRevisionModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('workflowRevision', id, host)
  }
  @lazy get published(): boolean {
    return this.publishedAt !== null
  }
  /** The definition it revises, when this principal holds it. */
  @lazy get workflow(): WorkflowModel | undefined {
    return here(this.host.model('workflow', this.workflowId)) as WorkflowModel | undefined
  }
}
export interface WorkflowRevisionModel extends Readonly<Omit<WorkflowRevisionWire, 'id'>> {}

/** Which revision a target runs, one per target. */
export class WorkflowBindingModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('workflowBinding', id, host)
  }
  @lazy get revision(): WorkflowRevisionModel | undefined {
    return here(this.host.model('workflowRevision', this.revisionId)) as
      | WorkflowRevisionModel
      | undefined
  }
}
export interface WorkflowBindingModel extends Readonly<WorkflowBindingWire> {}

/** A workflow run: status written by the server, its history a request. */
export class WorkflowRunModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('workflowRun', id, host)
  }
  /** Still moving: active or blocked. */
  @lazy get live(): boolean {
    return this.status === 'active' || this.status === 'blocked'
  }
  /** The step being worked: an active or blocked one, else the first pending. */
  @lazy get currentStep(): WorkflowRunStepWire | null {
    return (
      this.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
      this.steps.find((step) => step.status === 'pending') ??
      null
    )
  }
  @lazy get revision(): WorkflowRevisionModel | undefined {
    return here(this.host.model('workflowRevision', this.revisionId)) as
      | WorkflowRevisionModel
      | undefined
  }
  @lazy get workflow(): WorkflowModel | undefined {
    return here(this.host.model('workflow', this.workflowId)) as WorkflowModel | undefined
  }
}
export interface WorkflowRunModel extends Readonly<Omit<WorkflowRunRecord, 'id'>> {}

/** An automation trigger subscription (design §1.11). */
export class SubscriptionModel extends EntityModel {
  constructor(id: string, host: ModelHost) {
    super('subscription', id, host)
  }
  /** How a match reaches the subscriber, for a label: `nudge`, `notify`, both or none. */
  @lazy get delivery(): 'nudge' | 'notify' | 'nudge+notify' | 'none' {
    if (this.deliverNudge && this.deliverNotify) return 'nudge+notify'
    if (this.deliverNudge) return 'nudge'
    return this.deliverNotify ? 'notify' : 'none'
  }
}
export interface SubscriptionModel extends Readonly<Omit<SubscriptionWire, 'id'>> {
  /** The stored `sub_…` id, as the CLI and the server's history name it. */
  readonly subscriptionId: string
}

const schema = {
  agentProfile: record(
    'AgentProfileWire',
    'replica:agentProfiles',
    'One named agent setup, shared by the profile list and every picker.',
    {
      name: { type: 'string', note: 'Unique across the instance.' },
      description: { type: 'string', note: 'One line on what it is for.' },
      candidates: { type: 'object', note: 'Harness, model and effort, in order of preference.' },
      machineId: {
        type: 'id',
        nullable: true,
        note: 'Where its sessions run; null: wherever the work runs.',
      },
      instructions: { type: 'string', note: 'Markdown added to the agent’s instructions.' },
      createdAt: { type: 'isoDate', note: 'Set by the server.' },
      updatedAt: { type: 'isoDate', note: 'Set by the server.' },
    },
  ),
  workflow: record(
    'WorkflowWire',
    'replica:workflows',
    'One workflow definition, shared by the library and the run views.',
    {
      name: { type: 'string', note: 'What the library lists it as.' },
      description: { type: 'string', note: 'One line on what it is for.' },
      scope: { type: 'enum', note: '`global`, `repository` or `task`.' },
      scopeRef: { type: 'string', nullable: true, note: 'The repository or task it belongs to.' },
      latestRevisionId: {
        type: 'id',
        nullable: true,
        note: 'Its newest revision, set by the server.',
      },
      latestVersion: { type: 'number', note: 'Its newest revision number, set by the server.' },
      archivedAt: { type: 'isoDate', nullable: true, note: 'When it was archived.' },
      createdAt: { type: 'isoDate', note: 'Set by the server.' },
      updatedAt: { type: 'isoDate', note: 'Set by the server.' },
    },
  ),
  workflowRevision: record(
    'WorkflowRevisionWire',
    'replica:workflowRevisions',
    'One immutable revision: its instructions and steps.',
    {
      workflowId: { type: 'id', note: 'The definition it revises.' },
      version: { type: 'number', note: 'Its number within the workflow.' },
      instructions: { type: 'string', note: 'Markdown, the primary contract.' },
      steps: { type: 'object', note: 'The ordered steps, when it has any.' },
      createdAt: { type: 'isoDate', note: 'Set by the server.' },
      publishedAt: {
        type: 'isoDate',
        nullable: true,
        note: 'When it was published; null while a draft.',
      },
    },
  ),
  workflowBinding: record(
    'WorkflowBindingWire',
    'replica:workflowBindings',
    'Which revision one target runs.',
    {
      targetKind: { type: 'enum', note: '`global`, `repository`, `issue` or `session`.' },
      targetId: { type: 'string', note: 'The target; empty for the global default.' },
      revisionId: { type: 'id', note: 'The revision it runs.' },
      updatedAt: { type: 'isoDate', note: 'Set by the server.' },
    },
  ),
  workflowRun: record(
    'WorkflowRunRecord',
    'replica:workflowRuns',
    'One run of a workflow on a task or a session.',
    {
      subjectKind: { type: 'enum', note: '`issue` or `session`.' },
      subjectId: { type: 'id', note: 'The task or session it runs on.' },
      coordinatorSessionId: { type: 'id', note: 'The session that coordinates it.' },
      revisionId: { type: 'id', note: 'The revision it runs, a record of its own.' },
      workflowId: { type: 'id', note: 'That revision’s workflow.' },
      status: { type: 'enum', note: '`active`, `blocked`, `complete` or `superseded`.' },
      supersedesRunId: { type: 'id', nullable: true, note: 'The run it replaced.' },
      steps: { type: 'object', note: 'Every step with its status and evidence.' },
      startedAt: { type: 'isoDate', note: 'Set by the server.' },
      completedAt: { type: 'isoDate', nullable: true, note: 'When it completed.' },
    },
  ),
  subscription: record(
    'SubscriptionWire',
    'replica:subscriptions',
    'One trigger: an event that wakes a session or a task’s sessions.',
    {
      subscriptionId: {
        type: 'id',
        stamped: true,
        note: 'Its stored `sub_…` id, stamped by the row source.',
      },
      subscriberKind: { type: 'enum', note: '`session` or `issue`: who is woken.' },
      subscriberId: { type: 'id', note: 'The session or task woken.' },
      event: { type: 'string', note: 'The event kind matched (`issue.closed`, …).' },
      sourceKind: { type: 'enum', note: '`relationship`, `issue` or `session`: what is watched.' },
      sourceRef: { type: 'string', note: 'The watched relationship or record.' },
      deliverNudge: { type: 'boolean', note: 'A match nudges the subscriber in-session.' },
      deliverNotify: { type: 'boolean', note: 'A match notifies its person.' },
      origin: { type: 'enum', note: '`default` (made by the server) or `custom`.' },
      enabled: { type: 'boolean', note: 'Its one spec field: on or off.' },
      createdAt: { type: 'isoDate', note: 'Set by the server.' },
    },
  ),
} satisfies Pick<
  ModelSchema,
  | 'agentProfile'
  | 'workflow'
  | 'workflowRevision'
  | 'workflowBinding'
  | 'workflowRun'
  | 'subscription'
>

registerModels(schema, {
  agentProfile: AgentProfileModel,
  workflow: WorkflowModel,
  workflowRevision: WorkflowRevisionModel,
  workflowBinding: WorkflowBindingModel,
  workflowRun: WorkflowRunModel,
  subscription: SubscriptionModel,
})
