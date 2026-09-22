import { withStateChannel } from '../../agent-state/types.js'
import type { AgentStateProvider } from '../../agent-state/types.js'
import { isRecord, stringField } from '../shared/json-util.js'

/**
 * Fixture state provider (POD-4474) — the smallest provider that still proves
 * the state mechanism serves a third-party manifest.
 *
 * No hook wiring (`instrumentation` returns no args — the fixture posts
 * nothing, matching `hookInstall: 'none'`); `translate` reads the fixture's
 * own phase markers (`{fixture:true, phase}` payloads the poll observer
 * hands it), and `bootEvents` seeds a fresh spawn as started. Unknown payloads
 * translate to nothing rather than to another harness's events.
 */
export const fixtureStateProvider: AgentStateProvider = {
  instrumentation: () => ({ args: [] }),
  translate: async (payload) => {
    if (!isRecord(payload) || payload.fixture !== true) return []
    const phase = stringField(payload, 'phase')
    if (phase === 'working') return withStateChannel([{ kind: 'activity' }], 'poll')
    if (phase === 'idle')
      return withStateChannel(
        [{ kind: 'turn_completed', verdict: { kind: 'done' } }],
        'poll',
      )
    if (phase === 'needs-human')
      return withStateChannel(
        [{ kind: 'needs_user', need: 'question', summary: 'fixture is waiting' }],
        'poll',
      )
    return []
  },
  bootEvents: async () => withStateChannel([{ kind: 'session_started' }], 'poll'),
}
