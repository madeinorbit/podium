/**
 * THE WORKFLOW WRITE PATHS, AS DATA (POD-647).
 *
 * Every write this surface performs is one entry in this table: the POD-641
 * command CONTRACT it dispatches, the label the affordance shows, the sentence
 * shown when it applies, and the rights predicate that decides whether the
 * affordance may be reached at all. No component builds a mutation call inline
 * any more, which is the property that makes "which writes does this surface
 * have, and what does each require" answerable by reading one file.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTRACT NAME IS HERE AND THE CALL IS NOT
 * ---------------------------------------------------------------------------
 *
 * `@podium/commands` owns the contract (L1) and `apps/server` owns the handler
 * (L3); a transport reaches a contract BY NAME and the contract's own schema
 * validates the input before any handler runs. So the honest client-side unit is
 * the contract name plus the input, not a hand-written proc call with a
 * hand-built payload — and pinning the name here means a contract that is
 * renamed or removed breaks this table rather than one call site in a JSX
 * expression.
 *
 * The tRPC procs on `trpc.workflows.*` ARE those contracts: `modules/workflows/
 * registry.ts` joins each contract to its handler under the same bare name, and
 * `workflowFamilyProcedures()` serves them. Dispatching by name through that arm
 * is dispatching the contract.
 *
 * ---------------------------------------------------------------------------
 * NO PAYLOAD CARRIES ACTOR, OWNER OR ORIGIN
 * ---------------------------------------------------------------------------
 *
 * Readiness §3.1.3 A3 and ADR 3 D7: attribution is stamped from the
 * authenticated transport and payload identity is inert. Every `input` built
 * here is content only. The UI READS the actor / on-behalf-of pair off
 * `WorkflowRunWire.history` and never asserts it.
 *
 * ---------------------------------------------------------------------------
 * THE PREDICATE IS UX GATING, AND THE AUTHORITY STILL DECIDES
 * ---------------------------------------------------------------------------
 *
 * `enabledBy` exists so an affordance the principal cannot use is not offered —
 * from the menu OR from any other consumer of this table, which is the point of
 * it being data. It is NOT the authorization: ADR 3 D8 re-authorizes on every
 * apply, so a denied write must roll back and surface, which
 * `use-workflow-actions.ts` does. A predicate here that returned `true` would
 * still be safe; a UI that treated it as the decision would not be.
 *
 * SHARING IS DEFERRED, NOT DESIGNED AWAY. Workflows are PERSONAL/PRIVATE by
 * §3.1.1 rule 1 and per-feature sharing UX is out of scope for this phase. A
 * share entry is a row in this table with its own contract name and predicate
 * when POD-1071's matrix decision arrives — no restructuring required.
 *
 * POD-406 owns the SHARED declarative menu/dialog config family that this table
 * is meant to become an instance of. It has not landed (backlog at the time of
 * writing), so this is shaped to be absorbed by it — one flat list of entries,
 * each with an id, a label, a predicate and a run — rather than pre-empting its
 * type.
 */
import type { WorkflowContractName } from '@podium/commands'

/** What the principal may do on this surface. Supplied by the view from what the
 *  server told it, never computed from a role name here. */
export interface WorkflowRights {
  /** May create and revise library content. */
  readonly write: boolean
  /** May publish a candidate revision — a higher grade than `write`, because the
   *  server already treats publishing global content as approval-grade. */
  readonly publish: boolean
  /** May advance a run's state machine (skip / retry). */
  readonly advance: boolean
  /** May save an execution profile: it names managed credentials and owned
   *  compute, so it is its own grade (§3.1.4 M1/M2, ADR 1 D6). */
  readonly manageProfiles: boolean
}

/** Default-closed, per §3.1.1's rule that a missing classification fails toward
 *  privacy. Nothing is offered until the server has said something. */
export const NO_WORKFLOW_RIGHTS: WorkflowRights = {
  write: false,
  publish: false,
  advance: false,
  manageProfiles: false,
}

