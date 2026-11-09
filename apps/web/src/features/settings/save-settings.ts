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

import {
  applySettingsPatch,
  decodeSettingsPreferencePatch,
  planSettingsWrite,
  type SettingsWriteRefusal,
} from '@podium/commands/settings-write-plan'
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
 * PREFERENCES FIRST, then secrets: both preference tiers are synced records
 * (my `userPreferences`, the instance's `instancePreferences`), queued and shown
 * at once, so their leaves form the baseline the applied secret values are then
 * folded into. The other order would leave the form permanently dirty.
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
  options: {
    online?: boolean
    /** My personal leaves, as an edit of my `userPreferences` record
     *  (POD-6673): queued, shown at once, on every device of mine. A leaf
     *  set to `undefined` resets it. */
    personal?: (values: Readonly<Record<string, unknown>>) => Promise<void>
    /** The instance leaves, as an edit of the one `instancePreferences` record
     *  (POD-6677): queued, shown at once, on every member's devices. A leaf set
     *  to `undefined` resets it. Admins only; the server refuses anyone else. */
    instance?: (values: Readonly<Record<string, unknown>>) => Promise<void>
  } = {},
): Promise<SaveSettingsResult> {
  const plan = planSettingsWrite(previous, next, { online: options.online ?? browserIsOnline() })
  let confirmed = previous
  const appliedSecrets: Record<string, unknown> = {}

  for (const intent of plan.intents) {
    if (intent.kind !== 'preference') continue
    const personal = intent.command === 'records.userPreferences.edit'
    // A cleared leaf (`null` on the plan's wire) is a reset of the record's leaf.
    // On the instance tier a `null` is a real value on some leaves (load
    // pressure off, no idle-session cap), so only the declared clear paths reset.
    const values = personal
      ? Object.fromEntries(
          Object.entries(intent.values).map(([path, value]) => [path, value ?? undefined]),
        )
      : decodeSettingsPreferencePatch(intent.values)
    const write = personal ? options.personal : options.instance
    if (write === undefined) throw new Error(`saving settings needs the ${intent.command} writer`)
    await write(values)
    confirmed = applySettingsPatch(confirmed, values)
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
