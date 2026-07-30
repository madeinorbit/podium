/**
 * THE RELAY ARM OF THE DERIVED SURFACE (POD-732).
 *
 * `WorkflowService.dispatch` used to serve this: a reflective, name-keyed call
 * that looked a proc up in `workflowInputs`, parsed with whatever schema it
 * found, then invoked `this[proc]` by string. That shape served ANY method whose
 * name happened to appear in the table — the exposure question was never asked,
 * so `relay` was served because a schema existed, not because a contract
 * declared it. ADR 3 D3 says the opposite: default-closed, a transport is served
 * because the declaration names it.
 *
 * So this function asks the declaration, twice and separately:
 *
 *   · a MUTATION is served iff its contract's `exposure` includes `relay`, and
 *     it enters through `WorkflowService.execute` — the same door tRPC uses, so
 *     the two transports cannot disagree about validation, authorization or the
 *     ledger;
 *   · a QUERY is served iff its `WORKFLOW_QUERIES` entry says so.
 *
 * An unknown proc returns `undefined`, which is what the relay's dispatcher
 * reads as "not my router" — unchanged, and the reason the return type is not
 * simply `Promise<unknown>`.
 *
 * THE TRANSPORT IS A PARAMETER, not a literal in the body, and that is a
 * testability decision taken deliberately. Every workflow declaration currently
 * names `relay`, so a hard-coded `'relay'` would make the refusal branch
 * unreachable from any test — a guard that is PRESENT but that no test can prove
 * FIRES, which is the shape that lets a default-closed rule quietly stop being
 * one. With the tag passed in, a test asks about a transport nothing declares
 * and the branch is exercised for real. (Measured: with the literal in place,
 * deleting the whole check left the suite green.)
 */

import type { TransportTag } from '@podium/commands'
import {
  isWorkflowQuery,
  isWorkflowQueryExposedOn,
  WORKFLOW_QUERIES,
  type WorkflowQueryName,
} from './queries'
import { isWorkflowCommand, isWorkflowProcExposedOn } from './registry'
import type { WorkflowCaller, WorkflowService } from './service'

export function dispatchWorkflowRpc(
  service: WorkflowService,
  caller: WorkflowCaller,
  proc: string,
  raw: unknown,
  transport: TransportTag = 'relay',
): Promise<unknown> | undefined {
  if (isWorkflowCommand(proc)) {
    // NOT `undefined`. A proc that exists but is not served here is a REFUSAL,
    // not an absence: returning `undefined` would let the relay fall through to
    // the next router and report "unknown proc", which tells a caller that a
    // command it may not reach does not exist — and then stops telling them the
    // day someone adds `relay` to its exposure.
    if (!isWorkflowProcExposedOn(proc, transport)) {
      throw new Error(`workflows.${proc} is not available over the ${transport} transport`)
    }
    return Promise.resolve(service.execute(caller, proc, raw ?? {}))
  }
  if (isWorkflowQuery(proc)) {
    if (!isWorkflowQueryExposedOn(proc, transport)) {
      throw new Error(`workflows.${proc} is not available over the ${transport} transport`)
    }
    const query = WORKFLOW_QUERIES[proc as WorkflowQueryName]
    const input = query.input.parse(raw ?? {})
    const run = query.run as (s: WorkflowService, i: unknown, c: WorkflowCaller) => unknown
    return Promise.resolve(run(service, input, caller))
  }
  return undefined
}
