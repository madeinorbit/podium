/**
 * THE ONE DERIVED-FAMILY BUILDER (POD-314, the 3.4 cutover).
 *
 * Eight families landed their cutovers one at a time — sessions, workflows,
 * issues, mail, superagent, fleet, specs, settings — and each wrote its own
 * `modules/<family>/trpc.ts`. Read side by side, seven of those files are the
 * same file: iterate a contract table, check `exposure.includes('trpc')`, build
 * `t.procedure.input(contract.input).mutation(…)`, assert membership in both
 * directions, return the record. This issue had eleven more families to migrate,
 * and writing that file an eleventh time would have made nineteen copies of one
 * decision.
 *
 * So the shape is factored ONCE, here, and the eleven declare only what actually
 * differs between them: which table, which service, which queries.
 *
 * ---------------------------------------------------------------------------
 * THIS IS CONSUMING THE FRAMEWORK, NOT REDESIGNING IT
 * ---------------------------------------------------------------------------
 *
 * Nothing below invents a rule. Every claim it makes is one an existing family
 * already makes in its own words:
 *
 *  - exposure is default-closed and checked at MODULE LOAD (`modules/specs/trpc.ts`)
 *  - membership is checked in BOTH directions against the object that will
 *    actually be served, so an EMPTY surface fails rather than passes
 *    (`modules/settings/trpc.ts`, POD-732's "an empty router satisfies every
 *    absence claim perfectly")
 *  - output types are read off the JOINED HANDLER so `AppRouter` inference
 *    survives the derivation (`modules/workflows/trpc.ts`)
 *  - a query is served because its table entry names the transport, and queries
 *    are NOT contracts because a visibility class describes what a command WRITES
 *    (`modules/workflows/queries.ts`)
 *
 * The eight existing families are deliberately NOT rewritten onto this builder.
 * That would be a nineteen-file diff through eight other issues' cutovers in the
 * one commit that has to be graded as behaviour-preserving, and three of them
 * (fleet's `serverRole` gate, sessions' presence class, mail's action/verb
 * agreement check) have per-family rules this builder does not model. What it
 * does model is the shape the other eleven share exactly.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVICE ARRIVES AS A SELECTOR, AND WHAT THAT BUYS
 * ---------------------------------------------------------------------------
 *
 * `service: (m) => m.approvals` rather than each family reaching for its own
 * state. That is the acceptance criterion "one documented access pattern" made
 * structural rather than asserted: the module seam is read in ONE place in this
 * file, and a family module cannot reach `ctx.registry.sessionStore` or
 * `ctx.registry.modules` because it never sees a `ctx` at all. A handler receives
 * its service and its parsed input; there is no third thing for it to reach
 * through.
 *
 * That is also what makes the no-side-door claim checkable. A handler in a joined
 * table is a function on a service, reachable only by a transport that walks a
 * table — `scripts/audit-derived-families.ts` proves it by resolving the RUNNING
 * objects, not by grepping for an absence.
 */

import type { AnyCommandContract, TransportTag } from '@podium/commands'
import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import type { Capability } from '../issue-authz'
import type { RegistryModules, SessionRegistry } from '../relay'
import type { RepoRegistry } from '../repo-registry'
import { soleHumanPrincipal } from './sessions/presence-registry'
import { type Context, mods, t } from '../trpc'

/**
 * THE STATE A FAMILY MAY SELECT FROM — the whole of it, and deliberately a
 * closed list rather than the request context.
 *
 * `modules` is the composed service seam. `repos` is the repo registry, which is
 * ALSO a singleton service (`new RepoRegistry(registry, store)`, built once at
 * assembly and put on every context) that simply never made it onto
 * `RegistryModules`. Two families here — `files` and `hosts` — need it for the
 * repo-root allowlist, and the honest options were to widen `RegistryModules`
 * for everyone or to name it here. Naming it here is the smaller claim: it does
 * not change the seam eight other issues depend on, and it keeps the property
 * that matters, which is that a handler is handed STATE and never a `ctx`.
 *
 * What is NOT on this bundle is the point of it. There is no `capability`, no
 * `overrideScope`, no `registry` — so a handler built through this file cannot
 * make an authorization decision even by accident, and cannot reach
 * `ctx.registry.sessionStore` because it has no `ctx` to reach through.
 * Authorization is the contract's and the service's; this bundle is state.
 */
