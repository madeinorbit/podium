/**
 * WHAT A SESSION SAYS ABOUT ITS LAUNCH TERMS (POD-6858 Task 11,
 * docs/design/harness-session-posture.md §4.9 and §5).
 *
 * The daemon reports, once per launch, the harness mode Podium asked for and
 * every requirement the launch could not meet (`SessionMeta.launchPosture`).
 * Web and phone draw the same words from it, so both live here.
 */
import type { AgentKind, LaunchPostureReport, SessionMeta } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { agentLabel } from './quota'

/** Each requirement, as the end of "<harness> cannot …". */
const REQUIREMENT_IN_WORDS: Readonly<
  Record<LaunchPostureReport['unmet'][number]['requirement'], string>
> = {
  'workspace-trust': 'skip its folder trust question',
  'podium-cli': 'run the Podium CLI without asking',
  autonomy: 'run in the chosen mode',
  'quiet-start': 'start without a menu',
  'podium-material': 'open chat attachments without asking',
}

/**
 * One notice per requirement the launch could not meet:
 * "<harness label> cannot <requirement in words> here: <reason>".
 * None for a session with no report, or a report with nothing unmet.
 */
export function postureNotices(
  session: {
    agentKind: AgentKind | (string & {})
    launchPosture?: LaunchPostureReport | undefined
  },
  served?: readonly HarnessDescriptorWire[],
): string[] {
  const unmet = session.launchPosture?.unmet ?? []
  if (unmet.length === 0) return []
  const label = agentLabel(session.agentKind, served)
  return unmet.map(
    (entry) => `${label} cannot ${REQUIREMENT_IN_WORDS[entry.requirement]} here: ${entry.reason}`,
  )
}

/** The mode a session shows, and where it came from. */
export interface SessionModeReadout {
  readonly mode: string
  /** `observed`: the harness reported it. `requested`: what Podium asked for. */
  readonly source: 'observed' | 'requested'
}

/**
 * THE MODE A SESSION SHOWS (§4.9): the one the harness itself reports when it
 * reports one, otherwise the one Podium asked for at launch. Undefined when
 * neither is known; a requested mode is never shown as if it were in force.
 */
export function sessionModeReadout(
  session: Partial<Pick<SessionMeta, 'observedMode' | 'launchPosture'>>,
): SessionModeReadout | undefined {
  const observed = session.observedMode?.trim()
  if (observed) return { mode: observed, source: 'observed' }
  const requested = session.launchPosture?.requestedMode?.trim()
  if (requested) return { mode: requested, source: 'requested' }
  return undefined
}
