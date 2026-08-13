import { asMachineId, type MachineId } from '@podium/model'
import type { ConvergenceState, MobileWebIdentity } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { serverBuildVersion } from '../../build-version'
import { type Context, t } from '../../trpc'
import { familyState } from '../derived-family'
import type { UpdatesService } from './service'

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const FAILED: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])
const COORDINATOR_RESTART_POLL_MS = 250
/**
 * Backstop only. The wait normally ends when the grants it is waiting on stop
 * being in flight — the same inactivity deadline the service applies — so this
 * is deliberately generous and must never be the thing that ends a healthy,
 * slowly-progressing update.
 */
const COORDINATOR_RESTART_DEADLINE_MS = 60 * 60_000
const COORDINATOR_WAIT_ABANDONED_DETAIL =
  'The machine stopped reporting progress while updating, so the server stopped waiting for it.'
const WEB_IDENTITY_POLL_MS = 500
const WEB_IDENTITY_WAIT_MS = 5 * 60_000

function isDevelopmentMachine(machine: { channel?: string }): boolean {
  return (machine.channel ?? 'dev') === 'dev'
}

/** dest+HEAD with no dest tarball cannot be delivered to dest bundle/feed machines. */
function canGrantDevelopmentFleet(target: {
  version: string
  artifacts: { headless?: unknown }
}): boolean {
  if (!target.version.startsWith('dev+')) return true
  return target.artifacts.headless !== undefined
}

function needsDevelopmentBundle(target: {
  version: string
  artifacts: { headless?: unknown }
}): boolean {
  return target.version.startsWith('dev+') && target.artifacts.headless === undefined
}

/**
 * ONE WEBSITE, TWO DISTS (POD-1980).
 *
 * `podium-web` builds the desktop shell and the phone export in one run, and
 * `artifacts.web.digest` names one commit for both. So the website has an
 * identity only when both halves agree on it — otherwise a phone left on last
 * week's export reads as current because the desktop half is fresh.
 *
 * Answering `undefined` while the phone lags is what makes "is the website
 * behind" one question with one answer. It is deliberately NOT what the dest
 * tarball gate waits on: that gate protects the bytes it packs, and it packs
 * `apps/web/dist` only. Comparing the phone against the desktop rather than
 * against the expected commit is deliberate and equivalent — a desktop half that
 * is itself behind already fails the caller's `=== expected`.
 *
 * An ABSENT phone dist is not behind: an installation that never exported one
 * has nothing to rebuild, and reading its silence as staleness would leave
 * Update offering work forever.
 */
export function websiteDigestReader(
  readDesktop: (() => string | undefined) | undefined,
  readPhone: (() => MobileWebIdentity) | undefined,
): (() => string | undefined) | undefined {
  if (!readDesktop) return undefined
  if (!readPhone) return readDesktop
  return () => {
    const desktop = readDesktop()
    if (desktop === undefined) return undefined
    const phone = readPhone()
    return phone.present && phone.digest !== desktop ? undefined : desktop
  }
}

export async function waitForServedWebDigest(
  expected: string,
  read: () => string | undefined,
  pollMs = WEB_IDENTITY_POLL_MS,
  deadlineMs = WEB_IDENTITY_WAIT_MS,
  now: () => number = Date.now,
): Promise<void> {
  const started = now()
  for (;;) {
    if (read() === expected) return
    if (now() - started >= deadlineMs) {
      throw new Error('The website did not finish rebuilding in time.')
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs)
      timer.unref?.()
    })
  }
}

export interface UpdateFleetMachine {
  id: MachineId
  name?: string
  version: string
  state: ConvergenceState
  online: boolean
  busy: boolean
  detail?: string
}