export interface FamilyState {
  readonly modules: RegistryModules
  readonly repos: RepoRegistry
  /**
   * The opt-in telemetry emitter [spec:SP-f933], present only when the server was
   * assembled with one. On the bundle for the same reason as `repos`: exactly one
   * family (`telemetry.preview`) needs it, and naming it here is a smaller claim
   * than widening `RegistryModules`. Optional, so contexts without one — tests,
   * the in-process MCP caller — simply have no preview, which is the shipped
   * behaviour.
   *
   * CONSENT STATE IS NOT HERE and must not be: it is read from `config.json` by
   * the instance service, never from the request, because turning telemetry off
   * has to work with no server.
   */
  readonly telemetry?: Context['telemetry']
  /**
   * The durable store. On the bundle because four families genuinely read it —
   * `accounts` (the credential rows), and the per-user `pins` / `snoozes` /
   * `tabs` lists — and because `RegistryModules` composes SERVICES while these
   * are store tables with no service in front of them.
   *
   * THIS IS THE ONE MEMBER THAT COULD BECOME A BACK DOOR, so it is worth saying
   * what stops it. `store` is the same object `ctx.registry.sessionStore`
   * resolves to; naming it here does not narrow what a determined handler could
   * touch. What it buys is that the reach is DECLARED — a family that wants the
   * store selects it in its `service` function, in one line a reviewer can see,
   * instead of spelling `ctx.registry.sessionStore` inline in a procedure body
   * where no audit attributes it to a family. Putting a service in front of each
   * of these tables is the right end state and is POD-1071's ownership work, not
   * a router cutover's.
   */
  readonly store: SessionRegistry['sessionStore']
  /**
   * The hosted-runtime provider, absent on deployments with no cloud. On the
   * bundle for `repos`' reason — one family needs it — and left OPTIONAL rather
   * than defaulted here, because `CloudService` substitutes the disabled provider
   * at construction. Defaulting in two places is how the two diverge.
   */
  readonly cloud?: Context['cloud']
  /**
   * WHO IS ASKING — IDENTITY ONLY, and the shape is narrow on purpose.
   *
   * Four reads need to know whose rows to return or whose access to log:
   * `pins.list`, `snoozes.list`, `tabs.listOrders` (POD-380 keyed these per user
   * — the list is the CALLER's pins, not the instance's) and the read-toolkit
   * procs, which stamp the reader into their event log.
   *
   * THIS IS DELIBERATELY NOT `PresencePrincipal`, which was the first draft and
   * was wrong: that type CARRIES THE CAPABILITY inside it, so putting it here
   * would have handed every handler the authority object while a comment above it
   * claimed the opposite. Two fields, both names, no scope, no role, no override
   * flag — a handler can say whose row it wants and cannot decide whether it may
   * have it. If a handler ever wants to make a DECISION from this, that is the
   * signal the decision belongs in a contract or a service, not that this member
   * should grow back toward the capability.
   */
  readonly caller: {
    readonly userId: string
    /** The capability's OWN field type, not a widened `string | null`. The first
     *  draft widened it and tsgo caught the consequence immediately: the read
     *  toolkit takes a branded `ReaderRef`, so a widened id would have forced a
     *  cast at three call sites — which is how a brand quietly stops meaning
     *  anything. */
    readonly actorSessionId: Capability['actorSessionId']
  }
  /** Request-scoped world used by websocket publication and sync catch-up; the
   *  one read (`sync.changesSince`) passes it straight through to the service. */
  readonly publicationAuthority?: Context['publicationAuthority']
  /** Tiered per-machine repo discovery (POD-787) [spec:SP-3701]. Optional, so
   *  callers that do not exercise discovery need not construct one — which is
   *  the shipped shape, and why `discovery.lastMachineScan` answers null rather
   *  than throwing when it is absent. */
  readonly discovery?: Context['discovery']
  /** The superagent service. On the bundle because it is a request-context
   *  service like the others and two reads need it; it is NOT on
   *  `RegistryModules`, which is why it is named here rather than selected
   *  through the module seam. */
  readonly superagent: Context['superagent']
}

// ---------------------------------------------------------------------------
// What a family declares
// ---------------------------------------------------------------------------

/** One contract joined to the service method that implements it. The handler
 *  takes the service and the PARSED input, and nothing else — see the header. */
export interface DerivedCommand<Svc> {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract through
  // the `satisfies` in the family's registry, and re-derived per command below.
  readonly handler: (svc: Svc, input: any) => unknown
}

/** One read, declared with the transports that serve it. NOT a contract: a
 *  `visibility` class describes what a command WRITES and a read writes nothing. */
export interface DerivedQuery<Svc> {
  readonly input: z.ZodTypeAny
  readonly exposure: readonly TransportTag[]
  // biome-ignore lint/suspicious/noExplicitAny: same erasure as `handler`, and
  // the per-query types are re-derived by `QueryProcedures` below.
  readonly run: (svc: Svc, input: any) => unknown
}

