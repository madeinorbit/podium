import type { MachineId, UpdateChannel } from '@podium/model'
import type {
  AwaitingAsk,
  DeferredPlace,
  Operation,
  OperationError,
  OperationStep,
  StepPlace,
  UpdateTarget,
} from '@podium/protocol'
import type {
  OperationKindDefinition,
  OperationPlan,
  StepDeadlines,
  StepOutcome,
  StepProgressPatch,
  StepRunner,
} from '../operations/kinds'
import type { UpdatesService } from './service'
import {
  machineCanTakeDelivery,
  offeredDeliveries,
  TERMINAL_STATES,
  type WaveMachine,
} from './wave'

/**
 * THE `update` KIND (POD-2098, spec `2026-08-14-update-operations-design.md`
 * §3.1–§3.6, §7, §8) — the first kind registered into POD-2097's generic engine.
 *
 * What this file is, in one sentence: the update stops being an emergent
 * phenomenon derived from four polled facts and becomes a PLAN — a named list of
 * steps, computed once, driven idempotently, and re-derived from observable
 * reality by whichever process is alive to look.
 *
 * THE THREE THINGS A KIND OWES THE ENGINE, and what each is here:
 *
 *  - `plan()`  — {@link planUpdateOperation}, a pure function of the target, the
 *    fleet snapshot and the surface. It is pure so that the question "what will
 *    this update do?" is answerable in a table-driven test rather than by
 *    running one.
 *  - `reconcile()` — {@link reconcileUpdateOperation}. The process that runs an
 *    update is the process the update replaces, so adoption is the NORMAL path.
 *    Reality wins over memory, always: this server's own version, the served
 *    website's stamp, and the machine directory.
 *  - `runners` — one `ensure()` per step, each reality-first and idempotent.
 *
 * WHY THE STEP ORDER IS prepare → machines → server → web
 * ------------------------------------------------------
 * It is the spec's own §3.1 example order, and each adjacency has a reason:
 *
 *  - `prepare` first because everything downstream consumes what it packs. In
 *    the development flow `requestDestBundle()` is an EXPLICIT build, and an
 *    explicit build rebuilds `apps/web/dist` before it packs the tarball
 *    (`decideWebDist`) — so preparing is also what makes the website current.
 *  - `machines` before `server` because this server restarting is what ends this
 *    process. The old choreography expressed the same ordering as a 250 ms poll
 *    loop with a 60-minute backstop; here it is simply the order of the plan.
 *  - `web` last because on an INSTALLED server the served dist arrives with the
 *    server's own swap, and in the development flow `prepare` has already built
 *    it — so by the time the step is reached its reality check usually passes
 *    without acting, which is exactly what a reality-first runner should do.
 *
 * WHAT DOES NOT LIVE HERE: the wave planner, the grant protocol, the dev
 * publisher, the daemon swap. Those are the muscle and they are untouched. This
 * file is choreography only.
 */

export const UPDATE_OPERATION_KIND = 'update'

/**
 * §3.0: `update` and a future `server-move` share one group, so the two can
 * never interleave. Named here because `update` is the kind that introduces it.
 */
export const LIFECYCLE_EXCLUSION_GROUP = 'lifecycle'

export const UPDATE_STEP_PREPARE = 'prepare'
export const UPDATE_STEP_MACHINES = 'machines'
export const UPDATE_STEP_SERVER = 'server'
export const UPDATE_STEP_WEB = 'web'

/** §3.5: the one ask that gates correctness, and therefore the one marked required. */
export const DESKTOP_INSTALL_ASK = 'desktop-install'
/** §3.5: voluntary — an idle tab that has not reloaded must NOT hold the operation open. */
export const RELOAD_SURFACES_ASK = 'reload-surfaces'

/**
 * THE TYPED ERROR TAXONOMY (§7), as a discriminated union.
 *
 * These codes are OPEN vocabulary as far as the framework is concerned — the
 * protocol's `OperationError.code` is a bare `z.string()` precisely so the kind
 * that owns the failures owns their names. That is why the union is declared
 * here and not in `packages/protocol`: the generic layer cannot enumerate update
 * failures without becoming update-specific.
 *
 * `places` names the machines a failure is ABOUT, so the panel can say
 * "vmi has local edits" rather than "a machine failed".
 */
export const UPDATE_ERROR_CODES = [
  'machine-dirty-checkout',
  'machine-unsupported',
  'machine-unreachable',
  'download-failed',
  'server-did-not-reach-target',
  'web-build-failed',
  'preparation-failed',
] as const
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number]

export type UpdateFailure =
  | { code: 'machine-dirty-checkout'; places: string[]; names: string[]; detail?: string }
  | { code: 'machine-unsupported'; places: string[]; names: string[]; detail?: string }
  | { code: 'machine-unreachable'; places: string[]; names: string[]; detail?: string }
  | { code: 'download-failed'; places?: string[]; names?: string[]; detail?: string }
  | { code: 'server-did-not-reach-target'; observedVersion: string; targetVersion: string }
  | { code: 'web-build-failed'; detail?: string }
  | { code: 'preparation-failed'; detail?: string }

/**
 * The §7 table's middle column, rendered from the union. Copy lives with the
 * code that produces it so a new failure cannot be added without a sentence for
 * the human — the failure mode the taxonomy exists to prevent is a typed error
 * whose message is its own code.
 */
