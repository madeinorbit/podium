import { LAST_LAUNCH_PICK_KEY, type UiState } from './ui-state'

export type LaunchPick = { model: string; effort: string }
export type LaunchPickContext = { machineId: string; harness: string }
export type LastLaunchPicks = Record<string, Record<string, LaunchPick>>

const AUTO_PICK: LaunchPick = { model: 'auto', effort: 'auto' }

/** Plain preferences only: no sessions, transcripts, or harness integration. */
export function readLastLaunchPicks(raw: string | null): LastLaunchPicks {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([machineId, harnesses]) => {
      if (!harnesses || typeof harnesses !== 'object' || Array.isArray(harnesses)) return []
      const pairs = Object.entries(harnesses).flatMap(([harness, pick]) => {
        if (!pick || typeof pick !== 'object' ||
          typeof pick.model !== 'string' || !pick.model ||
          typeof pick.effort !== 'string' || !pick.effort) return []
        return [[harness, { model: pick.model, effort: pick.effort }]]
      })
      return [[machineId, Object.fromEntries(pairs)]]
    }))
  } catch {
    return {}
  }
}

export function lastLaunchPick(picks: LastLaunchPicks, context: LaunchPickContext): LaunchPick {
  return picks[context.machineId]?.[context.harness] ?? AUTO_PICK
}

/** Call only from the two new-work forms' launch handlers, including for Auto. */
export function rememberLaunchPick(
  ui: Pick<UiState, 'get' | 'set'>,
  context: LaunchPickContext,
  pick: LaunchPick,
): void {
  const picks = readLastLaunchPicks(ui.get(LAST_LAUNCH_PICK_KEY))
  ui.set(LAST_LAUNCH_PICK_KEY, JSON.stringify({
    ...picks,
    [context.machineId]: {
      ...picks[context.machineId],
      [context.harness]: { model: pick.model, effort: pick.effort },
    },
  }))
}

/** A saved draft wins on open, including an explicitly selected Auto pair.
 * Context changes restore both pills; the caller validates the machine's list AFTER this. */
export function draftForLaunchContext<T extends LaunchPick & { launchPickTouched?: boolean }>(
  draft: T,
  previous: LaunchPickContext | undefined,
  context: LaunchPickContext,
  picks: LastLaunchPicks,
): T {
  const changed = previous !== undefined &&
    (previous.machineId !== context.machineId || previous.harness !== context.harness)
  const ownPick = draft.launchPickTouched || draft.model !== 'auto' || draft.effort !== 'auto'
  if (!changed && ownPick) return draft
  const pick = lastLaunchPick(picks, context)
  return { ...draft, ...pick, launchPickTouched: false }
}
