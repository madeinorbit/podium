/**
 * THE DERIVED SETTINGS WRITE SURFACE (POD-420) — `settings.updatePersonal`,
 * `settings.updateInstance`, `settings.setSecret` and `settings.clearSecret`,
 * produced from the joined table in `registry.ts` rather than written out in
 * `router.ts`.
 *
 * `router.ts` spreads the result into its `settings` router alongside the
 * procedures this issue does NOT migrate:
 *
 *  - `get` — a READ. It carries no contract because a `visibility` class
 *    describes what a command WRITES, and what this read RETURNS is about to
 *    change shape twice (POD-419's scrub, POD-421's presence projection).
 *  - `set` — the legacy blob write, kept because the sidebar, the auto-continue
 *    dialog and the engine still call it, and now refusing a secret change
 *    (`SettingsService.assertNoSecretChange`). Retiring it belongs with the
 *    client scrub that stops the blob carrying secrets at all.
 *  - `telegramSetupStart` / `telegramSetupPoll` — a stateful pairing ceremony
 *    over a third-party API, not a settings write with a payload. Named in the
 *    contract table's own note and counted by `scripts/audit-settings-commands.ts`
 *    as the two hand-written writes this family still allows, so the exception
 *    is visible rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * MEMBERSHIP IS READ OFF THE TABLE, IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * A procedure appears here if and only if its contract declares `trpc` (ADR 3
 * D3, default-closed). {@link assertSurfaceMatchesContracts} checks that at
 * module load against the object that will actually be SERVED, in both
 * directions — a contract declaring `trpc` that produced no procedure, and a
 * procedure whose contract does not declare `trpc`, both throw before the server
 * answers a request.
 *
 * The second direction is not symmetry for its own sake: without it an EMPTY
 * surface satisfies every claim this file makes (POD-732 — "an empty router
 * satisfies every absence claim perfectly"). The first loop reads `built`, so an
 * empty object FAILS it.
 */

import type { UserId } from '@podium/model'
import { TRPCError, type TRPCMutationProcedure, type TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, mods, t } from '../../trpc'
import { redactErrorMessage } from './audit'
import { onBehalfOfUser } from '../../command-principal'
import { settingsAuthzDeps, settingsAuthzFailure } from './authz'
import {
  isSettingsCommandExposedOn,
  SETTINGS_COMMANDS_TRPC,
  type SettingsCommandName,
  settingsCommandsOn,
  settingsProcKey,
} from './registry'

/**
 * A READ is served as a QUERY, DERIVED from `policy.action` (POD-421).
 *
 * `settings.secretPresence` is the family's one contracted read. Serving it as a
 * mutation would work on the wire and would be a lie in the router: tRPC's
 * query/mutation split is what decides cacheability, prefetch and retry
 * behaviour on the client, and a read declared as a mutation is a read the
 * client will never treat as one. Reading `action` off the contract means the
 * eighth command lands on the right arm without anybody choosing.
 */
type IsRead<N extends SettingsCommandName> =
  (typeof SETTINGS_COMMANDS_TRPC)[N]['contract']['policy']['action'] extends 'read' ? true : false

type SettingsProcedure<N extends SettingsCommandName> = IsRead<N> extends true
  ? TRPCQueryProcedure<{
      meta: unknown
      input: z.input<(typeof SETTINGS_COMMANDS_TRPC)[N]['contract']['input']>
      output: Awaited<ReturnType<(typeof SETTINGS_COMMANDS_TRPC)[N]['handler']>>
    }>
  : TRPCMutationProcedure<{
      meta: unknown
      input: z.input<(typeof SETTINGS_COMMANDS_TRPC)[N]['contract']['input']>
      output: Awaited<ReturnType<(typeof SETTINGS_COMMANDS_TRPC)[N]['handler']>>
    }>

/**
 * Every derived procedure, keyed by the PROC name the router serves it under —
 * a mapped type over the table, so a fifth settings write appears here without
 * anyone editing this declaration.
 */
export type SettingsProcedures = {
  [N in SettingsCommandName as N extends `settings.${infer P}` ? P : N]: SettingsProcedure<N>
}

/**
 * THE GATE, THE HANDLER AND THE TRAIL, in that order, for every settings
 * command (POD-421).
 *
 * The order is the decision:
 *
 *   1. **Authorize**, from the contract's own `roleFloor`. Before the handler,
 *      so a principal below the floor never reaches code that could have a side
 *      effect, and never learns anything from how far it got.
 *   2. **Run**.
 *   3. **Record**, whichever way it went. A refusal is an audit fact — a trail
 *      of successes cannot answer "who TRIED to rotate this key" — and the
 *      refused input is redacted by the SAME rule as the applied one, because
 *      logging raw input on the failure path is the classic way the error path
 *      keeps the material the success path was careful about.
 *
 * The record is written for a THROWN handler too, not only for a gate refusal:
 * `assertNoSecretChange` and every model-level validation refuse inside the
 * handler, and those are the refusals an operator most wants to see.
 */
