/**
 * THE DERIVED SESSION SURFACE (POD-382, the 3.2 cutover) — every session-family
 * tRPC MUTATION, produced from the contract tables rather than written out.
 *
 * ---------------------------------------------------------------------------
 * WHAT "DERIVED" MEANS HERE, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * POD-380 landed `presenceProc(name)` in `router.ts` with an explicit note that it
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
 *   1. PRESENCE (POD-380) — `@podium/protocol`'s presence tables through
 *      `PresenceRegistry`, whose refusals are SILENT NO-OPS (§3.1.5, as POD-379
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
 * {@link TRPC_PRESENCE_NAMES} is the type-level half of that filter, and it is
 * CHECKED AGAINST THE RUNTIME EXPOSURE IN BOTH DIRECTIONS at module load
 * ({@link presenceEntries}): a contract that gains `trpc` without being added here,
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
 * So {@link PRESENCE_OUTPUTS} is written down, and its key set is checked against
 * the tables. The command plane needs no such map: its results are already derived
 * from its handler table (`SessionCommandResult`), and handoff's come from its
 * contract's output schema.
 */

import { type SessionHandoffOutput, sessionHandoffInput } from '@podium/commands'
import {
  isExposedOn,
  PRESENCE_COMMAND_TABLES,
  presenceCommand,
  sessionCommandPlane,
  sessionCommandPlaneInputs,
  sessionPresenceInputs,
} from '@podium/protocol'
import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import type { PinState, SnoozeMap } from '../../store/types'
import { type Context, mods, t } from '../../trpc'
import { sessionCommandCtx } from './command-ctx'
import {
  dispatchSessionCommand,
  type SessionCommandKey,
  type SessionCommandResult,
} from './command-plane'
import { PresenceRegistry, soleHumanPrincipal } from './presence-registry'

// ---------------------------------------------------------------------------
// Presence class
// ---------------------------------------------------------------------------

/** Every dotted presence-contract name, as a type. */
type PresenceName = keyof typeof sessionPresenceInputs

/**
 * The presence contracts served over tRPC — the type-level half of the exposure
 * filter, kept honest by the runtime cross-check in {@link presenceEntries}.
 *
 * `sessions.setDraft` is deliberately absent: `ws` only.
 */
const TRPC_PRESENCE_NAMES = [
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
] as const satisfies readonly PresenceName[]

type TrpcPresenceName = (typeof TRPC_PRESENCE_NAMES)[number]

/**
 * WHAT EACH PRESENCE COMMAND RETURNS ON THE WIRE.
 *
 * `void` for the owner-or-grant session writes: they are field writes whose result
 * the client learns from the delta, not from the call. A real value for the per-user
 * rows, because the caller reads back what it just wrote, and returning the whole
 * map is what lets the client apply one state update instead of re-querying.
 *
 * A type, not a value — nothing here exists at runtime. Its key set is
 * `PresenceName`, so a contract added to the tables without an output type is a
 * compile error at this line rather than an `unknown` in the client.
 */
interface PresenceOutputs extends Record<PresenceName, unknown> {
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

type PresenceProcedure<N extends PresenceName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof sessionPresenceInputs)[N]>
  output: PresenceOutputs[N]
}>

/** The procedures one namespace contributes, keyed by their bare proc names. */
type PresenceProceduresOn<NS extends string> = {
  [N in TrpcPresenceName as N extends `${NS}.${infer K}` ? K : never]: PresenceProcedure<N>
}

