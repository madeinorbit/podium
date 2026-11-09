import './synced-models'
import './workflow-models'
import { here, omitGone } from './lookup'

import {
  machineViewsFromWire,
  runSubjectReference,
  type RunSubjectReference,
} from '@podium/client-core/values'
import type { WorkflowRunWire } from '@podium/protocol'
import { compareShallow, computed, type IComputedValue } from 'mobx'
import type { MobxPool } from './pool'
import type {
  AgentProfileModel,
  MachineModel,
  SubscriptionModel,
  WorkflowBindingModel,
  WorkflowModel,
  WorkflowRevisionModel,
  WorkflowRunModel,
} from './models'
import { WORKFLOW_SCHEMA } from './workflow-schema'
import { LOADING } from './worklist/rollup'

/** Read-only projections over the one pool reader. The host's observed
 * projection supplies memoization; nothing here retains a second row copy. */
export function workflowMachines(pool: MobxPool) {
  const catalog = omitGone(pool.row(WORKFLOW_SCHEMA.machines.catalog, 'catalog'))
  const machines: MachineModel[] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.machines) {
    const row = omitGone(pool.model(WORKFLOW_SCHEMA.machines.entity, id))
    if (row === LOADING) pending++
    else if (row) machines.push(row)
  }
  return { views: machineViewsFromWire(machines), pending }
}

export function workflowSubject(
  pool: MobxPool,
  run: Pick<WorkflowRunWire, 'subjectKind' | 'subjectId'>,
): RunSubjectReference<{ id: string }> | typeof LOADING {
  // The session summary applies the existing resume-twin rule and source-order
  // tie break. A raw keyed session read would expose a suppressed parked twin.
  const present =
    run.subjectKind === 'session'
      ? pool.queries.setupSessionPresent(run.subjectId)
      : omitGone(pool.row(WORKFLOW_SCHEMA.issue.entity, run.subjectId, 'summary'))
  if (present === LOADING) return LOADING
  return runSubjectReference(run, (id) => (present ? { id } : undefined))
}

// ---------------------------------------------------------------------------
// The synced workflow records (POD-6676)
// ---------------------------------------------------------------------------

/**
 * Every agent profile, workflow, revision, binding and run this principal may
 * read, as the pool's shared models. The feed delivers them (ADR 12 D1), so a
 * change made on another device moves these lists without a request, and a
 * saved copy answers offline. Each list keeps its identity while its members do
 * not change.
 */
export interface WorkflowRecords {
  /** By name, then creation. */
  readonly profiles: readonly AgentProfileModel[]
  /** Live first, then archived, each by name. */
  readonly workflows: readonly WorkflowModel[]
  /** Each workflow's revisions, newest first. */
  readonly revisionsOf: (workflowId: string) => readonly WorkflowRevisionModel[]
  readonly bindings: readonly WorkflowBindingModel[]
  /** Every run, newest first; `live` ones are active or blocked. */
  readonly runs: readonly WorkflowRunModel[]
}

const NO_REVISIONS: readonly WorkflowRevisionModel[] = Object.freeze([])

type Kind = 'agentProfile' | 'workflow' | 'workflowRevision' | 'workflowBinding' | 'workflowRun'

/** The resident models of one kind, in table order. A model still loading is
 *  left out; the next publication brings it. */
function modelsOf<K extends Kind>(pool: MobxPool, kind: K): ReturnType<MobxPool['model']>[] {
  const out: ReturnType<MobxPool['model']>[] = []
  for (const id of pool.tables[kind]?.keys() ?? []) {
    const model = here(pool.model(kind, id))
    if (model !== undefined) out.push(model)
  }
  return out
}

interface RecordReads {
  readonly profiles: IComputedValue<readonly AgentProfileModel[]>
  readonly workflows: IComputedValue<readonly WorkflowModel[]>
  readonly revisions: IComputedValue<ReadonlyMap<string, readonly WorkflowRevisionModel[]>>
  readonly bindings: IComputedValue<readonly WorkflowBindingModel[]>
  readonly runs: IComputedValue<readonly WorkflowRunModel[]>
  readonly records: IComputedValue<WorkflowRecords>
}

