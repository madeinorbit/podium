import { familyState } from '../derived-family'
/**
 * THE DERIVED SETTINGS SURFACE (POD-420) — `settings.setSecret`,
 * `settings.clearSecret`, the presence read and the Telegram ceremony, produced
 * from the joined table in `registry.ts` rather than written out in `router.ts`.
 * (The preference tiers are synced records written by generic edits: POD-6673,
 * POD-6677.)
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
 *    contract table's own note, so the exception is visible rather than assumed.
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

import { describeError } from '@podium/logger'
import type { UserId } from '@podium/model'
import { TRPCError, type TRPCMutationProcedure, type TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { type Context, type mods, t } from '../../trpc'
import {
  assertPlainContract,
  type PlainCommandRefusal,
  runPlainCommand,
} from '../plain-command/entry'
import { plainRefusalError } from '../plain-command/family'
import { type PlainContractRegistration, trpcRequest } from '../plain-command/registry'
import { plainRoute } from '../write-routes/plain'
import { redactErrorMessage } from './audit'
import {
  SECRET_SURFACE_ABSENT,
  type SettingsAuthzDeps,
  settingsAuthzDeps,
  settingsAuthzFailure,
} from './authz'
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

type SettingsProcedure<N extends SettingsCommandName> =
  IsRead<N> extends true
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
async function runSettingsCommand(
  name: SettingsCommandName,
  ctx: Context,
  input: unknown,
): Promise<unknown | Promise<unknown>> {
  // ONE `familyState(ctx).modules`, used for both the trail and the handler. Two calls would be
  // two `router-triple-access` sites where one is needed, and the audit
  // repository is deliberately NOT reached out of `familyState(ctx).store`:
  // it is a dependency of the SERVICE (`SettingsService.recordCommand`), so the
  // transport never touches the store.
  return await settingsCommandWith(
    name,
    await settingsAuthzDeps(ctx),
    familyState(ctx).modules.settings,
    input,
  )
}

/** The settings service as the gate, the handler and the trail use it. */
export type SettingsCommandService = ReturnType<typeof mods>['settings']