/**
 * One presence procedure, built out of its contract: the contract's own input
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
function presenceProcedure<N extends TrpcPresenceName>(name: N): PresenceProcedure<N> {
  const contract = presenceCommand(name)
  // A name no contract declares would produce a procedure that refuses everything —
  // the "green gate that stopped looking" failure. Fail at module load instead.
  if (!contract) throw new Error(`presenceProcedure: no contract named ${name}`)
  return t.procedure
    .input(sessionPresenceInputs[name])
    .mutation(({ ctx, input }): PresenceOutputs[N] => {
      const result = presenceRegistryFor(ctx).execute(name, input, presencePrincipal(ctx), 'trpc')
      if (result.outcome === 'invalid-input') throw new Error(`invalid input for ${name}`)
      return result.value as PresenceOutputs[N]
    }) as PresenceProcedure<N>
}

/** The presence envelope for one call. */
function presenceRegistryFor(ctx: Context): PresenceRegistry {
  return new PresenceRegistry({
    sessions: mods(ctx).sessions,
    store: ctx.registry.sessionStore,
    now: () => Date.now(),
    // THE composition root's ledger — framework idempotency, one instance.
    mutations: mods(ctx).mutations,
  })
}

/** The transport principal for a tRPC call. One shared password ⇒ the sole human
 *  (§3.2); POD-1075 replaces this with a real per-user principal. */
export function presencePrincipal(ctx: Context) {
  return soleHumanPrincipal(ctx.capability)
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
        sessionCommandCtx(mods(ctx), ctx.capability, ctx.overrideScope),
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
        mods(ctx).sessions.handoffSession(input, { capability: ctx.capability }),
    ) as HandoffProcedure
}

// ---------------------------------------------------------------------------
// The manifest, and the routers
// ---------------------------------------------------------------------------

/** Which envelope serves a derived procedure. */
export type SessionSurfaceSource = 'presence' | 'command-plane' | 'handoff' | 'mail'

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
 * The presence half of the manifest, WITH the both-directions exposure check.
 *
 * Direction 1 (tables → list): a contract that declares `trpc` and is missing from
 * `TRPC_PRESENCE_NAMES` would be silently unserved.
 * Direction 2 (list → tables): a name here whose contract no longer declares `trpc`
 * would silently serve a command the contract says is not exposed there.
 *
 * Both throw, at module load, because either is a divergence between the wire and
 * the declaration that governs it — and a wire that disagrees with its contract is
 * exactly what the audit exists to make impossible.
 */
function presenceEntries(): SessionSurfaceEntry[] {
  const exposedByContract = new Set<string>()
  for (const table of PRESENCE_COMMAND_TABLES) {
    for (const key of Object.keys(table.defs)) {
      const name = `${table.namespace}.${key}`
      const contract = presenceCommand(name)
      if (!contract) throw new Error(`presence table declares ${name} with no contract`)
      if (isExposedOn(contract, 'trpc')) exposedByContract.add(name)
    }
  }
  const listed = new Set<string>(TRPC_PRESENCE_NAMES)
  for (const name of exposedByContract) {
    if (!listed.has(name)) {
      throw new Error(
        `presence contract ${name} declares trpc exposure but is not in TRPC_PRESENCE_NAMES — the derived router would not serve it`,
      )
    }
  }
  for (const name of listed) {
    if (!exposedByContract.has(name)) {
      throw new Error(
        `TRPC_PRESENCE_NAMES lists ${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
  return TRPC_PRESENCE_NAMES.map((name) => {
    const dot = name.indexOf('.')
    return {
      name,
      router: name.slice(0, dot),
      key: name.slice(dot + 1),
      source: 'presence' as const,
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
    ...presenceEntries(),
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
  sessions: PlaneProcedures & PresenceProceduresOn<'sessions'> & { handoff: HandoffProcedure }
  pins: PresenceProceduresOn<'pins'>
  snoozes: PresenceProceduresOn<'snoozes'>
  tabs: PresenceProceduresOn<'tabs'>
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
      entry.source === 'presence'
        ? presenceProcedure(entry.name as TrpcPresenceName)
        : entry.source === 'handoff'
          ? handoffProcedure()
          : planeProcedure(entry.key as SessionCommandKey)
  }
  return grouped as unknown as ReturnType<typeof sessionFamilyProcedures>
}
