/**
 * THE DERIVED SESSION SURFACE (POD-382, the 3.2 cutover) — every session-family
 * tRPC MUTATION, produced from the contract tables rather than written out.
 *
 * ---------------------------------------------------------------------------
 * WHAT "DERIVED" MEANS HERE, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * POD-380 landed `sessionStateProcedure(name)` in `router.ts` with an explicit note that it
 * was NOT the full derivation, because "procedures are still listed by hand below,
 * so the shape of the router is reviewable in this diff". That was right for one
 * class and it is what this issue finishes: there is no per-procedure line left.
 * Which session mutations exist, what they validate, which transports serve them,
 * how they authorize and how they dedupe are all read off the contracts, and
 * `router.ts` spreads the result.
 *
 * Three contract sources, because the family has three envelopes and they differ
 * in ways that are real:
 *
 *   1. DURABLE SESSION STATE (POD-380) — `@podium/protocol`'s session-state tables through
 *      `SessionStateRegistry`, whose refusals are SILENT NO-OPS (§3.1.5, as POD-379
 *      pinned for this class).
 *   2. COMMAND PLANE (POD-381; `stop` / `uploadImage` / `ask` added by POD-382) —
 *      `dispatchSessionCommand`, whose refusals are per-command shapes and whose
 *      gates include machine `use`.
 *   3. HANDOFF (POD-642) — `sessionHandoffContract` in `@podium/commands`: the one
 *      command that touches two machines, with its own coordinator, its own
 *      single-flight and its own two apply-time re-authorizations.
 *
 * They are NOT merged into one envelope. A single envelope would have to pick one
 * refusal shape and POD-379 pins three; picking one would be a product change
 * disguised as a refactor. What IS unified is that all three are declared, and that
 * no transport can reach a handler except through its envelope.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE DRIVES THE WIRE (ADR 3 D3, default-closed)
 * ---------------------------------------------------------------------------
 *
 * A contract appears here if and only if it declares `trpc`. That is why
 * `sessions.setDraft` is absent — it declares `ws`, because the draft's live path is
 * the debounced WebSocket edit — and nobody maintains a second list saying so.
 *
 * {@link TRPC_SESSION_STATE_NAMES} is the type-level half of that filter, and it is
 * CHECKED AGAINST THE RUNTIME EXPOSURE IN BOTH DIRECTIONS at module load
 * ({@link sessionStateEntries}): a contract that gains `trpc` without being added here,
 * or loses it while still listed, throws before the server serves a request. A
 * type-level list that could silently disagree with the contract it mirrors would
 * be the second declaration this whole issue is about.
 *
 * ---------------------------------------------------------------------------
 * WHY OUTPUT TYPES ARE STILL WRITTEN DOWN
 * ---------------------------------------------------------------------------
 *
 * `CommandDef` carries no output schema (its `__out` phantom is unset at runtime),
 * so a fully generic derivation types every result `unknown` — and the damage lands
 * on the WEB CLIENT, where `AppRouter` inference is what makes
 * `api.sessions.rename.mutate(…)` checked at all. That is not a compile error here;
 * it is a silent loss of checking at every call site.
 *
 * So {@link SESSION_STATE_OUTPUTS} is written down, and its key set is checked against
 * the tables. The command plane needs no such map: its results are already derived
 * from its handler table (`SessionCommandResult`), and handoff's come from its
 * contract's output schema.
 */

import {
  isExposedOn,
  SESSION_STATE_COMMAND_TABLES,
  sessionStateCommand,
  sessionCommandPlane,
  sessionCommandPlaneInputs,
  sessionStateInputs,
} from '@podium/commands'
import { type SessionHandoffOutput, sessionHandoffInput } from '@podium/commands'

