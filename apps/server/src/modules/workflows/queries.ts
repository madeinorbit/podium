/**
 * THE SEVEN WORKFLOW QUERIES, as a table (POD-732).
 *
 * `list · get · bindings · profiles · runs · prime · status`
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE HERE AND NOT SEVEN READ CONTRACTS IN `@podium/commands`
 * ---------------------------------------------------------------------------
 *
 * The eleven MUTATIONS are contract-derived (POD-731's `WORKFLOW_CONTRACTS`),
 * and this issue's criterion is that no hand-written `.mutation(` survives in
 * the workflows router. The queries are a different question and are
 * deliberately NOT promoted to L1 contracts by this issue:
 *
 *  - `CommandContract` requires a `visibility` class, and a visibility class
 *    describes WHAT A COMMAND WRITES. A read writes nothing. Declaring one
 *    anyway — `personal`, copied off the eleven — would put a value in the
 *    field that the classification lint and `contracts.test.ts` both grade
 *    against ADR 1's ownership matrix, for a row the query does not write. That
 *    is a false entry in the audit surface, not a missing one.
 *  - Read contracts are POD-311's remaining work and the read/tenant-visible
 *    ratchet is ADR 1 Amendment 1 D9.3's, held by POD-1071. A migration issue
 *    that invents the read half of the vocabulary is deciding a question two
 *    other issues own.
 *
 * What the queries DO get is the property that actually mattered: ONE
 * declaration, read by BOTH transports. `workflowInputs` was a second schema
 * table beside the router, and `WorkflowService.dispatch` was a second dispatch
 * beside it; both are gone. A query is served over a transport because this
 * table names it — default-closed, the same rule ADR 3 D3 puts on the eleven.
 *
 * AUTHORIZATION IS NOT HERE and must not move here. Every `run` below is one
 * call into the service method whose body ends at `WorkflowAccess` — the same
 * decision the eleven take. This table decides WHICH READS EXIST AND WHERE THEY
 * ARE SERVED, never who may take them.
 */

import type { TransportTag } from '@podium/commands'
import { WorkflowScope } from '@podium/protocol'
import { z } from 'zod'
import type { WorkflowCaller, WorkflowService } from './service'

/**
 * The three queries whose input is "nothing" — `bindings`, `profiles`, `prime`.
 *
 * `.passthrough()` rather than a strict empty object, kept BYTE-FOR-BYTE from
 * the `workflowInputs.actorInput` it replaces. A strict object would start
 * refusing the extra keys shipped clients already send, which is a wire change
 * wearing a tidy-up's clothes.
 */
const actorInput = z.object({}).passthrough()

/** Both shipped arms, matching the eleven contracts' `SERVED_ON`. */
const SERVED_ON: readonly TransportTag[] = ['trpc', 'relay']

export interface WorkflowQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: WorkflowService, input: z.infer<In>, caller: WorkflowCaller) => Out
}

/** Preserves the schema and return types through the object literal below —
 *  without it every entry widens to `ZodTypeAny`/`unknown` and the web client
 *  loses `AppRouter` inference on all seven reads. */
const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (service: WorkflowService, input: z.infer<In>, caller: WorkflowCaller) => Out,
): WorkflowQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

export const WORKFLOW_QUERIES = {
  list: query(
    z.object({
      includeArchived: z.boolean().optional(),
      scope: WorkflowScope.optional(),
      scopeRef: z.string().optional(),
    }),
    (service, input, caller) => service.list(input, caller),
  ),
  get: query(z.object({ id: z.string().min(1) }), (service, input, caller) =>
    service.get(input, caller),
  ),
  bindings: query(actorInput, (service, _input, caller) => service.bindings(caller)),
  profiles: query(actorInput, (service, _input, caller) => service.profiles(caller)),
  runs: query(z.object({ includeTerminal: z.boolean().optional() }), (service, input, caller) =>
    service.runs(input, caller),
  ),
  prime: query(actorInput, (service, _input, caller) => service.prime(caller)),
  status: query(z.object({ runId: z.string().optional() }), (service, input, caller) =>
    service.status(input, caller),
  ),
} as const

export type WorkflowQueryName = keyof typeof WORKFLOW_QUERIES

export const isWorkflowQuery = (proc: string): proc is WorkflowQueryName =>
  Object.hasOwn(WORKFLOW_QUERIES, proc)

/**
 * ADR 3 D3, default-closed, for the read half — the same shape
 * `isWorkflowProcExposedOn` has for the eleven. An unknown proc is `false`, so a
 * typo removes a surface loudly instead of opening one silently.
 */
export function isWorkflowQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isWorkflowQuery(proc)) return false
  return WORKFLOW_QUERIES[proc].exposure.includes(transport)
}