export interface UpdateFleetSnapshot {
  targetVersion: string | null
  total: number
  behind: number
  converging: number
  failed: number
  preparation?: {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
  machines: UpdateFleetMachine[]
  /**
   * Every registered machine, whatever its channel. `machines` above is the
   * dev-authority wave the global dialog accounts for; Settings needs one row
   * per machine so an edge/stable row can show its own convergence.
   */
  allMachines: UpdateFleetMachine[]
}

function fleetSnapshot(updates: UpdatesService): UpdateFleetSnapshot {
  const targetVersion = updates.targetVersion()
  // The global dialog is the coordinating source server's dev-authority wave.
  // Edge/stable machines have their own explicit per-row targets and actions;
  // comparing them with the dev target invents behind places this mutation
  // cannot and must not grant.
  const allMachines = updates
    .fleet()
    .map((machine) => ({ ...machine, id: asMachineId(machine.id) }))
  const machines = allMachines.filter((machine) => isDevelopmentMachine(machine))
  const target = updates.target()
  const grantable = target !== undefined && canGrantDevelopmentFleet(target)
  const behind = targetVersion
    ? machines.filter((machine) => machine.version !== targetVersion).length
    : 0

  return {
    targetVersion: targetVersion ?? null,
    total: machines.length,
    behind,
    converging: grantable ? machines.filter((machine) => IN_FLIGHT.has(machine.state)).length : 0,
    failed: grantable ? machines.filter((machine) => FAILED.has(machine.state)).length : 0,
    machines,
    allMachines,
  }
}

/**
 * Wait for the development fleet to boot at the target, then restart the
 * coordinator.
 *
 * The wait is BOUNDED, and bounded by the SAME rule as the grants it waits on:
 * it continues while at least one outstanding machine is still in flight, and
 * stops as soon as none is. A daemon that never comes back used to leave this
 * polling every 250ms forever, holding the coordinator on the old build with
 * nothing in the UI ever failing; now the service's inactivity deadline turns
 * that machine into a visible `stuck` and this wait ends with it.
 *
 * It gives up WITHOUT restarting. Restarting under an unknown fleet state is
 * the outcome the handshake gate exists to prevent.
 */
export function restartCoordinatorAfterDevelopmentFleet(
  updates: UpdatesService,
  targetVersion: string,
  affectedMachineIds: readonly MachineId[],
  requestCoordinatorRestart: () => void,
  pollMs = COORDINATOR_RESTART_POLL_MS,
  deadlineMs = COORDINATOR_RESTART_DEADLINE_MS,
  now: () => number = Date.now,
): void {
  const startedAt = now()
  const check = (): void => {
    // Reading the fleet is what ages a silent grant, so this poll and the
    // service share ONE notion of failure.
    const fleet = new Map(updates.fleet().map((machine) => [machine.id, machine]))
    const outstanding = affectedMachineIds.filter(
      (machineId) => !updates.machineBootedAtTarget(machineId, targetVersion),
    )
    if (outstanding.length === 0) {
      requestCoordinatorRestart()
      return
    }

    // Keep waiting exactly as long as the grants themselves are alive. A
    // machine reporting `restarting` at minute nine is progress, not a reason
    // to give up; the service's silence deadline decides when it stops being
    // progress, and this stops when it does. An absolute clock here would have
    // abandoned a working update the service was still happy with.
    const stillWorking = outstanding.some((machineId) => {
      const state = fleet.get(machineId)?.state
      return state !== undefined && IN_FLIGHT.has(state)
    })
    if (!stillWorking) return

    // Backstop only: never leave a timer running forever if a machine somehow
    // stays in flight without the service ever aging it out.
    if (now() - startedAt >= deadlineMs) {
      updates.abandonWait(outstanding, COORDINATOR_WAIT_ABANDONED_DETAIL)
      return
    }
    const timer = setTimeout(check, pollMs)
    timer.unref?.()
  }
  check()
}

/** The fleet read model used by the dialog and Settings. */
export function updateFleet(ctx: Context): UpdateFleetSnapshot {
  const fleet = fleetSnapshot(familyState(ctx).modules.updates)
  const preparation = ctx.updatePreparation?.()
  return preparation ? { ...fleet, preparation } : fleet
}

/**
 * Human-authorized entry point for every place behind the server's target. The
 * wave service remains the authority for what gets granted; this procedure
 * records the operator's one decision and starts its planner-controlled wave.
 */
export function startUpdate(
  updates: UpdatesService,
  currentVersion = serverBuildVersion(),
  requestCoordinatorRestart?: () => void,
  opts?: {
    servedWebDigest?: string | (() => string | undefined)
    /** The phone website on disk, read when asked. Absent means "no phone app
     *  here", which is not a stale phone app — see `servedWebIdentity` (POD-1980). */
    servedMobileWeb?: () => MobileWebIdentity
    requestWebRebuild?: () => void
    requestDestBundle?: () => Promise<unknown>
  },
): {
  state: 'in-progress'
  version: string
  done: number
  total: number
  fleet: UpdateFleetSnapshot
  grantedMachineIds: string[]
  includesBundle: boolean
} {
  const target = updates.target()
  if (!target) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No update target is configured.',
    })
  }
  const initialFleet = fleetSnapshot(updates)
  const serverBehind = currentVersion !== target.version
  const expectedWeb = target.artifacts.web?.digest
  const readDesktopWeb =
    typeof opts?.servedWebDigest === 'function'
      ? opts.servedWebDigest
      : opts?.servedWebDigest !== undefined
        ? () => opts.servedWebDigest as string
        : undefined
  // The WEBSITE is both dists, so that is what "behind" is measured against.
  const readWebsite = websiteDigestReader(readDesktopWeb, opts?.servedMobileWeb)
  const webBehind = expectedWeb !== undefined && readWebsite?.() !== expectedWeb
  if (!serverBehind && !webBehind && initialFleet.behind === 0 && initialFleet.converging === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
  }
  const rebuildWeb = opts?.requestWebRebuild ?? requestCoordinatorRestart
  if (webBehind && !serverBehind && !rebuildWeb) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This Podium installation cannot rebuild its web app automatically.',
    })
  }

  const grantable = canGrantDevelopmentFleet(target)
  const packDevelopment = needsDevelopmentBundle(target) && opts?.requestDestBundle !== undefined
  const grantedMachineIds = grantable ? updates.authorize() : []
  if (!grantable && packDevelopment) updates.markAuthorized()

  const affectedMachineIds = initialFleet.machines
    .filter((machine) => machine.online && machine.version !== target.version)
    .map((machine) => machine.id)

  if (packDevelopment && opts.requestDestBundle) {
    if (webBehind && rebuildWeb) rebuildWeb()
    void continueDevelopmentUpdate({
      updates,
      targetVersion: target.version,
      expectedWeb,
      webBehind,
      // The DESKTOP dist, deliberately, though `webBehind` above counts both.
      // This wait exists so a tarball is not packed around yesterday's website,
      // and the tarball carries `apps/web/dist` only — waiting on the phone
      // export here would hold every remote machine's update for bytes none of
      // them receive. A phone-only staleness therefore satisfies this wait at
      // once and is finished by the page's own wait instead (POD-1980).
      readServedWeb: readDesktopWeb,
      requestDestBundle: opts.requestDestBundle,
      serverBehind,
      requestCoordinatorRestart,
      affectedMachineIds,
    })
  } else if (serverBehind && requestCoordinatorRestart) {
    if (grantedMachineIds.length > 0) {
      restartCoordinatorAfterDevelopmentFleet(
        updates,
        target.version,
        affectedMachineIds,
        requestCoordinatorRestart,
      )
    } else {
      requestCoordinatorRestart()
    }
  } else if (webBehind && rebuildWeb) {
    rebuildWeb()
  }

  return {
    state: 'in-progress',
    version: target.version,
    done: 0,
    total: Math.max(
      1,
      (serverBehind ? 1 : 0) +
        (webBehind ? 1 : 0) +
        (packDevelopment ? 1 : 0) +
        Math.max(initialFleet.behind, initialFleet.converging),
    ),
    fleet: fleetSnapshot(updates),
    grantedMachineIds,
    includesBundle: packDevelopment,
  }
}