import { TRPCError, type TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import type { PinState, SnoozeMap } from '../../store/types'
import { type Context, mods, t } from '../../trpc'
import { familyState } from '../derived-family'
import { sessionCommandCtx } from './command-ctx'
import {
  dispatchSessionCommand,
  type SessionCommandKey,
  type SessionCommandResult,
} from './command-plane'
import { SessionStateRegistry, sessionStatePrincipalFor } from './session-state/registry'
import { dispatchRename } from './rename-adapter'

// ---------------------------------------------------------------------------
// Durable session-state class
// ---------------------------------------------------------------------------

/** Every dotted session-state-contract name, as a type. */
type SessionStateName = keyof typeof sessionStateInputs

/** The one command POD-351 moved to the target path. Named once so the manifest,
 *  the builder and any future migration cannot disagree about which it is. */
const RENAME_NAME = 'sessions.rename' as const

/**
 * The session-state contracts served over tRPC — the type-level half of the exposure
 * filter, kept honest by the runtime cross-check in {@link sessionStateEntries}.
 *
 * `sessions.setDraft` is deliberately absent: `ws` only.
 */
const TRPC_SESSION_STATE_NAMES = [
  'sessions.rename',
  'sessions.setArchived',
  'sessions.setWorkState',
  'sessions.setIssueId',
  'sessions.markRead',
  'sessions.markUnread',
  'snoozes.set',
  'snoozes.clear',
  'pins.set',
  'tabs.setOrder',
] as const satisfies readonly SessionStateName[]

type TrpcSessionStateName = (typeof TRPC_SESSION_STATE_NAMES)[number]

/**
 * WHAT EACH DURABLE SESSION STATE COMMAND RETURNS ON THE WIRE.
 *
 * `void` for the owner-or-grant session writes: they are field writes whose result
 * the client learns from the delta, not from the call. A real value for the per-user
 * rows, because the caller reads back what it just wrote, and returning the whole
 * map is what lets the client apply one state update instead of re-querying.
 *
 * A type, not a value — nothing here exists at runtime. Its key set is
 * `SessionStateName`, so a contract added to the tables without an output type is a
 * compile error at this line rather than an `unknown` in the client.
 */
interface SessionStateOutputs extends Record<SessionStateName, unknown> {
  'sessions.rename': void
  'sessions.setArchived': void
  'sessions.setWorkState': void
  'sessions.setIssueId': void
  'sessions.markRead': void
  'sessions.markUnread': void
  'sessions.setDraft': void
  'snoozes.set': SnoozeMap
  'snoozes.clear': SnoozeMap
  'pins.set': PinState
  'tabs.setOrder': Record<string, string[]>
}

type SessionStateProcedure<N extends SessionStateName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof sessionStateInputs)[N]>
  output: SessionStateOutputs[N]
}>

/** The procedures one namespace contributes, keyed by their bare proc names. */
type SessionStateProceduresOn<NS extends string> = {
  [N in TrpcSessionStateName as N extends `${NS}.${infer K}` ? K : never]: SessionStateProcedure<N>
}

/**
 * One session-state procedure, built out of its contract: the contract's own input
 * schema (one validation source) and a body that is the framework envelope —
 * exposure, parse, LIVE authorization, framework idempotency, handler.
 *
 * The refusal shape is the CLASS's, not this function's: `denied`, `not-exposed` and
 * an unknown target all return `undefined`, the same answer a write against a
 * nonexistent session gives (§3.1.5 — the command surface must not become an
 * existence oracle). `invalid-input` is made loud because it is unreachable through
 * this transport (the procedure parsed the same schema already) and a silent
 * `undefined` would be indistinguishable from the deliberate no-op.
 */
function sessionStateProcedure<N extends TrpcSessionStateName>(name: N): SessionStateProcedure<N> {
  const contract = sessionStateCommand(name)
  // A name no contract declares would produce a procedure that refuses everything —
  // the "green gate that stopped looking" failure. Fail at module load instead.
  if (!contract) throw new Error(`sessionStateProcedure: no contract named ${name}`)
  return t.procedure
    .input(sessionStateInputs[name])
    .mutation(({ ctx, input }): SessionStateOutputs[N] => {
      const result = sessionStateRegistryFor(ctx).execute(
        name,
        input,
        sessionStatePrincipal(ctx),
        'trpc',
      )
      if (result.outcome === 'invalid-input') throw new Error(`invalid input for ${name}`)
      return result.value as SessionStateOutputs[N]
    }) as SessionStateProcedure<N>
}

/** The session-state envelope for one call. */
function sessionStateRegistryFor(ctx: Context): SessionStateRegistry {
  return new SessionStateRegistry({
    sessions: familyState(ctx).modules.sessions,
    state: familyState(ctx).modules.sessions.state,

    // THE composition root's ledger — framework idempotency, one instance.
    mutations: familyState(ctx).modules.mutations,
  })
}

/** The transport principal for a tRPC call. One shared password ⇒ the sole human
 *  (§3.2); POD-1075 replaces this with a real per-user principal. */
