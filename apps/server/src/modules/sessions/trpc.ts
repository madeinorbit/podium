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
  type SessionHandoffOutput,
  sessionCommandPlane,
  sessionCommandPlaneInputs,
  sessionHandoffContract,
  sessionHandoffInput,
  sessionStateCommand,
  sessionStateInputs,
} from '@podium/commands'

import { TRPCError, type TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import type { SnoozeMap } from '../../store/types'
import { familyState } from '../derived-family'
import { plainRoute } from '../write-routes/plain'
import { syncRoute } from '../write-routes/sync'
import { sessionCommandCtx } from './command-ctx'
import {
  dispatchSessionCommand,
  type SessionCommandKey,
  type SessionCommandResult,
} from './command-plane'
import { handoffRefusalOf } from './handoff/refusal'
import { handoffThroughEffect } from './session-handoff-effect'
import {
  IMMEDIATE_PLANE_COMMANDS,
  IMMEDIATE_SESSION_STATE_COMMANDS,
  QUEUED_SEND_COMMANDS,
  QUEUED_SESSION_STATE_COMMANDS,
} from './sync-write'

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
 * `sessions.setDraft` is deliberately absent: `ws` only. Its keystrokes are a
 * live stream (ADR 12 D1), not a write on the sync entry point.
 *
 * `sessions.setIssueId` is absent too: it is on `sync.submit` only (POD-6416),
 * because no shipped client ever called its route ({@link SUBMIT_ONLY_NAMES}).
 */
const TRPC_SESSION_STATE_NAMES = [
  'sessions.rename',
  'sessions.setArchived',
  'sessions.setWorkState',
  'sessions.dismissOffer',
  'sessions.markRead',
  'sessions.markUnread',
  'snoozes.set',
  'snoozes.clear',
] as const satisfies readonly SessionStateName[]

type TrpcSessionStateName = (typeof TRPC_SESSION_STATE_NAMES)[number]

/**
 * Session-state contracts that declare `trpc` because `sync.submit` is served over
 * tRPC, and that have no per-command route of their own (POD-6416). The exposure
 * cross-check reads them as accounted for.
 */
const SUBMIT_ONLY_NAMES: ReadonlySet<string> = new Set(IMMEDIATE_SESSION_STATE_COMMANDS)

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
  'sessions.dismissOffer': void
  'sessions.markRead': void
  'sessions.markUnread': void
  'sessions.setDraft': void
  'snoozes.set': SnoozeMap
  'snoozes.clear': SnoozeMap
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
  const queued = (QUEUED_SESSION_STATE_COMMANDS as readonly string[]).includes(name)
  if (queued) {
    // LEGACY(remove-after: 2027-03): an older app queues these on their own
    // routes; the route is a thin adapter onto `sync.submit` (POD-6350).
    return syncRoute({
      command: { name, def: contract },
      input: sessionStateInputs[name],
      run: async ({ submit }): Promise<SessionStateOutputs[N]> => {
        const { reply } = await submit()
        if (reply.outcome === 'applied') return reply.result as SessionStateOutputs[N]
        if (reply.refusal.kind === 'invalid') throw new Error(`invalid input for ${name}`)
        return undefined as SessionStateOutputs[N]
      },
    }) as unknown as SessionStateProcedure<N>
  }
  // Every session-state route but rename's (`renameProcedure`) is a queued
  // command's: a new one is a registration first, then a route.
  throw new Error(`sessionStateProcedure: ${name} is not a queued session-state command`)
}

// ---------------------------------------------------------------------------
// The walking skeleton (POD-351)
// ---------------------------------------------------------------------------

/**
 * `sessions.rename` — POD-351's walking skeleton, now a thin adapter onto its
 * sync registration (`sync-write.ts`, POD-6350). The rollback flag that took the
 * session-state envelope instead (`PODIUM_SESSION_RENAME_PATH=legacy`) is gone
 * (POD-6601): the write has one path.
 *
 * It stays in `TRPC_SESSION_STATE_NAMES` and keeps its session-state contract,
 * because that contract is still what declares its exposure, and the
 * both-directions exposure cross-check in `sessionStateEntries()` must keep
 * covering it.
 *
 * The public return type stays `void`, deliberately: a denial must not be
 * distinguishable from a not-found here (§3.1.5). The richer outcome is what the
 * outbox drain reads to dead-letter a rejected offline write (POD-316).
 */
function renameProcedure(): SessionStateProcedure<'sessions.rename'> {
  const def = sessionStateCommand(RENAME_NAME)
  if (!def) throw new Error(`renameProcedure: no contract named ${RENAME_NAME}`)
  return syncRoute({
    command: { name: RENAME_NAME, def },
    input: sessionStateInputs['sessions.rename'],
    run: async ({ submit }): Promise<void> => {
      const { reply, cause } = await submit()
      if (reply.outcome === 'applied') return
      if (cause !== undefined) throw cause
      if (reply.refusal.kind === 'invalid') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid command input' })
      }
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'command refused' })
    },
  }) as unknown as SessionStateProcedure<'sessions.rename'>
}

// ---------------------------------------------------------------------------
// Command plane
// ---------------------------------------------------------------------------