export function describeUpdateOperationFailure(failure: UpdateFailure): OperationError {
  const subject = (failure: { names?: string[]; places?: string[] }): string =>
    failure.names?.[0] ?? failure.places?.[0] ?? 'A machine'
  switch (failure.code) {
    case 'machine-dirty-checkout':
      return {
        code: failure.code,
        message: `${subject(failure)} has local edits that prevent a safe update. Commit or stash them there, then try again.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-unsupported':
      return {
        code: failure.code,
        message: `${subject(failure)} can't use this update's package. Check the release includes its platform.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-unreachable':
      return {
        code: failure.code,
        message: `${subject(failure)} stopped responding while updating. Check it's running; it will resume when it reconnects.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'download-failed':
      return {
        code: failure.code,
        message:
          "The update couldn't be downloaded. Check the server's connection, then try again.",
        ...(failure.places ? { places: failure.places } : {}),
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'server-did-not-reach-target':
      return {
        code: failure.code,
        message: `The server restarted but came back on ${failure.observedVersion}. Nothing else was changed. Try again or check the server log.`,
        detail: `Expected ${failure.targetVersion}, observed ${failure.observedVersion}.`,
      }
    case 'web-build-failed':
      return {
        code: failure.code,
        message:
          'The app rebuild failed on the server. Machines that already updated stay updated. Try again.',
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'preparation-failed':
      return {
        code: failure.code,
        message: failure.detail
          ? `The server couldn't prepare this update: ${failure.detail}`
          : "The server couldn't prepare this update.",
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
  }
}

/**
 * Map a machine's convergence `detail` — a string written by the daemon, the
 * grant path, or the service's own timeout — onto a code.
 *
 * The patterns are deliberately the SAME ones `describeUpdateFailure` already
 * matches in `apps/web/src/features/updates/update-view.ts`. That function keeps
 * working unchanged (the panel issue consumes the codes later); this is where
 * the same evidence acquires a name the server can persist and a retry can key
 * on, instead of a sentence that has to be re-parsed by every reader.
 */
export type MachineFailureCode =
  | 'machine-dirty-checkout'
  | 'machine-unsupported'
  | 'machine-unreachable'
  | 'download-failed'

export function classifyMachineFailure(detail: string | undefined): MachineFailureCode {
  const normalized = detail?.trim() ?? ''
  if (/dirty[-_\s]working[-_\s]tree|local (?:files|edits)|uncommitted/i.test(normalized)) {
    return 'machine-dirty-checkout'
  }
  if (/unsupported[-_\s]delivery|unsupported[-_\s]platform|no[-_\s]artifact/i.test(normalized)) {
    return 'machine-unsupported'
  }
  if (
    /unable to connect|access the url|failed to fetch|fetch failed|download(?: timed out| failed)|network(?:error| request failed)|econn(?:refused|reset)|etimedout|enotfound/i.test(
      normalized,
    )
  ) {
    return 'download-failed'
  }
  // Everything else — including the service's own GRANT_TIMED_OUT_DETAIL ("The
  // machine stopped reporting progress while updating.") — is a machine that
  // stopped answering. That is the honest default: the alternative is a generic
  // "could not finish" that tells the operator nothing about where to look.
  return 'machine-unreachable'
}

/** Which surface created the operation. Open vocabulary owned by this kind (§4). */
export type UpdateSurface = 'web' | 'mobile' | 'desktop-all-in-one' | 'desktop-remote' | 'policy'

/** §3.1 `details` for this kind, under the same frozen-contract law as its container. */
export interface UpdateOperationDetails {
  target: UpdateTarget
  channel: UpdateChannel
  /** The version this server was on when the plan was computed — the "from". */
  fromVersion?: string
  surface?: UpdateSurface
  [key: string]: unknown
}

export function updateOperationDetails(operation: Operation): UpdateOperationDetails | undefined {
  const details = operation.details as UpdateOperationDetails | undefined
  if (!details || typeof details !== 'object') return undefined
  const target = details.target
  if (!target || typeof target !== 'object' || typeof target.version !== 'string') return undefined
  return details
}

// ─────────────────────────────── planning ────────────────────────────────

export interface UpdatePlanInput {
  target: UpdateTarget
  channel: UpdateChannel
  /** The whole fleet; this function does the channel filtering itself. */
  fleet: readonly WaveMachine[]
  /** THE one channel resolver (POD-2100) — never a `?? 'dev'` of our own. */
  channelOf: (machine: WaveMachine) => UpdateChannel
  /** This server's own build version, as `/version` reports it. */
  appVersion: string
  /** The served website's commit — BOTH dists, or undefined while they disagree. */
  servedWebDigest: string | undefined
  /** This server can pack a development tarball (the dev publisher is wired). */
  canPrepare: boolean
  /** This server can rebuild `apps/web/dist` without a restart. */
  canRebuildWeb: boolean
  /** This server can restart itself onto the target (a source checkout). */
  canRestartServer: boolean
  /** THIS host's machine id, so its own row can be recognised. */
  hostMachineId?: string
  surface?: UpdateSurface
  /**
   * Retry (§3.2): only these machine ids are in scope. Absent plans everything.
   * The remainder is computed by the caller from the operation being retried.
   */
  onlyMachines?: readonly string[]
  /** Links a remainder operation to the one it retries. */
  retryOf?: string
}

/** A dev+ identity with no packed tarball still has to be packed before it can be delivered. */
export function needsDevelopmentBundle(target: {
  version: string
  artifacts: { headless?: unknown }
}): boolean {
  return target.version.startsWith('dev+') && target.artifacts.headless === undefined
}

/**
 * Can this descriptor be handed to a machine AT ALL?
 *
 * A `dev+<sha>` identity names a commit; until it has been packed it offers
 * nothing an installed daemon can consume. Granting it anyway is how the fleet
 * used to learn by failing, and it is why this question is asked in the two
 * places that could otherwise disagree — the plan (should there be a machines
 * step?) and the runner (may it tick right now?).
 */
export function canGrantDevelopmentFleet(target: {
  version: string
  artifacts: { headless?: unknown }
}): boolean {
  return !needsDevelopmentBundle(target)
}

function placeOf(machine: WaveMachine): StepPlace {
  return {
    id: machine.id,
    ...(machine.name ? { name: machine.name } : {}),
    state: machine.state,
    ...(machine.detail ? { detail: machine.detail } : {}),
  }
}

/**
 * THE PLAN (§3.1): a pure function of the target, the fleet and the surface.
 *
 * "Steps that don't apply are omitted, never shown as skipped noise" is load
 * bearing: the panel renders "step 2 of 4" straight off this list, so a step
 * that was never going to do anything would make that sentence a lie.
 */
export function planUpdateOperation(input: UpdatePlanInput): OperationPlan {
  const { target } = input
  const details: UpdateOperationDetails = {
    target,
    channel: input.channel,
    fromVersion: input.appVersion,
    ...(input.surface ? { surface: input.surface } : {}),
  }

  const channelMachines = input.fleet.filter(
    (machine) => input.channelOf(machine) === input.channel,
  )
  const host = input.hostMachineId
    ? channelMachines.find((machine) => machine.id === input.hostMachineId)
    : undefined

  /**
   * ALL-IN-ONE (§4, §5): the server lives INSIDE Podium Desktop on this
   * machine, so server, daemon and web are one signed bundle that only the
   * shell may replace. There is therefore nothing for a runner to do — the plan
   * is EMPTY and carries one required ask, which is what makes the engine settle
   * the operation straight into `waiting` (§3.2). A browser looking at the same
   * server renders that honestly and cannot act on it (P5).
   *
   * Derived from the HOST daemon's `supervised` flag rather than from the
   * surface that clicked, because it is a fact about this installation and not
   * about who is looking at it.
   */
  if (host?.supervised === true) {
    const ask: AwaitingAsk = {
      id: DESKTOP_INSTALL_ASK,
      surface: 'desktop-all-in-one',
      title: 'Install the update in Podium Desktop',
      detail: `Finish this in Podium Desktop on ${host.name ?? host.id}.`,
      place: host.id,
      // REQUIRED: this is the ask that gates correctness. Nothing else moves
      // until the shell installs and the successor server adopts (§5).
      required: true,
    }
    return { steps: [], details, awaiting: [ask], deferred: [] }
  }

  const steps: OperationPlan['steps'] = []
  const deferred: DeferredPlace[] = []
  const awaiting: AwaitingAsk[] = []

  if (needsDevelopmentBundle(target) && input.canPrepare) {
    steps.push({ id: UPDATE_STEP_PREPARE, title: 'Preparing the update', state: 'pending' })
  }

  // NOTHING CAN BE DELIVERED, AND NOTHING WILL PACK IT. A bare dev identity on
  // a server with no publisher has no bytes to hand anyone, so planning a
  // machines step would plan a step that can never finish.
  const deliverable = canGrantDevelopmentFleet(target) || input.canPrepare

  // A supervised daemon is the SHELL's to update, never the wave's (POD-2099,
  // spec §4). It is excluded outright rather than deferred: deferred means
  // "will be done later by us", and this one will never be ours to do.
  const behind = channelMachines.filter(
    (machine) =>
      machine.version !== target.version &&
      machine.supervised !== true &&
      (input.onlyMachines === undefined || input.onlyMachines.includes(machine.id)),
  )
  // Delivery capability is only asked when the artifact ALREADY EXISTS. While a
  // `prepare` step is planned the target is a bare identity, so its offered
  // deliveries are empty and every machine would trivially pass — the wave
  // planner asks again at grant time, with the packed descriptor in hand.
  const deliveries = offeredDeliveries(target)
  const core = behind.filter(
    (machine) =>
      machine.online && (deliveries.length === 0 || machineCanTakeDelivery(machine, deliveries)),
  )
  // §3.6: a machine that is asleep must not hold the outcome open. It goes to
  // `deferred` with an honest note and the standing reconciliation converges it
  // when it reconnects.
  for (const machine of behind) {
    if (core.includes(machine)) continue
    deferred.push({
      id: machine.id,
      ...(machine.name ? { name: machine.name } : {}),
      reason: machine.online ? 'cannot-take-delivery' : 'offline',
    })
  }
  if (core.length > 0 && deliverable) {
    steps.push({
      id: UPDATE_STEP_MACHINES,
      title: 'Updating your machines',
      state: 'pending',
      progress: { done: 0, total: core.length },
      places: core.map(placeOf),
    })
  }

  if (input.appVersion !== target.version && input.canRestartServer) {
    steps.push({ id: UPDATE_STEP_SERVER, title: 'Updating your server', state: 'pending' })
  }

  const expectedWeb = target.artifacts.web?.digest
  const webBehind = expectedWeb !== undefined && input.servedWebDigest !== expectedWeb
  if (webBehind && (input.canRebuildWeb || input.canPrepare || input.canRestartServer)) {
    steps.push({ id: UPDATE_STEP_WEB, title: 'Serving the new app', state: 'pending' })
    // VOLUNTARY, and that is the whole point of the flag: a tab that has not
    // reloaded is a straggler that self-serves on its next load (§3.5), so this
    // ask must never hold the operation in `waiting` the way the all-in-one
    // install does. The panel renders it as "Reload"; the engine ignores it.
    awaiting.push({
      id: RELOAD_SURFACES_ASK,
      surface: 'web',
      title: 'Reload open Podium tabs',
      detail: 'Reloads this page in about two seconds; your sessions keep running.',
      required: false,
    })
  }

  return {
    steps,
    details,
    awaiting,
    deferred,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
  }
}

// ─────────────────────────────── reconcile ───────────────────────────────

/**
 * The observable facts adoption is judged against (§3.4). Deliberately three
 * plain values and a directory read: memory from the dead process appears
 * nowhere in this type, which is the property that makes reconciliation honest.
 */
export interface UpdateReality {
  /** This server's own version, now that it has booted. */
  appVersion: string
  /** The served website's commit — both dists — or undefined while they disagree. */
  servedWebDigest: string | undefined
  /** The machine directory, as the daemons' handshakes have refreshed it. */
  machineDirectory: readonly WaveMachine[]
  now: number
}

function patchStep(
  operation: Operation,
  stepId: string,
  patch: (step: OperationStep) => OperationStep,
): Operation {
  return {
    ...operation,
    steps: (operation.steps ?? []).map((step) => (step.id === stepId ? patch(step) : step)),
  }
}

function stepOf(operation: Operation, stepId: string): OperationStep | undefined {
  return (operation.steps ?? []).find((step) => step.id === stepId)
}

/**
 * ADOPTION (§3.4). Re-derive every step from what is observably true, then let
 * the engine resume from there.
 *
 * The `server` step is the one that cannot be re-run: this process IS its
 * outcome. `running` means the predecessor persisted the step and then asked for
 * its own restart, so seeing it here means the restart happened and this binary
 * is the answer. Being on the target is `done`; being on anything else is
 * `server-did-not-reach-target` — the case that today silently produces a fresh
 * dialog offering the same update again.
 */
export function reconcileUpdateOperation(operation: Operation, reality: UpdateReality): Operation {
  const details = updateOperationDetails(operation)
  if (!details) {
    // Bytes that do not name a target cannot be reconciled against anything.
    // Failing is right: leaving it live would wedge the lifecycle group behind
    // an operation nothing can advance.
    return {
      ...operation,
      state: 'failed',
      finishedAt: reality.now,
      updatedAt: reality.now,
      error: {
        code: 'preparation-failed',
        message: "This update's plan could not be read after the server restarted.",
      },
    }
  }
  const targetVersion = details.target.version
  let next = operation

  const server = stepOf(next, UPDATE_STEP_SERVER)
  if (server && !isFinishedStep(server)) {
    if (reality.appVersion === targetVersion) {
      next = patchStep(next, UPDATE_STEP_SERVER, (step) => ({
        ...step,
        state: 'done',
        finishedAt: reality.now,
        lastProgressAt: reality.now,
      }))
    } else if (server.state === 'running' || server.state === 'stalled') {
      const error = describeUpdateOperationFailure({
        code: 'server-did-not-reach-target',
        observedVersion: reality.appVersion,
        targetVersion,
      })
      return {
        ...patchStep(next, UPDATE_STEP_SERVER, (step) => ({
          ...step,
          state: 'failed',
          finishedAt: reality.now,
          lastProgressAt: reality.now,
          error,
        })),
        state: 'failed',
        finishedAt: reality.now,
        updatedAt: reality.now,
        error,
      }
    }
    // `pending` and still behind: nothing happened yet, the step stands.
  }

  const web = stepOf(next, UPDATE_STEP_WEB)
  const expectedWeb = details.target.artifacts.web?.digest
  if (web && !isFinishedStep(web) && expectedWeb !== undefined) {
    if (reality.servedWebDigest === expectedWeb) {
      next = patchStep(next, UPDATE_STEP_WEB, (step) => ({
        ...step,
        state: 'done',
        finishedAt: reality.now,
        lastProgressAt: reality.now,
      }))
    } else if (web.state === 'running' || web.state === 'stalled') {
      // The build that was in flight died with its process. Back to `pending`
      // so the resumed plan RE-ENSURES it rather than watching for a report
      // nothing will ever send.
      next = patchStep(next, UPDATE_STEP_WEB, (step) => ({ ...step, state: 'pending' }))
    }
  }

  const machines = stepOf(next, UPDATE_STEP_MACHINES)
  if (machines && !isFinishedStep(machines)) {
    const directory = new Map(reality.machineDirectory.map((machine) => [machine.id, machine]))
    const places = (machines.places ?? []).map((place) => {
      const machine = directory.get(place.id)
      if (!machine) return place
      // The directory is refreshed from the daemon handshake, so a machine
      // REPORTING the target has proved it, whatever the dead process believed
      // it was in the middle of.
      if (machine.version === targetVersion) {
        return { ...place, state: 'current', percent: 100 }
      }
      return {
        ...place,
        state: machine.online ? place.state : 'offline',
        ...(machine.name ? { name: machine.name } : {}),
      }
    })
    const done = places.filter((place) => place.state === 'current').length
    next = patchStep(next, UPDATE_STEP_MACHINES, (step) => ({
      ...step,
      places,
      progress: { done, total: places.length },
      // Never `done` from here alone: the runner re-ensures on resume and
      // decides, so there is one place that says when a wave has finished.
      state: done === places.length && places.length > 0 ? 'done' : 'pending',
      ...(done === places.length && places.length > 0
        ? { finishedAt: reality.now, lastProgressAt: reality.now }
        : {}),
    }))
  }

  const prepare = stepOf(next, UPDATE_STEP_PREPARE)
  if (prepare && (prepare.state === 'running' || prepare.state === 'stalled')) {
    // Same as `web`: the pack died with its process, and `ensure()` is
    // idempotent — it re-checks the descriptor before it rebuilds anything.
    next = patchStep(next, UPDATE_STEP_PREPARE, (step) => ({ ...step, state: 'pending' }))
  }

  /**
   * THE ALL-IN-ONE ASK, ANSWERED FROM THE FAR SIDE OF THE RESTART (§3.4, §5).
   *
   * An all-in-one plan has NO STEPS: the whole update is the shell replacing
   * itself, and the only thing holding the operation open is the required
   * `desktop-install` ask. So nothing above this line can advance it, and
   * nothing on the wire ever will either — the process that would have reported
   * the install is the one that died, and the page that clicked the button died
   * with it.
   *
   * What CAN be observed is the same fact the `server` step is judged on, read
   * one layer out: the server reading these bytes lives INSIDE that shell, and
   * it is now running the target. That is the install, seen from after the
   * restart. Reality over memory, applied to an ask instead of a step.
   *
   * Without this the ask outlives the restart it was asking for, the reloaded
   * panel offers "Restart Podium" for an update that is already installed —
   * which then fails as `no-update-available`, because there is nothing left to
   * install — and the operation sits in `waiting` until its ten-minute grace
   * quietly calls it done, long after the user stopped believing it.
   */
  if (reality.appVersion === targetVersion) {
    const awaiting = (next.awaiting ?? []).filter((ask) => ask.id !== DESKTOP_INSTALL_ASK)
    if (awaiting.length !== (next.awaiting ?? []).length) next = { ...next, awaiting }
  }

  return { ...next, updatedAt: reality.now }
}

function isFinishedStep(step: OperationStep): boolean {
  return step.state === 'done' || step.state === 'skipped' || step.state === 'failed'
}

// ──────────────────────────────── runners ────────────────────────────────

/**
 * Everything a step runner may reach. Assembled by whoever STARTS the operation
 * (the tRPC mutation) or by whoever ADOPTS it (boot), which is why it is never
 * persisted: it is live plumbing, and the successor process builds its own.
 */
export interface UpdateOperationContext {
  updates: UpdatesService
  channel: UpdateChannel
  /** This server's own build version. */
  appVersion: () => string
  /** THIS host's machine id — how an all-in-one installation recognises itself. */
  hostMachineId?: string
  surface?: UpdateSurface
  /** Retry (§3.2): plan only these machines, and link back to the operation retried. */
  onlyMachines?: readonly string[]
  retryOf?: string
  /** The served website's commit, both dists (see `websiteDigestReader`). */
  servedWebDigest?: () => string | undefined
  requestDestBundle?: () => Promise<unknown>
  requestWebRebuild?: () => void
  requestCoordinatorRestart?: () => void
  /** The dev publisher's readiness, for naming a failed website build. */
  preparation?: () => { webReady: boolean; bundleReady: boolean; failureDetail?: string }
  /**
   * Report progress for one step of THIS operation.
   *
   * MUST NOT BE AWAITED FROM INSIDE `ensure()`: it goes through the engine's
   * per-operation chain, which the caller of `ensure()` is holding. Every use
   * below is from a continuation that runs after `ensure()` has returned, which
   * is the same reason those runners answer `running` rather than blocking.
   */
  report?: (operationId: string, stepId: string, patch: StepProgressPatch) => void
  /** Deferred wake-up for the watchers. Injected so a test never sleeps. */
  schedule?: (fn: () => void, ms: number) => void
  /** How often a watcher re-reads the world. */
  watchIntervalMs?: number
  now?: () => number
}

const DEFAULT_WATCH_INTERVAL_MS = 500

function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
}

/**
 * §3.3's per-step budgets. Silence is what fires, not slowness: a nine-minute
 * download reporting progress every few seconds is healthy, and a two-minute one
 * that says nothing is not.
 */
export const UPDATE_STEP_DEADLINES: Record<string, StepDeadlines> = {
  // A pack is a compile: quiet for its whole length, so only a total applies.
  [UPDATE_STEP_PREPARE]: { totalMs: 20 * 60_000 },
  // The same ten minutes the grant protocol already uses, now on a TIMER rather
  // than ageing only when someone reads `fleet()`.
  [UPDATE_STEP_MACHINES]: { silenceMs: 10 * 60_000, totalMs: 60 * 60_000 },
  // A restart that has not produced a successor in five minutes is not coming.
  [UPDATE_STEP_SERVER]: { silenceMs: 5 * 60_000, totalMs: 15 * 60_000 },
  [UPDATE_STEP_WEB]: { silenceMs: 5 * 60_000, totalMs: 15 * 60_000 },
}

/** In-flight preparation, per operation: `ensure()` twice must be one build. */
const preparing = new Map<string, Promise<unknown>>()

function watch(
  context: UpdateOperationContext,
  operationId: string,
  stepId: string,
  poll: () => StepProgressPatch | undefined,
): void {
  const schedule = context.schedule ?? defaultSchedule
  const interval = context.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  const tick = (): void => {
    const patch = poll()
    if (patch === undefined) {
      schedule(tick, interval)
      return
    }
    context.report?.(operationId, stepId, patch)
  }
  schedule(tick, interval)
}

/**
 * `prepare` — pack what the fleet will be handed (§3.1).
 *
 * REALITY FIRST: a target that already carries a headless artifact needs no
 * pack, whoever packed it. That is also what makes this safe to re-enter after
 * adoption, after a stall retry, and after a retry operation.
 *
 * It hands the build out and answers `running` rather than awaiting it. A pack
 * is a compile — awaiting it here would hold the engine's chain, and therefore
 * the tRPC mutation that started the operation, for the length of a build.
 */
const prepareRunner: StepRunner<UpdateOperationContext> = {
  // Nothing has been handed to a machine yet, so cancelling costs a build (§3.2).
  reversible: true,
  ensure: async ({ operation, context }) => {
    const details = updateOperationDetails(operation)
    if (!details) return { state: 'failed', error: { code: 'preparation-failed' } }
    const published = context.updates.target(details.channel)
    if (published?.version === details.target.version && !needsDevelopmentBundle(published)) {
      return { state: 'done', detail: 'The update package is ready.' }
    }
    if (!context.requestDestBundle) {
      return {
        state: 'failed',
        error: describeUpdateOperationFailure({
          code: 'preparation-failed',
          detail: 'This Podium installation cannot pack a development update.',
        }),
      }
    }

    const inFlight = preparing.get(operation.id) ?? context.requestDestBundle()
    preparing.set(operation.id, inFlight)
    inFlight.then(
      () => {
        preparing.delete(operation.id)
        context.report?.(operation.id, UPDATE_STEP_PREPARE, {
          state: 'done',
          detail: 'The update package is ready.',
        })
      },
      (error: unknown) => {
        preparing.delete(operation.id)
        context.report?.(operation.id, UPDATE_STEP_PREPARE, {
          state: 'failed',
          // The publisher's PUBLIC reason, which is the sentence §7 promises to
          // quote. Its console-only diagnostic (offending paths and all) stays
          // in the log where it belongs.
          error: describeUpdateOperationFailure({
            code: 'preparation-failed',
            detail: publicReason(error) ?? context.preparation?.().failureDetail,
          }),
        })
      },
    )
    return { state: 'running', detail: 'Building the update package…' }
  },
}

function publicReason(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'publicReason' in error) {
    const reason = (error as { publicReason?: unknown }).publicReason
    if (typeof reason === 'string' && reason.length > 0) return reason
  }
  return error instanceof Error ? error.message : undefined
}

