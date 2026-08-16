/**
 * THE PANEL AS A PURE FUNCTION OF THE OPERATION (POD-2102, spec §6).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 *
 * The client is a RENDERER of the operation (P2). Everything the panel shows
 * while an update is running — which step is current, how far it got, whether it
 * is alive, what failed — is read out of the operation object the server serves
 * verbatim. Nothing here recomputes progress, and nothing here fabricates a
 * state the server did not report; that habit is what gave the old dialog three
 * competing progress numbers for one panel (spec §1.2).
 *
 * The one thing a surface DOES compute locally is P5's local fact: "is my own
 * build still behind the target, and can I do something about it?" That arrives
 * as `local`, and it is the only input that differs between two tabs looking at
 * the same operation.
 *
 * ---------------------------------------------------------------------------
 * THE FROZEN CONTRACT, FROM THE RENDERER'S SIDE (P8)
 * ---------------------------------------------------------------------------
 *
 * This bundle is swapped DURING the operation it is drawing, so it will be
 * handed operations from a newer server: steps whose ids it has never heard of,
 * error codes that did not exist when it shipped, extra fields everywhere. So:
 *
 *  - step ids are never switched on. `prepare | machines | server | web` are the
 *    update kind's contract, but the checklist is built from whatever steps the
 *    operation carries, in order, using `title` for presentation and falling
 *    back to the id when a title is absent.
 *  - error codes are open strings. A known code gets §7's three-layer copy; an
 *    unknown one degrades to the server's own message plus a generic next
 *    action, never to a blank panel.
 *  - absent is never an error: an operation with no `steps`, no `updatedAt` and
 *    no `error` still renders.
 */
import type { AwaitingAsk, Operation, OperationError, OperationStep } from '@podium/protocol'
import {
  describeUpdateFailure,
  type Place,
  UNTRANSLATED_FAILURE_MESSAGE,
  type UpdateView,
} from './update-view'

/** The four surfaces, same vocabulary the offer copy already uses. */
export type UpdateSurface = 'web' | 'desktop-all-in-one' | 'desktop-remote' | 'mobile'

/**
 * A heartbeat older than this reads as "stopped", not as "working" (P4).
 *
 * Well under the engine's own stall deadline — §7's `stalled` copy talks in
 * minutes — so the user can tell a slow step from a stuck one long before the
 * engine gives up on it. But not much under: the first drive against a live
 * engine had `prepare` packing a bundle for a minute without a single progress
 * report, and a twenty-second threshold called that stuck while it was plainly
 * working. Crying wolf on every quiet build is the same failure as saying
 * nothing — the user still cannot tell the two apart.
 */
export const STALE_AFTER_MS = 60_000

/** How long a finished panel stays up before collapsing to the indicator (§6.2.4). */
export const DONE_COLLAPSE_MS = 6_000

export type PanelState =
  | 'none'
  | 'offer'
  | 'running'
  | 'waiting-you'
  | 'waiting-elsewhere'
  | 'done'
  | 'failed'

export type StepRowState = 'done' | 'current' | 'stalled' | 'pending' | 'failed'

export interface StepRow {
  id: string
  title: string
  state: StepRowState
  /** "1 of 3 · vmi3407763 downloading 62%" — always says what it is doing, never a bare bar. */
  substatus?: string
}

export type PrimaryActionKind =
  | 'start'
  | 'retry'
  | 'reload'
  | 'restart-app'
  | 'install-desktop'
  | 'check'

export interface PrimaryAction {
  kind: PrimaryActionKind
  label: string
  pendingLabel: string
  /** What pressing it will do to the user's world, in their words (§6.2.3). */
  consequence?: string
}

export interface ErrorPresentation {
  /** What happened, in place language. */
  message: string
  /** The ONE next action. */
  nextAction: string
  /** Collapsed technical detail, copyable, carrying the operation id (P7). */
  detail?: string
}

/** What the collapsed toolbar affordance shows (§6.1). */
export type IndicatorState = 'none' | 'idle-dot' | 'animating' | 'attention'

