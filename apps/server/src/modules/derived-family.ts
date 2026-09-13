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
 * (fleet's `serverRole` gate, sessions' session-state class, mail's action/verb
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
 *
 * ---------------------------------------------------------------------------
 * THE DECISIONS THIS FILE DOES TAKE, AND WHY THEY ARE NOT A CONTRADICTION
 * ---------------------------------------------------------------------------
 *
 * There are two, and they are deliberately argued in ONE place. PDM-294 wrote
 * this section for the first; PDM-290 extended it rather than adding a second
 * paragraph elsewhere, because two separately-argued exceptions to one
 * invariant, in two places, is how the invariant stops being one. The heading
 * said THE ONE DECISION until the second arrived; if a third does, it is
 * appended here, and the reason has to fit the same three-position table.
 *
 * PDM-294: the builder now reads `contract.policy.roleFloor` and refuses a
 * principal below it, through `./role-floor`. Read alongside the paragraph above
 * about `FamilyState` that sounds like its opposite, the distinction is the one
 * `fleet/trpc.ts` and `settings/trpc.ts` already draw:
 *
 *   - a HANDLER still cannot authorize, by construction — it receives a service
 *     and a parsed input, no capability, no scope, no ctx, and nothing in
 *     `./role-floor` is reachable from one;
 *   - the TRANSPORT enforces what the CONTRACT declared, before the service is
 *     even selected.
 *
 * It is here rather than in a per-family `authz.ts` because a per-family file
 * leaves the mechanism able to produce the defect again: before PDM-294 this
 * builder read `exposure` and `input` and never `policy`, so eighteen contracts
 * carrying an `admin` floor were served to any authenticated member, and a
 * FOURTEENTH family would have inherited the hole on the day it was added. A
 * fix that a new family can forget is not a fix.
 *
 * PDM-290 adds `sessionTargets` to `FamilyState`, and it is a THIRD position
 * next to those two rather than a hole in either:
 *
 *   - a SERVICE may receive a PRE-BOUND ANSWER. `sessionTargets` is one
 *     question — may this caller command this session, and what is the row —
 *     already closed over this request's principal. The service asks; it cannot
 *     read a scope out of what comes back, cannot see a role, cannot mint a
 *     principal, and cannot phrase a different question.
 *
 * Why the roleFloor gate above could not cover it, which is the part worth
 * having in writing. A floor is a claim about the CALLER's grade and nothing
 * about the TARGET: `cloud.moveSession` declares `roleFloor: 'member'`, and
 * every authenticated caller satisfies a member floor. The defect was that the
 * command took a caller-supplied `sessionId`, resolved it with no principal at
 * all, and seeded a hosted runtime from another human's resume ref and cwd —
 * a row-level ownership question the transport cannot answer, because answering
 * it means reading the row. So this one belongs to the service, exactly where
 * the `FamilyState` paragraph above says authorization belongs.
 *
 * The shape is the concession that keeps that paragraph literally true. Handing
 * the bundle a `CommandPrincipal` would have worked and would have put a
 * capability, a role and a scope in front of every handler in thirteen
 * families, in order to fix one command in one of them.
 *
 * PDM-297 adds `operationTargets`, and it is the THIRD POSITION'S SECOND
 * MEMBER rather than a fourth row in this table. That distinction is the whole
 * of why this section did not have to grow a new argument: a position that can
 * only ever hold one instance was never a position, it was an exception with a
 * nice name. `operationTargets` was built by a different family, for a different
 * question — may this caller `manage` the machine an operation targets, and then
 * act — and it needed no rule that was not already written above.
 *
 * PDM-308 adds `layoutActors` and `readPositionActors`, the third position's
 * THIRD and FOURTH members, and they are worth a paragraph because they are the
 * first members that answer a question about the CALLER rather than the TARGET —
 * and that turns out not to need a new rule either.
 *
 * `layout` and `read-position` join their contracts here for `exposure` (PDM-308
 * is that join; before it, nothing compared either family's declared transports
 * with what `router.ts` served). What they could NOT hand to this file is their
 * authorization, and the reason is precise rather than a preference. All three of
 * their contracts declare `roleFloor: 'member'`, and the PDM-294 gate above
 * deliberately does not consult the `member` floor — `role-floor.ts`, point 1:
 * treating an absent role as satisfying no floor is right, but applying it to
 * `member` would newly refuse every principal with no account row across 149
 * contracts. These two families have applied exactly that stricter rule to their
 * OWN member floor since POD-402 review gap 1, and two tests pin it. Folding
 * their gate into the builder's floor, the way PDM-297 folded `operations`'
 * hard-coded `admin`, would therefore have DELETED a refusal while every
 * instrument stayed green.
 *
 * So the gate stays theirs and arrives pre-bound: a handler asks `requireActor`
 * whose row it may write and receives a `UserId` or the family's own refusal. It
 * cannot read a role out of that, cannot see a capability, and cannot phrase a
 * different question — which is this position's rule, unchanged. That a
 * CALLER-shaped question fits it without amendment is the same evidence
 * `operationTargets` was: a position that keeps admitting members on its stated
 * terms is an invariant, not an exception with a nice name.
 *
 * It is the same shape for the same reason. `operations.cancel`, `settleAsk` and
 * `action` all declare `roleFloor: 'admin'`, which the gate above now enforces,
 * and a floor still says nothing about the TARGET: the target machine is read
 * out of the operation's own durable `details`, so it is a row-level question
 * exactly like `cloud.moveSession`'s. The one thing operations needs that
 * sessions did not is that the engine FORWARDS the caller's principal into
 * kind-specific `onAction` handlers; the port carries that too, pre-bound, so
 * the handler still asks and never holds. If a family ever genuinely cannot
 * express its need as "the port answers and the service acts", that is a new
 * position and belongs in this table with its own argument — not absorbed into
 * this one.
 */

import type { UserId } from '@podium/model'
import type { AnyCommandContract, TransportTag } from '@podium/commands'
import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  type Principal,
} from '@podium/protocol'
import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import type { Capability } from '../issue-authz'
import type { RegistryModules, SessionRegistry } from '../relay'
import type { RepoRegistry } from '../repo-registry'
import type { UsersRepository } from '../store/users'
import { type Context, mods, t } from '../trpc'
import {
  assertNoSecretReadFloor,
  roleFloorFailure,
  roleFloorDeps,
  roleFloorIsGated,
} from './role-floor'
import { sessionStatePrincipalFor } from './sessions/session-state/registry'
import { type SessionTargetGate, sessionTargetGate } from './sessions/session-target-gate'
import {
  type OperationTargetGate,
  operationTargetGate,
} from './operations/operation-target-gate'
import { type FileAccessGate, fileAccessGate } from './files/file-access-gate'
import { type PerUserActorGate, perUserActorGate } from './per-user-actor-gate'
import { layoutActor, layoutAuthzDeps, layoutAuthzFailure } from './layout/authz'
import {
  readPositionActor,
  readPositionAuthzDeps,
  readPositionAuthzFailure,
} from './read-position/authz'

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
   * ACCOUNTS AND THEIR CREDENTIALS — the member this bundle gained at POD-1554, when
   * `auth.setPassword` stopped writing one password for the whole instance and started
   * writing the CALLER's. `instance` is the one family that reads it. It is the
   * repository rather than a narrowed "credential writer" because the same family also
   * asks whether the caller is an admin, and two seams onto one table would be a second
   * place for the answer to drift.
   *
   * Optional: a server can be assembled without a user store, and the commands refuse
   * rather than inventing an account (see `InstanceService.requireAccountStore`).
   */
  readonly users?: UsersRepository | undefined
  /** Is login required on this instance — `credentialsRequired()` from server.ts,
   *  the ONE joined reader of open mode and per-user credentials. */
  readonly loginRequired?: (() => boolean | Promise<boolean>) | undefined
  /**
   * The hosted-runtime provider, absent on deployments with no cloud. On the
   * bundle for `repos`' reason — one family needs it — and left OPTIONAL rather
   * than defaulted here, because `CloudService` substitutes the disabled provider
   * at construction. Defaulting in two places is how the two diverge.
   */
  readonly cloud?: Context['cloud']
  /**
   * THE INSTANCE'S OWN LIFECYCLE, and the ability to turn it over (POD-2766).
   *
   * The pair `setup.activate` needs, and the two members that make this bundle
   * widen in a diff a reviewer sees — which is what the header above asks for.
   * `readiness` is a live reader rather than a value: the command refuses an
   * instance that is not activation-pending, and a snapshot would let a stale
   * screen restart a deployment that had already recovered.
   *
   * Both optional. A server assembled without them (tests, the in-process MCP
   * caller) refuses to activate rather than reporting a restart that never
   * happened.
   */
  readonly readiness?: Context['readiness']
  readonly requestCoordinatorRestart?: Context['requestCoordinatorRestart']
  /**
   * THIS PROCESS's event-loop accounting rings (loop design §7.2), for
   * `perf.snapshot`. On the bundle for the same reason as `repos` and
   * `telemetry`: exactly one family reads it, and naming it here is a smaller
   * claim than widening `RegistryModules` — the handle is a property of the
   * PROCESS, not a composed service, and the registry composes services.
   *
   * Optional, and absence is a real state rather than a missing wire: at profile
   * level `off` nothing is installed, so there is no handle to pass.
   */
  readonly loopAccounting?: Context['loopAccounting']
  /**
   * WHO IS ASKING — IDENTITY ONLY, and the shape is narrow on purpose.
   *
   * Four reads need to know whose rows to return or whose access to log:
   * `pins.list`, `snoozes.list`, `tabs.listOrders` (POD-380 keyed these per user
   * — the list is the CALLER's pins, not the instance's) and the read-toolkit
   * procs, which stamp the reader into their event log.
   *
   * THIS IS DELIBERATELY NOT `SessionStatePrincipal`, which was the first draft and
   * was wrong: that type CARRIES THE CAPABILITY inside it, so putting it here
   * would have handed every handler the authority object while a comment above it
   * claimed the opposite. Two fields, both names, no scope, no role, no override
   * flag — a handler can say whose row it wants and cannot decide whether it may
   * have it. If a handler ever wants to make a DECISION from this, that is the
   * signal the decision belongs in a contract or a service, not that this member
   * should grow back toward the capability.
   */
  readonly caller: {
    readonly userId: UserId
    /** Passed opaque to SessionStateService, which owns the visibility decision. */
    readonly sessionState: ReturnType<typeof sessionStatePrincipalFor>
    /** The capability's OWN field type, not a widened `string | null`. The first
     *  draft widened it and tsgo caught the consequence immediately: the read
     *  toolkit takes a branded `ReaderRef`, so a widened id would have forced a
     *  cast at three call sites — which is how a brand quietly stops meaning
     *  anything. */
    readonly actorSessionId: Capability['actorSessionId']
  }
  /**
   * MAY THIS CALLER COMMAND THAT SESSION — the ANSWER, not the authority to
   * decide it (PDM-290). The third position in "THE DECISIONS THIS FILE DOES
   * TAKE" above argues why this is not the capability coming back; the rule is
   * stated there, once, next to the other two, rather than a second time here.
   *
   * Selected by `cloud` alone today. `moveSession` is the only method on that
   * service that takes a session id, and it is the reason this member exists.
   */
  readonly sessionTargets: SessionTargetGate
  /**
   * MAY THIS CALLER MANAGE THE MACHINE THIS OPERATION TARGETS — the ANSWER, and
   * the acting methods bound to it (PDM-297). Selected by `operations` alone.
   * See the third position in "THE DECISIONS THIS FILE DOES TAKE"; this is that
   * position's second member, and `operations/operation-target-gate.ts` is its
   * implementation.
   */
  readonly operationTargets: OperationTargetGate
  /**
   * MAY THIS CALLER READ THESE BYTES — the ANSWER, and every file door bound to
   * it (PDM-272). Selected by `files` alone, and it is the WHOLE of that
   * family's state: see `files/file-access-gate.ts` for why the port owns the
   * RPC rather than sitting beside it.
   *
   * The third position's FIFTH member. It is the first whose family had NO
   * identity available at all — `files` selected three services and no caller,
   * so its three reads authorized on the path because the path was the only
   * thing in the seam. That is the shape this position exists to make
   * expressible, and it needed no new rule.
   */
  readonly fileTargets: FileAccessGate
  /**
   * WHOSE LAYOUT ROW THIS WRITE BELONGS TO — the ANSWER, and the family's own
   * live account check already applied (PDM-308). Selected by `layout` alone.
   * See the third position in "THE DECISIONS THIS FILE DOES TAKE", and
   * `./per-user-actor-gate.ts` for why this did not fold into the floor gate.
   */
  readonly layoutActors: PerUserActorGate
  /** As `layoutActors`, for the feed-cursor family. Selected by
   *  `read-position` alone (PDM-308). */
  readonly readPositionActors: PerUserActorGate
  readonly feedPrincipal?: import('@podium/protocol').Principal
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
const callerUserId = (ctx: Context): UserId => {
  if (ctx.principal?.kind === 'user') return ctx.principal.user
  if (ctx.principal?.kind === 'agent' && ctx.principal.onBehalfOf) return ctx.principal.onBehalfOf
  throw new Error('authenticated human principal is required')
}