/**
 * `machines` — the existing wave, driven by the operation (§3.1).
 *
 * The muscle is untouched: `markAuthorized` + `tick(channel)` against the same
 * planner, the same grants, the same daemon protocol. What changes is that
 * progress is PROJECTED into the operation instead of being re-derived by three
 * different pieces of code, and that "done" has one definition.
 */
const machinesRunner: StepRunner<UpdateOperationContext> = {
  /**
   * §3.2 names this step as cancellable: "machine wave not yet granted /
   * individual machines finish their in-flight grant". A grant already sent is
   * not recalled by a cancel and does not need to be — the daemon's own swap is
   * crash-safe and rolls itself back — so stopping the wave strands nothing. The
   * wave is re-planned from scratch on every tick, so no further machine is
   * selected once the operation is gone.
   */
  reversible: true,
  ensure: async ({ operation, step, context }) => {
    const details = updateOperationDetails(operation)
    if (!details) return { state: 'failed', error: { code: 'preparation-failed' } }
    const settled = settleMachines(operation, step, context)
    if (settled) return settled

    /**
     * NEVER GRANT WHAT CANNOT BE DELIVERED. `prepare` is supposed to have left
     * a packed descriptor published for this version; if it has not, ticking
     * would hand every installed daemon a bare `dev+<sha>` identity it can only
     * refuse — the fleet learning by failing, which is exactly the defect the
     * delivery-capability work removed. Staying `running` instead means the
     * step's own deadline decides, visibly, rather than a wave of rejections.
     */
    const published = context.updates.target(details.channel) ?? details.target
    if (!canGrantDevelopmentFleet(published)) {
      return {
        state: 'running',
        detail: 'Waiting for the update package.',
        ...projectMachines(operation, step, context),
      }
    }

    context.updates.markAuthorized(details.channel)
    context.updates.tick(details.channel)
    const progress = projectMachines(operation, step, context)
    return { state: 'running', ...progress }
  },
}