export interface UpdatePanelView {
  state: PanelState
  title: string
  subtitle?: string
  operationId?: string
  version?: string
  /** The plan, in order. Empty for an offer (no operation exists yet). */
  steps: StepRow[]
  /** "Step 2 of 4" — honest because the steps are the plan's own named steps. */
  stepPosition?: { current: number; total: number }
  /** Offer only: the place-language rows the old dialog already got right. */
  places?: Place[]
  notes?: { summary?: string; url?: string }
  restartNote?: string
  /** Why this update is not optional, when it is not. */
  reason?: string
  /** "Running for 40 s" / "No progress for 2 min" — never ambiguous (P4). */
  liveness?: string
  primary?: PrimaryAction
  /** Offered only while every started step is still reversible (§3.2). */
  cancel?: { label: string; operationId: string }
  error?: ErrorPresentation
  /** A sentence about the last thing the user tried that the server declined (e.g. cancel). */
  note?: string
  /** Asks this surface cannot act on, rendered honestly (P5). */
  awaitingElsewhere: string[]
  /** "2 machines will update when they reconnect" (§3.6). */
  deferredNote?: string
  indicator: IndicatorState
  indicatorLabel: string
}

export interface LocalFacts {
  /**
   * Is the build running THIS surface behind the operation's target? The one
   * locally-computed fact in the whole panel (P5/§3.5).
   */
  behind: boolean
  /** Can this surface reload itself? (A page can; a headless embedder cannot.) */
  canReload: boolean
  /** Is this surface the desktop shell, with a signed update it may install? */
  canInstallDesktop: boolean
}

export interface DesktopInstallProgress {
  phase: 'downloading' | 'installing'
  percent?: number
}

/**
 * A rejection from an action this panel dispatched — a refused `updates.start`,
 * a shell `installUpdate` that failed. It is NOT part of the operation, and
 * that is exactly why it is here: before this, a rejected `installUpdate`
 * vanished into `runAction`'s try/finally and the user saw a spinner stop
 * (retired POD-2091).
 */
export interface ActionError {
  code?: string
  message?: string
  detail?: string
}

export interface OperationViewInput {
  /** The server's operation, parsed. `null` is the ordinary answer. */
  operation: Operation | null
  /** The offer surface, when no operation exists yet (§6.2.1). */
  offer: UpdateView | null
  local: LocalFacts
  surface: UpdateSurface
  /** Render clock. Injected, so liveness is testable without a timer. */
  now: number
  desktopProgress?: DesktopInstallProgress
  actionError?: ActionError
  /** A refusal sentence from the last declined action (see {@link cancelRefusalSentence}). */
  note?: string
  /**
   * A failed operation the user already dismissed. The panel collapses, but the
   * indicator keeps the warning until a new operation replaces it — a failure
   * is never allowed to evaporate (§6.2.5).
   */
  acknowledgedFailureId?: string
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'canceled'])

export function isOperationTerminal(operation: Operation | null | undefined): boolean {
  return operation !== null && operation !== undefined && TERMINAL.has(operation.state)
}

/**
 * Is this operation still worth polling at one second? Used by the state hook to
 * pick its cadence, and defined here so "active" means one thing in the app.
 */