/*
 * LEGACY(remove-after: 2027-03): the command plane's per-command routes, kept for
 * the shipped clients that still call them (POD-6416; checked at v0.1.3, v0.2.0
 * and v0.2.1-edge.3). Removing one breaks that client's control. Each is an
 * adapter onto a registration, and its meta names that registration (POD-6601);
 * none acts on a daemon from inside the request. The plane's gate and the
 * route's old answer stay in the route:
 *  - stop, hibernate, resurrect: `records.session.edit` (`desired`), which the
 *    lifecycle controller acts on after the commit. kill:
 *    `records.session.remove`. (client-core's outbox kinds, an older CLI.)
 *  - create, resume: a `session.launch` effect record (the mobile app, the
 *    desktop web; resume only the v0.1.3 desktop web).
 *  - interrupt: a `session.interrupt` effect record (the mobile app, the web).
 *  - configure: a `session.configure` effect record (the web's model chip).
 *  - answerAskUserQuestion: a `session.answer` effect record (app builds
 *    before POD-6415).
 *  - continue, and the chat sends: their own registrations on `sync.submit`.
 *  - uploadImage: a plain registration (bytes to a held upload or a machine;
 *    no synced row).
 */

/**
 * WHAT EACH OLD PLANE ROUTE WRITES (POD-6601): the registration its handler
 * submits through `SessionCommandCtx`'s lifecycle edits. The route's meta names
 * it. A plane command that is neither here, a send, `continue` nor the plain
 * upload has no route and fails at module load.
 */
const PLANE_ROUTE_WRITES = {
  stop: 'records.session.edit',
  hibernate: 'records.session.edit',
  resurrect: 'records.session.edit',
  kill: 'records.session.remove',
  create: 'effects.create',
  resume: 'effects.create',
  interrupt: 'effects.create',
  configure: 'effects.create',
  answerAskUserQuestion: 'effects.create',
} as const satisfies Partial<Record<SessionCommandKey, string>>

/** The plane's writes on the plain path (`plain-family.ts`). */
const PLAIN_PLANE_COMMANDS: ReadonlySet<string> = new Set(['uploadImage'])

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
  const queuedSend = (QUEUED_SEND_COMMANDS as readonly string[]).includes(key)
  const onEntry = (IMMEDIATE_PLANE_COMMANDS as readonly string[]).includes(key)
  // THE CHAT SENDS ARE THIN ADAPTERS ONTO `sync.submit` (POD-6350), a send
  // carrying a wake choice (--model/--effort) included since POD-6415. So is
  // `continue` (POD-6416).
  if (queuedSend || onEntry) {
    return syncRoute({
      command: { name: `sessions.${key}`, def: sessionCommandPlane.defs[key] },
      input: schema,
    }) as unknown as PlaneProcedure<K>
  }
  if (PLAIN_PLANE_COMMANDS.has(key)) return plainRoute(`sessions.${key}`) as PlaneProcedure<K>
  const registration = (PLANE_ROUTE_WRITES as Partial<Record<SessionCommandKey, string>>)[key]
  if (registration === undefined) {
    throw new Error(`sessions.${key}: no registration serves this plane command's route`)
  }
  const built = syncRoute({
    command: { name: `sessions.${key}`, def: sessionCommandPlane.defs[key] },
    registration,
    input: schema,
    run: async ({ ctx, input }): Promise<unknown> =>
      await dispatchSessionCommand(
        await sessionCommandCtx(familyState(ctx).modules, ctx.capability, ctx.overrideScope),
        key,
        input,
      ),
  })
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
 * `sessions.handoff` (POD-642). The caller is the context's principal — never out
 * of `input`, whose schema carries no identity field at all (ADR 3 D7: payload
 * identity is inert, here by construction).
 *
 * A `session.handoff` effect record since POD-6422: the route creates it as its
 * caller and waits for it, so the move runs after commit, never inside this
 * request. The coordinator it runs still gates `use` on BOTH machines,
 * re-authorizes at two apply points and single-flights duplicate dispatch.
 * LEGACY(remove-after: 2027-03): the CLI and older apps call this route; the
 * apps now create the record themselves.
 */
function handoffProcedure(): HandoffProcedure {
  return syncRoute({
    command: sessionHandoffContract,
    registration: 'effects.create',
    input: sessionHandoffInput,
    run: async ({ ctx, input }): Promise<SessionHandoffOutput> => {
      try {
        return await handoffThroughEffect(familyState(ctx).modules, ctx.principal, input)
      } catch (error) {
        const refusal = handoffRefusalOf(error)
        if (!refusal) throw error
        throw new TRPCError({
          code: refusal === 'unauthorized' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
          message: error instanceof Error ? error.message : 'handoff refused',
          cause: error,
        })
      }
    },
  }) as unknown as HandoffProcedure
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
  /** tRPC router this procedure lives on (`sessions` · `snoozes`). */
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
    if (!listed.has(name) && !SUBMIT_ONLY_NAMES.has(name)) {
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
 * `router.ts` spreads these into its `sessions` / `snoozes`
 * routers alongside the family's QUERIES. The reads are deliberately NOT derived
 * here: they have no contracts yet, that is POD-311's remaining work, and this
 * issue's claim is about mutations. What matters is that a read cannot hide a write
 * — the audit checks procedure TYPE, not naming.
 */
export function sessionFamilyProcedures(): {
  sessions: PlaneProcedures & SessionStateProceduresOn<'sessions'> & { handoff: HandoffProcedure }
  snoozes: SessionStateProceduresOn<'snoozes'>
} {
  const grouped: Record<string, Record<string, unknown>> = {
    sessions: {},
    snoozes: {},
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