/**
 * Project the live fleet into this step's places — the ONE computation of update
 * progress (P2). The old code had three: the client's flags at button-press
 * time, the fleet-derived view, and a server total that overwrote both.
 */
export function projectMachines(
  operation: Operation,
  step: OperationStep,
  context: UpdateOperationContext,
): { places: StepPlace[]; progress: { done: number; total: number } } {
  const details = updateOperationDetails(operation)
  const targetVersion = details?.target.version
  const fleet = new Map(context.updates.fleet().map((machine) => [machine.id, machine]))
  const places = (step.places ?? []).map((place) => {
    const machine = fleet.get(place.id)
    if (!machine) return { ...place, state: 'offline' }
    if (targetVersion !== undefined && machine.version === targetVersion) {
      return { ...place, state: 'current', percent: 100, name: machine.name ?? place.name }
    }
    // A daemon that reported `restarting` and then disconnected has crossed the
    // handoff (`machineCrossedRestartBoundary`). Across a wire boundary its next
    // handshake cannot happen until THIS server restarts too, so waiting for one
    // would deadlock both processes — the old choreography's central insight,
    // kept.
    if (
      targetVersion !== undefined &&
      context.updates.machineCrossedRestartBoundary(machine.id as MachineId, targetVersion)
    ) {
      return { ...place, state: 'restarting', name: machine.name ?? place.name }
    }
    /**
     * A MACHINE THAT IS BEHIND IS NOT `current`, WHATEVER THE WAVE CALLS IT.
     *
     * `WaveMachine.state` is the CONVERGENCE state, and its resting value is
     * `current` — it means "no grant is in flight", not "this machine is on the
     * target". Reading it as the latter is precisely how a wave could be
     * declared finished before a single machine had moved, so the version
     * comparison above is the only thing that produces `current` here and a
     * resting machine reads as `pending`, which is the §3.1 vocabulary for a
     * place whose turn has not come.
     */
    const resting = machine.state === 'current'
    return {
      ...place,
      state: !machine.online ? 'offline' : resting ? 'pending' : machine.state,
      ...(machine.name ? { name: machine.name } : {}),
      ...(machine.detail ? { detail: machine.detail } : {}),
    }
  })
  const done = places.filter(
    (place) => place.state === 'current' || place.state === 'restarting',
  ).length
  return { places, progress: { done, total: places.length } }
}