export function isOperationActive(operation: Operation | null | undefined): boolean {
  return operation !== null && operation !== undefined && !TERMINAL.has(operation.state)
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.round(minutes / 6) / 10} h`
}

function targetVersion(operation: Operation): string | undefined {
  const details = operation.details as { target?: { version?: unknown } } | undefined
  const version = details?.target?.version
  return typeof version === 'string' ? version : undefined
}

function stepTitle(step: OperationStep): string {
  return step.title ?? step.id
}

/**
 * The one place a place row becomes a sentence. `state` is the kind's own
 * vocabulary (`downloading`, `restarting`, …) and is printed as it arrives:
 * a renderer that only knew a closed list would go silent on the first new one.
 */
function placeLine(place: {
  name?: string
  state?: string
  percent?: number
  detail?: string
}): string | undefined {
  const name = place.name ?? place.detail
  const state = place.state
  const percent = typeof place.percent === 'number' ? ` ${Math.round(place.percent)}%` : ''
  if (name && state) return `${name} ${state}${percent}`
  if (name) return name
  if (state) return `${state}${percent}`
  return undefined
}

/** The place a human wants named: the one actually moving, else the first one left. */
function interestingPlace(step: OperationStep): string | undefined {
  const places = step.places ?? []
  const moving = places.find(
    (place) => place.state !== undefined && place.state !== 'done' && place.state !== 'pending',
  )
  const remaining = places.find((place) => place.state !== 'done')
  return placeLine(moving ?? remaining ?? places[0] ?? {})
}

function substatusFor(step: OperationStep): string | undefined {
  const parts: string[] = []
  if (step.progress && Number.isFinite(step.progress.total) && step.progress.total > 0) {
    parts.push(`${step.progress.done} of ${step.progress.total}`)
  }
  const place = interestingPlace(step)
  if (place) parts.push(place)
  if (step.detail) parts.push(step.detail)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function rowState(step: OperationStep): StepRowState {
  switch (step.state) {
    case 'done':
      return 'done'
    case 'running':
      return 'current'
    case 'stalled':
      return 'stalled'
    case 'failed':
      return 'failed'
    default:
      return 'pending'
  }
}

/**
 * The checklist. `skipped` steps are dropped rather than dimmed: the plan is
 * "what this update does", and a step that does not apply was never part of it
 * (§3.1) — showing it as skipped noise is what the plan-as-plan model replaced.
 */
export function stepRows(operation: Operation): StepRow[] {
  return (operation.steps ?? [])
    .filter((step) => step.state !== 'skipped')
    .map((step) => {
      const substatus = substatusFor(step)
      return {
        id: step.id,
        title: stepTitle(step),
        state: rowState(step),
        ...(substatus ? { substatus } : {}),
      }
    })
}

function currentStep(operation: Operation): OperationStep | undefined {
  const steps = (operation.steps ?? []).filter((step) => step.state !== 'skipped')
  return (
    steps.find((step) => step.state === 'running' || step.state === 'stalled') ??
    steps.find((step) => step.state === 'failed') ??
    steps.find((step) => step.state === 'pending')
  )
}

function stepPositionOf(rows: StepRow[]): { current: number; total: number } | undefined {
  if (rows.length === 0) return undefined
  const index = rows.findIndex((row) => row.state !== 'done')
  return { current: index === -1 ? rows.length : index + 1, total: rows.length }
}

/**
 * The liveness line (P4). Two readings, and the difference between them is the
 * whole point: a step that stamped progress recently is WORKING and says how
 * long it has been at it; one that has not is STUCK and says how long it has
 * been silent. A bar that cannot tell you which is banned by §6.3.
 */
function livenessLine(operation: Operation, step: OperationStep | undefined, now: number): string {
  const lastProgress = step?.lastProgressAt ?? operation.updatedAt
  const silentFor = lastProgress === undefined ? undefined : now - lastProgress
  const stale =
    step?.state === 'stalled' || (silentFor !== undefined && silentFor >= STALE_AFTER_MS)
  if (stale && silentFor !== undefined) return `No progress for ${formatDuration(silentFor)}`
  const startedAt = step?.startedAt ?? operation.startedAt
  if (startedAt !== undefined) return `Running for ${formatDuration(now - startedAt)}`
  return 'Working…'
}

/**
 * An ask, as a sentence for somebody who is NOT the one who can act on it.
 *
 * `required` picks which field: a required ask gates correctness, and the
 * server writes its `detail` for the onlooker ("Finish this in Podium Desktop
 * on ludovico"), which is exactly what this surface needs to say. A voluntary
 * ask's detail is written for the ACTOR ("Reloads this page in about two
 * seconds") and would be a lie here, so its `title` is used instead.
 */
function askLine(ask: AwaitingAsk): string {
  const chosen = ask.required ? (ask.detail ?? ask.title) : (ask.title ?? ask.detail)
  const parts = [chosen ?? ask.id]
  if (ask.place && !parts[0]?.includes(ask.place)) parts.push(`on ${ask.place}`)
  return parts.join(' ')
}

/**
 * Asks that belong to somebody else's surface. Rendered as sentences, never as
 * buttons: a browser tab does not restart a person's desktop app (P5).
 */
function elsewhereAsks(operation: Operation, surface: UpdateSurface): string[] {
  return (operation.awaiting ?? [])
    .filter((ask) => ask.surface !== undefined && ask.surface !== surface)
    .map(askLine)
}

function deferredNote(operation: Operation): string | undefined {
  const deferred = operation.deferred ?? []
  if (deferred.length === 0) return undefined
  const names = deferred.flatMap((place) => (place.name ? [place.name] : []))
  const subject =
    names.length > 0 && names.length <= 3
      ? names.join(', ')
      : `${deferred.length} machine${deferred.length === 1 ? '' : 's'}`
  return `${subject} will update when ${deferred.length === 1 && names.length === 1 ? 'it reconnects' : 'they reconnect'}.`
}

function placeSubject(places: readonly string[] | undefined, fallback: string): string {
  if (!places || places.length === 0) return fallback
  if (places.length <= 2) return places.join(' and ')
  return `${places.length} machines`
}

/**
 * §7's taxonomy: every failure becomes what happened / the one next action /
 * collapsed technical detail. `code` is an open string, so an unrecognized one
 * still produces all three layers — the server's own message becomes layer one
 * and the generic retry becomes layer two.
 *
 * The desktop shell's codes (POD-2135: `debug-build`, `signature-invalid`,
 * `install-failed`, `restart-failed`, `no-pending-update`, `no-update-available`)
 * are in the same kebab-case namespace and are mapped here too, because to the
 * user "the update failed" is one story regardless of which half reported it.
 */
export function presentOperationError(
  error: Pick<OperationError, 'code' | 'message' | 'detail' | 'places'> | ActionError,
  context: { operationId?: string } = {},
): ErrorPresentation {
  const code = error.code ?? ''
  const places = 'places' in error ? error.places : undefined
  const detailLines = [
    error.detail ?? error.message,
    code ? `code: ${code}` : undefined,
    context.operationId ? `operation: ${context.operationId}` : undefined,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0)
  const detail = detailLines.length > 0 ? detailLines.join('\n') : undefined
  const layers = errorCopy(code, error.message, places)
  return { ...layers, ...(detail ? { detail } : {}) }
}

function errorCopy(
  code: string,
  message: string | undefined,
  places: readonly string[] | undefined,
): { message: string; nextAction: string } {
  switch (code) {
    case 'machine-dirty-checkout': {
      const subject = placeSubject(places, 'A machine')
      return {
        message: `${subject} has local edits that prevent a safe update.`,
        nextAction: `Commit or stash them there, then try again.`,
      }
    }
    case 'machine-unsupported':
      return {
        message: `${placeSubject(places, 'A machine')} can't use this update's package.`,
        nextAction: 'Check the release includes its platform, then try again.',
      }
    case 'machine-unreachable':
      return {
        message: `${placeSubject(places, 'A machine')} stopped responding while updating.`,
        nextAction: "Check it's running; it will resume when it reconnects.",
      }
    case 'download-failed':
      return {
        message: "The update couldn't be downloaded.",
        nextAction: "Check the server's connection, then try again.",
      }
    case 'server-did-not-reach-target':
      return {
        message: 'The server restarted but came back on its old version. Nothing else was changed.',
        nextAction: 'Try again, or check the server log.',
      }
    case 'web-build-failed':
      return {
        message:
          'The app rebuild failed on the server. Machines that already updated stay updated.',
        nextAction: 'Try again.',
      }
    case 'stalled':
      return {
        message: message ?? 'The update stopped making progress. Podium retried once.',
        nextAction: 'Try again, or cancel.',
      }
    case 'preparation-failed':
      // The SERVER's sentence, verbatim when it has one. §7's template — "The
      // server couldn't prepare this update: <public reason>" — is what the
      // server already writes, so wrapping it again produced the sentence
      // twice in one line, which is what a real failed pack showed on the
      // first drive against a live engine.
      return {
        message: message ?? "The server couldn't prepare this update.",
        nextAction: 'Try again once the reason above is resolved.',
      }
    // The desktop shell's half of the taxonomy (POD-2135).
    case 'debug-build':
      return {
        message: 'Desktop updates are turned off in this development build.',
        nextAction: 'Install a released build of Podium Desktop to update it.',
      }
    case 'signature-invalid':
      return {
        message: "The desktop update couldn't be verified, so Podium refused to install it.",
        nextAction: 'Try again; if it keeps failing, download Podium again from the release page.',
      }
    case 'install-failed':
      return {
        message: "Podium couldn't install the desktop update.",
        nextAction: 'Try again, and check this machine has free disk space.',
      }
    case 'restart-failed':
      return {
        message: 'The desktop update installed, but Podium could not restart itself.',
        nextAction: 'Quit Podium and open it again to finish.',
      }
    case 'no-pending-update':
    case 'no-update-available':
      return {
        message: 'There is no desktop update ready to install.',
        nextAction: 'Check for updates again.',
      }
    default: {
      // NO CODE, OR ONE THIS BUNDLE PREDATES. Two chances before the generic
      // sentence: first `describeUpdateFailure`, which holds the accumulated
      // knowledge about what a raw delivery sentence means (dirty checkout,
      // unsupported platform, unreachable source); then, when it recognized
      // nothing, the SERVER'S OWN message — a §7 error carries a user-facing
      // sentence, and a bundle that predates the code still owes the user that
      // sentence rather than a shrug.
      const described = describeUpdateFailure(message, places?.[0])
      const translated = described.message !== UNTRANSLATED_FAILURE_MESSAGE
      return {
        message: translated ? described.message : (message ?? described.message),
        nextAction: described.guidance,
      }
    }
  }
}

/**
 * WHY CANCEL IS ALWAYS OFFERED WHILE THE OPERATION RUNS.
 *
 * Reversibility is a property of the KIND's step runners and deliberately does
 * not ride the wire (`OperationDefinition.runners[].reversible`, server-side).
 * The renderer therefore cannot pre-compute whether cancel is allowed — and the
 * engine already answers that question the right way round: `operations.cancel`
 * RETURNS a typed refusal rather than throwing, precisely so the panel can say
 * "this can't be canceled now, it will finish or fail" (§3.2, operations/trpc).
 *
 * So the button is offered, and the refusal becomes a sentence. The alternative
 * — hiding it on a guess — is how you get a user hunting for a button that the
 * design says exists.
 */
export function cancelRefusalSentence(
  refused: 'not-found' | 'already-finished' | 'irreversible' | string,
  step?: string,
): string {
  if (refused === 'already-finished') return 'This update already finished.'
  if (refused === 'not-found') return 'This update is no longer running.'
  return step
    ? `This update can't be canceled while it is ${step}. It will finish or fail.`
    : "This update can't be canceled now. It will finish or fail."
}

