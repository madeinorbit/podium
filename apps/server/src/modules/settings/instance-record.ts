/**
 * THE INSTANCE PREFERENCES AS ONE SYNCED RECORD (POD-6677, ADR 12 D1; design
 * POD-5620 §1.5).
 *
 * The instance tier of the settings lives where it always did, in
 * `meta['settings']`. What changed is how it reaches a client: no request any
 * more, but one `instancePreferences` record on the feed, which every member of
 * the instance receives (`deployment-substrate`) and an app keeps offline.
 *
 *  - THE FEED CAPTURE. Every write of the settings blob hands the new blob to
 *    {@link makeInstancePreferencesFeedCapture} inside its own transaction
 *    (`SettingsRepository.setSettings`), so the record follows the row whoever
 *    moved it: an admin's edit, a deployment write (the update channel, the
 *    telemetry consent, the login policy, even from a plain command: the record
 *    is the blob's projection, a system write), the server's own telemetry
 *    identity. Inside a sync command the change carries that command's
 *    provenance. The Authority skips a value that did not change.
 *  - THE ADMIN'S EDITS. `records.instancePreferences.edit`: the leaves a patch
 *    names, through the settings service (its secret refusal, its value checks,
 *    `settings.changed` after commit); a cleared leaf resets to the default.
 *    Only an account whose role is admin-grade NOW may write it.
 *  - THE TRAIL. Every attempt is recorded in the settings audit trail, applied
 *    or refused, as `settings.updateInstance`'s were: an applied row commits
 *    with the write, so a replay (which runs nothing) records nothing; a gate
 *    refusal is recorded before any unit opens, a handler refusal after its
 *    unit rolled back.
 *  - BOOT TRUTH ({@link reconcileInstancePreferences}): the stored blob onto the
 *    log, so a device's first bootstrap holds it. Rolling back needs no data
 *    step: the blob is unchanged in shape, and an older build ignores this
 *    kind's log rows (it parses them as an unknown kind and advances).
 */

import { INSTANCE_PREFERENCES_RECORD } from '@podium/commands'
import { describeError } from '@podium/logger'
import {
  INSTANCE_PREFERENCES_ROW_ID,
  instancePreferencesRecordOf,
  isAdminGrade,
  type UserId,
  type UserRole,
} from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import type { EntityChangeSpec, LedgerWriter } from '@podium/sync'
import { z } from 'zod'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { asSystemWrite } from '../../plain-command-scope'
import type { SessionStore } from '../../store'
import type { InstancePreferencesFeedCapture } from '../../store/settings'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry } from '../sync-write/registry'
import { INSTANCE_PREFERENCES_EDIT, redactErrorMessage } from './audit'
import { SettingsPatchRefused, type SettingsService } from './service'

/** The record's change entry: the instance's leaves, whole (the log stores whole rows). */
export function instancePreferencesChangeOf(settings: PodiumSettings): EntityChangeSpec {
  return {
    entity: 'instancePreferences',
    id: INSTANCE_PREFERENCES_ROW_ID,
    op: 'upsert',
    value: instancePreferencesRecordOf(settings),
  }
}

/** The capture installed on the repository: the record of each blob it writes. */
export function makeInstancePreferencesFeedCapture(
  ledger: Pick<LedgerWriter, 'capture'>,
): InstancePreferencesFeedCapture {
  // A SYSTEM WRITE (ADR 12 D2), as the machine display projection is: the
  // record is the server's own derivation of the stored blob, republished
  // whenever the blob changes, so it is allowed when a plain command's work
  // writes the blob (`setup.setChannel`, `telemetry.set`, the login policy's
  // open mode). Inside a sync command the change keeps that command's
  // provenance, which is a separate context.
  return async (settings) => {
    await asSystemWrite(async () => await ledger.capture([instancePreferencesChangeOf(settings)]))
  }
}

/** What the boot reconcile appends through: the boot's `server` writer. */
export interface InstancePreferencesReconcileWriter {
  reconcile(
    entity: Parameters<LedgerWriter['reconcile']>[0],
    rows: { id: string; value: unknown }[],
  ): Promise<unknown>
}