/**
 * Has the wave reached an outcome? `done` when every planned machine is at the
 * target (or has crossed the restart boundary), `failed` when one reported a
 * verdict only a human can clear.
 */
function settleMachines(
  operation: Operation,
  step: OperationStep,
  context: UpdateOperationContext,
): StepOutcome | undefined {
  const { places, progress } = projectMachines(operation, step, context)
  const failedPlaces = places.filter(
    (place) => place.state !== undefined && TERMINAL_STATES.has(place.state as never),
  )
  const first = failedPlaces[0]
  if (first !== undefined) {
    const shared = {
      places: failedPlaces.map((place) => place.id),
      names: failedPlaces.map((place) => place.name ?? place.id),
      ...(first.detail ? { detail: first.detail } : {}),
    }
    const failure: UpdateFailure = { code: classifyMachineFailure(first.detail), ...shared }
    return {
      state: 'failed',
      places,
      progress,
      error: describeUpdateOperationFailure(failure),
    }
  }
  if (places.length > 0 && progress.done === places.length) {
    return { state: 'done', places, progress }
  }
  return undefined
}

/**
 * `server` — this process's own replacement (§3.4).
 *
 * The engine has ALREADY persisted this step as `running` before calling us
 * (`beginStep`), which is the whole of the crash-safety argument: whatever
 * happens next, a successor that boots finds "the server step was running" and
 * reconciles it against its own version. So there is no in-process wait loop and
 * nothing to remember — the step completes at adoption or not at all.
 */