function localAction(input: OperationViewInput): PrimaryAction | undefined {
  if (input.local.canInstallDesktop) {
    return {
      kind: 'install-desktop',
      label: 'Restart Podium',
      pendingLabel: 'Installing…',
      consequence: 'Installs the update and restarts Podium; your sessions keep running.',
    }
  }
  if (input.local.canReload) {
    return {
      kind: 'reload',
      label: 'Reload',
      pendingLabel: 'Reloading…',
      consequence: 'Reloads this page, about 2 seconds; your sessions keep running.',
    }
  }
  return undefined
}

function offerView(input: OperationViewInput): UpdatePanelView {
  const offer = input.offer
  if (!offer) return noneView()

  /**
   * The two answers a MANUAL check produces. Neither carries an indicator: the
   * user opened this themselves and an "everything is fine" dot living in the
   * toolbar forever is exactly the noise §6.1 removed. The panel says its
   * sentence and collapses.
   */
  if (offer.state === 'checking') {
    return {
      ...noneView(),
      state: 'offer',
      title: 'Checking for updates…',
      subtitle: 'Asking this app and the rest of the fleet.',
    }
  }
  if (offer.state === 'current') {
    return {
      ...noneView(),
      state: 'done',
      title: 'Podium is up to date',
      subtitle: `Version ${offer.version} is the latest.`,
      version: offer.version,
    }
  }
  if (offer.state !== 'available' && offer.state !== 'required') return noneView()
  const primary: PrimaryAction = {
    kind: 'start',
    label: 'Update Podium',
    pendingLabel: 'Starting…',
  }
  return {
    state: 'offer',
    title: `Podium ${offer.version} is ${offer.state === 'required' ? 'required' : 'available'}`,
    subtitle: 'One Podium update, applied where it is needed.',
    version: offer.version,
    steps: [],
    places: offer.places,
    ...(offer.notes ? { notes: offer.notes } : {}),
    restartNote: offer.restartNote,
    ...(offer.reason ? { reason: offer.reason } : {}),
    primary,
    awaitingElsewhere: [],
    indicator: offer.state === 'required' ? 'attention' : 'idle-dot',
    indicatorLabel: `Podium ${offer.version} is ${offer.state === 'required' ? 'required' : 'available'}`,
  }
}

