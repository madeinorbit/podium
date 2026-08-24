import type { MachineId, UpdateChannel } from '@podium/model'
import type {
  AwaitingAsk,
  DeferredPlace,
  MachineFailureCode,
  Operation,
  OperationError,
  OperationStep,
  StepPlace,
  UpdateTarget,
} from '@podium/protocol'
import { buildsDiffer, classifyUpdateFailureDetail } from '@podium/protocol'
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  PROGRESS_REPORT_INTERVAL_MS,
} from '@podium/runtime/update-delivery'
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
  isPackagedRolloutTarget,
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

/**
 * Legacy persisted operations may still carry this ask. New plans never mint it;
 * adoption removes it once a post-transition server is already on the target.
 */
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
  'machine-update-failed',
  /**
   * The machine took no update because finishing one would have stopped it for
   * good (POD-2210): a Podium running as a single foreground process is server
   * and daemon in one PID with nothing to restart it, so its daemon refuses
   * rather than exiting. Named as its own code because the default —
   * `machine-unreachable` — would have told the operator to check a machine that
   * is running perfectly and answered them clearly.
   */
  'machine-cannot-restart',
  /**
   * THE REFUSAL THAT KEPT A MACHINE ALIVE, IN ITS THREE KINDS (POD-2239).
   *
   * Migrations are forward-only, so a build older than the database it is
   * pointed at would refuse to start, and the thing that would put the newer
   * build back is the server that will not start. The daemon declines the
   * downgrade before swapping anything and says which of three things it knows.
   *
   * THREE CODES, NOT ONE, because they are three different states of knowledge
   * and §7 forbids a failure asserting what it has not established. POD-2233
   * had already split them on the ActionError path; collapsing them again here
   * would have re-created the defect one layer down, where a real update runs.
   */
  'machine-schema-advanced',
  'machine-schema-unknown',
  'machine-schema-unreadable',
  /**
   * THE ELEVEN SENTENCES THE UNREACHABLE DEFAULT WAS ANSWERING FOR (POD-2241).
   *
   * A by-import audit drove every producer in the update path and handed what
   * it actually wrote to both readers. Eleven precise sentences — every git
   * delivery step, both verification failures, every delivery misconfiguration,
   * both boot-reconciliation verdicts, an HTTP status from the artifact fetch —
   * fell to `machine-unreachable`, so a machine that had just answered was
   * reported as having stopped responding and as due to resume when it
   * reconnects. Neither was true and the second could never become true.
   *
   * These four codes are the next actions those sentences actually imply, which
   * is the only reason to have a code at all:
   *
   *  - `machine-delivery-failed` — a step failed on a live machine (git status,
   *    fetch, checkout, or their timeout). Nothing was changed there; retrying
   *    can legitimately produce a different answer.
   *  - `machine-delivery-unavailable` — this update cannot be delivered to that
   *    machine AS CONFIGURED (a bad git reference, no checkout runner, no
   *    artifact URL, no pinned key). Retrying is guaranteed to return here, so
   *    the copy must not offer it.
   *  - `machine-artifact-rejected` — digest or signature verification failed and
   *    the daemon refused to install. Corrupt or tampered; a security event, and
   *    the one failure where "try again" is actively bad advice.
   *  - `machine-update-not-confirmed` — it restarted and came back on the wrong
   *    version. It is UP; the boot itself is what reported this.
   */
  'machine-delivery-failed',
  'machine-delivery-unavailable',
  'machine-artifact-rejected',
  'machine-update-not-confirmed',
  /**
   * The server retracted the target while a machine was still applying it —
   * `setTargetUnavailable` ends those rows as `stuck` and says why. The machine
   * is fine and nothing about it needs checking, which is exactly what the
   * unreachable default told the operator to go and do.
   */
  'update-withdrawn',
  'download-failed',
  'server-did-not-reach-target',
  'web-build-failed',
  'preparation-failed',
] as const
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number]

