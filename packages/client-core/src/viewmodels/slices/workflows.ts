/**
 * WORKFLOWS SLICE (POD-647) — the workflow LIBRARY, one revision's DETAIL, and a
 * run's PROGRESS, as three derivations over the rows the principal was handed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SLICE TAKES ITS ROWS AS ARGUMENTS RATHER THAN READING A STORE
 * ---------------------------------------------------------------------------
 *
 * Every other slice in this directory derives from the replica snapshot, because
 * its entities are replicated. Workflows are NOT: they reach the client through
 * RPC reads (`workflows.list · get · bindings · profiles · runs`), and whether
 * they should instead become replicated entities is an open decision that
 * POD-1127 owns and that is deliberately not settled here.
 *
 * So this module is the DERIVATION half of a slice with its source left open. It
 * is a set of pure functions over wires, with no knowledge of where the wires
 * came from — which is exactly the shape that survives POD-1127 either way. If
 * workflows become replicated, a `SliceDefinition` wraps these functions and
 * nothing in them changes; if they stay RPC read models, the RPC hook keeps
 * feeding them. What must not happen in the meantime is the alternative this
 * issue exists to end: the same derivations written inline in a component, where
 * a second surface cannot reach them and no test can drive them without a DOM.
 *
 * ---------------------------------------------------------------------------
 * THE LIBRARY IS THE PRINCIPAL'S SLICE, NOT THE INSTANCE'S
 * ---------------------------------------------------------------------------
 *
 * Workflow definitions, revisions and runs have no declared visibility class, so
 * per `docs/multi-user-readiness.md` §3.1.1 rule 1 they are PERSONAL and
 * PRIVATE. Nothing here counts, totals or summarizes anything except the rows it
 * was handed, and nothing here fabricates a row for an id it cannot resolve. A
 * derivation that answered "how many workflows exist" rather than "how many of
 * THESE" would be an existence oracle (§3.1.2) written into a viewmodel, which
 * is the hardest place to notice one.
 *
 * ---------------------------------------------------------------------------
 * A RUN'S SUBJECT MAY BE INVISIBLE, AND THAT IS NOT DELETED
 * ---------------------------------------------------------------------------
 *
 * A run points at the issue or session it advances. Under the scoped feed
 * (POD-1077) that referent may be absent because it is INVISIBLE, still
 * ARRIVING, or genuinely REMOVED, and the three need different renderings. This
 * slice resolves it through `resolveReferent` — the shared F2 answer — and
 * publishes the state rather than a boolean, so no consumer can collapse
 * not-visible into removed or spin on it forever.
 *
 * Depends on F2 (session-ownership) and on the machines slice's authority module
 * for placement. Imports no other slice.
 * Platform-neutral: no DOM, no storage.
 */
import type {
  ExecutionProfileWire,
  WorkflowDetailWire,
  WorkflowRevisionWire,
  WorkflowRunEventWire,
  WorkflowRunStepWire,
  WorkflowRunWire,
  WorkflowScope,
  WorkflowWire,
} from '@podium/protocol'
import {
  type MachineAvailability,
  type MachineView,
} from './machines/authority'
import { resolveReferent, type ReferentExit, type ReferentState } from '../session-ownership'

// ---------------------------------------------------------------------------
// The library list.
// ---------------------------------------------------------------------------

export interface WorkflowLibraryEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  /** `global` or `repository · <ref>` — the label both the list and the detail
   *  header show, derived once so they cannot disagree. */
  readonly scopeLabel: string
  readonly scope: WorkflowScope
  readonly version: number
  /** True when the newest revision has never been published. Drives the
   *  candidate badge; it is NOT a right and does not gate the publish action. */
  readonly hasUnpublishedHead: boolean
  readonly archived: boolean
}

export function scopeLabel(scope: WorkflowScope, scopeRef: string | null): string {
  return scopeRef ? `${scope} · ${scopeRef}` : scope
}

/**
 * The library list, ordered as the sidebar shows it: live entries first, then
 * archived, each group by name.
 *
 * `hasUnpublishedHead` needs the DETAIL of an entry to be knowable, and the list
 * read does not carry revisions — so it is answered only for the entry whose
 * detail is loaded, and is `false` (not "unknown", not a guess) otherwise. The
 * badge is an affordance, and an affordance derived from a guess is worse than
 * an absent one.
 */