function noneView(): UpdatePanelView {
  return {
    state: 'none',
    title: '',
    steps: [],
    awaitingElsewhere: [],
    indicator: 'none',
    indicatorLabel: '',
  }
}

/**
 * THE VIEW MODEL.
 *
 * One function, one output, no hidden clock and no fetch: everything the panel
 * and the indicator draw is derived here from the operation the server served,
 * the offer facts, and this surface's local fact.
 */
export function operationView(input: OperationViewInput): UpdatePanelView {
  const view = computeView(input)
  // The note is about the last thing that happened to the USER (a refused
  // cancel, a spent reload budget), not about the operation, so it rides on
  // whatever the operation happens to be saying right now.
  return input.note && view.state !== 'none' ? { ...view, note: input.note } : view
}

function computeView(input: OperationViewInput): UpdatePanelView {
  const operation = input.operation

  // An action that failed is the panel's problem even when the server has no
  // operation to hang it on: this is the path a rejected `installUpdate` used
  // to fall down (retired POD-2091).
  if (input.actionError) {
    const error = presentOperationError(input.actionError, {
      ...(operation ? { operationId: operation.id } : {}),
    })
    return {
      state: 'failed',
      title: 'Podium update failed',
      ...(operation ? { operationId: operation.id } : {}),
      steps: operation ? stepRows(operation) : [],
      error,
      primary: {
        kind: 'retry',
        label: 'Try again',
        pendingLabel: 'Trying again…',
      },
      awaitingElsewhere: [],
      indicator: 'attention',
      indicatorLabel: 'Update failed',
    }
  }

  if (!operation) return offerView(input)

  const rows = stepRows(operation)
  const position = stepPositionOf(rows)
  const version = targetVersion(operation)
  const deferred = deferredNote(operation)
  const elsewhere = elsewhereAsks(operation, input.surface)
  const base = {
    operationId: operation.id,
    steps: rows,
    ...(position ? { stepPosition: position } : {}),
    ...(version ? { version } : {}),
    ...(deferred ? { deferredNote: deferred } : {}),
    awaitingElsewhere: elsewhere,
  }

  if (operation.state === 'failed') {
    const error = presentOperationError(operation.error ?? {}, { operationId: operation.id })
    return {
      ...base,
      state: 'failed',
      title: version ? `Podium ${version} could not be applied` : 'Podium update failed',
      error,
      primary: { kind: 'retry', label: 'Try again', pendingLabel: 'Trying again…' },
      indicator: 'attention',
      indicatorLabel: 'Update failed',
    }
  }

  // A canceled operation is not a story the panel has to tell: the user asked
  // for it to stop, it stopped, and whatever is still available comes back as
  // an offer on the next poll.
  if (operation.state === 'canceled') return noneView()

  // A straggler surface after the operation itself finished (§3.5): the shared
  // work is over, this tab is still on the old bundle, so it self-serves. Same
  // panel, later step — never a second dialog.
  if (operation.state === 'done') {
    if (input.local.behind) {
      const primary = localAction(input)
      return {
        ...base,
        state: 'waiting-you',
        title: version ? `Podium ${version} is ready here` : 'The update is ready here',
        subtitle: 'Everything else is updated. This page is still on the previous build.',
        ...(primary ? { primary } : {}),
        indicator: 'attention',
        indicatorLabel:
          primary?.kind === 'install-desktop' ? 'Restart to finish' : 'Reload to finish',
      }
    }
    return {
      ...base,
      state: 'done',
      title: version ? `Podium is on ${version} everywhere` : 'Podium is up to date everywhere',
      ...(deferred ? { subtitle: deferred } : {}),
      indicator: 'idle-dot',
      indicatorLabel: version ? `Podium is on ${version}` : 'Podium is up to date',
    }
  }

  const step = currentStep(operation)
  const liveness =
    input.desktopProgress !== undefined
      ? desktopProgressLine(input.desktopProgress)
      : livenessLine(operation, step, input.now)

  if (operation.state === 'waiting') {
    const mine = (operation.awaiting ?? []).some(
      (ask) => ask.surface === undefined || ask.surface === input.surface,
    )
    const primary = mine || input.local.behind ? localAction(input) : undefined
    if (primary) {
      return {
        ...base,
        state: 'waiting-you',
        title: version ? `Podium ${version} is ready here` : 'The update is ready here',
        subtitle: 'The shared steps are done. This page is the last one.',
        // NO LIVENESS LINE HERE, on purpose. Liveness reports on WORK; the
        // shared work has finished and the operation is waiting on a person, so
        // the same heartbeat that means "alive" while running would read as
        // "no progress for 26 s" the moment it is the user who is not moving —
        // an alarm about their own hesitation. What the panel says instead is
        // what pressing the button will do.
        ...(input.desktopProgress !== undefined ? { liveness } : {}),
        primary,
        indicator: 'attention',
        indicatorLabel:
          primary.kind === 'install-desktop' ? 'Restart to finish' : 'Reload to finish',
      }
    }
    return {
      ...base,
      state: 'waiting-elsewhere',
      title: version ? `Podium ${version} is finishing elsewhere` : 'The update is finishing',
      subtitle:
        elsewhere[0] ??
        (input.surface === 'web'
          ? 'Finish this in Podium Desktop on that machine.'
          : 'Waiting for another place to finish.'),
      // Same reason as above: the wait is on a PERSON somewhere else, and
      // counting the seconds of their inattention is not liveness, it is
      // nagging about something this surface cannot do anything about (P5).
      indicator: 'animating',
      indicatorLabel: 'Update waiting for another place',
    }
  }

  const stalled = step?.state === 'stalled'
  return {
    ...base,
    state: 'running',
    title: version ? `Podium ${version} is being applied` : 'Podium is being updated',
    ...(step ? { subtitle: stepTitle(step) } : {}),
    liveness,
    cancel: { label: 'Cancel', operationId: operation.id },
    indicator: stalled ? 'attention' : 'animating',
    indicatorLabel: position
      ? `Update running: step ${position.current} of ${position.total}`
      : 'Update running',
  }
}

function desktopProgressLine(progress: DesktopInstallProgress): string {
  const percent = typeof progress.percent === 'number' ? ` ${Math.round(progress.percent)}%` : ''
  return progress.phase === 'downloading' ? `Downloading${percent}` : `Installing${percent}`
}