/** {@link runSettingsCommand} over resolved dependencies, without a request context. */
export async function settingsCommandWith(
  name: SettingsCommandName,
  deps: SettingsAuthzDeps,
  service: SettingsCommandService,
  input: unknown,
): Promise<unknown> {
  const record = async (outcome: 'applied' | 'refused', error?: string): Promise<void> => {
    await service.recordCommand({
      command: name,
      outcome,
      principal: deps.principal,
      input,
      ...(error !== undefined ? { error } : {}),
    })
  }

  const refusal = settingsAuthzFailure(name, deps)
  if (refusal) {
    await record('refused', refusal.message)
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
    await record('refused', message)
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
  const fail = async (e: unknown): Promise<never> => {
    // THE CHAIN IS WHAT GETS REDACTED, not just the outermost message
    // [POD-3824]. A settings handler that wraps a store or provider refusal left
    // the actual reason one `cause` down, and both the trail and the refused
    // client kept only the wrapper. Widening the string does NOT weaken the
    // backstop: `messageMentionsRedactedValue` is a substring scan over whatever
    // is about to leave, so a wider string is a wider scan — the material now
    // gets caught in a cause it was never inspected in before.
    const raw = describeError(e)
    const safe = redactErrorMessage(name, input, raw)
    await record('refused', safe)
    // RE-THROWN WITH THE REDACTED MESSAGE, not the original. This is the wire
    // half of the error path: a handler that built its message from the material
    // must not hand that message to a browser just because the trail was careful.
    // The pass-through arm keeps a TRPCError's authored message and code intact;
    // a backstop hit fails closed onto BAD_REQUEST, as it always did.
    throw e instanceof TRPCError && safe === raw
      ? e
      : new TRPCError({ code: 'BAD_REQUEST', message: safe })
  }

  let result: unknown
  try {
    result = run(service, input, actor)
  } catch (e) {
    return await fail(e)
  }
  if (result instanceof Promise) {
    return await result.then(
      async (value) => {
        await record('applied')
        return value
      },
      async (e) => await fail(e),
    )
  }
  await record('applied')
  return result
}

/**
 * THE PLAIN SETTINGS COMMANDS (ADR 12 D8, POD-6360): the secret pair, the presence
 * read and the Telegram ceremony. Their data is not synced, so they take the plain
 * path: the shared front door (coarse check, then parse), then the family's gate,
 * handler and trail inside the plain scope.
 *
 * Read off the contract rather than listed: a settings command a client may
 * queue (`offline-eligible`) would not be plain. None is left: both preference
 * tiers are synced records now.
 */
export const isPlainSettingsCommand = (name: SettingsCommandName): boolean =>
  SETTINGS_COMMANDS_TRPC[name].contract.delivery.class !== 'offline-eligible'

/**
 * A FRONT-DOOR REFUSAL IN THIS FAMILY'S TERMS. The family's own gate decides the
 * error when it refuses too; otherwise (an agent acting for an admin, say: the
 * human's role passes, the agent's capability does not) the refusal is FORBIDDEN,
 * except for the presence read, which refuses as absent for the reason
 * `authz.ts` gives: its subject is an existence fact.
 */
export function settingsFrontDoorRefusal(
  name: SettingsCommandName,
  deps: SettingsAuthzDeps | undefined,
): TRPCError {
  const own = deps === undefined ? undefined : settingsAuthzFailure(name, deps)
  if (own !== undefined) return own
  const { policy } = SETTINGS_COMMANDS_TRPC[name].contract
  if (policy.action === 'read' && policy.resource === 'secret') {
    return new TRPCError({ code: 'NOT_FOUND', message: SECRET_SURFACE_ABSENT })
  }
  return new TRPCError({ code: 'FORBIDDEN', message: `${name} is not permitted for this caller` })
}

/**
 * One plain settings command. A front-door refusal is recorded on the trail like
 * every other refusal. Its input is NOT: the coarse check runs before the parse,
 * so there is no parsed input whose redaction rule applies, and raw input stored
 * on a refusal is exactly where a secret leaks.
 *
 * The dependencies are resolved AFTER the coarse check, because resolving them
 * asks who the human is, which a principal the front door turns away (a system
 * principal) does not have. A refusal still gets its family-shaped error.
 */
export async function plainSettingsCommandWith(
  name: SettingsCommandName,
  principal: CommandPrincipal,
  resolve: () => Promise<{ deps: SettingsAuthzDeps; service: SettingsCommandService }>,
  rawInput: unknown,
): Promise<unknown> {
  const { contract } = SETTINGS_COMMANDS_TRPC[name]
  const reply = await runPlainCommand({
    contract,
    principal,
    transport: 'trpc',
    input: rawInput,
    run: async (input) => {
      const { deps, service } = await resolve()
      return await settingsCommandWith(name, deps, service, input)
    },
  })
  if (reply.outcome === 'applied') return reply.result
  return await settingsRefused(name, principal, resolve, reply.refusal)
}

/** A front-door refusal of a plain settings command, recorded on the trail (see
 *  {@link plainSettingsCommandWith}). */
async function settingsRefused(
  name: SettingsCommandName,
  principal: CommandPrincipal,
  resolve: () => Promise<{ deps: SettingsAuthzDeps; service: SettingsCommandService }>,
  refusal: PlainCommandRefusal,
): Promise<never> {
  const { contract } = SETTINGS_COMMANDS_TRPC[name]
  if (refusal.kind === 'invalid') throw plainRefusalError(contract, refusal)
  if (principal.kind === 'system') {
    // No human, so no trail principal and no role: the family's own refusal shape,
    // read off the contract alone.
    throw settingsFrontDoorRefusal(name, undefined)
  }
  const { deps, service } = await resolve()
  const error = settingsFrontDoorRefusal(name, deps)
  await service.recordCommand({
    command: name,
    outcome: 'refused',
    principal: deps.principal,
    input: {},
    error: error.message,
  })
  throw error
}

const settingsDepsOf = (ctx: Context) => async () => ({
  deps: await settingsAuthzDeps(ctx),
  service: familyState(ctx).modules.settings,
})

const isPlainSettingsWrite = (name: SettingsCommandName): boolean =>
  isPlainSettingsCommand(name) && SETTINGS_COMMANDS_TRPC[name].contract.policy.action !== 'read'

/**
 * The plain settings WRITES, registered in `plain-command/commands.ts`. The
 * presence read is served as a query on the same front door
 * ({@link plainSettingsCommandWith}); a read has no registration.
 */
export const SETTINGS_PLAIN_REGISTRATIONS: readonly PlainContractRegistration[] = (
  Object.keys(SETTINGS_COMMANDS_TRPC) as SettingsCommandName[]
)
  .filter(isPlainSettingsWrite)
  .map((name) => ({
    contract: SETTINGS_COMMANDS_TRPC[name].contract,
    handle: async (ctx, input, source) => {
      const { deps, service } = await settingsDepsOf(trpcRequest(ctx, source))()
      return await settingsCommandWith(name, deps, service, input)
    },
  }))

/** The input is parsed by the plain entry, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

function buildProcedure(name: SettingsCommandName): unknown {
  const { contract } = SETTINGS_COMMANDS_TRPC[name]
  if (isPlainSettingsWrite(name)) {
    return plainRoute(contract.name, {
      refused: async (refusal, { ctx }) =>
        await settingsRefused(name, ctx.principal, settingsDepsOf(ctx), refusal),
    })
  }
  if (contract.policy.action !== 'read') {
    throw new Error(`settings: ${name} is a write off the plain path`)
  }
  // A read: the plain presence read on the front door, or the family's own.
  if (isPlainSettingsCommand(name)) {
    assertPlainContract(contract)
    return t.procedure
      .input(unparsed)
      .query(
        async ({ ctx, input }): Promise<unknown> =>
          await plainSettingsCommandWith(name, ctx.principal, settingsDepsOf(ctx), input),
      )
  }
  return t.procedure
    .input(contract.input)
    .query(async ({ ctx, input }): Promise<unknown> => await runSettingsCommand(name, ctx, input))
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