export function workflowLibraryEntries(
  workflows: readonly WorkflowWire[],
  detail?: WorkflowDetailWire | null,
): WorkflowLibraryEntry[] {
  const headOf = (id: string): WorkflowRevisionWire | undefined =>
    detail?.workflow.id === id ? detail.revisions[0] : undefined
  return [...workflows]
    .sort(
      (a, b) =>
        Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
        a.name.localeCompare(b.name),
    )
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      scope: workflow.scope,
      scopeLabel: scopeLabel(workflow.scope, workflow.scopeRef),
      version: workflow.latestVersion,
      hasUnpublishedHead: headOf(workflow.id)?.publishedAt === null,
      archived: workflow.archivedAt !== null,
    }))
}

/**
 * Has the open workflow left the principal's list?
 *
 * Under POD-1077 a row can be EVICTED — visibility revoked with no revision
 * moving and no deletion anywhere. The surface must then navigate away QUIETLY:
 * no tombstone, no toast, no deletion affordance, and above all no heal loop
 * re-requesting the id it just lost. This answers only "is the open id still in
 * the list I can see", which is the whole question — deliberately NOT "was it
 * deleted", which the client cannot know and must not claim.
 */
export function openWorkflowStillVisible(
  selectedId: string | null,
  entries: readonly WorkflowLibraryEntry[],
): boolean {
  if (selectedId === null) return true
  return entries.some((entry) => entry.id === selectedId)
}

// ---------------------------------------------------------------------------
// One workflow's revision detail.
// ---------------------------------------------------------------------------

export interface WorkflowRevisionRow {
  readonly id: string
  readonly version: number
  readonly published: boolean
}

export interface WorkflowRevisionDetail {
  readonly workflowId: string
  readonly name: string
  readonly description: string
  readonly scopeLabel: string
  /** The newest revision — the one the editor edits and `publish` targets.
   *  Absent for a workflow with no revision at all, which the UI renders as an
   *  empty state rather than a broken editor. */
  readonly head?: WorkflowRevisionRow
  /** Head's instructions/steps, as the editor's initial buffer. */
  readonly instructions: string
  readonly stepsJson: string
  /** Newest first, exactly as the read returns them. */
  readonly history: WorkflowRevisionRow[]
}

export function workflowRevisionDetail(detail: WorkflowDetailWire): WorkflowRevisionDetail {
  const head = detail.revisions[0]
  const row = (r: WorkflowRevisionWire): WorkflowRevisionRow => ({
    id: r.id,
    version: r.version,
    published: r.publishedAt !== null,
  })
  return {
    workflowId: detail.workflow.id,
    name: detail.workflow.name,
    description: detail.workflow.description,
    scopeLabel: scopeLabel(detail.workflow.scope, detail.workflow.scopeRef),
    ...(head ? { head: row(head) } : {}),
    instructions: head?.instructions ?? '',
    stepsJson: JSON.stringify(head?.steps ?? [], null, 2),
    history: detail.revisions.map(row),
  }
}

// ---------------------------------------------------------------------------
// Run progress.
// ---------------------------------------------------------------------------

/** The step a run is WAITING on: the one that is active or blocked, else the
 *  first pending one. Linear enforcement lives on the server; this is only the
 *  step the controls address. */
export function currentStepOf(run: WorkflowRunWire): WorkflowRunStepWire | undefined {
  return (
    run.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
    run.steps.find((step) => step.status === 'pending')
  )
}

/** Which advances the run's OWN state permits right now. Purely a state-machine
 *  reading — it says nothing about rights, which are a separate predicate the
 *  command config carries and the authority re-decides at apply. Conflating the
 *  two is how a UI starts treating "not now" and "not you" as one answer. */
export interface RunAdvances {
  readonly skip: boolean
  readonly retry: boolean
}

export function runAdvances(run: WorkflowRunWire): RunAdvances {
  const current = currentStepOf(run)
  const live = run.status === 'active' || run.status === 'blocked'
  if (!current || !live) return { skip: false, retry: false }
  return { skip: true, retry: current.status === 'blocked' }
}

/** One recorded act, as the run history renders it. The PAIR is kept apart:
 *  `actor` is which agent or session acted, `onBehalfOf` is which human it acted
 *  for, and `onBehalfOf === null` means there is no human behind it — a system
 *  act — rather than an unknown one. */