export function sessionStatePrincipal(ctx: Context) {
  return sessionStatePrincipalFor(ctx.principal)
}

// ---------------------------------------------------------------------------
// The walking skeleton (POD-351)
// ---------------------------------------------------------------------------

/**
 * `sessions.rename` ON THE TARGET PATH — POD-351's join, re-pointed into POD-382's
 * derived surface.
 *
 * ## Why this is a fourth source and not a session-state procedure
 *
 * Every OTHER session-state contract is served by `sessionStateProcedure`, which runs the
 * `SessionStateRegistry` envelope. Rename is the one command the walking skeleton moved
 * to the TARGET path: the `@podium/commands` contract, the real `CommandPrincipal`
 * with its delegation chain resolved live, and the contract's accept/reject outcome
 * union. `dispatchRename` chooses between that and the legacy session-state envelope on
 * the flag, so BOTH paths stay reachable from one call site — which is what the
 * shadow comparison requires and what makes `PODIUM_SESSION_RENAME_PATH=legacy` a
 * real rollback rather than a dead branch.
 *
 * Declaring it as its own source rather than special-casing inside
 * `sessionStateProcedure` keeps that visible in the MANIFEST: the audit and any reader
 * can see exactly which commands are on which envelope, and a second command
 * migrating later is a row that changes rather than a condition someone has to find.
 *
 * ## What it still shares with the session-state class, and why that is not a compromise
 *
 * It stays in `TRPC_SESSION_STATE_NAMES` and keeps its session-state contract, because that
 * contract is still what declares its exposure and its policy — and the both-
 * directions exposure cross-check in `sessionStateEntries()` must keep covering it.
 * `@podium/commands`' `sessionRenameContract` COMPOSES that same input schema
 * instance (asserted with `toBe` in `packages/commands/src/sessions/rename.test.ts`),
 * so there is one schema object and the two envelopes cannot diverge on the wire.
 *
 * ## The public return type stays `void`, deliberately
 *
 * The session-state class's refusal shape is a silent no-op (§3.1.5, pinned by POD-379).
 * Surfacing the target path's richer outcome to THIS transport would make a denial
 * distinguishable from a not-found and turn the procedure into an existence oracle.
 * The outcome is not discarded — it is what the outbox drain reads to dead-letter a
 * rejected offline write (POD-316), where the caller is already authorized and the
 * reason leaks nothing.
 */
function renameProcedure(): SessionStateProcedure<'sessions.rename'> {
  return t.procedure
    .input(sessionStateInputs['sessions.rename'])
    .mutation(({ ctx, input }): void => {
      const modules = familyState(ctx).modules
      const dispatch = dispatchRename(
        {
          sessions: modules.sessions,
          mutations: modules.mutations,
          principal: sessionCommandCtx(modules, ctx.capability).principal,
          legacyPrincipal: sessionStatePrincipal(ctx),
          // The rollback envelope, built lazily — the target path is the default.
          legacyRegistry: () => sessionStateRegistryFor(ctx),
        },
        input,
      )
      if (dispatch === undefined) return
      if (dispatch.outcome === 'denied' || dispatch.outcome === 'not-exposed') {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'command refused' })
      }
      if (dispatch.outcome === 'invalid-input') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid command input' })
      }
      if (dispatch.result == null) return
      if (!dispatch.result.ok) {
        throw new TRPCError({ code: 'CONFLICT', message: dispatch.result.reason })
      }
    }) as SessionStateProcedure<'sessions.rename'>
}

// ---------------------------------------------------------------------------
// Command plane
// ---------------------------------------------------------------------------

/**
 * The precise procedure type one command-plane contract derives to — what keeps
 * `AppRouter` (and therefore the web client and every `createCaller` test) typed
 * exactly as the hand-written procedures were: input is the schema's `z.input`,
 * output is the handler's awaited return.
 */
type PlaneProcedure<K extends SessionCommandKey> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof sessionCommandPlaneInputs)[K]>
  output: Awaited<SessionCommandResult<K>>
}>

type PlaneProcedures = { [K in SessionCommandKey]: PlaneProcedure<K> }

