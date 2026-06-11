/**
 * Playwright globalTeardown: reap the harness's isolated abduco/tmux sessions.
 * Playwright SIGKILLs the webServer tree, so serve-harness's own shutdown handler
 * may never run — this is the cleanup that always does.
 */
import { reapHarnessSessions } from './harness-env'

export default function globalTeardown(): void {
  reapHarnessSessions(Number(process.env.PORT ?? 8799))
}