const serverRunner: StepRunner<UpdateOperationContext> = {
  reversible: false,
  ensure: async ({ operation, context }) => {
    const details = updateOperationDetails(operation)
    if (!details) return { state: 'failed', error: { code: 'preparation-failed' } }
    if (context.appVersion() === details.target.version) {
      return { state: 'done', detail: 'The server is on the new version.' }
    }
    if (!context.requestCoordinatorRestart) {
      return {
        state: 'failed',
        error: describeUpdateOperationFailure({
          code: 'server-did-not-reach-target',
          observedVersion: context.appVersion(),
          targetVersion: details.target.version,
        }),
      }
    }
    context.requestCoordinatorRestart()
    return { state: 'running', detail: 'Restarting onto the new version…' }
  },
}

/**
 * `web` — the served website reaching the target commit (§3.1).
 *
 * Reality first, and the reality is a stamp on disk. In the development flow
 * `prepare` has usually already produced it, so this step's common case is to
 * observe and finish without acting.
 */
const webRunner: StepRunner<UpdateOperationContext> = {
  /**
   * NOT cancellable, and the reason is the step BEFORE it. §3.2: "from the
   * server swap onward the operation cannot be canceled, only fail forward".
   * Whenever a `server` step exists, `web` runs after it — so a cancel accepted
   * here would be a cancel accepted after the swap, leaving a new server serving
   * an old website. The panel's honest sentence is "this can't be canceled now,
   * it will finish or fail", and that is what a refusal produces.
   */
  reversible: false,
  ensure: async ({ operation, context }) => {
    const details = updateOperationDetails(operation)
    if (!details) return { state: 'failed', error: { code: 'preparation-failed' } }
    const expected = details.target.artifacts.web?.digest
    if (expected === undefined) return { state: 'skipped' }
    const read = context.servedWebDigest
    if (read?.() === expected) return { state: 'done', detail: 'The new app is being served.' }

    context.requestWebRebuild?.()
    watch(context, operation.id, UPDATE_STEP_WEB, () => {
      if (read?.() === expected) {
        return { state: 'done', detail: 'The new app is being served.' }
      }
      const failure = context.preparation?.().failureDetail
      if (failure !== undefined) {
        return {
          state: 'failed',
          error: describeUpdateOperationFailure({ code: 'web-build-failed', detail: failure }),
        }
      }
      return undefined
    })
    return { state: 'running', detail: 'Rebuilding the app…' }
  },
}