function planeProcedure<K extends SessionCommandKey>(key: K): PlaneProcedure<K> {
  // THE CONTRACT'S OWN SCHEMA INSTANCE at runtime — not a restatement beside it —
  // WIDENED for the builder's benefit only. With `key` still generic,
  // `sessionCommandPlaneInputs[key]` is a UNION of eleven schemas, and tRPC's
  // builder then tries to reconcile eleven input/output pairs in one signature; it
  // picks one and rejects the rest. Widening here and stating the precise type in
  // the RETURN is what keeps the client exact: `PlaneProcedure<K>` is derived from
  // the same table, so `AppRouter` carries the real input and output types even
  // though this line does not.
  const schema = sessionCommandPlaneInputs[key] as z.ZodTypeAny
  const built = t.procedure
    .input(schema)
    .mutation(({ ctx, input }): unknown =>
      dispatchSessionCommand(
        sessionCommandCtx(familyState(ctx).modules, ctx.capability, ctx.overrideScope),
        key,
        input,
      ),
    )
  // The precise type is asserted ONCE, here, from the same tables the runtime uses:
  // `PlaneProcedure<K>` reads its input off `sessionCommandPlaneInputs[K]` and its
  // output off the handler table, so the client sees the real pair. The resolver's
  // own return is deliberately `unknown` — with `K` generic, letting the builder
  // infer means reconciling eleven input/output pairs in one signature, which it
  // does by picking one and rejecting the other ten.
  return built as unknown as PlaneProcedure<K>
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

type HandoffProcedure = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<typeof sessionHandoffInput>
  output: SessionHandoffOutput
}>

/**
 * `sessions.handoff` (POD-642). The caller is passed as a SEPARATE argument, from
 * the context's capability — never out of `input`, whose schema carries no identity
 * field at all (ADR 3 D7: payload identity is inert, here by construction).
 *
 * Not folded into the command plane: handoff gates `use` on BOTH machines,
 * re-authorizes at two apply points minutes apart, and single-flights duplicate
 * dispatch instead of deduping on a `mutationId` it deliberately does not carry.
 */
function handoffProcedure(): HandoffProcedure {
  return t.procedure
    .input(sessionHandoffInput)
    .mutation(
      ({ ctx, input }): Promise<SessionHandoffOutput> =>
        familyState(ctx).modules.sessions.handoffSession(input, { capability: ctx.capability, principal: ctx.principal }),
    ) as HandoffProcedure
}

// ---------------------------------------------------------------------------
// The manifest, and the routers
// ---------------------------------------------------------------------------

/** Which envelope serves a derived procedure. */
export type SessionSurfaceSource =
  | 'session-state'
  | 'command-plane'
  | 'handoff'
  | 'mail'
  | 'walking-skeleton'

/**
 * ONE ROW PER DERIVED MUTATION — the manifest the cutover audit reads.
 *
 * Produced by the same walk that produces the procedures, from the same contracts,
 * so it cannot describe a surface the router does not serve. The audit closes the
 * other direction — a mutation on a session-family router that is not in this
 * manifest fails the build — which is what makes "no hand-written session mutation"
 * a checked claim rather than a grep over a file.
 */
export interface SessionSurfaceEntry {
  /** Dotted wire name (`sessions.rename`). */
  name: string
  /** tRPC router this procedure lives on (`sessions` · `pins` · `snoozes` · `tabs`). */
  router: string
  /** Procedure key within that router. */
  key: string
  source: SessionSurfaceSource
}

/**
 * The session-state half of the manifest, WITH the both-directions exposure check.
 *
 * Direction 1 (tables → list): a contract that declares `trpc` and is missing from
 * `TRPC_SESSION_STATE_NAMES` would be silently unserved.
 * Direction 2 (list → tables): a name here whose contract no longer declares `trpc`
 * would silently serve a command the contract says is not exposed there.
 *
 * Both throw, at module load, because either is a divergence between the wire and
 * the declaration that governs it — and a wire that disagrees with its contract is
 * exactly what the audit exists to make impossible.
 */