export const familyState = (ctx: Context): FamilyState => ({
  modules: mods(ctx),
  repos: ctx.repos,
  telemetry: ctx.telemetry,
  store: ctx.registry.sessionStore,
  ...(ctx.users ? { users: ctx.users } : {}),
  ...(ctx.loginRequired ? { loginRequired: ctx.loginRequired } : {}),
  cloud: ctx.cloud,
  ...(ctx.readiness ? { readiness: ctx.readiness } : {}),
  ...(ctx.requestCoordinatorRestart
    ? { requestCoordinatorRestart: ctx.requestCoordinatorRestart }
    : {}),
  ...(ctx.loopAccounting ? { loopAccounting: ctx.loopAccounting } : {}),
  caller: {
    userId: callerUserId(ctx),
    sessionState: sessionStatePrincipalFor(ctx.principal),
    actorSessionId: ctx.capability.actorSessionId,
  },
  // The principal is read HERE and nowhere downstream: the gate closes over it,
  // and what reaches a family is a question it may ask.
  sessionTargets: sessionTargetGate(mods(ctx), ctx.principal, ctx.overrideScope),
  // TWO ACTORS, and the split is the shipped behaviour rather than a choice made
  // here — see the port's header. The AUTHORIZING actor is resolved from the
  // capability through `roleFloorDeps`, which is what `assertActionAuthorized`
  // read; the DISPATCH actor is `ctx.principal`, which is what the engine
  // forwarded into kind `onAction` handlers. Converging them is a pending
  // PDM-107 ruling and a behaviour change, not a cutover's business.
  operationTargets: operationTargetGate(
    mods(ctx),
    async () => (await roleFloorDeps(ctx)).principal,
    ctx.principal,
  ),
  // THE SAME CONSTRUCTION AS THE GATES ABOVE, and the same reason: this request's
  // principal, capability and user id are read HERE, and what reaches the `files`
  // family is a set of doors that have already asked. `callerUserId` is reused
  // rather than respelled so the session rule this gate runs cannot come to
  // disagree with the one `sessions`' own reads run over the same bytes.
  fileTargets: fileAccessGate(
    mods(ctx),
    ctx.repos,
    {
      userId: callerUserId(ctx),
      capability: ctx.capability,
      ...(ctx.overrideScope ? { overrideScope: true } : {}),
    },
    ctx.principal,
  ),
  // THE GATE IS BOUND HERE AND THE PRINCIPAL IS READ NOWHERE DOWNSTREAM, the
  // same construction as the two target gates above: the deps resolver closes
  // over this request's ctx, and what reaches the family is a question it may
  // ask. Both families keep their OWN failure function, so the refusal a caller
  // sees is still the one `layout/authz.ts` and `read-position/authz.ts` decide
  // and their tests pin.
  layoutActors: perUserActorGate(
    async () => await layoutAuthzDeps(ctx),
    layoutAuthzFailure,
    layoutActor,
  ),
  readPositionActors: perUserActorGate(
    async () => await readPositionAuthzDeps(ctx),
    readPositionAuthzFailure,
    readPositionActor,
  ),
  ...(ctx.principal?.kind === 'user'
    ? {
        feedPrincipal: {
          kind: 'user' as const,
          user: ctx.principal.user,
          device: asDeviceId(`trpc:${ctx.principal.user}`),
          // A REF, minted here — not the command layer's Capability object. The
          // ports carry this and must never inspect it, so handing them a
          // structured capability would hand them a scope to read.
          capability: asCapabilityRef(`trpc:user:${ctx.principal.user}`),
        },
      }
    : ctx.principal?.kind === 'agent'
      ? {
          feedPrincipal: {
            kind: 'agent' as const,
            // POD-1164: an agent's identity and its session id are the same
            // string, minted by asAgentIdentityId(sessionId).
            agentIdentity: asAgentIdentityId(ctx.principal.agentSessionId),
            onBehalfOf: ctx.principal.onBehalfOf,
            device: asDeviceId(`trpc:${ctx.principal.agentSessionId}`),
            capability: asCapabilityRef(`trpc:agent:${ctx.principal.agentSessionId}`),
            // THE COMMAND PRINCIPAL CARRIES NO DELEGATION REF, so one is derived
            // from the session. It resolves through whichever DelegationScopePort
            // is installed; against `NoDelegationsGranted` that is an EMPTY scope,
            // so a /trpc agent sees nothing — the same outcome as before
            // POD-1196, now stated rather than produced by an early return.
            delegation: asDelegationRef(`session:${ctx.principal.agentSessionId}`),
          },
        }
      : {}),
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
    const qualifiedName = `${spec.family}.${name}`
    // AT MODULE LOAD, like the membership check below: a contract whose refusal
    // this gate cannot spell safely must stop the server assembling, not serve
    // and leak (PDM-294). See `assertNoSecretReadFloor`.
    assertNoSecretReadFloor(qualifiedName, command.contract)
    // THE FLOOR IS READ HERE FOR EVERY FAMILY BUILT THROUGH THIS FILE (PDM-294).
    // Skipped for the `member` floor so the 149 contracts that declare it do not
    // pay a live user lookup per call — `roleFloorIsGated` is the one predicate
    // this skip and `roleFloorFailure` both go through, so they cannot drift.
    const gated = roleFloorIsGated(command.contract)
    built[name] = t.procedure
      .input(command.contract.input)
      // THE ONE ACCESS PATTERN: the seam is read here, the service is handed to
      // the handler, and the handler never sees a ctx. `input` is erased at this
      // point because the table is heterogeneous — each pairing is checked where
      // it is declared, and re-derived for the client by `MutationProcedures`.
      //
      // The gate runs BEFORE the service is selected, so a principal below the
      // floor never reaches a family's state at all — and the handler still
      // cannot make the decision itself, because it still receives no ctx.
      .mutation(async ({ ctx, input }) => {
        if (gated) {
          const refusal = roleFloorFailure(qualifiedName, command.contract, await roleFloorDeps(ctx))
          if (refusal) throw refusal
        }
        return await command.handler(spec.service(familyState(ctx)), input)
      })
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