// ─────────────────────────────── the kind ────────────────────────────────

/**
 * The registrable definition. Handed to `modules.operations.kinds.register(...)`
 * at the composition root, in a diff a reviewer can see — which is the entire
 * reason POD-2097 named both halves of that seam instead of hiding the registry
 * behind the engine.
 */
export function updateOperationKind(): OperationKindDefinition<
  UpdateOperationContext,
  UpdateReality
> {
  return {
    kind: UPDATE_OPERATION_KIND,
    exclusionGroup: LIFECYCLE_EXCLUSION_GROUP,
    // The engine hands the context straight back; everything the plan needs is
    // a fact this context can be asked for, so the pure function stays pure and
    // the impure reads happen in exactly one place.
    plan: (context) => planUpdateOperation(planInputFrom(context)),
    reconcile: reconcileUpdateOperation,
    runners: {
      [UPDATE_STEP_PREPARE]: prepareRunner,
      [UPDATE_STEP_MACHINES]: machinesRunner,
      [UPDATE_STEP_SERVER]: serverRunner,
      [UPDATE_STEP_WEB]: webRunner,
    },
    deadlines: UPDATE_STEP_DEADLINES,
  }
}

/**
 * THE FLEET → OPERATION BRIDGE (§3.3's "progress heartbeats").
 *
 * A daemon's `updateStatus` frame, a machine connecting, a machine dropping —
 * each is a fact about the wave, and each is what stamps `lastProgressAt` on
 * the `machines` step. Wiring it to the EVENTS rather than to a poll is the
 * whole of the liveness fix: today's grant deadline only ages when somebody
 * reads `fleet()`, so an update nobody is watching is an update nothing is
 * timing.
 *
 * Silent when no update operation is running, which is the ordinary case — the
 * daemon protocol keeps working exactly as before with nothing to report to.
 */