/** The stored instance settings onto the log: the back-fill, and every boot's truth. */
export async function reconcileInstancePreferences(
  writer: InstancePreferencesReconcileWriter,
  store: Pick<SessionStore, 'settings'>,
): Promise<void> {
  const settings = await store.settings.getSettings()
  await writer.reconcile('instancePreferences', [
    { id: INSTANCE_PREFERENCES_ROW_ID, value: instancePreferencesRecordOf(settings) },
  ])
}

export interface InstancePreferencesRecordDeps {
  readonly settings: () => Pick<SettingsService, 'updatePreferences' | 'recordCommand'>
  /** The account's role NOW, never a snapshot (ADR 3 D16); undefined when disabled. */
  readonly roleOf: (user: UserId) => Promise<UserRole | undefined>
}

/** The human a principal writes for, or undefined (a system principal, none). */
function humanOf(principal: CommandPrincipal): UserId | undefined {
  if (principal.kind === 'system') return undefined
  return onBehalfOfUser(principal) ?? undefined
}

/** Whether the service refused the patch itself, rather than failing to write it. */
const isDefinitive = (error: unknown): boolean =>
  error instanceof SettingsPatchRefused || error instanceof z.ZodError

const REFUSED = 'the instance settings are written by an admin'

export function registerInstancePreferencesRecord(
  registry: SyncWriteRegistry,
  deps: InstancePreferencesRecordDeps,
): void {
  const audit = async (
    principal: CommandPrincipal,
    input: unknown,
    outcome: 'applied' | 'refused',
    error?: string,
  ) =>
    await deps.settings().recordCommand({
      command: INSTANCE_PREFERENCES_EDIT,
      outcome,
      principal,
      input,
      ...(error !== undefined ? { error } : {}),
    })

  registerRecordKind(registry, INSTANCE_PREFERENCES_RECORD, {
    target: async (_op, id, { principal }, edited) => {
      if (id !== INSTANCE_PREFERENCES_ROW_ID) return undefined
      // The live gate: an admin-grade account NOW. Read before dedup, so a
      // replay from an account demoted since is refused too.
      const human = humanOf(principal)
      const role = human === undefined ? undefined : await deps.roleOf(human)
      if (role !== undefined && isAdminGrade(role)) return NO_TARGET
      await audit(
        principal,
        { id, patch: edited?.patch ?? {}, unset: edited?.unset ?? [] },
        'refused',
        REFUSED,
      )
      return undefined
    },
    edit: async (ctx, id, patch, _expected, unset) => {
      if (id !== INSTANCE_PREFERENCES_ROW_ID)
        throw new SyncWriteRefused({ kind: 'target-not-found' })
      const human = humanOf(ctx.principal)
      if (human === undefined) throw new Error('records.instancePreferences.edit without a human')
      // A cleared leaf is `undefined` in the service's patch: the blob's leaf
      // goes and resolves to its default again (a reset is a write).
      const values: Record<string, unknown> = {}
      for (const [path, value] of Object.entries(patch)) {
        if (value !== undefined) values[path] = value
      }
      for (const path of unset) values[path] = undefined
      if (Object.keys(values).length === 0) return { ok: true }
      const input = { id, patch, unset }
      try {
        // The service commits the blob through this command's writer; the
        // blob's own feed capture publishes the record inside that unit, under
        // this command's provenance.
        await deps.settings().updatePreferences(human, values, ctx.ledger)
      } catch (error) {
        if (isDefinitive(error)) {
          // Redacted by the rule the trail uses, so no secret leaves in it.
          const message = redactErrorMessage(INSTANCE_PREFERENCES_EDIT, input, describeError(error))
          throw new SyncWriteRefused({ kind: 'invalid', message }, { cause: error })
        }
        throw error
      }
      await audit(ctx.principal, input, 'applied')
      return { ok: true }
    },
    // A refused or failed edit rolled its unit back, the trail row with it: the
    // refusal is recorded here, outside it, its message redacted.
    editRolledBack: async ({ principal }, id, edited, error) => {
      const cause = error instanceof SyncWriteRefused ? (error.cause ?? error) : error
      const input = { id, patch: edited.patch, unset: edited.unset }
      await audit(
        principal,
        input,
        'refused',
        redactErrorMessage(INSTANCE_PREFERENCES_EDIT, input, describeError(cause)),
      )
    },
  })
}
