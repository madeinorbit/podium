/** Resolved settings handler and audit trail, shared without route construction. */
import { describeError } from '@podium/logger'
import type { UserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { onBehalfOfUser } from '../../command-principal'
import type { mods } from '../../trpc'
import { redactErrorMessage } from './audit'
import { type SettingsAuthzDeps, settingsAuthzFailure } from './authz'
import { SETTINGS_COMMANDS_TRPC, type SettingsCommandName } from './registry'

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