export function createUpdateFleetBridge(deps: {
  engine: {
    active(group?: string): { id: string; kind: string; operation: Operation | null } | undefined
    recordProgress(id: string, stepId: string, patch: StepProgressPatch): Promise<void>
  }
  updates: UpdatesService
}): { onFleetChanged: () => void } {
  return {
    onFleetChanged: () => {
      const row = deps.engine.active(LIFECYCLE_EXCLUSION_GROUP)
      if (!row || row.kind !== UPDATE_OPERATION_KIND || !row.operation) return
      const step = stepOf(row.operation, UPDATE_STEP_MACHINES)
      if (!step || isFinishedStep(step) || step.state === 'pending') return
      const details = updateOperationDetails(row.operation)
      if (!details) return
      const context: UpdateOperationContext = {
        updates: deps.updates,
        channel: details.channel,
        appVersion: () => details.fromVersion ?? '',
      }
      const settled = settleMachines(row.operation, step, context)
      const patch: StepProgressPatch = settled ?? {
        state: 'running',
        ...projectMachines(row.operation, step, context),
      }
      void deps.engine.recordProgress(row.id, UPDATE_STEP_MACHINES, patch)
    },
  }
}

/**
 * The one place the plan's inputs are READ from the world. Kept separate from
 * {@link planUpdateOperation} so that function can stay a pure, table-testable
 * function of facts rather than of services.
 *
 * Throws when no target is published: a plan with nothing to converge on is not
 * a degraded plan, it is not a plan, and the caller already has to refuse that
 * case before offering an update at all (§6.3 — an internal precondition is
 * never shown as an error).
 */
export function planInputFrom(context: UpdateOperationContext): UpdatePlanInput {
  const target = context.updates.target(context.channel)
  if (!target) throw new Error(`no ${context.channel} update target is published`)
  return {
    target,
    channel: context.channel,
    fleet: context.updates.fleet(),
    channelOf: (machine) => context.updates.channelOf(machine),
    appVersion: context.appVersion(),
    servedWebDigest: context.servedWebDigest?.(),
    canPrepare: context.requestDestBundle !== undefined,
    canRebuildWeb: context.requestWebRebuild !== undefined,
    canRestartServer: context.requestCoordinatorRestart !== undefined,
    ...(context.hostMachineId ? { hostMachineId: context.hostMachineId } : {}),
    ...(context.surface ? { surface: context.surface } : {}),
    ...(context.onlyMachines ? { onlyMachines: context.onlyMachines } : {}),
    ...(context.retryOf ? { retryOf: context.retryOf } : {}),
  }
}

/** Reset the module-level in-flight preparation map. Tests only. */
export function resetUpdateOperationState(): void {
  preparing.clear()
}