/**
 * THE TABLE CONSTRAINTS DO NOT MENTION THE SERVICE TYPE, and that is load-bearing
 * rather than sloppy.
 *
 * The first draft constrained the tables as `Record<string, DerivedCommand<Svc>>`,
 * which reads better and does not work: `Svc` then appears in the constraint of
 * one parameter and in the return type of another, TypeScript cannot solve the
 * two together, and it silently infers `Svc = unknown` — at which point every
 * derived procedure's output widens to `unknown` and `apps/web` loses `AppRouter`
 * inference on the whole family. That is POD-732's failure exactly: the damage
 * lands at the call sites, not here.
 *
 * So the service type is inferred from the SELECTOR alone, and the handler/service
 * pairing is checked where the shipped families already check it — in each
 * family's registry, by `satisfies Record<…ContractName, …Command>` over
 * `DerivedCommand<TheService>`. Nothing is unchecked; the check just lives where
 * it can be solved.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the note above — the service
// parameter is deliberately unconstrained here so it stays inferrable from the
// selector; each family's registry pins it with `satisfies`.
type AnyDerivedCommand = {
  readonly contract: AnyCommandContract
  readonly handler: (...args: any[]) => unknown
}
// biome-ignore lint/suspicious/noExplicitAny: as above.
type AnyDerivedQuery = {
  readonly input: z.ZodTypeAny
  readonly exposure: readonly TransportTag[]
  readonly run: (...args: any[]) => unknown
}

// ---------------------------------------------------------------------------
// The procedure types — why they are mapped rather than written out
// ---------------------------------------------------------------------------

/**
 * `AppRouter` inference is what makes `api.approvals.approve.mutate(…)` checked at
 * all in `apps/web`. A naive derivation types every result `unknown`, and the
 * damage lands silently at every call site rather than here — POD-732 hit exactly
 * this and its note is the reason these are mapped types over the TABLES: the
 * input comes off the contract's own schema instance and the output off the joined
 * handler's return type, so neither is written down a second time and a twelfth
 * command appears without anyone editing a declaration.
 */
export type MutationProcedures<C extends Record<string, AnyDerivedCommand>> = {
  [N in keyof C]: TRPCMutationProcedure<{
    meta: unknown
    input: z.input<C[N]['contract']['input']>
    output: Awaited<ReturnType<C[N]['handler']>>
  }>
}

export type QueryProcedures<Q extends Record<string, AnyDerivedQuery>> = {
  [N in keyof Q]: TRPCQueryProcedure<{
    meta: unknown
    input: z.input<Q[N]['input']>
    output: Awaited<ReturnType<Q[N]['run']>>
  }>
}

export type FamilyProcedures<
  C extends Record<string, AnyDerivedCommand>,
  Q extends Record<string, AnyDerivedQuery>,
> = MutationProcedures<C> & QueryProcedures<Q>

/**
 * Everything a family declares. `family` is the router key, used only in the
 * failure messages — a throw that cannot say WHICH surface is broken costs the
 * next reader the grep this file was written to make unnecessary.
 */
export interface DerivedFamily<
  Svc,
  C extends Record<string, AnyDerivedCommand>,
  Q extends Record<string, AnyDerivedQuery>,
