import { familyState } from '../derived-family'
/**
 * THE DERIVED WORKFLOW SURFACE (POD-732, the 3.10 cutover) — every workflow
 * tRPC procedure, produced from the contract table and the query table rather
 * than written out.
 *
 * Since POD-6418 the writes go through the sync write entry point
 * (`sync-write.ts`); the mutations built here are thin adapters onto it.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE
 * ---------------------------------------------------------------------------
 *
 * Eighteen procedures in `router.ts`, each naming a schema out of
 * `workflowInputs` and a method on `WorkflowService`. Eleven of them were
 * `.mutation(`. That shape is a second declaration of a surface that already
 * declares itself: which workflow writes exist, what they validate, which
 * transports serve them and how they dedupe are all facts of
 * `WORKFLOW_CONTRACTS`, and a hand-written procedure beside a contract is a
 * second answer to "how is this authorized".
 *
 * `scripts/audit-workflow-commands.ts` fails the build if a `.mutation(`
 * reappears inside the `workflows:` router literal — the same gate POD-382 put
 * on the session family, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE DRIVES THE WIRE (ADR 3 D3, default-closed)
 * ---------------------------------------------------------------------------
 *
 * A command appears here if and only if its contract declares `trpc`, and a
 * query if and only if its table entry does. Nobody maintains a second list
 * saying so, and the check is at MODULE LOAD: a contract that loses `trpc`
 * while still being built here throws before the server serves a request,
 * rather than serving a procedure that refuses everything — the "green gate that
 * stopped looking" failure.
 *
 * ---------------------------------------------------------------------------
 * WHY OUTPUT TYPES SURVIVE THE DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `AppRouter` inference is what makes `api.workflows.checkpoint.mutate(…)`
 * checked at all in `apps/web`. A naive generic derivation types every result
 * `unknown` and the damage lands silently on every call site, not here. So the
 * mutation output is read off the JOINED HANDLER's return type (the registry
 * pairs contract with handler, so the handler is in scope) and the query output
 * off its table entry's `run`. Neither is written down a second time.
 */

import { TRPCError, type TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, t } from '../../trpc'
import type { MutationProcedures } from '../derived-family'
import { legacyRouteAdapters } from '../sync-write/family'
import { WORKFLOW_QUERIES, type WorkflowQueryName } from './queries'
import type { WorkflowProcName } from './registry'
import type { WorkflowCaller } from './service'
import {
  WORKFLOW_SYNC_COMMANDS,
  WORKFLOW_SYNC_FAMILY,
  type WorkflowSyncCommands,
} from './sync-write'

/**
 * The transport principal for a workflow tRPC call.
 *
 * MOVED HERE FROM `router.ts` UNCHANGED, deliberately. POD-730's reviewer note
 * is that this function is where ADR 9 D1.5 compliance is actually decided —
 * "not an agent" still becomes `protectedWrite`, i.e. the `admin` grade — and
 * POD-731 narrowed what that grade MEANS without changing who mints it.
 * Replacing the mint is POD-1075's real `(user, device, capability)` principal,
 * and doing it inside a cutover would change authorization in the one diff that
 * has to be graded as behaviour-preserving. It is one function in the workflow
 * module now instead of one in a 1400-line router, which is where POD-1075 will
 * look for it.
 */
export function workflowCaller(ctx: Context): WorkflowCaller {
  const sessionId = ctx.capability.actorSessionId
  const actor = sessionId
    ? ({ kind: 'session', id: sessionId } as const)
    : ({ kind: 'operator', id: null } as const)
  if (ctx.principal) {
    return {
      actor,
      capability: ctx.capability,
      principal: ctx.principal,
      ...(ctx.capability.role === 'admin' ? { protectedWrite: true } : {}),
      ...(ctx.overrideScope ? { overrideScope: true } : {}),
    }
  }
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'workflow calls require an authenticated principal',
  })
}

// ---------------------------------------------------------------------------
// The ten mutations: thin adapters onto the sync write entry point
// ---------------------------------------------------------------------------

/**
 * LEGACY(remove-after: 2027-03): since POD-6418 every workflow write goes through
 * `sync.submit` (`sync-write.ts`), and these routes are thin adapters onto it.
 * Shipped clients still call every one: the desktop app's own build of the web
 * app (create, revise, publish, assign, skip, retry) and an older `podium
 * workflow` CLI on the operator's tRPC (all ten). Removing one breaks that
 * client's write against this server.
 */
const workflowWriteRoutes = (): MutationProcedures<WorkflowSyncCommands> =>
  legacyRouteAdapters(
    WORKFLOW_SYNC_FAMILY,
    Object.keys(WORKFLOW_SYNC_COMMANDS) as WorkflowProcName[],
  )

// ---------------------------------------------------------------------------
// The seven queries
// ---------------------------------------------------------------------------

type QueryProcedure<N extends WorkflowQueryName> = TRPCQueryProcedure<{
  meta: unknown
  input: z.input<(typeof WORKFLOW_QUERIES)[N]['input']>
  output: Awaited<ReturnType<(typeof WORKFLOW_QUERIES)[N]['run']>>
}>

function workflowQuery<N extends WorkflowQueryName>(name: N): QueryProcedure<N> {
  const query = WORKFLOW_QUERIES[name]
  if (!query.exposure.includes('trpc')) {
    throw new Error(`workflows.${name} does not declare the trpc transport`)
  }
  return t.procedure
    .input(query.input)
    .query(({ ctx, input }) =>
      (query.run as (s: unknown, i: unknown, c: WorkflowCaller) => unknown)(
        familyState(ctx).modules.workflows,
        input,
        workflowCaller(ctx),
      ),
    ) as QueryProcedure<N>
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

type WorkflowProcedures = MutationProcedures<WorkflowSyncCommands> & {
  [N in WorkflowQueryName]: QueryProcedure<N>
}

/**
 * Every workflow procedure, keyed by its bare proc name — spread into the
 * `workflows:` router in `router.ts`, which contains no procedure of its own.
 *
 * Built by iterating the TABLES, not a list written here: a twelfth contract is
 * served because it was declared, and the only way to remove a procedure is to
 * remove its declaration.
 */
export function workflowFamilyProcedures(): WorkflowProcedures {
  const record: Record<string, unknown> = { ...workflowWriteRoutes() }
  for (const name of Object.keys(WORKFLOW_QUERIES) as WorkflowQueryName[]) {
    record[name] = workflowQuery(name)
  }
  return record as WorkflowProcedures
}
