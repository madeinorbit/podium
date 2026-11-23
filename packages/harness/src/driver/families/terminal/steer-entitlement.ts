/**
 * THE TUIS `generic-pty` MAY DECLINE STEER FOR (POD-5855). Every terminal
 * harness shares that one driver id, and whether a TUI takes a prompt entered
 * mid-turn into its own queue is a per-harness measurement
 * (`runtime.terminal.queuesBusyInput`). These are the ones nobody has measured
 * doing so: Cursor cannot run past the submit against a fake model, and Pi was
 * not installed for the POD-4834 runs. Antigravity has no measured mid-turn
 * queue yet. `fake-harness` is the corpus's own synthetic TUI, which models
 * no mid-turn queue.
 */
export const NO_NATIVE_STEER_TERMINAL_HARNESSES = [
  'cursor',
  'pi',
  'antigravity',
  'fake-harness',
] as const

/** A measured terminal entitlement, not a default for another TUI. */
export function terminalMayDeclineNativeSteer(harness: string): boolean {
  return (NO_NATIVE_STEER_TERMINAL_HARNESSES as readonly string[]).includes(harness)
}