function runSettingsCommand(
  name: SettingsCommandName,
  ctx: Context,
  input: unknown,
): unknown | Promise<unknown> {
  const deps = settingsAuthzDeps(ctx)
  // ONE `mods(ctx)`, used for both the trail and the handler. Two calls would be
  // two `router-triple-access` sites where one is needed, and the audit
  // repository is deliberately NOT reached out of `ctx.registry.sessionStore`:
  // it is a dependency of the SERVICE (`SettingsService.recordCommand`), so the
  // transport never touches the store.
  const service = mods(ctx).settings
  const record = (outcome: 'applied' | 'refused', error?: string): void => {
    service.recordCommand({
      command: name,
      outcome,
      principal: deps.principal,
      input,
      ...(error !== undefined ? { error } : {}),
    })
  }

  const refusal = settingsAuthzFailure(name, deps)
  if (refusal) {
    record('refused', refusal.message)
    throw refusal
  }

  // WHO THE WRITE BELONGS TO (POD-1213). A personal preference lands on this
  // user's row, so a principal with no human behind it may not write one: a
  // SYSTEM principal answers `null` here and is REFUSED rather than defaulted to
  // the first admin. That is §3.1.6 S4's rule ("unknown must fail closed, never
  // fall back to an operator identity") at the one seam where a settings write
  // acquires an owner — and it is refused HERE, before the handler, so the
  // refusal is recorded by the same trail as every other.
  const actor = onBehalfOfUser(deps.principal)
  if (actor === null) {
    const message = `${name} writes on behalf of a user, and this principal has none`
    record('refused', message)
    throw new TRPCError({ code: 'FORBIDDEN', message })
  }

  const { handler } = SETTINGS_COMMANDS_TRPC[name]
  // The table is heterogeneous, so at THIS point the parsed input is the union
  // of all schemas and TypeScript cannot pair it with the handler. It does not
  // need to: each pairing is checked where it is declared (the table is
  // `satisfies Record<SettingsContractName, SettingsCommand>` and each handler
  // carries a `satisfies SettingsHandler<…>` over its own contract's inferred
  // input), and `SettingsProcedures` re-derives the per-command types for the
  // client. This erasure is the one place the two meet.
  const run = handler as (svc: typeof service, input: unknown, actor: UserId) => unknown

  // A handler may be sync or async, and BOTH must be recorded. Awaiting a
  // synchronous result would make every settings write a microtask later than it
  // is today; not awaiting an async one would record `applied` for a command
  // that is about to reject. `Promise.resolve`-free branch on the actual result.
  const fail = (e: unknown): never => {
    const raw = e instanceof Error ? e.message : String(e)
    const safe = redactErrorMessage(name, input, raw)
    record('refused', safe)
    // RE-THROWN WITH THE REDACTED MESSAGE, not the original. This is the wire
    // half of the error path: a handler that built its message from the material
    // must not hand that message to a browser just because the trail was careful.
    throw e instanceof TRPCError && safe === raw
      ? e
      : new TRPCError({ code: 'BAD_REQUEST', message: safe })
  }

  let result: unknown
  try {
    result = run(service, input, actor)
  } catch (e) {
    return fail(e)
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        record('applied')
        return value
      },
      (e) => fail(e),
    )
  }
  record('applied')
  return result
}

function buildProcedure(name: SettingsCommandName): unknown {
  const { contract } = SETTINGS_COMMANDS_TRPC[name]
  const proc = t.procedure.input(contract.input)
  const call = ({ ctx, input }: { ctx: Context; input: unknown }): unknown =>
    runSettingsCommand(name, ctx, input)
  // Derived from the contract, never chosen here — see `IsRead` above.
  return contract.policy.action === 'read' ? proc.query(call) : proc.mutation(call)
}

/** The both-directions exposure check, against the object that will be served. */
function assertSurfaceMatchesContracts(built: Record<string, unknown>): void {
  for (const name of Object.keys(SETTINGS_COMMANDS_TRPC) as SettingsCommandName[]) {
    const present = built[settingsProcKey(name)] !== undefined
    if (isSettingsCommandExposedOn(name, 'trpc') && !present) {
      throw new Error(
        `settings contract ${name} declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!isSettingsCommandExposedOn(name, 'trpc') && present) {
      throw new Error(
        `the derived router serves ${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
}

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `settings` router. */
export function settingsFamilyProcedures(): SettingsProcedures {
  const built: Record<string, unknown> = {}
  for (const name of settingsCommandsOn('trpc')) built[settingsProcKey(name)] = buildProcedure(name)
  assertSurfaceMatchesContracts(built)
  return built as unknown as SettingsProcedures
}