function sessionStateEntries(): SessionSurfaceEntry[] {
  const exposedByContract = new Set<string>()
  for (const table of SESSION_STATE_COMMAND_TABLES) {
    for (const key of Object.keys(table.defs)) {
      const name = `${table.namespace}.${key}`
      const contract = sessionStateCommand(name)
      if (!contract) throw new Error(`session-state table declares ${name} with no contract`)
      if (isExposedOn(contract, 'trpc')) exposedByContract.add(name)
    }
  }
  const listed = new Set<string>(TRPC_SESSION_STATE_NAMES)
  for (const name of exposedByContract) {
    if (!listed.has(name)) {
      throw new Error(
        `session-state contract ${name} declares trpc exposure but is not in TRPC_SESSION_STATE_NAMES — the derived router would not serve it`,
      )
    }
  }
  for (const name of listed) {
    if (!exposedByContract.has(name)) {
      throw new Error(
        `TRPC_SESSION_STATE_NAMES lists ${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
  return TRPC_SESSION_STATE_NAMES.map((name) => {
    const dot = name.indexOf('.')
    return {
      name,
      router: name.slice(0, dot),
      key: name.slice(dot + 1),
      // POD-351: rename is served by the TARGET path, not the session-state envelope.
      // Its exposure and policy are still the session-state contract's — which is why it
      // stays in this walk and keeps its both-directions exposure check above — but
      // which envelope RUNS it is a different fact, and the manifest records it.
      source: name === RENAME_NAME ? ('walking-skeleton' as const) : ('session-state' as const),
    }
  })
}

/** The command-plane half, filtered by the same default-closed exposure read. */
function planeEntries(): SessionSurfaceEntry[] {
  const defs = sessionCommandPlane.defs as Record<string, Parameters<typeof isExposedOn>[0]>
  return Object.keys(defs)
    .filter((key) => {
      const def = defs[key]
      return def !== undefined && isExposedOn(def, 'trpc')
    })
    .map((key) => ({
      name: `sessions.${key}`,
      router: 'sessions',
      key,
      source: 'command-plane' as const,
    }))
}

/** Every derived session-family mutation, with the envelope that serves it. */
export function sessionSurfaceManifest(): SessionSurfaceEntry[] {
  return [
    ...sessionStateEntries(),
    ...planeEntries(),
    // Handoff's exposure is `['trpc']` on its own contract in `@podium/commands`;
    // it is a single entry rather than a table walk because it is a single command.
    { name: 'sessions.handoff', router: 'sessions', key: 'handoff', source: 'handoff' },
    // `sessions.ask` — DECLARED HERE, BUILT IN router.ts, and the split is the point.
    //
    // POD-729 cut the seance over to the MAIL contract table (it reaches delivery, so
    // a send path no contract governs was the hole that cutover closed), and the
    // sessions router serves it through that family's own derivation,
    // `mailMutation('ask')`. It is recorded in this manifest anyway because the audit
    // reads the manifest to decide whether a mutation on a session-family router is
    // accounted for — leaving it out would make POD-729's derived procedure look like
    // a hand-written one, and taking it out of the audit's sight would be worse.
    { name: 'sessions.ask', router: 'sessions', key: 'ask', source: 'mail' },
  ]
}

/**
 * THE DERIVED PROCEDURES, grouped by the router they belong on.
 *
 * `router.ts` spreads these into its `sessions` / `pins` / `snoozes` / `tabs`
 * routers alongside the family's QUERIES. The reads are deliberately NOT derived
 * here: they have no contracts yet, that is POD-311's remaining work, and this
 * issue's claim is about mutations. What matters is that a read cannot hide a write
 * — the audit checks procedure TYPE, not naming.
 */
export function sessionFamilyProcedures(): {
  sessions: PlaneProcedures & SessionStateProceduresOn<'sessions'> & { handoff: HandoffProcedure }
  pins: SessionStateProceduresOn<'pins'>
  snoozes: SessionStateProceduresOn<'snoozes'>
  tabs: SessionStateProceduresOn<'tabs'>
} {
  const grouped: Record<string, Record<string, unknown>> = {
    sessions: {},
    pins: {},
    snoozes: {},
    tabs: {},
  }
  for (const entry of sessionSurfaceManifest()) {
    // `mail` entries are built by the mail family's own derivation in router.ts —
    // one command, one contract, one builder. See the manifest note on sessions.ask.
    if (entry.source === 'mail') continue
    const bucket = grouped[entry.router]
    if (!bucket) throw new Error(`no router bucket for ${entry.name}`)
    bucket[entry.key] =
      entry.source === 'walking-skeleton'
        ? renameProcedure()
        : entry.source === 'session-state'
          ? sessionStateProcedure(entry.name as TrpcSessionStateName)
          : entry.source === 'handoff'
            ? handoffProcedure()
            : planeProcedure(entry.key as SessionCommandKey)
  }
  return grouped as unknown as ReturnType<typeof sessionFamilyProcedures>
}
