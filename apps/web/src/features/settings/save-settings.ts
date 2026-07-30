/**
 * SAVING SETTINGS AS COMMANDS (POD-420) — the client half of the split.
 *
 * The Save button used to send the whole blob to one mutation. It now asks
 * `planSettingsWrite` which COMMANDS the edit requires and issues those, which
 * is what makes the acceptance criterion true where a user can see it: an
 * offline attempt to write a secret is refused, with the refusal surfaced in the
 * save bar, while the preferences in the same save still go through.
 *
 * WHY THE DECISION IS NOT MADE HERE. The planner is a pure L1 function over the
 * contract table, so this module contains no rule of its own — no list of
 * secret-looking keys, no "if offline then". It issues what it is given and
 * reports what it was refused. That matters because a component is the worst
 * possible home for an authorization rule: it is invisible to every gate, it is
 * duplicated by the next platform, and it is the layer a user can skip.
 *
 * THE SERVER DOES NOT TRUST ANY OF THIS. `settings.set` refuses a secret change
 * on its own (`SettingsService.assertNoSecretChange`), and the secret commands
 * are online-sensitive by contract. This path exists so the refusal is
 * EXPLAINED rather than experienced as a failed request.
 */

import { applySettingsPatch, planSettingsWrite, type SettingsWriteRefusal } from '@podium/commands'
import type { PodiumSettings } from '@podium/runtime'
import type { Trpc } from '@/app/trpc'

export interface SaveSettingsResult {
  /** The blob as the server now holds it, for the "last saved" baseline. Equal
   *  to `previous` when nothing could be issued. */
  readonly saved: PodiumSettings
  /** What could not be written, and why. Empty on a clean save. */
  readonly refusals: readonly SettingsWriteRefusal[]
}

/** `navigator.onLine` when the browser has an opinion; optimistic elsewhere —
 *  the same reading `@podium/client-core`'s outbox takes, so the two do not
 *  disagree about what "offline" means. */
export function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Issue the commands an edit requires, and report what was refused.
 *
 * PREFERENCES FIRST, then secrets: a preference command returns the whole
 * settings blob, so running them first gives a server-confirmed baseline that
 * the applied secret values are then folded into. The other order would return
 * a baseline that predates the secret writes and leave the form permanently
 * dirty.
 *
 * A PARTIAL SAVE IS A REAL OUTCOME and is not an error: when a secret is refused
 * offline, the preferences in the same save are still written, and the refused
 * field stays dirty — which is correct, because it is genuinely unsaved. The
 * user's typed value is deliberately NOT discarded and NOT re-fetched over.
 */
export async function saveSettingsAsCommands(
  trpc: Trpc,
  previous: PodiumSettings,
  next: PodiumSettings,
  options: { online: boolean } = { online: browserIsOnline() },
): Promise<SaveSettingsResult> {
  const plan = planSettingsWrite(previous, next, { online: options.online })
  let confirmed = previous
  const appliedSecrets: Record<string, unknown> = {}

  for (const intent of plan.intents) {
    if (intent.kind !== 'preference') continue
    confirmed =
      intent.command === 'settings.updatePersonal'
        ? await trpc.settings.updatePersonal.mutate({ values: intent.values })
        : await trpc.settings.updateInstance.mutate({ values: intent.values })
  }

  for (const intent of plan.intents) {
    if (intent.kind !== 'secret') continue
    if (intent.command === 'settings.setSecret' && intent.value !== undefined) {
      await trpc.settings.setSecret.mutate({ key: intent.key, value: intent.value })
      appliedSecrets[intent.key] = intent.value
    } else {
      await trpc.settings.clearSecret.mutate({ key: intent.key })
      appliedSecrets[intent.key] = ''
    }
  }

  return {
    // The secret commands answer with a PRESENCE projection and never with the
    // material, so the local baseline is brought forward from what was sent —
    // the one place the client knows a value the server will never repeat.
    saved: applySettingsPatch(confirmed, appliedSecrets),
    refusals: plan.refusals,
  }
}

/** One line for the save bar. Names the fields, because a refusal a user cannot
 *  act on is a failure surfaced as a shrug. */
export function refusalMessage(refusals: readonly SettingsWriteRefusal[]): string | null {
  if (refusals.length === 0) return null
  const offline = refusals.filter((r) => r.reason === 'requires-connection')
  if (offline.length === refusals.length) {
    return `Not saved while offline: ${offline.map((r) => r.path).join(', ')} — server-owned secrets are never queued.`
  }
  return `Not saved: ${refusals.map((r) => r.path).join(', ')}.`
}
