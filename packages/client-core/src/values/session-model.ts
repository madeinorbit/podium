/**
 * WHAT A SESSION RUNS ON, AND WHETHER IT CAN BE CHANGED WHILE IT RUNS.
 *
 * Read by the session model chip (POD-6264), which the chat composer carries
 * and the session header shows in the CLI view.
 */

/**
 * MAY A CLIENT OFFER A MODEL / EFFORT CONTROL ON THIS RUNNING SESSION?
 * (POD-3087.)
 *
 * The one fact that answers it is `configureFields`, reported by the daemon on
 * bind out of the live driver's own `configure.fields`. Nothing else on
 * `SessionMeta` can: `driverFamily` is the nearest, and it is wrong here —
 * `grok-acp` is family `server` and declares `configure` for `permissionMode`
 * alone, so a family-gated picker appears on a session that can only refuse it.
 *
 * ABSENT IS NOT "NO", and this function exists as much for that rule as for the
 * lookup. Undefined means we have not been told — an older daemon mid-upgrade,
 * or a session that has not bound yet — and reading it as "cannot" would hide
 * the control on every session in the fleet during a rolling upgrade, silently.
 * So absent answers `unknown`, and the caller decides; only an EMPTY array,
 * which is a daemon that answered "nothing", is a real no.
 */
export type ConfigurableVerdict = 'yes' | 'no' | 'unknown'

export function canConfigureModel(session: {
  configureFields?: readonly string[]
}): ConfigurableVerdict {
  if (session.configureFields === undefined) return 'unknown'
  return session.configureFields.includes('model') ? 'yes' : 'no'
}

interface ModelFacts {
  observedModel?: string
  observedEffort?: string
  requestedModel?: string
  requestedEffort?: string
  model?: string
  effort?: string
}

/**
 * THE MODEL A READOUT SHOWS [POD-121]. The transcript-OBSERVED one when known
 * (`observedModel` — resolves a spawn-time `auto` and follows `/model`
 * switches), then the one last REQUESTED at runtime (`requestedModel`,
 * POD-3081), then the spawn selection — including an explicit `auto`, shown
 * literally until observation resolves it [POD-158].
 *
 * THE MIDDLE ARM IS WHY THE ORDER IS THREE AND NOT TWO. A sticky configure takes
 * effect on the NEXT turn, so between the change and the next assistant message
 * there is no observation of the new model — and without this arm the readout
 * would fall all the way through to the SPAWN selection and show a model two
 * changes out of date. It sits BELOW the observation because the observation is
 * the stronger claim: during that window the session really is still answering
 * as the old model, and the dotted rule on a requested readout says so.
 */
export function readoutModel(session: ModelFacts): string | undefined {
  return session.observedModel || session.requestedModel || session.model || undefined
}

/** The effort a readout shows, in the same order. A spawn-time `auto` is no
 *  claim about effort, so it shows nothing. */
export function readoutEffort(session: ModelFacts): string | undefined {
  return (
    session.observedEffort ||
    session.requestedEffort ||
    (session.effort && session.effort !== 'auto' ? session.effort : undefined)
  )
}

/**
 * THE VALUE A MODEL MENU HOLDS on a session that can change it. The last
 * REQUESTED value leads here, unlike the readout: it is what the next turn runs
 * on, and it is the answer to the menu the person just used. Then what the
 * transcript shows, then the launch request.
 */
export function menuModel(session: ModelFacts): string {
  return session.requestedModel || session.observedModel || session.model || 'auto'
}

export function menuEffort(session: ModelFacts): string {
  return session.requestedEffort || session.observedEffort || session.effort || 'auto'
}

/**
 * A model id the machine's catalog does not list still reads as a name:
 * "claude-fable-5" → "fable 5", "claude-opus-4-8" → "opus 4.8",
 * "claude-haiku-4-5-20251001" → "haiku 4.5" (date suffix dropped, consecutive
 * numeric parts join as a dotted version).
 */