export type UpdateFailure =
  | {
      code: 'machine-dirty-checkout'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-unsupported'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-unreachable'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-update-failed'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-cannot-restart'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-schema-advanced'
      places: string[]
      names: string[]
      detail?: string
      databaseSnapshotPath?: string
    }
  | {
      code: 'machine-schema-unknown'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-schema-unreadable'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-delivery-failed'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-delivery-unavailable'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-artifact-rejected'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'machine-update-not-confirmed'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'update-withdrawn'
      places: string[]
      names: string[]
      detail?: string
    }
  | {
      code: 'download-failed'
      places?: string[]
      names?: string[]
      detail?: string
    }
  | {
      code: 'server-did-not-reach-target'
      observedVersion: string
      targetVersion: string
      /** The supervising parent's own account of what it did and why. */
      parentReport?: string
    }
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
        message: `${subject(
          failure,
        )} has local edits that prevent a safe update. Commit or stash them there, then try again.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-unsupported':
      return {
        code: failure.code,
        message: `${subject(
          failure,
        )} can't use this update's package. Check the release includes its platform.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-unreachable':
      return {
        code: failure.code,
        message: `${subject(
          failure,
        )} stopped responding while updating. Check it's running; it will resume when it reconnects.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-update-failed':
      return {
        code: failure.code,
        message:
          `${subject(failure)} reported an unexpected update failure. The technical detail ` +
          "below is the error it reported; check that machine's log and disk before trying again.",
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-cannot-restart':
      return {
        code: failure.code,
        // Says what was NOT done first, because the operator's next question is
        // whether their checkout moved, and then the two ways out — the one that
        // takes five seconds, and the one that makes it not happen again.
        message: `${subject(
          failure,
        )} is running Podium as a single foreground process, so it cannot update itself. Nothing was changed. Stop it and start it again there to pick this up, or install it as a service with \`podium setup\`.`,
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    /**
     * The three schema refusals (POD-2239), in the order of how much each one
     * KNOWS. Each says what is established, then that nothing was changed —
     * the first question an operator asks — then the one action that exists.
     * None of them says "try again" except the one where trying again can
     * actually produce a different answer.
     */
    case 'machine-schema-advanced':
      // Both halves are established here: the refusal named an applied
      // migration the target does not define, so the target IS behind this
      // database and WOULD refuse to open it.
      return {
        code: failure.code,
        message:
          `${subject(failure)} was asked to move to an older version that cannot open the data ` +
          'it already has. Nothing was changed and Podium is still running there. Pick a ' +
          'version at least as new as the one it is on — or, if you really need the older one, ' +
          (failure.databaseSnapshotPath
            ? `restore the pre-upgrade database snapshot at ${failure.databaseSnapshotPath} ` +
              'by hand first (docs/data-and-upgrades.md).'
            : 'restore a database backup from before the upgrade by hand first ' +
              '(no Podium-created snapshot is available for this older upgrade; see ' +
              'docs/data-and-upgrades.md).'),
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-schema-unknown':
      /**
       * The arm that must assert LESS than the other two. Neither half is
       * established: the target did not declare what it can open and could not
       * be proved newer, so "older" and "cannot open" are both guesses.
       *
       * And no advice to pick something newer, which is not merely unproven
       * but unachievable: a coordinator on a source build reports `dev+<sha>`,
       * which orders against nothing published, so every choice returns here.
       * The action that exists belongs to the release, not to the operator.
       */
      return {
        code: failure.code,
        message:
          `${subject(failure)} was asked to move to a version that does not say which data it ` +
          'can open, so nothing here could tell whether it would start. Nothing was changed and ' +
          'Podium is still running there. Ask the server operator for a release that declares ' +
          'which data it can open — that is what settles this. A machine running a development ' +
          'build cannot order itself against published versions, so choosing a different one ' +
          'will not.',
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-schema-unreadable':
      // Says nothing about the target at all — the database could not be read.
      // The only one of the three where "try again" is right, because a read
      // that lost to a lock or a permission can win next time.
      return {
        code: failure.code,
        message:
          `${subject(failure)} could not read its own database, so nothing here could tell ` +
          'whether that version would start against it. Nothing was changed and Podium is still ' +
          'running there. Check that database file and its disk on that machine — the technical ' +
          'detail below says why the read failed — then try again.',
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-delivery-failed':
      // A step failed on a machine that is still running and still answering.
      // Say what was NOT done first — the operator's next question is whether
      // their checkout moved — and point at the detail, which names the step.
      return {
        code: failure.code,
        message:
          `${subject(failure)} could not put this update in place. Nothing was changed there ` +
          'and Podium is still running. The technical detail below names the step that failed; ' +
          "try again, and if it keeps failing check that machine's checkout and its disk.",
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-delivery-unavailable':
      // NO "try again" — this is the arm for the failures that are properties
      // of the release or the pairing, not of a moment. Retrying returns here.
      return {
        code: failure.code,
        message:
          `This update cannot be delivered to ${subject(failure)} as configured. Nothing was ` +
          "changed there. Ask the server operator to check the release and that machine's " +
          'pairing — trying again will not change this on its own.',
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-artifact-rejected':
      // The one failure where "try again" is bad advice rather than merely
      // useless: the bytes that arrived were not the bytes that were signed, so
      // a retry either succeeds by luck or repeats the same unsafe fetch.
      return {
        code: failure.code,
        message:
          `The update package failed verification on ${subject(failure)}, so Podium refused to ` +
          'install it and nothing was changed there. Ask the server operator to re-publish the ' +
          'release before applying it again — what arrived was not what was signed.',
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'machine-update-not-confirmed':
      // Reported BY THE MACHINE'S OWN BOOT, so it is up. Nothing here claims
      // why the new version did not start; the detail says how far it got.
      return {
        code: failure.code,
        message:
          `${subject(failure)} took this update but did not come back on the new version, and ` +
          "is running again on the version it had. Check that machine's log for why the new " +
          'version did not start — the technical detail below says how far it got.',
        places: failure.places,
        ...(failure.detail ? { detail: failure.detail } : {}),
      }
    case 'update-withdrawn':
      return {
        code: failure.code,
        message:
          `The server withdrew this update while ${subject(failure)} was still applying it, so ` +
          'nothing was changed there. The detail below is the reason it gave; apply the update ' +
          'again once the server is publishing one.',
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
        message: failure.parentReport
          ? `The server came back on ${failure.observedVersion}: ${failure.parentReport}`
          : `The server restarted but came back on ${failure.observedVersion}. Nothing else was changed. Try again or check the server log.`,
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
 * grant path, the boot reconciler, or the service's own timeout — onto a code.
 *
 * THIS IS NO LONGER A CLASSIFIER (POD-2241). It used to be one, and that was
 * the defect: `describeUpdateFailure` in apps/web classified the SAME sentence
 * independently, so an arm added here was half a fix and the missing half
 * produced a confident wrong answer rather than a blank. The patterns now live
 * once, in `@podium/protocol`'s {@link classifyUpdateFailureDetail}, which both
 * readers call. Add a token there, not here — and note that doing so reds this
 * package and apps/web until both have said what it means, which is the point.
 *
 * Kept as a named export because the operation path is its only caller and the
 * name says what the call is FOR; and because `MachineFailureCode` widening in
 * the protocol should fail HERE, at the union, rather than silently produce a
 * code no arm of {@link describeUpdateOperationFailure} answers.
 */
export type { MachineFailureCode }

/** Every machine code must be a member of this kind's §7 taxonomy. */
type _MachineCodesAreUpdateErrorCodes = MachineFailureCode extends UpdateErrorCode ? true : never
const _machineCodesAreUpdateErrorCodes: _MachineCodesAreUpdateErrorCodes = true
void _machineCodesAreUpdateErrorCodes

export function classifyMachineFailure(detail: string | undefined): MachineFailureCode {
  return classifyUpdateFailureDetail(detail)
}

/** Which surface created the operation. Open vocabulary owned by this kind (§4). */
export type UpdateSurface = 'web' | 'mobile' | 'desktop-all-in-one' | 'desktop-remote' | 'policy'

/** §3.1 `details` for this kind, under the same frozen-contract law as its container. */
export interface UpdateOperationDetails {
  target: UpdateTarget
  channel: UpdateChannel
  /** The version this server was on when the plan was computed — the "from". */
  fromVersion?: string
  /** Verified restore point available when this attempt began or created by it. */
  databaseSnapshotPath?: string
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

/**
 * WHICH VERSION IS THE RUNNING OPERATION DELIVERING ON THIS CHANNEL (POD-2228)?
 *
 * `UpdatesService` asks this to recognise its own package: a publication for
 * the version already under way is that update acquiring its bytes, not a rival
 * version to be queued behind it. It matters only where the service has no
 * memory to compare against — a successor process after a restart — which is
 * precisely where an adopted operation was starved of the package it resumed
 * waiting for.
 *
 * It lives here rather than at the composition root because reading an update's
 * `details` is this kind's knowledge, and a second copy of that reading in
 * `relay.ts` is how the harness and production would come to disagree. A row
 * this binary cannot parse, or one belonging to another kind (a future server
 * move shares the exclusion group), answers `undefined` — the caller then falls
 * back to the memory test, which is the pre-existing behaviour.
 */
export function exclusiveUpdateVersion(
  row: { operation: Operation | null } | undefined,
  channel: UpdateChannel,
): string | undefined {
  const operation = row?.operation
  if (!operation || operation.kind !== UPDATE_OPERATION_KIND) return undefined
  const details = updateOperationDetails(operation)
  if (!details || details.channel !== channel) return undefined
  return details.target.version
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
  /** This server's source identity, authoritative across deliberate display labels. */
  sourceDigest?: string
  /** Whether this coordinator owns a package that the operation may replace. */
  serverInstallKind?: 'installed' | 'source'
  /** The served website's commit — BOTH dists, or undefined while they disagree. */
  servedWebDigest: string | undefined
  /** This server can pack a development tarball (the dev publisher is wired). */
  canPrepare: boolean
  /** This server can rebuild `apps/web/dist` without a restart. */
  canRebuildWeb: boolean
  /** This server has a supervising parent that can hand over to the target. */
  canRestartServer: boolean
  /** Newest verified restore point, when one already exists. */
  databaseSnapshotPath?: string
  /** THIS host's machine id, so its own row can be recognised. */
  hostMachineId?: string
  /** The coordinating server runs below a native crash-supervisor frame. */
  desktopSupervised?: boolean
  surface?: UpdateSurface
  /**
   * Retry (§3.2): only these machine ids are in scope. Absent plans everything.
   * The remainder is computed by the caller from the operation being retried.
   */
  onlyMachines?: readonly string[]
  /** Links a remainder operation to the one it retries. */
  retryOf?: string
}

/**
 * A TARGET WITH NOTHING TO DELIVER — the source host's own identity, before its
 * release has been built and published into the feed.
 *
 * ASKED OF THE ARTIFACTS, NOT OF THE VERSION STRING. It used to be
 * `version.startsWith('dev+')`, which stopped being true the moment development
 * versions became orderable mints (`0.1.2-dev.4+abc1234`, POD-2502) — and would
 * stop being true again at the next naming change. The property that actually
 * matters is the one this names: the descriptor points at no bytes, so nobody
 * can converge to it, and on a host that can publish, the answer is to build and
 * publish a release. `canPrepare` is what fences that answer to such a host.
 */
export function needsDevelopmentBundle(target: {
  version: string
  artifacts: { headless?: unknown; headlessAlternatives?: readonly unknown[] }
}): boolean {
  return (
    target.artifacts.headless === undefined &&
    (target.artifacts.headlessAlternatives ?? []).length === 0
  )
}

/**
 * What publishing adds to a bare identity, and the only thing it adds.
 *
 * `feed` on every channel now: `bundle` named "a tarball this server packed and
 * pushed", which was a statement about who signed it rather than about how it
 * travels, and it travels as a feed download like everything else (spec §1).
 */
const PACKED_DELIVERY = 'feed'

type DeliverableTarget = {
  version: string
  artifacts: {
    headless?: { delivery: string }
    headlessAlternatives?: readonly { delivery: string }[]
  }
}

/**
 * Can THIS machine be handed THIS descriptor, as it stands, right now?
 *
 * The question used to be asked of the target alone — "has it been packed?" —
 * and that is what made git delivery an alternative offered ALONGSIDE the pack
 * rather than a substitute for it (POD-2195). Git delivery is retired, so an
 * identity target is now nothing to EVERY machine rather than nothing to only
 * some, and this reduces to "does the descriptor name bytes this machine can
 * take". The predicate stays because the caps question is still real: a target
 * can name bytes a particular machine has told us it cannot install.
 */
export function machineCanTakeTargetNow(
  machine: Pick<WaveMachine, 'deliveryCaps'>,
  target: DeliverableTarget,
): boolean {
  const deliveries = offeredDeliveries(target)
  // Nothing offered and nothing packed is nothing to hand anyone. Granting it
  // anyway is how the fleet used to learn by failing.
  if (deliveries.length === 0) return !needsDevelopmentBundle(target)
  return machineCanTakeDelivery(machine, deliveries)
}

/** Is there anyone here this descriptor can be handed to as it stands? */
export function fleetCanTakeTargetNow(
  target: DeliverableTarget,
  machines: readonly Pick<WaveMachine, 'deliveryCaps'>[],
): boolean {
  if (!needsDevelopmentBundle(target)) return true
  return machines.some((machine) => machineCanTakeTargetNow(machine, target))
}

/**
 * DOES THIS MACHINE NEED THE PACK — the stricter question, and deliberately so.
 *
 * {@link machineCanTakeDelivery} answers YES for a machine that has never
 * reported its capabilities, because refusing it would strand it forever. Here
 * the cost of being wrong runs the other way: skipping the pack for a machine
 * that turns out to need it buys a wave of rejections, while packing for one
 * that did not costs a build. So an unknown machine counts as needing it.
 */
function machineNeedsPack(machine: WaveMachine, target: DeliverableTarget): boolean {
  if (machine.deliveryCaps === undefined || machine.deliveryCaps.length === 0) return true
  return !machineCanTakeTargetNow(machine, target)
}

/**
 * A PLANNED PLACE HAS NOT BEEN ASKED ANYTHING YET (POD-2201).
 *
 * `pending` is §3.1's word for a place whose turn has not come, and it is what
 * every planned place is by construction: the plan is a statement of what this
 * operation INTENDS, made before it has said one word to any machine.
 *
 * It used to copy the machine's live convergence state instead, which quietly
 * made a new operation inherit the last one's outcome: a machine whose last word
 * was `rejected` — or that a cancel left `stuck` — was planned as a place that
 * had already failed, and {@link settleMachines} duly failed the step on it
 * before anything authorized a grant. `Try again` could therefore never clear a
 * refusal, which is a dead end §6.2 says the panel must not have.
 *
 * The same reasoning is already written down twice: {@link admissibleDeferredPlaces}
 * admits a machine as `pending`, and {@link projectMachines} refuses to call a
 * behind machine `current` however the wave labels it. The detail goes with the
 * state for the same reason — a sentence about a refusal is the refusal, in
 * prose. The first projection re-states both from the live fleet within the
 * step's first pass.
 */
function placeOf(machine: WaveMachine): StepPlace {
  return {
    id: machine.id,
    ...(machine.name ? { name: machine.name } : {}),
    state: 'pending',
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
    ...(input.databaseSnapshotPath ? { databaseSnapshotPath: input.databaseSnapshotPath } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
  }

  const channelMachines = input.fleet.filter(
    (machine) => input.channelOf(machine) === input.channel && isPackagedRolloutTarget(machine),
  )
  const serverDiffers = buildsDiffer(
    { version: input.appVersion, digest: input.sourceDigest },
    { version: target.version, digest: target.artifacts.web?.digest },
  )
  // A source process can rebuild its own current checkout, but it cannot swap
  // to a package for a different checkout. The operator owns that transition.
  const sourceCannotTakeTarget = input.serverInstallKind === 'source' && serverDiffers
  const host = input.hostMachineId
    ? input.fleet.find((machine) => machine.id === input.hostMachineId)
    : undefined
  // Server-only desktop mode intentionally has no local daemon, hence no host
  // machine report. Process ownership is the authoritative fact; a supervised
  // daemon row remains the backward-compatible corroborating signal.
  const desktopHosted = input.desktopSupervised === true || host?.supervised === true
  const hostUpdatesThroughFleet =
    host?.online === true && isPackagedRolloutTarget(host) && host.version !== target.version
  const steps: OperationPlan['steps'] = []
  const deferred: DeferredPlace[] = []
  const awaiting: AwaitingAsk[] = []

  // Desktop supervision is crash ownership only. Its host daemon is deliberately
  // in this same behind set, so an all-in-one is a coordinator of a fleet of one.
  const behind = channelMachines.filter(
    (machine) =>
      machine.version !== target.version &&
      (input.onlyMachines === undefined || input.onlyMachines.includes(machine.id)),
  )

  /**
   * THE PACK IS PLANNED PER DELIVERY CAPABILITY (POD-2195).
   *
   * It used to be planned for every bare `dev+<sha>` identity, whoever was in
   * the fleet — so a machine advertising git delivery alone waited on a package
   * it could never consume, and the server built 325 MB nothing would read.
   * Spec §9.2 says the machine that owns the checkout needs no build and no
   * download; §9.3 says the development path IS the production mechanism, so it
   * must not be the one path that needs a compiler.
   *
   * The honest question is therefore about the machines and not about the
   * target: pack when someone we are going to update cannot take what the
   * target already offers. `behind` rather than the wave's own selection,
   * because a machine that is merely ASLEEP converges against whatever is
   * published when it wakes (§3.6) — leaving it a bare identity would strand it
   * until a human ran another update.
   */
  const packable = needsDevelopmentBundle(target) && input.canPrepare
  if (packable && behind.some((machine) => machineNeedsPack(machine, target))) {
    steps.push({
      id: UPDATE_STEP_PREPARE,
      title: 'Preparing the update',
      state: 'pending',
    })
  }

  /**
   * A machine belongs in the wave if it can take this target NOW or once the
   * pack this plan just committed to has run. The second half is why a mixed
   * fleet's installed machine is waved rather than deferred: the artifact it
   * needs is a planned step of this very operation, not a state of the world.
   */
  const canTakeEventually = (machine: WaveMachine): boolean =>
    machineCanTakeTargetNow(machine, target) ||
    (packable && machineCanTakeDelivery(machine, [PACKED_DELIVERY]))
  const core = behind.filter((machine) => machine.online && canTakeEventually(machine))
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
  if (core.length > 0) {
    steps.push({
      id: UPDATE_STEP_MACHINES,
      title: 'Updating your machines',
      state: 'pending',
      progress: { done: 0, total: core.length },
      places: core.map(placeOf),
    })
  }

  if (
    !desktopHosted &&
    !hostUpdatesThroughFleet &&
    input.serverInstallKind !== 'source' &&
    serverDiffers &&
    input.canRestartServer
  ) {
    steps.push({
      id: UPDATE_STEP_SERVER,
      title: 'Updating your server',
      state: 'pending',
    })
  }

  const expectedWeb = target.artifacts.web?.digest
  const webBehind = expectedWeb !== undefined && input.servedWebDigest !== expectedWeb
  if (
    !desktopHosted &&
    !sourceCannotTakeTarget &&
    webBehind &&
    (input.canRebuildWeb || input.canPrepare || input.canRestartServer)
  ) {
    steps.push({
      id: UPDATE_STEP_WEB,
      title: 'Serving the new app',
      state: 'pending',
    })
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
  /**
   * The supervising parent's note about the release it installed, if it left one
   * (`run/parent-outcome.json`). Set when the parent rolled the machine back, or
   * could not and had to say why (decision 4). Without it the only thing this
   * server can report is that it came back on the wrong version — true, but it
   * reads as an unexplained failure when the parent in fact acted deliberately.
   */
  parentReport?: string
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
        ...(reality.parentReport ? { parentReport: reality.parentReport } : {}),
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
  } else if (server?.state === 'done' && reality.parentReport && reality.appVersion !== targetVersion) {
    // A successor that boots mid-handover adopts this operation, observes
    // itself on the target, and blesses the step — legitimately, on the happy
    // path. When its health gate then fails and the parent rolls the machine
    // back, the NEXT boot arrives here holding the parent's own rollback
    // sentence while the step still says done. The blessing must not outrank
    // that evidence: an update that was attempted and reverted settling as
    // clean success is exactly the lie this operation exists to not tell.
    const error = describeUpdateOperationFailure({
      code: 'server-did-not-reach-target',
      observedVersion: reality.appVersion,
      targetVersion,
      parentReport: reality.parentReport,
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
      next = patchStep(next, UPDATE_STEP_WEB, (step) => ({
        ...step,
        state: 'pending',
      }))
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
      /**
       * AND ACROSS THE RESTART TOO (POD-2172). This is where the same ordering
       * bit hardest: `adoptOnBoot` is awaited before the daemon gateway listens,
       * so NO machine is connected when reconciliation runs. Rewriting every
       * unfinished place to `offline` therefore erased the verdict of every
       * machine that had already given one, on every adoption — the persisted
       * `stuck` that the successor's whole job is to act on.
       */
      if (place.state !== undefined && TERMINAL_STATES.has(place.state as never)) {
        return { ...place, ...(machine.name ? { name: machine.name } : {}) }
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
    next = patchStep(next, UPDATE_STEP_PREPARE, (step) => ({
      ...step,
      state: 'pending',
    }))
  }

  /** Retire the required ask left by a pre-transition persisted operation once
   * its old shell has demonstrably returned on the target. New plans never mint
   * this ask; all-in-one Macs now converge through their ordinary machine step.
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
  /** This server's source identity, independent of its display label. */
  sourceDigest?: () => string | undefined
  /** Explicit process install shape; absent remains unknown and actionable. */
  serverInstallKind?: 'installed' | 'source'
  /** THIS host's machine id — how an all-in-one installation recognises itself. */
  hostMachineId?: string
  /** The coordinating server is a child of, and replaced by, Podium Desktop. */
  desktopSupervised?: boolean
  surface?: UpdateSurface
  /** Retry (§3.2): plan only these machines, and link back to the operation retried. */
  onlyMachines?: readonly string[]
  retryOf?: string
  /** The served website's commit, both dists (see `websiteDigestReader`). */
  servedWebDigest?: () => string | undefined
  /** Installed coordinator-only: place and verify the exact target before restart. */
  prepareCoordinatorUpdate?: (target: UpdateTarget) => Promise<void>
  requestDestBundle?: () => Promise<unknown>
  requestWebRebuild?: () => void
  requestCoordinatorRestart?: () => void
  /** The dev publisher's readiness, for naming a failed website build. */
  preparation?: () => {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
  /** Server-owned snapshot seam; daemon places deliberately have none. */
  createDatabaseSnapshot?: (fromVersion: string, targetVersion: string) => string | undefined
  /** Verified recovery point to carry into a new operation's failure guidance. */
  latestDatabaseSnapshot?: () => string | undefined
  /**
   * Synchronous because the path must be durable in the operation before the
   * restart request can terminate this process.
   */
  recordOperationDetails?: (operationId: string, patch: Record<string, unknown>) => void
  /**
   * Report progress for one step of THIS operation.
   *
   * MUST NOT BE AWAITED FROM INSIDE `ensure()`: it goes through the engine's
   * per-operation chain, which the caller of `ensure()` is holding. Every use
   * below is from a continuation that runs after `ensure()` has returned, which
   * is the same reason those runners answer `running` rather than blocking.
   */
  report?: (operationId: string, stepId: string, patch: StepProgressPatch) => void
  /**
   * Is this step still the one the engine is watching (POD-2173)? The fence for
   * anything this file leaves running after `ensure()` has returned.
   *
   * Optional, and absent means "carry on": a context assembled without an engine
   * has nothing that could have ended the step behind the watcher's back.
   */
  stepActive?: (operationId: string, stepId: string) => boolean
  /** Deferred wake-up for the watchers. Injected so a test never sleeps. */
  schedule?: (fn: () => void, ms: number) => void
  /** How often a watcher re-reads the world. */
  watchIntervalMs?: number
  /** How often a watched step says it is still there. Injected so tests never sleep. */
  heartbeatIntervalMs?: number
  now?: () => number
}

const DEFAULT_WATCH_INTERVAL_MS = 500

function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
}

/**
 * How often a step whose work is happening elsewhere says it is still there
 * (POD-2101).
 *
 * FIFTEEN SECONDS IS NOT ARBITRARY: the panel calls a step stale after sixty
 * seconds of silence, and a pack or a web rebuild runs for minutes with nothing
 * to report. Four heartbeats inside that window means one lost tick never reads
 * as trouble, and a step that genuinely dies is still visibly quiet long before
 * its total runs out.
 */
export const STEP_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * EVERY BUDGET IN THE UPDATE, IN ONE PLACE (POD-2101, spec §3.3).
 *
 * The numbers here nest, and the nesting is the point — it is asserted in
 * `operation.test.ts` rather than left to whoever edits one of them next:
 *
 *  - a daemon's own download timeout (5 min) and its git convergence budget
 *    (8 min) must expire BEFORE the coordinator gives up on that machine, so a
 *    failure arrives with the machine's own reason attached instead of being
 *    guessed from silence;
 *  - the machines step's silence budget must therefore outlast the longest
 *    legitimate quiet stretch any supported daemon can produce, which is the git
 *    budget — not the heartbeat cadence;
 *  - and every silence budget must be shorter than its step's total, or the
 *    total would be the only deadline that could ever fire.
 *
 * WHY NOT NINETY SECONDS, which this issue's plan proposed for a download: a
 * daemon that predates `percent` reports `downloading` once and then works in
 * silence for up to its whole download timeout. A 90 s step deadline would stall
 * and re-grant it mid-transfer, every time — the plan's own acceptance list
 * requires those daemons to converge. Ninety seconds is the right number for a
 * heartbeat that IS being sent (the panel's staleness line renders it from
 * `lastProgressAt` and needs nothing from us); it is the wrong number for the
 * deadline that fails a machine.
 */
export const UPDATE_BUDGETS = {
  /** `DEFAULT_DOWNLOAD_TIMEOUT_MS` in `@podium/runtime/update-delivery`. */
  downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
  /**
   * THE LONGEST A HEALTHY MACHINE MAY SAY NOTHING, and where that number comes
   * from now that git convergence is retired (spec disposition 5).
   *
   * It used to be `GIT_CONVERGENCE_BUDGET_MS`: a git convergence had no byte
   * count to report against, so its whole run was one silence and the server
   * had to out-wait it. Every delivery is now a feed download, which heartbeats
   * every two seconds — so the bound that matters is the daemon's own hard
   * deadline for a download that has stalled. Deriving it from the SAME
   * constant the daemon enforces is what keeps the daemon failing first; a
   * server that gives up earlier would age a machine into `stuck` while it was
   * still working.
   */
  machineDeliverySilenceMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
  /** The daemon's download heartbeat cadence, `PROGRESS_REPORT_INTERVAL_MS`. */
  downloadHeartbeatMs: PROGRESS_REPORT_INTERVAL_MS,
  /** This server's own heartbeat cadence for steps it is watching. */
  stepHeartbeatMs: STEP_HEARTBEAT_INTERVAL_MS,
  /** Margin between a daemon's longest silence and the step giving up on it. */
  machineSilenceMarginMs: 2 * 60_000,
} as const

/**
 * §3.3's per-step budgets, derived from {@link UPDATE_BUDGETS}. Silence is what
 * fires, not slowness: a nine-minute download reporting progress every two
 * seconds is healthy, and a two-minute one that says nothing is not.
 */
export const UPDATE_STEP_DEADLINES: Record<string, StepDeadlines> = {
  // Heartbeats now arrive while the pack runs, so this step is judged on
  // silence too rather than on its total alone.
  [UPDATE_STEP_PREPARE]: { silenceMs: 3 * 60_000, totalMs: 20 * 60_000 },
  // DERIVED: the daemon's own delivery silence bound plus a margin, so
  // whichever moves first stays coherent. Timer-armed by the engine rather than
  // ageing when someone reads `fleet()`.
  [UPDATE_STEP_MACHINES]: {
    silenceMs: UPDATE_BUDGETS.machineDeliverySilenceMs + UPDATE_BUDGETS.machineSilenceMarginMs,
    totalMs: 60 * 60_000,
  },
  // A restart reports nothing while it happens — this process is the thing
  // being replaced — so silence IS the restart deadline: five minutes without a
  // successor means it is not coming. The total is the outer backstop for a
  // successor that boots but never finishes adopting.
  [UPDATE_STEP_SERVER]: { silenceMs: 5 * 60_000, totalMs: 15 * 60_000 },
  // The web rebuild heartbeats while it runs, so silence here means the watcher
  // itself stopped, which is a much shorter wait than a build.
  [UPDATE_STEP_WEB]: { silenceMs: 2 * 60_000, totalMs: 15 * 60_000 },
}

/** In-flight preparation, per operation: `ensure()` twice must be one build. */
const preparing = new Map<string, Promise<unknown>>()

/**
 * Watch something this process handed off, reporting when it ends — and saying
 * it is still there while it has not (POD-2101).
 *
 * THE HEARTBEAT IS EVIDENCE, NOT DECORATION: it is sent only while `poll()` is
 * still answering "not finished", which means the watcher is alive, the work it
 * is watching has not failed, and this server is the one saying so. What it buys
 * is the difference between a pack that is running and a pack whose server died
 * — sixty seconds of silence is the first thing the panel calls trouble, and a
 * bundle takes minutes.
 *
 * `elapsed` names how long the step has been at it, so the sentence a human
 * reads moves too rather than just the timestamp underneath it.
 */
function watch(
  context: UpdateOperationContext,
  operationId: string,
  stepId: string,
  poll: () => StepProgressPatch | undefined,
  opts: {
    /** True once someone else has reported the outcome: stop, say nothing. */
    until?: () => boolean
    heartbeat?: (elapsedMs: number) => StepProgressPatch
  } = {},
): void {
  const schedule = context.schedule ?? defaultSchedule
  const interval = context.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  const beat = context.heartbeatIntervalMs ?? STEP_HEARTBEAT_INTERVAL_MS
  const now = context.now ?? Date.now
  const startedAt = now()
  let lastBeatAt = startedAt
  const tick = (): void => {
    if (opts.until?.() === true) return
    const patch = poll()
    if (patch === undefined) {
      const at = now()
      if (opts.heartbeat && at - lastBeatAt >= beat) {
        lastBeatAt = at
        context.report?.(operationId, stepId, opts.heartbeat(at - startedAt))
      }
      schedule(tick, interval)
      return
    }
    context.report?.(operationId, stepId, patch)
  }
  schedule(tick, interval)
}

/** "1 min 20 s", for a detail line that has to move while nothing else does. */
function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

/**
 * `prepare` — RESOLVE AND PREFLIGHT what the fleet will be handed (§3.1, audit
 * gap 21).
 *
 * The step used to be named for the one thing only a source host ever did:
 * pack a tarball. That was always the wrong altitude — edge and stable never
 * packed anything and simply had no such step — and it stopped describing even
 * the dev channel once `dev` became a pulled feed. What every channel actually
 * needs before a machine is granted anything is the same two facts, and they
 * are what this step now stands for:
 *
 *  - RESOLVED: the channel's feed advertises exactly the version this operation
 *    is delivering, pulled through `resolveReleaseTarget` like any other.
 *  - PREFLIGHTED: that resolve is what HEADs every artifact URL the manifest
 *    names and refuses a manifest with no schema declaration — so reaching the
 *    end of this step means the bytes are reachable and the build has said what
 *    database it can open, BEFORE any machine is told to go and fetch them.
 *
 * REALITY FIRST: a target that already carries a headless artifact is already
 * resolved and preflighted, whoever published it. That is also what makes this
 * safe to re-enter after adoption, after a stall retry, and after a retry
 * operation.
 *
 * On a source host the fact is not yet true when the step starts, and making it
 * true means building the release and publishing its manifest into the feed —
 * the pre-release stage of §6, which is the ONLY channel-specific thing left
 * here. It hands that build out and answers `running` rather than awaiting it:
 * a build is a compile, and awaiting it would hold the engine's chain, and
 * therefore the tRPC mutation that started the operation, for its whole length.
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
    // A PACK IS QUIET FOR MINUTES and has no percentage to offer, so its
    // liveness is "the build this server started has not settled yet" — true,
    // observable here, and the whole difference between a healthy prepare step
    // and one the panel calls stuck after sixty seconds (POD-2101).
    watch(context, operation.id, UPDATE_STEP_PREPARE, () => undefined, {
      // The settle handlers below report the outcome; this watcher only ever
      // reports that the outcome has not arrived yet.
      until: () => !preparing.has(operation.id),
      heartbeat: (elapsedMs) => ({
        state: 'running',
        detail: `Building the update package… ${elapsedLabel(elapsedMs)}`,
      }),
    })
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

    /**
     * A VERDICT THIS OPERATION DID NOT ASK FOR IS NOT THIS OPERATION'S VERDICT
     * (POD-2201, spec §6.2, §7).
     *
     * The step used to settle before it authorized anything, so a machine whose
     * last word — to a PREVIOUS operation, or to a cancel that left it `stuck` —
     * was terminal decided this one in under ten milliseconds, with zero grants
     * issued and nothing asked of the machine. The panel then offered Try again,
     * which is another operation, which failed the same way: a button that
     * looked like a way out and could not be one. Starting an update is a new
     * human decision, and §6.2's promise is that a failure is never a dead end.
     *
     * WHY THIS IS NOT "MOVE `markAuthorized` UP". Forgetting a verdict on every
     * pass would forget the one the wave is being failed on and re-grant on the
     * next re-entry, forever — the hot loop POD-2105's terminal guard and its
     * per-machine attempt cap exist to prevent. So it is asked per PLACE, and
     * only of a place this operation has not yet put anything to: a place still
     * `pending` has been granted nothing by this step, so any verdict against it
     * was given to somebody else's decision. The moment a place is granted, its
     * carried state stops being `pending` and its verdict settles the step in
     * the usual way — one grant per human decision, on this route and on
     * `authorizeMachine`'s alike.
     *
     * It runs before the delivery gate below rather than after, because it is a
     * statement about authority and not about readiness: a step that is still
     * waiting for its package must not be sitting on a stale refusal either.
     */
    const untouched = (step.places ?? [])
      .filter((place) => place.state === undefined || place.state === 'pending')
      .map((place) => place.id)
    if (untouched.length > 0) context.updates.clearMachineVerdicts(details.channel, untouched)

    const settled = settleMachines(operation, step, context)
    if (settled) return settled

    /**
     * NEVER GRANT WHAT CANNOT BE DELIVERED — asked of the MACHINES this step is
     * waiting on, not of the target alone (POD-2195).
     *
     * `prepare` is supposed to have left a packed descriptor published for this
     * version; if it has not, ticking would hand an installed daemon a bare
     * `dev+<sha>` identity it can only refuse — the fleet learning by failing,
     * which is exactly the defect the delivery-capability work removed. Staying
     * `running` instead means the step's own deadline decides, visibly, rather
     * than a wave of rejections.
     *
     * But a machine that owns a checkout can take that identity TODAY: it names
     * a repo and a sha, which is the whole of what git delivery needs. Asking
     * only "has it been packed?" held such a machine behind a package it could
     * never consume, for a package this plan may not even contain (spec §9.2).
     * The wave planner does the same per-machine filtering at grant time, so a
     * mixed fleet advances the git machines here and picks the rest up when the
     * packed descriptor arrives.
     */
    const published = context.updates.target(details.channel) ?? details.target
    const awaited = new Set((step.places ?? []).map((place) => place.id))
    const waiting = context.updates.fleet().filter((machine) => awaited.has(machine.id))
    if (!fleetCanTakeTargetNow(published, waiting)) {
      return {
        state: 'running',
        detail: 'Waiting for the update package.',
        ...projectMachines(operation, step, context),
      }
    }

    /**
     * THE ONE AUTOMATIC RETRY, FOR A MACHINE MID-GRANT (§3.3, POD-2101).
     *
     * The engine re-enters `ensure()` after it has marked this step `stalled`,
     * and by itself that would change nothing: the wave planner deliberately
     * skips a machine it believes is mid-grant, so `tick()` would select nobody
     * and the step would go straight back to waiting on the same silence. Re-
     * issuing the grant is what a retry MEANS here — safe because the daemon's
     * grant runner serializes: the same grant id is ignored, a newer one cancels
     * the delivery in flight before taking over.
     *
     * `stalls` rather than `attempts`, because adoption after a server restart
     * also re-enters this runner and that is not a stall — the successor should
     * let the existing grants stand and watch them.
     */
    if ((step.stalls ?? 0) > 0) context.updates.reissueGrants(details.channel)

    context.updates.markAuthorized(details.channel)
    context.updates.tick(details.channel)
    const progress = projectMachines(operation, step, context)
    return { state: 'running', ...progress }
  },
}

/**
 * THE PLACES THIS STEP IS ACTUALLY WAITING ON (POD-2167).
 *
 * The wave holds a grant open for these and for nothing else, so these are the
 * places whose silence is the step's silence. Everything outside the set is
 * quiet for a reason that is not trouble: `current` and `restarting` have
 * arrived, `pending` has not been granted anything to be silent about, and
 * `rejected`/`stuck` have already said their piece — `settleMachines` fails the
 * step on those the moment it sees them, so a clock on them would only race it.
 *
 * `offline` IS in the set, and deliberately: a daemon that dropped mid-grant is
 * the exact machine §7's `machine-unreachable` is for. A machine that was
 * offline when the plan was made is not here at all — it is `deferred` (§3.6).
 */
const AWAITED_PLACE_STATES: ReadonlySet<string> = new Set(['granted', 'downloading', 'offline'])

/**
 * Give one projected place its clock, by comparing it with what was last
 * recorded about the same machine (POD-2167).
 *
 * PROGRESS IS A CHANGE IN WHAT THE MACHINE IS DOING — its state, how far it has
 * got, what it says about itself. It is deliberately not "a frame arrived": the
 * daemon reports every two seconds whether or not anything moved, and treating
 * arrival as progress is a smaller version of the same mistake as treating the
 * whole wave's traffic as one step's heartbeat. A download frozen at 62% for ten
 * minutes has stopped, and should be found to have stopped.
 *
 * `name` is excluded because a machine being renamed is not the update moving.
 */
function clockPlace(carried: StepPlace, projected: StepPlace, now: number): StepPlace {
  const { lastProgressAt: _wasAt, ...was } = carried
  const { lastProgressAt: _isAt, ...is } = projected
  if (projected.state === undefined || !AWAITED_PLACE_STATES.has(projected.state)) return is
  const moved = was.state !== is.state || was.percent !== is.percent || was.detail !== is.detail
  return { ...is, lastProgressAt: moved ? now : (carried.lastProgressAt ?? now) }
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
  const now = (context.now ?? Date.now)()
  const fleet = new Map(context.updates.fleet().map((machine) => [machine.id, machine]))
  const places = (step.places ?? []).map((carried) => clockPlace(carried, project(carried), now))

  function project(carried: StepPlace): StepPlace {
    /**
     * THE PERCENTAGE IS NEVER CARRIED FORWARD (POD-2101). Every other field on
     * a place is a description of the machine that survives being re-stated;
     * `percent` describes a phase, and a phase ends. Spreading the previous
     * place would leave "62%" sitting under `restarting` — a number about work
     * that has already finished, on the one contract whose whole subject is
     * whether work is moving.
     */
    const { percent: _endedWithItsPhase, ...place } = carried
    const machine = fleet.get(place.id)
    if (!machine) return { ...place, state: 'offline' }
    /**
     * THE PERSISTED VERDICT IS THE ONLY COPY, ACROSS A RESTART (POD-2172).
     *
     * Everything below reads the LIVE service, whose convergence state is
     * in-memory and dies with the process. So a machine that reported `stuck`
     * before a coordinator restart has its answer in exactly one place
     * afterwards — the place this projection is about to overwrite. Fixing the
     * ordering in {@link reconcileUpdateOperation} alone would not have helped:
     * `ensure()` re-projects immediately and would lose it again a moment later.
     *
     * Held only while the machine is unreachable and still behind. A daemon that
     * has come back speaks for itself, and the target-version proof below is
     * always allowed to overrule a verdict — a machine that is now ON the target
     * did not, in the end, fail to update.
     */
    if (
      !machine.online &&
      machine.version !== targetVersion &&
      place.state !== undefined &&
      TERMINAL_STATES.has(place.state as never)
    ) {
      return { ...place, ...(machine.name ? { name: machine.name } : {}) }
    }
    if (
      targetVersion !== undefined &&
      context.updates.machineBootedAtTarget(machine.id as MachineId, targetVersion)
    ) {
      return {
        ...place,
        state: 'current',
        percent: 100,
        name: machine.name ?? place.name,
      }
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
      return {
        ...place,
        state: 'restarting',
        name: machine.name ?? place.name,
      }
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
    /**
     * A VERDICT OUTLIVES THE CONNECTION THAT CARRIED IT (POD-2172).
     *
     * `offline` describes reachability; `rejected` and `stuck` describe what the
     * machine SAID. Testing reachability first threw the second away: a daemon
     * that reported `stuck` with a dirty working tree and was then restarted so
     * the operator could look at the checkout projected as `offline`, which
     * {@link settleMachines} does not fail on — so the wave stopped seeing a
     * failure it had already been told about and waited out ten minutes of
     * silence to end with a nameless `stalled` instead of the one sentence that
     * says what to fix.
     */
    const verdict = TERMINAL_STATES.has(machine.state) ? machine.state : undefined
    return {
      ...place,
      state: verdict ?? (!machine.online ? 'offline' : resting ? 'pending' : machine.state),
      ...(machine.name ? { name: machine.name } : {}),
      ...(machine.detail ? { detail: machine.detail } : {}),
      /**
       * "vmi3407763 downloading 62%" (§6.2), from the daemon's own heartbeat.
       * Carried only while the machine is actually converging: a percentage
       * left on a resting or offline place would be a number describing work
       * that is not happening, which is the failure mode this whole issue is
       * about (POD-2101).
       */
      ...(machine.online && !resting && machine.percent !== undefined
        ? { percent: machine.percent }
        : {}),
    }
  }

  const done = places.filter((place) => place.state === 'current').length
  return { places, progress: { done, total: places.length } }
}

/**
 * NAME THE MACHINE THE TIMEOUT IS ABOUT (POD-2167, §7).
 *
 * The engine's generic answer to a silence deadline is "This step ran out of
 * time" — true, and useless to the person who now has to go and look at
 * something. The breach carries the places whose own clocks expired, so the one
 * failure a fleet update is most likely to produce can say WHICH machine went
 * quiet and, when it managed to say why before it did, what it said.
 *
 * `undefined` for every other step: `prepare`, `server` and `web` act on this
 * machine and have nobody to name, and the framework's sentence is already the
 * best available. Also `undefined` when no place breached — a `total` overrun,
 * or a step whose clock is its own — because inventing a culprit out of a
 * step-wide timeout would be worse than the generic sentence, not better.
 */
export function describeUpdateStall(input: {
  step: OperationStep
  breach: { places: string[] }
}): OperationError | undefined {
  if (input.step.id !== UPDATE_STEP_MACHINES) return undefined
  const silent = new Set(input.breach.places)
  const places = (input.step.places ?? []).filter((place) => silent.has(place.id))
  const first = places[0]
  if (!first) return undefined
  return describeUpdateOperationFailure({
    code: classifyMachineFailure(first.detail),
    places: places.map((place) => place.id),
    names: places.map((place) => place.name ?? place.id),
    ...(first.detail ? { detail: first.detail } : {}),
  })
}

/**
 * Has the wave reached an outcome? `done` when every planned machine is at the
 * target by raw reconnect identity, `failed` when one reported a verdict only
 * a human can clear. Crossing the restart boundary remains in progress.
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
    const code = classifyMachineFailure(first.detail)
    const snapshotPath = updateOperationDetails(operation)?.databaseSnapshotPath
    const failure: UpdateFailure =
      code === 'machine-schema-advanced'
        ? {
            code,
            ...shared,
            ...(snapshotPath ? { databaseSnapshotPath: snapshotPath } : {}),
          }
        : { code, ...shared }
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
    if (!context.createDatabaseSnapshot || !context.recordOperationDetails) {
      return {
        state: 'failed',
        error: describeUpdateOperationFailure({
          code: 'preparation-failed',
          detail: 'Database snapshot support is unavailable; the server was not restarted.',
        }),
      }
    }
    if (context.prepareCoordinatorUpdate) {
      try {
        await context.prepareCoordinatorUpdate(details.target)
      } catch (error) {
        return {
          state: 'failed',
          error: describeUpdateOperationFailure({
            code: 'download-failed',
            detail: error instanceof Error ? error.message : String(error),
          }),
        }
      }
    }
    let databaseSnapshotPath: string | undefined
    try {
      databaseSnapshotPath = context.createDatabaseSnapshot(
        details.fromVersion ?? context.appVersion(),
        details.target.version,
      )
      if (!databaseSnapshotPath) throw new Error('the database has no snapshotable file')
      context.recordOperationDetails(operation.id, { databaseSnapshotPath })
    } catch (error) {
      return {
        state: 'failed',
        error: describeUpdateOperationFailure({
          code: 'preparation-failed',
          detail: `Database snapshot failed; the server was not restarted: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      }
    }
    context.requestCoordinatorRestart()
    return {
      state: 'running',
      detail: `Database snapshot: ${databaseSnapshotPath}. Restarting the server…`,
    }
  },
}

/**
 * `web` — VERIFY THE PAGE ROLLOUT AFTER THE RESTART (§3.1, audit gap 21).
 *
 * Reality first, and the reality is the digest of the website this process is
 * actually serving. The step's normal outcome is therefore to OBSERVE, not to
 * act: on every channel the new `web/` dist ships inside the headless bundle
 * and becomes current the moment the swap-and-restart of the `server` step
 * completes, so by the time this step is reached the correct answer is usually
 * already true. That restates dev-web-build's blast-radius rule (audit gap 22)
 * from the operation's side: the dist only ever moves on an operator-approved
 * update, and this is the step that confirms it moved.
 *
 * The rebuild it can still ask for is the source-host case, where there is no
 * unpacked bundle behind the served dist and the website has to be produced
 * from the checkout. That is the same pre-release stage `prepare` runs, and it
 * is the last channel-specific thing on this path.
 *
 * Reloading open TABS is not this step's business and never blocks it: the
 * reload ask is voluntary (§3.5), because a tab that has not reloaded is a
 * straggler that self-serves on its next load.
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
    watch(
      context,
      operation.id,
      UPDATE_STEP_WEB,
      () => {
        if (read?.() === expected) {
          return { state: 'done', detail: 'The new app is being served.' }
        }
        const failure = context.preparation?.().failureDetail
        if (failure !== undefined) {
          return {
            state: 'failed',
            error: describeUpdateOperationFailure({
              code: 'web-build-failed',
              detail: failure,
            }),
          }
        }
        return undefined
      },
      {
        /**
         * THE EXIT THIS WATCHER DID NOT HAVE (POD-2173).
         *
         * `poll()` above answers `undefined` until the digest matches or the
         * publisher reports a failure, and neither can happen once a rebuild has
         * outrun the step's fifteen-minute total — which is the one deadline
         * that CAN fire here, because the heartbeat comes from this very
         * watcher, so the two-minute silence budget can never expire while it
         * lives. The step failed and the watcher it left behind carried on
         * reading a digest off disk twice a second for the life of the process,
         * one more of them for every re-entry, and `engine.stop()` could not
         * sweep any of them: these timers belong to the kind.
         *
         * `prepare` has had this guard all along, keyed on its own in-flight
         * map. `web` hands its work to a publisher it does not own, so the fence
         * is the engine's answer instead: the step is no longer in flight.
         */
        until: () => !(context.stepActive?.(operation.id, UPDATE_STEP_WEB) ?? true),
        // A rebuild is a compile too: minutes of nothing, and the stamp on disk
        // only changes at the very end (POD-2101).
        heartbeat: (elapsedMs) => ({
          state: 'running',
          detail: `Rebuilding the app… ${elapsedLabel(elapsedMs)}`,
        }),
      },
    )
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
    describeStall: describeUpdateStall,
    describeWaitingExpiry: describeUpdateWaitingExpiry,
  }
}

/** §7's code for the all-in-one update nobody installed. */
export const UPDATE_NOT_INSTALLED_ERROR_CODE = 'update-not-installed'

/**
 * THE GRACE RAN OUT — WAS ANYTHING ACHIEVED? (POD-2186.)
 *
 * New all-in-one plans have an ordinary machine step. This still classifies a
 * pre-transition persisted operation whose only content is the old required
 * desktop-install ask; expiry must not rewrite "nobody installed it" as success.
 *
 * SO THE TEST IS "DID ANY STEP GET DONE", not "is this the all-in-one plan".
 * The question the framework is really asking is whether completing is honest,
 * and a plan that finished no work has nothing to be honest about whatever the
 * reason. A retry whose remainder is empty would land here too, and should.
 */
export function describeUpdateWaitingExpiry(input: {
  operation: Operation
}): OperationError | undefined {
  const steps = input.operation.steps ?? []
  // `done` is the ONLY state that is work achieved. `skipped` is a step that
  // did not apply, which is exactly as vacuous as having no step at all.
  if (steps.some((step) => step.state === 'done')) return undefined
  const ask = (input.operation.awaiting ?? []).find((candidate) => candidate.required === true)
  const place = ask?.place
  return {
    code: UPDATE_NOT_INSTALLED_ERROR_CODE,
    // §7: the sentence a person reads, written by the side that knows what
    // happened. The panel's taxonomy falls through to this message for a code it
    // does not carry, so an older bundle still owes the operator the truth.
    message: place
      ? `The update was offered in Podium Desktop on ${place}, and nobody installed it.`
      : 'The update was offered in Podium Desktop, and nobody installed it.',
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
    admitDeferred(
      id: string,
      stepId: string,
      placeIds: readonly string[],
      patch: StepProgressPatch,
    ): Promise<void>
    reensure(id: string, stepId: string, patch?: StepProgressPatch): Promise<void>
  }
  updates: UpdatesService
  /**
   * THE ENGINE'S CLOCK, because this is where the places get their timestamps
   * (POD-2167). A bridge reading `Date.now()` while the engine it reports to is
   * on another clock writes stamps that engine can only read as the far future —
   * which silently disables every deadline the step has. Defaults to real time,
   * which is what the composition root's engine uses.
   */
  now?: () => number
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
        ...(deps.now ? { now: deps.now } : {}),
      }

      // §3.6: a deferred machine that woke up while its own step is still
      // running belongs to THIS update, not to the reconciler that would
      // otherwise pick it up afterwards. Admitted BEFORE the projection below,
      // so its first appearance in the payload is already inside the step's
      // places and its own progress — never as a place the panel has to
      // discover in a later frame.
      const admitted = admissibleDeferredPlaces(row.operation, details, deps.updates)
      if (admitted.length > 0) {
        const places = [...(step.places ?? []), ...admitted]
        void deps.engine.admitDeferred(
          row.id,
          UPDATE_STEP_MACHINES,
          admitted.map((place) => place.id),
          {
            places,
            progress: {
              done: places.filter(isArrived).length,
              total: places.length,
            },
          },
        )
        return
      }

      const settled = settleMachines(row.operation, step, context)
      const projected = settled ?? {
        state: 'running' as const,
        ...projectMachines(row.operation, step, context),
      }

      /**
       * A MACHINE THE WAVE WAS WAITING ON JUST CAME BACK (POD-2167).
       *
       * Reporting progress is not enough for this one event. `tick()` plans
       * against machines that are online RIGHT NOW, so a machine that was
       * offline when the step last ran was not offered a grant and will not be
       * offered one by anything that merely watches. The step has to be entered
       * again, and this edge — offline, then not — is the only fleet event that
       * changes what it could do.
       *
       * It is what makes a coordinator restart taken mid-wave resume properly:
       * `adoptOnBoot` runs before the gateway listens, so the resumed step sees
       * every place offline, and this is each daemon's reconnect arriving to say
       * the fleet is real after all. Keyed on the transition rather than on the
       * state, so a machine that stays down costs one re-entry and not one per
       * event — and a machine that flaps gets exactly the retry it deserves.
       */
      const wasOffline = new Set(
        (step.places ?? []).filter((place) => place.state === 'offline').map((place) => place.id),
      )
      const returned =
        settled === undefined &&
        (projected.places ?? []).some(
          (place) =>
            wasOffline.has(place.id) && place.state !== undefined && place.state !== 'offline',
        )
      if (returned) {
        void deps.engine.reensure(row.id, UPDATE_STEP_MACHINES, projected)
        return
      }

      void deps.engine.recordProgress(row.id, UPDATE_STEP_MACHINES, projected)
    },
  }
}

const isArrived = (place: StepPlace): boolean => place.state === 'current'

/**
 * WHICH DEFERRED PLACES MAY JOIN THE WAVE NOW (§3.6).
 *
 * A place is deferred because it was asleep (or could not take the artifact) at
 * plan time. The question here is the same one the plan asked, asked again
 * against the live fleet: is it online, is it still behind, is it ours to
 * update, and can it take what is being handed out? Anything else stays
 * deferred and converges through the standing reconciler after the operation
 * ends — which is the honest outcome, not a fallback.
 */
export function admissibleDeferredPlaces(
  operation: Operation,
  details: UpdateOperationDetails,
  updates: UpdatesService,
): StepPlace[] {
  const deferred = operation.deferred ?? []
  if (deferred.length === 0) return []
  const published = updates.target(details.channel) ?? details.target
  const deliveries = offeredDeliveries(published)
  const fleet = new Map(updates.fleet().map((machine) => [machine.id, machine]))
  const admitted: StepPlace[] = []
  for (const place of deferred) {
    const machine = fleet.get(place.id)
    if (!machine?.online) continue
    if (!isPackagedRolloutTarget(machine)) continue
    if (machine.version === details.target.version) continue
    if (updates.channelOf(machine) !== details.channel) continue
    if (deliveries.length > 0 && !machineCanTakeDelivery(machine, deliveries)) continue
    admitted.push({
      id: machine.id,
      ...(machine.name ? { name: machine.name } : {}),
      state: 'pending',
    })
  }
  return admitted
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
    sourceDigest: context.sourceDigest?.(),
    ...(context.serverInstallKind ? { serverInstallKind: context.serverInstallKind } : {}),
    servedWebDigest: context.servedWebDigest?.(),
    canPrepare: context.requestDestBundle !== undefined,
    canRebuildWeb: context.requestWebRebuild !== undefined,
    databaseSnapshotPath: context.latestDatabaseSnapshot?.(),
    canRestartServer: context.requestCoordinatorRestart !== undefined,
    ...(context.hostMachineId ? { hostMachineId: context.hostMachineId } : {}),
    ...(context.desktopSupervised ? { desktopSupervised: true } : {}),
    ...(context.surface ? { surface: context.surface } : {}),
    ...(context.onlyMachines ? { onlyMachines: context.onlyMachines } : {}),
    ...(context.retryOf ? { retryOf: context.retryOf } : {}),
  }
}

/** Reset the module-level in-flight preparation map. Tests only. */
export function resetUpdateOperationState(): void {
  preparing.clear()
}
