/**
 * DRIVING THE ORACLE AT THE PRODUCTION DOOR (POD-732).
 *
 * POD-730's characterization suite was written against eleven three-line
 * methods on `WorkflowService` — `service.checkpoint(input, caller)` — and
 * POD-731 kept those methods alive ON PURPOSE so the suite could drive the new
 * contract+handler path unedited. That is what made behaviour preservation a
 * measurement rather than a claim, and it is the reason this file exists rather
 * than a rewrite of 88 tests.
 *
 * This issue DELETES the eleven. So the question is how the oracle keeps
 * measuring, and there are two answers with very different worth:
 *
 *   · Re-add the shims to the test file. The suite stays green and measures a
 *     copy of the thing that was deleted. That is a MOVE reported as a
 *     deletion.
 *   · Drive the ONE PRODUCTION DOOR and adapt only the call shape. The suite
 *     stays green and measures `WorkflowService.execute` — the same function
 *     tRPC, the relay and the approval broker all enter through, with the same
 *     contract parse, the same `WorkflowAccess` decision and the same ledger.
 *
 * This is the second. {@link driveWorkflows} reorders arguments and does
 * nothing else: there is no branch in it, no schema, no fallback, and no
 * behaviour it could contribute. It is deliberately a Proxy over the real
 * service rather than a wrapper object with eleven methods on it, because
 * eleven methods here would be the eleven shims wearing a test's clothes — the
 * shape has to be one that CANNOT drift from the eleven contracts, and a Proxy
 * keyed on `isWorkflowCommand` is exactly as long as the registry says.
 *
 * WHAT CHANGED IN WHAT THE SUITE MEASURES, and it is a strengthening: the input
 * is now PARSED by the contract before the handler sees it. POD-731's shims
 * passed hand-built objects through unvalidated, on the reasoning that a parse
 * would turn the suite's pinned domain errors into ZodErrors.
 *
 * That reasoning was MEASURED, not assumed, and it was right about exactly one
 * pin out of 88: `create` with `scopeRef: ''`. Its schema has carried `.min(1)`
 * since before POD-731, so no tRPC or relay caller could ever have reached the
 * domain error the old pin asserted — it described a path only an unparsed shim
 * could take. That pin is re-stated at its site against what the wire actually
 * does. Every other pinned domain error survives the parse unchanged, because
 * the schema accepts the input that produces it. So the unvalidated door is
 * deleted rather than inherited.
 */

import { isWorkflowCommand, type WORKFLOW_COMMANDS, type WorkflowProcName } from './registry'
import type { WorkflowCaller, WorkflowService } from './service'

/** The eleven, in the shape POD-730's suite calls them. */
type WorkflowCommandMethods = {
  [N in WorkflowProcName]: (
    input: unknown,
    caller: WorkflowCaller,
    // Per-proc, off the JOINED HANDLER — not `ReturnType<execute>`, which
    // collapses to a union across all eleven and would silently unType every
    // assertion in POD-730's suite.
  ) => ReturnType<(typeof WORKFLOW_COMMANDS)[N]['handler']>
}

export type DrivenWorkflowService = WorkflowService & WorkflowCommandMethods

/**
 * A `WorkflowService` that also answers to the eleven proc names, by forwarding
 * to `execute`.
 *
 * `Reflect.get(target, prop, target)` — the receiver is the TARGET, not the
 * proxy. Anything else and `this` inside the service's own methods would be the
 * proxy, so a re-entrant call (`runFor` from inside `execute`) would bounce back
 * through this handler and the suite would be measuring the adapter's
 * re-entrancy rather than the service's.
 */
export function driveWorkflows(service: WorkflowService): DrivenWorkflowService {
  return new Proxy(service, {
    get(target, prop, _receiver) {
      if (typeof prop === 'string' && isWorkflowCommand(prop)) {
        return (input: unknown, caller: WorkflowCaller) =>
          target.execute(caller, prop as WorkflowProcName, input)
      }
      return Reflect.get(target, prop, target)
    },
  }) as DrivenWorkflowService
}
