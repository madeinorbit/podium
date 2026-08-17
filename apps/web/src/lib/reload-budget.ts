/**
 * THE GUARD'S HARD RELOAD, RECORDED SO IT CAN BE EXPLAINED (POD-2102).
 *
 * The wire-version guard (`features/setup/version-guard.ts`) may hard-reload a
 * tab twice before it gives up. That budget is the corruption backstop and it
 * stays — but when it is spent, someone has just watched their app reload
 * itself twice and been told nothing, and the sentence they are owed belongs in
 * the update panel (spec §6.2.3), which is the surface that knows what the
 * update is doing.
 *
 * WHY IT LIVES IN `lib/` AND NOT IN EITHER FEATURE: the writer is
 * `features/setup` and the reader is `features/updates`, and a feature may not
 * import another feature (features/README.md). This is the shared layer under
 * them both, which is exactly what it is for.
 *
 * sessionStorage rather than a module variable, for the obvious reason: the
 * fact has to survive the very reload it describes.
 */

const RELOAD_BUDGET_KEY = 'podium.update.reload-budget-spent'

/** The sentence the panel shows once the guard has spent its budget. */
export const RELOAD_BUDGET_SENTENCE =
  'Podium reloaded this page automatically to match the server and it did not help, ' +
  'so the app you are looking at may be an older build than the server is serving.'

export function noteReloadBudgetSpent(): void {
  try {
    globalThis.sessionStorage?.setItem(RELOAD_BUDGET_KEY, '1')
  } catch {
    // Private mode: the explanation is a nicety, never a dependency.
  }
}

export function reloadBudgetSpent(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(RELOAD_BUDGET_KEY) === '1'
  } catch {
    return false
  }
}

export function clearReloadBudgetNote(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_BUDGET_KEY)
  } catch {
    // ignore — nothing to clear if storage is unavailable
  }
}