function recordReads(pool: MobxPool): RecordReads {
  return pool.sources.view('workflow.records', () => {
    const list = <T>(read: () => readonly T[]) => computed(read, { equals: compareShallow })
    const profiles = list(() =>
      (modelsOf(pool, 'agentProfile') as AgentProfileModel[]).sort(
        (a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt),
      ),
    )
    const workflows = list(() =>
      (modelsOf(pool, 'workflow') as WorkflowModel[]).sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.createdAt.localeCompare(b.createdAt),
      ),
    )
    const revisions = computed(() => {
      const by = new Map<string, WorkflowRevisionModel[]>()
      for (const revision of modelsOf(pool, 'workflowRevision') as WorkflowRevisionModel[]) {
        const bucket = by.get(revision.workflowId) ?? []
        bucket.push(revision)
        by.set(revision.workflowId, bucket)
      }
      for (const bucket of by.values()) bucket.sort((a, b) => b.version - a.version)
      return by as ReadonlyMap<string, readonly WorkflowRevisionModel[]>
    })
    const bindings = list(() => modelsOf(pool, 'workflowBinding') as WorkflowBindingModel[])
    const runs = list(() =>
      (modelsOf(pool, 'workflowRun') as WorkflowRunModel[]).sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
      ),
    )
    // One record per change of any member list: its identity is the screen's.
    const records = computed((): WorkflowRecords => {
      const byWorkflow = revisions.get()
      return {
        profiles: profiles.get(),
        workflows: workflows.get(),
        revisionsOf: (id) => byWorkflow.get(id) ?? NO_REVISIONS,
        bindings: bindings.get(),
        runs: runs.get(),
      }
    })
    return { profiles, workflows, revisions, bindings, runs, records }
  })
}

/** The synced workflow records, for the workflows screen. */
export function workflowRecords(pool: MobxPool): WorkflowRecords {
  return recordReads(pool).records.get()
}

/** Every agent profile, by name, for a picker. */
export function agentProfileModels(pool: MobxPool): readonly AgentProfileModel[] {
  return recordReads(pool).profiles.get()
}

/**
 * MY TRIGGER SUBSCRIPTIONS (POD-6676): those whose subscriber is mine, a session
 * of mine (the feed sends a session's subscriptions to its owner alone) or a task
 * assigned to me. A task's subscriptions reach every member who reads the task
 * (design §1.11); this list is the Automations screen's own, as before.
 * Oldest first.
 */
export function mySubscriptions(
  pool: MobxPool,
  viewer: string | undefined,
): readonly SubscriptionModel[] {
  const reads = pool.sources.view('workflow.subscriptions', () => {
    const byViewer = new Map<string, IComputedValue<readonly SubscriptionModel[]>>()
    return {
      of(user: string): IComputedValue<readonly SubscriptionModel[]> {
        let read = byViewer.get(user)
        if (read === undefined) {
          read = computed(
            () => {
              const out: SubscriptionModel[] = []
              for (const id of pool.tables.subscription?.keys() ?? []) {
                const sub = here(pool.model('subscription', id)) as SubscriptionModel | undefined
                if (sub === undefined) continue
                const mine =
                  sub.subscriberKind === 'session'
                    ? true
                    : here(pool.model('issue', sub.subscriberId))?.assignee === user
                if (mine) out.push(sub)
              }
              return out.sort(
                (a, b) =>
                  a.createdAt.localeCompare(b.createdAt) ||
                  a.subscriptionId.localeCompare(b.subscriptionId),
              )
            },
            { equals: compareShallow },
          )
          byViewer.set(user, read)
        }
        return read
      },
    }
  })
  return viewer === undefined ? NO_SUBSCRIPTIONS : reads.of(viewer).get()
}

const NO_SUBSCRIPTIONS: readonly SubscriptionModel[] = Object.freeze([])
