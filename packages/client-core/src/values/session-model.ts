/**
 * WHAT A SESSION RUNS ON, AND WHETHER IT CAN BE CHANGED WHILE IT RUNS.
 *
 * Read by the session model chip (POD-6264), which the web chat composer
 * carries and the session header shows in the CLI view, and by the phone
 * composer's chip (POD-2380).
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

/** Why this session's model cannot be changed from here: where the shown value
 *  comes from, then what stops the change. The harness owns model selection;
 *  Podium reports it. Shared by the web chip and the phone chip. */
export function modelReadoutReason(
  session: { observedModel?: string | null; requestedModel?: string | null },
  verdict: ConfigurableVerdict,
): string {
  const provenance = session.observedModel
    ? 'The model this agent is running, read from its transcript.'
    : session.requestedModel
      ? 'Requested on the running session; it applies from the next message.'
      : 'Requested at launch; not yet seen in the transcript.'
  const capability =
    verdict === 'no'
      ? 'This harness takes its model and effort at launch, so they cannot change mid-conversation. Start a new session to use another.'
      : verdict === 'yes'
        ? 'The session is not running. Wake it to change its model or effort.'
        : // Unknown is said as unknown: the daemon has not reported this
          // session's driver, and claiming either answer would be invented.
          'This session has not reported whether its model can change while it runs.'
  return `${provenance} ${capability}`
}

/** The words for a `session.configure` write that never reached the queue. */
export const CONFIGURE_WRITE_FAILED = 'Could not change the running session.'

/**
 * How a `session.configure` change ended (POD-6523), as one sentence and
 * whether it worked; null for a cancel, which is the person's own choice. The
 * web chip's toast and the phone composer's caption say the same words.
 */
export function configureEndingNotice(change: {
  readonly status: string
  readonly result?: unknown
  readonly error?: { readonly message?: string } | null | undefined
}): { ok: boolean; text: string } | null {
  const answer = change.result as
    | { ok?: unknown; effective?: string; reason?: string; detail?: string }
    | null
    | undefined
  if (change.status === 'succeeded')
    return {
      ok: true,
      text:
        answer?.effective === 'now'
          ? 'The running session changed.'
          : 'The change applies from the next turn.',
    }
  if (change.status === 'cancelled') return null
  if (typeof answer?.reason === 'string')
    return {
      ok: false,
      text: answer.detail ?? `Could not change the running session (${answer.reason}).`,
    }
  return {
    ok: false,
    text:
      change.status === 'expired'
        ? 'The change was not made in time; the session runs as before.'
        : (change.error?.message ?? CONFIGURE_WRITE_FAILED),
  }
}