export function compactModelId(raw: string): string {
  const parts = raw
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
  const words: string[] = []
  for (const part of parts) {
    const last = words.at(-1)
    if (/^\d+$/.test(part) && last !== undefined && /^\d/.test(last)) {
      words[words.length - 1] = `${last}.${part}`
    } else {
      words.push(part)
    }
  }
  return words.join(' ')
}

/** Thinking time describes the tradeoff, not a promise about answer quality. */
const EFFORT_HELP: Readonly<Record<string, string>> = {
  auto: 'the agent choosing how much time to spend thinking',
  none: 'no extra thinking time',
  off: 'no extra thinking time',
  minimal: 'very little thinking time for quicker replies',
  low: 'less thinking time for quicker replies',
  medium: 'a balance of thinking time and reply speed',
  high: 'more thinking time for difficult tasks, which can take longer',
  xhigh: 'extra thinking time for difficult tasks, which can take longer',
  max: 'the most thinking time available, which can take longer',
  ultra: 'extended thinking time for the hardest tasks, which can take longer',
}

function effortMeaning(value: string): string {
  return Object.hasOwn(EFFORT_HELP, value)
    ? (EFFORT_HELP[value] ?? `the agent's "${value}" thinking setting`)
    : `the agent's "${value}" thinking setting`
}

export type ControlAvailability = 'ready' | 'pending' | 'fixed' | 'pick-model' | 'unsupported'

export function effortControlHelp(
  value: string,
  availability: ControlAvailability,
  inSession = false,
): string {
  const meaning =
    !value || value === 'auto'
      ? 'Auto lets the agent choose how much time to spend thinking.'
      : `Uses ${effortMeaning(value)}.`
  const action: Record<ControlAvailability, string> = {
    ready: inSession
      ? 'Choose a thinking level here for your next message.'
      : 'Choose a thinking level here before starting the task.',
    pending: 'Wait for your current change to finish before choosing again.',
    fixed: 'Thinking time is fixed here; choose it in the new-task box for a new session.',
    'pick-model': 'Choose a model here first to see its thinking levels.',
    unsupported: 'This model offers no thinking levels here; choose another model to set one.',
  }
  return `${meaning} ${action[availability]}`
}

export function modelControlHelp(
  label: string,
  automatic: boolean,
  availability: 'ready' | 'pending' = 'ready',
  inSession = false,
): string {
  const meaning = automatic
    ? 'Auto lets the agent choose which model generates its replies.'
    : availability === 'pending'
      ? `${label} is selected for your next reply while the change is being applied.`
      : `${label} generates the agent's replies.`
  const action =
    availability === 'pending'
      ? 'Wait for your current change to finish before choosing again.'
      : inSession
        ? 'Choose a model here for your next message.'
        : 'Choose a model here before starting the task.'
  return `${meaning} ${action}`
}

/** Readouts keep model and effort confirmation separate; either may arrive first. */
export function modelReadoutHelp(
  session: ModelFacts,
  verdict: ConfigurableVerdict,
  label: string | undefined,
): string {
  const raw = readoutModel(session)
  let meaning =
    !raw || raw === 'auto'
      ? 'The agent chooses which model generates its replies'
      : session.observedModel
        ? `${label ?? raw} generates the replies`
        : session.requestedModel
          ? `${label ?? raw} is selected for your next reply but is not yet confirmed`
          : `${label ?? raw} was selected for this session but is not yet confirmed`
  const effort = readoutEffort(session)
  if (raw && raw !== 'auto' && !session.observedModel && effort && !session.observedEffort) {
    meaning = `${label ?? raw} is selected for ${session.requestedModel ? 'your next reply' : 'this session'} with ${effortMeaning(effort)} (not yet confirmed)`
  } else if (effort) {
    meaning += `, with ${effortMeaning(effort)}${session.observedEffort ? '' : ' (selected, not yet confirmed)'}`
  }
  const action =
    verdict === 'no'
      ? 'These choices are fixed here; choose them in the new-task box for a new session.'
      : verdict === 'yes'
        ? 'Wake this session to change its model or thinking time here.'
        : 'Model changes are not available yet; you can choose a model in the new-task box for a new session.'
  return `${meaning}. ${action}`
}
