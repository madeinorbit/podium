import { createLogger } from '@podium/logger'

const log = createLogger('web:setup')

/**
 * What a restart attempt achieved, as seen from a page that is still running.
 *
 * `started` means the shell (or the browser) took the request and this document
 * is on its way out. `unavailable` means nothing further will happen without a
 * human, and is the ONLY answer a caller may draw a "Restart Podium" button for.
 */
export type ShellRestart = 'started' | 'unavailable'

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * A mode change must make the native shell re-read config. Plain browsers have
 * no host process to restart, so their equivalent is a page reload.
 *
 * THIS NEVER THROWS, and that is the contract (POD-1292). Every caller arrives
 * here just after a durable config write, where a rejection can only ever mean
 * "the app is still the old one" — never "the change was not saved". Letting it
 * propagate is what turned a saved VPS connection into an error box telling the
 * user to quit by hand, so the outcome is a RETURN VALUE, and a refusal leaves
 * a log record instead of the silence this bug was reported through.
 */
export async function restartPodiumShell(): Promise<ShellRestart> {
  const restart = (window as unknown as { __PODIUM_RESTART__?: () => unknown }).__PODIUM_RESTART__
  if (restart) {
    try {
      await Promise.resolve(restart())
    } catch (cause) {
      log.error('native restart hook refused', { reason: reason(cause) })
      return 'unavailable'
    }
    // The native hook replaces the process, so it does not resolve — reaching
    // this line means the shell declined without saying so. Report it as a
    // refusal: a page still executing is a page that owes the user the button,
    // and being wrong in this direction costs one frame of a hidden panel.
    log.warn('native restart hook returned with the page still running')
    return 'unavailable'
  }
  try {
    window.location.reload()
    return 'started'
  } catch (cause) {
    log.error('page reload refused', { reason: reason(cause) })
    return 'unavailable'
  }
}
