/** Settings writes use the declared command plan and the synced record writers.
 * Each control submits its changed leaves; Undo applies only their old values
 * against the live records, preserving changes made elsewhere. */

import {
  applySettingsPatch,
  changedSettingsLeaves,
  decodeSettingsPreferencePatch,
  planSettingsWrite,
  type SettingsWriteRefusal,
} from '@podium/commands/settings-write-plan'
import type { PodiumSettings } from '@podium/runtime'
import type { Trpc } from '@/app/trpc'

export interface SaveSettingsResult {
  /** The settings after the commands that could be issued. */
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

/** Issue the commands an edit requires, reporting any refused leaves. */
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

/** One line for a refused row. Names the fields, because a refusal a user cannot
 *  act on is a failure surfaced as a shrug. */
export function refusalMessage(refusals: readonly SettingsWriteRefusal[]): string | null {
  if (refusals.length === 0) return null
  const offline = refusals.filter((r) => r.reason === 'requires-connection')
  if (offline.length === refusals.length) {
    return `Not saved while offline: ${offline.map((r) => r.path).join(', ')} — server-owned secrets are never queued.`
  }
  return `Not saved: ${refusals.map((r) => r.path).join(', ')}.`
}

export type SettingsWriters = Parameters<typeof saveSettingsAsCommands>[3]

/** A single interaction, captured before its write. No settings are staged.
 * The inverse contains only touched leaves, never an old settings group. */
export function settingsChange(previous: PodiumSettings, patch: Partial<PodiumSettings>) {
  const leaves = changedSettingsLeaves(previous, { ...previous, ...patch })
  const values = Object.fromEntries(leaves.map(({ path, value }) => [path, value]))
  const before = Object.fromEntries(leaves.map(({ path }) => [path, settingsValue(previous, path)]))
  return {
    paths: leaves.map(({ path }) => path),
    async save(
      trpc: Trpc,
      read: () => PodiumSettings,
      writers: SettingsWriters,
      permitted: Readonly<Record<string, boolean>>,
    ): Promise<() => Promise<void>> {
      const write = async (patch: Readonly<Record<string, unknown>>) => {
        const live = read()
        const next = applySettingsPatch(live, patch)
        const plan = planSettingsWrite(live, next, { online: writers?.online ?? browserIsOnline() })
        for (const intent of plan.intents) {
          if (permitted[intent.command] !== true)
            throw new Error('You do not have permission to change this setting.')
        }
        const result = await saveSettingsAsCommands(trpc, live, next, writers)
        if (result.refusals.length) {
          throw new Error(refusalMessage(result.refusals) ?? result.refusals[0]!.message)
        }
      }
      await write(values)
      return () => write(before)
    },
  }
}

function settingsValue(settings: PodiumSettings, path: string): unknown {
  let value: unknown = settings
  for (const key of path.split('.')) {
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  }
  return value
}