/**
 * Website first (the development tarball packing gate asserts the served stamp),
 * then the tarball, then remotes (setTarget ticks an authorized wave), then
 * this server. A failed pack still redeploys this host when it is behind.
 */
function continueDevelopmentUpdate(input: {
  updates: UpdatesService
  targetVersion: string
  expectedWeb: string | undefined
  webBehind: boolean
  readServedWeb?: () => string | undefined
  requestDestBundle: () => Promise<unknown>
  serverBehind: boolean
  requestCoordinatorRestart?: () => void
  affectedMachineIds: readonly MachineId[]
}): void {
  void (async () => {
    if (input.webBehind && input.expectedWeb && input.readServedWeb) {
      await waitForServedWebDigest(input.expectedWeb, input.readServedWeb)
    }
    await input.requestDestBundle()
    if (!input.serverBehind || !input.requestCoordinatorRestart) return
    const published = input.updates.target()
    if (published && canGrantDevelopmentFleet(published)) {
      restartCoordinatorAfterDevelopmentFleet(
        input.updates,
        input.targetVersion,
        input.affectedMachineIds,
        input.requestCoordinatorRestart,
      )
      return
    }
    input.requestCoordinatorRestart()
  })().catch(() => {
    if (input.serverBehind && input.requestCoordinatorRestart) {
      input.requestCoordinatorRestart()
    }
  })
}

export function updateProcedures() {
  return {
    fleet: t.procedure.query(({ ctx }) => updateFleet(ctx)),
    repairCompatibility: t.procedure.mutation(({ ctx }) => {
      if (!ctx.requestCoordinatorRestart) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This Podium installation cannot rebuild its web app automatically.',
        })
      }
      ctx.requestCoordinatorRestart()
      return { state: 'in-progress' as const, version: serverBuildVersion() }
    }),
    converge: t.procedure.mutation(({ ctx }) =>
      startUpdate(
        familyState(ctx).modules.updates,
        serverBuildVersion(),
        ctx.requestCoordinatorRestart,
        {
          ...(ctx.servedWebDigest ? { servedWebDigest: ctx.servedWebDigest } : {}),
          ...(ctx.servedMobileWeb ? { servedMobileWeb: ctx.servedMobileWeb } : {}),
          ...(ctx.requestWebRebuild ? { requestWebRebuild: ctx.requestWebRebuild } : {}),
          ...(ctx.requestDestBundle ? { requestDestBundle: ctx.requestDestBundle } : {}),
        },
      ),
    ),
  }
}
