/**
 * `settings.updatePersonal` ON THE SYNC WRITE ENTRY POINT (POD-6350, ADR 12 D2).
 *
 * The one settings command the apps queue. The entry point gives it the dedup
 * it never had; this registration keeps the family's two rules:
 *
 *  - THE LIVE GATE (`authz.ts`): the contract's role floor against the account's
 *    role now, and a human the preference belongs to. In the target resolver,
 *    so a replay from a principal demoted since is refused before dedup.
 *  - THE TRAIL (POD-421): every attempt is recorded, applied or refused, with its
 *    input redacted. An applied write records inside the unit of work, so the
 *    trail row commits with the write and a replay (which runs nothing) records
 *    nothing. A refusal records OUTSIDE it: a gate refusal before any unit opens,
 *    a handler refusal after the unit rolled back (`rolledBack`).
 *
 * A patch the service refuses for what it is (a secret in a preference patch, a
 * value the settings schema rejects) is a definitive `invalid` refusal. Anything
 * else propagates, and the outbox retries it.
 */

import { SETTINGS_CONTRACTS } from '@podium/commands'
import { describeError } from '@podium/logger'
import type { UserId, UserRole } from '@podium/model'
import { z } from 'zod'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry } from '../sync-write/registry'
import { redactErrorMessage } from './audit'
import { settingsAuthzFailure } from './authz'
import { SettingsPatchRefused, type SettingsService } from './service'

const NAME = 'settings.updatePersonal'
const contract = SETTINGS_CONTRACTS[NAME]

export interface SettingsSyncWriteDeps {
  settings(): Pick<SettingsService, 'updatePreferences' | 'recordCommand'>
  /** The account's role NOW, never a snapshot (ADR 3 D16). */
  roleOf(user: UserId): Promise<UserRole | undefined>
}

/** The family's refusal for a principal, or undefined to proceed. Exported for
 *  the old route, which answers with this same error. */
export async function updatePersonalRefusal(
  deps: Pick<SettingsSyncWriteDeps, 'roleOf'>,
  principal: CommandPrincipal,
): Promise<{ message: string; error: Error } | undefined> {
  const actor = onBehalfOfUser(principal)
  const role = actor === null ? undefined : await deps.roleOf(actor)
  const refusal = settingsAuthzFailure(NAME, { principal, role })
  if (refusal) return { message: refusal.message, error: refusal }
  if (actor === null) {
    const message = `${NAME} writes on behalf of a user, and this principal has none`
    return { message, error: new Error(message) }
  }
  return undefined
}

/** Whether the service refused the patch itself, rather than failing to write it. */
const isDefinitive = (error: unknown): boolean =>
  error instanceof SettingsPatchRefused || error instanceof z.ZodError

export function registerSettingsCommands(
  registry: SyncWriteRegistry,
  deps: SettingsSyncWriteDeps,
): void {
  const record = async (
    principal: CommandPrincipal,
    input: unknown,
    outcome: 'applied' | 'refused',
    error?: string,
  ) =>
    await deps.settings().recordCommand({
      command: NAME,
      outcome,
      principal,
      input,
      ...(error !== undefined ? { error } : {}),
    })

  registry.register({
    contract,
    target: async (input, { principal }) => {
      const refusal = await updatePersonalRefusal(deps, principal)
      if (refusal === undefined) return NO_TARGET
      await record(principal, input, 'refused', refusal.message)
      return undefined
    },
    handle: async (ctx, input) => {
      const actor = onBehalfOfUser(ctx.principal)
      if (actor === null) throw new Error(`${NAME} reached its handler without a human`)
      let next: Awaited<ReturnType<SettingsService['updatePreferences']>>
      try {
        next = await deps.settings().updatePreferences(actor, input.values)
      } catch (error) {
        if (isDefinitive(error)) throw new SyncWriteRefused({ kind: 'invalid' }, { cause: error })
        throw error
      }
      await record(ctx.principal, input, 'applied')
      return next
    },
    rolledBack: async ({ principal }, input, error) => {
      const cause = error instanceof SyncWriteRefused ? error.cause : error
      await record(
        principal,
        input,
        'refused',
        redactErrorMessage(NAME, input, describeError(cause)),
      )
    },
  })
}