> {
  readonly family: string
  /** THE ONE READ OF THE STATE SEAM for every family built through here, and the
   *  ONLY place the service type is pinned — see the note on `AnyDerivedCommand`.
   *  Most families select a single service (`(s) => s.modules.approvals`); the two
   *  that genuinely need a second return a small record naming exactly what they
   *  use, so the widening is visible in the family rather than in this file. */
  readonly service: (state: FamilyState) => Svc
  readonly commands: C
  readonly queries: Q
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * The both-directions membership check, run at MODULE LOAD against the object
 * that will actually be SERVED.
 *
 * The second direction is the one that matters and it is not symmetry for its own
 * sake. Without it an EMPTY surface satisfies every claim this builder makes —
 * POD-732's "an empty router satisfies every absence claim perfectly". The first
 * loop reads `built`, so an empty object FAILS it rather than passing it.
 *
 * At load and not at call time, deliberately: a procedure that refuses everything
 * at runtime is the "green gate that stopped looking" failure mode, and it looks
 * identical to a procedure nobody happened to call.
 */
function assertSurfaceMatchesDeclarations(
  family: string,
  commands: Record<string, AnyDerivedCommand>,
  queries: Record<string, AnyDerivedQuery>,
  built: Record<string, unknown>,
): void {
  for (const [name, command] of Object.entries(commands)) {
    const declared = command.contract.exposure.includes('trpc')
    const present = built[name] !== undefined
    if (declared && !present) {
      throw new Error(
        `${family}.${name}: the contract declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!declared && present) {
      throw new Error(
        `${family}.${name}: the derived router serves it, but its contract does not declare trpc exposure`,
      )
    }
  }
  for (const [name, query] of Object.entries(queries)) {
    const declared = query.exposure.includes('trpc')
    const present = built[name] !== undefined
    if (declared && !present) {
      throw new Error(
        `${family}.${name}: the query table declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!declared && present) {
      throw new Error(
        `${family}.${name}: the derived router serves it, but its query table entry does not declare trpc exposure`,
      )
    }
  }
  // A NAME CANNOT BE BOTH, and this is checked rather than assumed. tRPC would
  // silently keep whichever spread landed last, so a write shadowed by a read of
  // the same name would serve as a QUERY — which is precisely how a mutation
  // hides from an audit that checks procedure type.
  for (const name of Object.keys(commands)) {
    if (Object.hasOwn(queries, name)) {
      throw new Error(
        `${family}.${name} is declared as BOTH a command and a query — one name cannot be two procedures, and the surviving spread would decide the wire verb silently`,
      )
    }
  }
}

/**
 * Every procedure a family serves, built by iterating its TABLES — spread into
 * `router.ts`, which after this issue contains no procedure of its own for any
 * family built here.
 *
 * A twelfth command is served because it was DECLARED, and the only way to remove
 * a procedure is to remove its declaration. That is the property the whole phase
 * is buying, and it is why this function takes tables rather than a list of names.
 */
/**
 * THE ONE PLACE A REQUEST CONTEXT BECOMES FAMILY STATE.
 *
 * Every derived procedure in every family built through this file goes through
 * this function, and it is the only line in the server that reads `ctx.registry`
 * on behalf of a derived transport. That is what the "one documented access
 * pattern" criterion means operationally: not that reach-through is forbidden by
 * convention, but that there is exactly one function to audit, and a family that
 * wanted more would have to widen `FamilyState` in a diff a reviewer sees.
 *
 * It was two identical literals for about ten minutes, which is precisely how
 * these things drift — one gains a member and the other does not, and the reads
 * and the writes of the same family start seeing different state.
 */
const familyState = (ctx: Context): FamilyState => ({
  modules: mods(ctx),
  repos: ctx.repos,
  telemetry: ctx.telemetry,
  store: ctx.registry.sessionStore,
  cloud: ctx.cloud,
  caller: {
    userId: soleHumanPrincipal(ctx.capability).userId,
    actorSessionId: ctx.capability.actorSessionId,
  },
  publicationAuthority: ctx.publicationAuthority,
  discovery: ctx.discovery,
  superagent: ctx.superagent,
})

export function derivedFamilyProcedures<
  Svc,
  C extends Record<string, AnyDerivedCommand>,
  Q extends Record<string, AnyDerivedQuery>,
>(spec: DerivedFamily<Svc, C, Q>): FamilyProcedures<C, Q> {
  const built: Record<string, unknown> = {}

  for (const [name, command] of Object.entries(spec.commands)) {
    if (!command.contract.exposure.includes('trpc')) continue
    built[name] = t.procedure
      .input(command.contract.input)
      // THE ONE ACCESS PATTERN: the seam is read here, the service is handed to
      // the handler, and the handler never sees a ctx. `input` is erased at this
      // point because the table is heterogeneous — each pairing is checked where
      // it is declared, and re-derived for the client by `MutationProcedures`.
      .mutation(({ ctx, input }) => command.handler(spec.service(familyState(ctx)), input))
  }

  for (const [name, query] of Object.entries(spec.queries)) {
    if (!query.exposure.includes('trpc')) continue
    built[name] = t.procedure
      .input(query.input)
      .query(({ ctx, input }) => query.run(spec.service(familyState(ctx)), input))
  }

  assertSurfaceMatchesDeclarations(spec.family, spec.commands, spec.queries, built)
  return built as FamilyProcedures<C, Q>
}

/**
 * A QUERY-ONLY SURFACE — the same builder with an empty contract table.
 *
 * Most of what `router.ts` still declares is reads: routers whose writes another
 * issue already derived (`superagent`, `specs`, `settings`, `automations`,
 * `repos`, `discovery`), and routers that only ever had reads (`search`, `git`,
 * `usage`, `quota`, `features`, `sync`). They go through the SAME code path as
 * every derived family — same state bundle, same both-directions membership
 * check — rather than a second, laxer one, because a query-only shortcut is
 * exactly where a mutation would eventually be added without anyone noticing.
 *
 * The empty commands table is written out rather than defaulted, so "this family
 * has no writes" is a statement rather than an omission.
 */
export function queryProcedures<Q extends Record<string, AnyDerivedQuery>>(
  family: string,
  queries: Q,
): QueryProcedures<Q> {
  return derivedFamilyProcedures({
    family,
    service: (state) => state,
    commands: {},
    queries,
  }) as QueryProcedures<Q>
}