/**
 * TODAY'S RIGHTS, and why they are what they are.
 *
 * The workflow read model carries no per-row grant yet — POD-641 moved the
 * server's authorization onto real principals, but the READ wires expose no
 * decision for a client to mirror, and POD-1127 has not settled whether these
 * become replicated entities carrying one. Synthesizing a `false` here would
 * hide affordances that work; synthesizing per-row `true` would be a decorative
 * check. So the surface grants what a single-user instance already grants — the
 * parity guard this phase is held to — and the predicate seam is real and
 * consumed, ready for the decision when the wire carries it.
 */
export const OPERATOR_WORKFLOW_RIGHTS: WorkflowRights = {
  write: true,
  publish: true,
  advance: true,
  manageProfiles: true,
}

/** One write, as data. `TInput` is the contract's input; it is built by the
 *  caller at the point of use and never carries identity. */
export interface WorkflowCommand<TInput = unknown> {
  readonly id: string
  /** The POD-641 contract this dispatches. */
  readonly contract: WorkflowContractName
  readonly label: string
  /** Shown while the write is in flight. */
  readonly pendingLabel: string
  /** Shown when the authority APPLIES it. Never shown optimistically. */
  readonly success: string
  readonly enabledBy: (rights: WorkflowRights) => boolean
  readonly build: (input: TInput) => Record<string, unknown>
}

function command<TInput>(entry: WorkflowCommand<TInput>): WorkflowCommand<TInput> {
  return entry
}

export interface CreateInput {
  name: string
  description: string
  scope: string
  scopeRef: string
  instructions: string
  steps: unknown[]
}

export const workflowCommands = {
  create: command<CreateInput>({
    id: 'workflows.create',
    contract: 'create',
    label: 'Create revision 1',
    pendingLabel: 'Creating workflow…',
    success: 'Created the workflow.',
    enabledBy: (r) => r.write,
    build: (input) => ({
      name: input.name,
      description: input.description,
      scope: input.scope,
      ...(input.scope === 'global' ? {} : { scopeRef: input.scopeRef }),
      instructions: input.instructions,
      steps: input.steps,
    }),
  }),

  revise: command<{ workflowId: string; instructions: string; steps: unknown[] }>({
    id: 'workflows.revise',
    contract: 'revise',
    label: 'Create revision',
    pendingLabel: 'Creating revision…',
    success: 'Created a new immutable revision.',
    enabledBy: (r) => r.write,
    build: (input) => ({ ...input }),
  }),

  publish: command<{ revisionId: string }>({
    id: 'workflows.publish',
    contract: 'publish',
    label: 'Publish',
    pendingLabel: 'Publishing…',
    success: 'Published this revision.',
    enabledBy: (r) => r.publish,
    build: (input) => ({ revisionId: input.revisionId }),
  }),

  assign: command<{ targetKind: string; targetId: string; revisionId: string }>({
    id: 'workflows.assign',
    contract: 'assign',
    label: 'Assign latest revision',
    pendingLabel: 'Assigning revision…',
    success: 'Pinned the exact workflow revision.',
    enabledBy: (r) => r.write,
    build: (input) => ({ ...input }),
  }),

  skip: command<{ runId: string; stepId: string; reason: string }>({
    id: 'workflows.skip',
    contract: 'skip',
    label: 'Skip current',
    pendingLabel: 'Skipping…',
    success: 'Skipped the current workflow step.',
    enabledBy: (r) => r.advance,
    build: (input) => ({ ...input }),
  }),

  retry: command<{ runId: string; stepId: string }>({
    id: 'workflows.retry',
    contract: 'retry',
    label: 'Retry',
    pendingLabel: 'Retrying…',
    success: 'Reset the step for another attempt.',
    enabledBy: (r) => r.advance,
    build: (input) => ({ ...input }),
  }),

  profileSave: command<{
    name: string
    accountId: string
    harness: string
    model: string
    effort: string
    machineId: string | null
  }>({
    id: 'workflows.profileSave',
    contract: 'profileSave',
    label: 'Save profile',
    pendingLabel: 'Saving profile…',
    success: 'Saved the execution profile.',
    enabledBy: (r) => r.manageProfiles,
    build: (input) => ({ ...input }),
  }),
} as const

export type WorkflowCommandId = keyof typeof workflowCommands