export interface RunAttributionRow {
  readonly kind: string
  readonly actorKind: string
  readonly actorId: string | null
  readonly onBehalfOf: string | null
  readonly at: string
  /** True when a HUMAN is recorded behind the act. The product already depends
   *  on the human-versus-agent distinction; this publishes it once instead of
   *  letting each surface re-decide what a null means. */
  readonly delegated: boolean
}

export function runAttribution(run: WorkflowRunWire): RunAttributionRow[] {
  return run.history.map((event: WorkflowRunEventWire) => ({
    kind: event.kind,
    actorKind: event.actorKind,
    actorId: event.actorId,
    onBehalfOf: event.onBehalfOf,
    at: event.createdAt,
    delegated: event.onBehalfOf !== null,
  }))
}

/**
 * The run's subject, resolved against a PARTIAL world.
 *
 * `present` carries the resolved value; `not-visible` is an OPAQUE reference —
 * the id is real, the principal may not see behind it, and the UI says exactly
 * that; `pending` is still arriving; `removed` is gone. Four states because
 * collapsing any pair of them produces one of the two defects §3.1.2 names:
 * spinning forever on an invisible referent, or rendering it as deleted.
 */
export interface RunSubjectReference<T> {
  readonly state: ReferentState
  readonly id: string
  readonly value?: T
}

export function runSubjectReference<T>(
  run: WorkflowRunWire,
  lookup: (id: string) => T | undefined,
  exitOf: (id: string) => ReferentExit | undefined = () => undefined,
): RunSubjectReference<T> {
  const resolved = resolveReferent(run.subjectId, lookup, exitOf)
  return {
    state: resolved.state,
    id: run.subjectId,
    ...(resolved.value !== undefined ? { value: resolved.value } : {}),
  }
}

// ---------------------------------------------------------------------------
// Run placement — owned compute, and it fails closed.
// ---------------------------------------------------------------------------

/**
 * Why a profile cannot place work right now, or that it can.
 *
 * `unplaced` is the NULL-machineId case and it is a refusal, not a wildcard. A
 * profile that names no machine resolves to "no machine chosen" and the caller
 * must choose one that it holds `use` on — never to "anything available", which
 * is precisely the silent retarget §3.1.4 M5 forbids. The other two arms are the
 * machines slice's own `unauthorized` / `unreachable` distinction, carried
 * through rather than flattened: "ask the owner" and "wake it up" are opposite
 * recoveries and a single "unavailable" tells the user neither.
 */
export type ProfilePlacementState =
  | 'available'
  | 'unreachable'
  | 'unauthorized'
  /** The profile names no machine. Nothing is chosen on the principal's behalf. */
  | 'unplaced'
  /** The profile names a machine the principal cannot even SEE. Indistinguishable
   *  from an id that never existed, by §3.1.5's consistent-error rule. */
  | 'unknown'

export interface ProfilePlacement {
  readonly profileId: string
  readonly machineId: string | null
  readonly state: ProfilePlacementState
}

export function profilePlacement<M extends { id: string; online: boolean }>(
  profile: Pick<ExecutionProfileWire, 'id' | 'machineId'>,
  views: readonly MachineView<M>[],
): ProfilePlacement {
  if (profile.machineId === null) {
    return { profileId: profile.id, machineId: null, state: 'unplaced' }
  }
  const view = views.find((v) => v.machine.id === profile.machineId)
  const state: ProfilePlacementState = view === undefined ? 'unknown' : view.availability
  return { profileId: profile.id, machineId: profile.machineId, state }
}

/**
 * The machines a placement control may OFFER.
 *
 * Only `available` ones are offerable — the gate is applied to the population
 * rather than to the click, so there is no path on which an unauthorized machine
 * is offered and then refused. The refused ones are returned SEPARATELY (rather
 * than dropped) so the UI can show why the list is short: an empty offer with no
 * explanation is the M5 defect restated.
 */
export interface PlacementOptions<M> {
  readonly offerable: readonly M[]
  readonly unauthorized: readonly M[]
  readonly unreachable: readonly M[]
}

export function placementOptions<M extends { id: string; online: boolean }>(
  views: readonly MachineView<M>[],
): PlacementOptions<M> {
  const by = (a: MachineAvailability): M[] =>
    views.filter((v) => v.availability === a).map((v) => v.machine)
  return {
    offerable: by('available'),
    unauthorized: by('unauthorized'),
    unreachable: by('unreachable'),
  }
}
