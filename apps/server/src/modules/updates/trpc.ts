import { asMachineId, type MachineId, type UpdateChannel } from '@podium/model'
import type { ConvergenceState, MobileWebIdentity, Operation } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { serverBuildVersion } from '../../build-version'
import { type Context, t } from '../../trpc'
import { familyState } from '../derived-family'
import type { OperationsModule } from '../operations'
import {
  fleetCanTakeTargetNow,
  LIFECYCLE_EXCLUSION_GROUP,
  planInputFrom,
  planUpdateOperation,
  UPDATE_OPERATION_KIND,
  UPDATE_STEP_MACHINES,
  UPDATE_STEP_PREPARE,
  type UpdateOperationContext,
  type UpdatePlanInput,
  type UpdateSurface,
  updateOperationDetails,
} from './operation'
import type { ChannelCheckRecord, UpdatesService } from './service'
import type { WaveMachine } from './wave'

const IN_FLIGHT: ReadonlySet<ConvergenceState> = new Set(['granted', 'downloading', 'restarting'])
const FAILED: ReadonlySet<ConvergenceState> = new Set(['rejected', 'stuck'])

/**
 * ASKED, NOT ASSUMED (POD-2100). This used to default an unpinned machine to
 * `dev` on its own, so a machine the grant path resolved to the fleet default
 * could still be counted into the authority wave the dialog reports on.
 * `channelOf` is now the single resolution site for everyone.
 */
function isOnChannel(
  updates: UpdatesService,
  machine: WaveMachine,
  channel: UpdateChannel,
): boolean {
  return updates.channelOf(machine) === channel
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

export interface UpdateFleetMachine {
  id: MachineId
  name?: string
  version: string
  state: ConvergenceState
  online: boolean
  busy: boolean
  detail?: string
  /**
   * WHO MOVED THIS ROW (POD-2105, spec §3.6).
   *
   * Present only when the standing reconciliation drove this machine to the
   * current target — a machine that was asleep during the update and converged
   * on its own reconnect, with nobody watching and no operation to attribute it
   * to. ADDITIVE and absent by default per the frozen-contract law (P8): no UI
   * reads it yet, and Settings/history can label it later without a wire change.
   */
  convergedBy?: 'reconciler'
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
  /**
   * When each channel in use was last checked and what came back (POD-2100).
   * ADDITIVE and tolerant of absence per the frozen-contract law (spec P8): an
   * old bundle rendering a new server ignores it, and a channel that has never
   * been checked has no entry rather than a fabricated one.
   */
  channelChecks: ChannelCheckRecord[]
  /**
   * The durable operation currently converging this fleet, if one is (POD-2098).
   *
   * ADDITIVE, and deliberately only an id: this payload is the OLD read model
   * and it stays exactly as it was, so the current dialog and Settings do not
   * change. The id is the thread from here to `operations.active`, which the
   * update panel picks up in its own issue. An old bundle ignores it (P8).
   */
  operationId?: string
  /**
   * A version published while the operation ran, waiting its turn (§3.2). Shown
   * so "0.4.4 arrived and will be offered when this finishes" is sayable rather
   * than a target that silently changes underneath the panel.
   */
  nextTargetVersion?: string
}

/**
 * SCOPED TO THE OPERATION'S AUTHORITY, WHICH IS THE HOST'S (POD-2222/POD-2212).
 *
 * This was dev-scoped, and that was POD-2100's decision with a stated reason:
 * edge and stable machines carry their own per-row targets, so comparing them
 * against the DEV target would invent behind places the global action could not
 * grant. The reason was right; its premise expired. POD-2189 made the global
 * action's authority the HOST's own channel, and this read model was not moved
 * with it — so on a stable installation the offer and the action stopped
 * describing the same wave. `targetVersion` was null and `total`/`behind` were
 * zero while a published stable release sat one fetch away, which is why a
 * stable installation was never OFFERED an update at all.
 *
 * The widening is exactly one channel wide, and the invariant it preserves is
 * the one POD-2100 was protecting: the set counted here is the set
 * `updates.converge`/`updates.start` would grant, because both ask
 * {@link UpdatesService.operationChannel}. Machines pinned elsewhere are still
 * left out of these counts and still keep their own per-row target, action and
 * standing reconciliation — they remain in `allMachines`, which is where
 * Settings renders them.
 */
function fleetSnapshot(
  updates: UpdatesService,
  reconciler?: { convergedBy(machine: WaveMachine): 'reconciler' | undefined },
  hostMachineId?: string,
): UpdateFleetSnapshot {
  const channel = updates.operationChannel(hostMachineId)
  const allMachines = updates.fleet().map((machine) => {
    const convergedBy = reconciler?.convergedBy(machine)
    return {
      ...machine,
      id: asMachineId(machine.id),
      ...(convergedBy ? { convergedBy } : {}),
    }
  })
  const machines = allMachines.filter((machine) => isOnChannel(updates, machine, channel))
  const target = updates.target(channel)
  const targetVersion = target?.version
  // PER MACHINE, not per target (POD-2195): a fleet that can take git delivery
  // is converging on a bare `dev+<sha>` identity right now, and zeroing its live
  // counts for the want of a tarball nobody is waiting for made Settings say
  // nothing was happening while a machine fetched.
  const grantable = target !== undefined && fleetCanTakeTargetNow(target, machines)
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
    channelChecks: updates.channelChecks(),
  }
}

/**
 * THE UPDATE OPERATION'S CONTEXT, assembled from the request (POD-2098).
 *
 * Deliberately built here rather than at composition time: half of it (the
 * publisher, the redeploy request, the served stamps) is optional plumbing the
 * tRPC context already carries, and the OTHER half — `report` — needs the
 * engine, which is what turns a runner's "I handed this out" into a persisted
 * transition. Boot assembles the same shape from the same pieces (`server.ts`),
 * which is the point of it being a plain object and not a service.
 */
export function updateOperationContext(input: {
  updates: UpdatesService
  operations: OperationsModule
  channel: UpdateChannel
  appVersion: () => string
  hostMachineId?: string
  surface?: UpdateSurface
  onlyMachines?: readonly string[]
  retryOf?: string
  servedWebDigest?: () => string | undefined
  servedMobileWeb?: () => MobileWebIdentity
  requestCoordinatorRestart?: () => void
  requestWebRebuild?: () => void
  requestDestBundle?: () => Promise<unknown>
  preparation?: () => { webReady: boolean; bundleReady: boolean; failureDetail?: string }
}): UpdateOperationContext {
  // ONE WEBSITE, TWO DISTS: the operation's `web` step is about the WEBSITE, so
  // it reads the same combined answer the old path did (POD-1980).
  const website = websiteDigestReader(input.servedWebDigest, input.servedMobileWeb)
  return {
    updates: input.updates,
    channel: input.channel,
    appVersion: input.appVersion,
    ...(input.hostMachineId ? { hostMachineId: input.hostMachineId } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.onlyMachines ? { onlyMachines: input.onlyMachines } : {}),
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    ...(website ? { servedWebDigest: website } : {}),
    ...(input.requestCoordinatorRestart
      ? { requestCoordinatorRestart: input.requestCoordinatorRestart }
      : {}),
    ...(input.requestWebRebuild ? { requestWebRebuild: input.requestWebRebuild } : {}),
    ...(input.requestDestBundle ? { requestDestBundle: input.requestDestBundle } : {}),
    ...(input.preparation ? { preparation: input.preparation } : {}),
    report: (operationId, stepId, patch) => {
      void input.operations.engine.recordProgress(operationId, stepId, patch)
    },
    // The other half of the same seam (POD-2173): `report` is how a watcher
    // says something, and this is how it learns to stop.
    stepActive: (operationId, stepId) => input.operations.engine.watching(operationId, stepId),
  }
}

function contextFor(
  ctx: Context,
  extra: { onlyMachines?: readonly string[]; retryOf?: string; surface?: UpdateSurface } = {},
): UpdateOperationContext {
  const state = familyState(ctx)
  return updateOperationContext({
    updates: state.modules.updates,
    operations: state.modules.operations,
    // THE HOST'S OWN CHANNEL, not the literal `'dev'` this used to write
    // (POD-2189): on a shipped installation every machine resolves to `stable`,
    // so a hardcoded dev authority meant `planInputFrom` threw and the fleet got
    // no operation at all. A machine pinned elsewhere still keeps its own
    // per-row action (POD-2100).
    channel: state.modules.updates.operationChannel(state.store.hostMachineId),
    appVersion: serverBuildVersion,
    hostMachineId: state.store.hostMachineId,
    ...extra,
    ...(ctx.servedWebDigest ? { servedWebDigest: ctx.servedWebDigest } : {}),
    ...(ctx.servedMobileWeb ? { servedMobileWeb: ctx.servedMobileWeb } : {}),
    ...(ctx.requestCoordinatorRestart
      ? { requestCoordinatorRestart: ctx.requestCoordinatorRestart }
      : {}),
    ...(ctx.requestWebRebuild ? { requestWebRebuild: ctx.requestWebRebuild } : {}),
    ...(ctx.requestDestBundle ? { requestDestBundle: ctx.requestDestBundle } : {}),
    ...(ctx.updatePreparation ? { preparation: ctx.updatePreparation } : {}),
  })
}

/**
 * The preconditions that must refuse BEFORE an operation exists (§6.3).
 *
 * "Never show an internal precondition as an error" cuts both ways: the panel
 * must not render one, and the server must not manufacture an operation that
 * exists only to fail with one. A refusal here is the same sentence the old
 * `startUpdate` produced, so the current dialog's copy is unchanged.
 */
export function assertUpdateStartable(input: UpdatePlanInput): void {
  const plan = planUpdateOperation(input)
  if (plan.steps.length === 0 && (plan.awaiting ?? []).length === 0) {
    if ((plan.deferred ?? []).length > 0) return
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Podium is already at this version everywhere.',
    })
  }
  const expectedWeb = input.target.artifacts.web?.digest
  const webBehind = expectedWeb !== undefined && input.servedWebDigest !== expectedWeb
  const serverBehind = input.appVersion !== input.target.version
  if (webBehind && !serverBehind && !input.canRebuildWeb && !input.canPrepare) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This Podium installation cannot rebuild its web app automatically.',
    })
  }
}

const CHANNEL_PROSE: Record<UpdateChannel, string> = {
  stable: 'stable',
  edge: 'edge',
  dev: 'development',
}

/**
 * WHY THERE IS NOTHING TO UPDATE TO, in a sentence the person who asked can use
 * (§6.3, POD-2197).
 *
 * "No update target is configured." is the internal precondition §6.3 set out to
 * make unreachable: it describes this server's bookkeeping and offers no next
 * action. Two things are actually true when a target is missing, and they are
 * different sentences. Either the publisher REFUSED and knows why — a dirty
 * checkout, a website not built for HEAD — in which case its own words are the
 * whole answer, including what to do about it. Or nothing has been published on
 * this channel at all, which is an ordinary state of the world and sayable as
 * one.
 *
 * Observed live (POD-2194): a checkout with two uncommitted changes produced the
 * useful sentence in `preparation.failureDetail` and the useless one at the
 * caller.
 */
export function missingTargetReason(channel: UpdateChannel, failureDetail?: string): string {
  if (failureDetail !== undefined && failureDetail.length > 0) return failureDetail
  return `Nothing has been published on the ${CHANNEL_PROSE[channel] ?? channel} channel yet.`
}

/**
 * START ONE UPDATE (§3.2, P6) — the single-flight entry point.
 *
 * A second caller is not told "no": it is handed the operation that is already
 * running, which is what makes two tabs pressing Update render the same panel
 * instead of one of them seeing an error about the other.
 */
export async function startUpdateOperation(
  ctx: Context,
  extra: { onlyMachines?: readonly string[]; retryOf?: string; surface?: UpdateSurface } = {},
): Promise<{ operationId: string; operation: Operation | null; alreadyRunning: boolean }> {
  const state = familyState(ctx)
  const context = contextFor(ctx, extra)
  const updates = state.modules.updates
  if (!updates.target(context.channel)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: missingTargetReason(context.channel, ctx.updatePreparation?.().failureDetail),
    })
  }
  assertUpdateStartable(planInputFrom(context))

  const engine = state.modules.operations.engine
  const result = await engine.start(UPDATE_OPERATION_KIND, context, { createdBy: 'user' })
  if (!result.started) {
    if ('alreadyRunning' in result) {
      const row = engine.active(LIFECYCLE_EXCLUSION_GROUP)
      return {
        operationId: result.alreadyRunning,
        operation: row?.operation ?? null,
        alreadyRunning: true,
      }
    }
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This server cannot run update operations.',
    })
  }
  return { operationId: result.operation.id, operation: result.operation, alreadyRunning: false }
}

/** The fleet read model used by the dialog and Settings. */
export function updateFleet(ctx: Context): UpdateFleetSnapshot {
  const state = familyState(ctx)
  const updates = state.modules.updates
  const fleet = fleetSnapshot(updates, state.modules.updatesReconciler, state.store.hostMachineId)
  const preparation = ctx.updatePreparation?.()
  const active = state.modules.operations.engine.active(LIFECYCLE_EXCLUSION_GROUP)
  // The queued version belongs to the same authority as the counts above: a dev
  // publication is not what a stable host is waiting its turn for (POD-2222).
  const queued = updates.nextTarget(updates.operationChannel(state.store.hostMachineId))
  return {
    ...fleet,
    ...(preparation ? { preparation } : {}),
    ...(active?.kind === UPDATE_OPERATION_KIND ? { operationId: active.id } : {}),
    ...(queued ? { nextTargetVersion: queued.version } : {}),
  }
}

/**
 * THE LEGACY SHAPE, computed from the operation.
 *
 * `updates.converge` is kept for one release so the shipped dialog and Settings
 * keep working while the panel is built (its own issue). Every number here now
 * comes from the operation's plan — which is the point of P2: there is one
 * computation of update progress, and this is a projection of it rather than a
 * fourth opinion.
 */
function legacyConvergeResult(
  updates: UpdatesService,
  operation: Operation | null,
  fallbackVersion: string,
  hostMachineId?: string,
): {
  state: 'in-progress'
  version: string
  done: number
  total: number
  fleet: UpdateFleetSnapshot
  grantedMachineIds: string[]
  includesBundle: boolean
} {
  const steps = operation?.steps ?? []
  const done = steps.filter((step) => step.state === 'done' || step.state === 'skipped').length
  const fleet = fleetSnapshot(updates, undefined, hostMachineId)
  return {
    state: 'in-progress',
    version:
      updateOperationDetails(operation ?? ({} as Operation))?.target.version ?? fallbackVersion,
    done,
    total: Math.max(1, steps.length),
    fleet,
    grantedMachineIds: fleet.machines
      .filter((machine) => IN_FLIGHT.has(machine.state))
      .map((machine) => machine.id),
    includesBundle: steps.some((step) => step.id === UPDATE_STEP_PREPARE),
  }
}

/**
 * A failure the FIRST PASS of the plan produced has to reach the OLD client as a
 * thrown error, because a thrown error is the only failure channel it has (see
 * `use-update-state.ts`'s catch → `describeUpdateFailure`). An operation that
 * failed that early failed before anything was handed out — a target the
 * transport cannot deliver, a publisher that refused outright — so throwing is
 * not losing it: it is recorded, retryable and in history either way.
 *
 * `updates.start`, the endpoint that replaces this one, never throws for a
 * failure: it answers the operation, and the panel renders the typed error.
 */
function throwIfFailedOnStart(operation: Operation | null): void {
  if (operation?.state !== 'failed') return
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: operation.error?.detail ?? operation.error?.message ?? 'The update could not start.',
  })
}

export function updateProcedures() {
  return {
    fleet: t.procedure.query(({ ctx }) => updateFleet(ctx)),
    /**
     * "Check for updates now" (spec §9.2). The daily timer answers "is anything
     * new"; this answers it for a human who is looking at the panel and does not
     * want to wait a day. Rate-limited per channel inside the service, so a
     * held-down button is one feed request, not a loop.
     */
    checkNow: t.procedure.mutation(({ ctx }) => familyState(ctx).modules.updates.checkNow()),
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
    /**
     * The one human click, as a durable operation (§3.2). Answers the operation
     * itself so the caller can render it immediately and then follow
     * `operations.active` — there is no second endpoint to learn.
     */
    start: t.procedure
      .input(z.object({ surface: z.string().optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        const started = await startUpdateOperation(ctx, {
          ...(input?.surface ? { surface: input.surface as UpdateSurface } : {}),
        })
        return {
          operationId: started.operationId,
          alreadyRunning: started.alreadyRunning,
          operation: started.operation,
        }
      }),

    /**
     * RETRY (§3.2): a NEW operation whose plan is the remainder — the machines
     * that are still not at the target — linked to the one it retries. History
     * stays honest: the failure is not overwritten by its own second attempt.
     */
    retry: t.procedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
      const engine = familyState(ctx).modules.operations.engine
      const row = engine.history(UPDATE_OPERATION_KIND, 100).find((r) => r.id === input.id)
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That update is no longer on record.' })
      }
      const previous = row.operation
      const machinesStep = (previous?.steps ?? []).find((step) => step.id === UPDATE_STEP_MACHINES)
      // The REMAINDER, from the failed operation's own record of where each
      // place got to. A place that reached the target is not retried — that is
      // what makes "Try again" cheap after a half-applied update (§8).
      const remainder = (machinesStep?.places ?? [])
        .filter((place) => place.state !== 'current')
        .map((place) => place.id)
      const started = await startUpdateOperation(ctx, {
        retryOf: input.id,
        ...(remainder.length > 0 ? { onlyMachines: remainder } : {}),
      })
      return {
        operationId: started.operationId,
        alreadyRunning: started.alreadyRunning,
        operation: started.operation,
      }
    }),

    /**
     * KEPT FOR ONE RELEASE (POD-2098): the shipped dialog's entry point, now a
     * thin alias over `start`. It exists so this issue does not regress the live
     * UI while the operation panel is built in its own issue; the moment that
     * lands, this and its shape go.
     */
    converge: t.procedure.mutation(async ({ ctx }) => {
      const state = familyState(ctx)
      const engine = state.modules.operations.engine
      const started = await startUpdateOperation(ctx)
      /**
       * THE ONE PLACE THAT WAITS, and only because the OLD contract does.
       *
       * `engine.start` deliberately no longer awaits the drive: a click must not
       * be held for the length of the first runner. But this endpoint's shipped
       * caller reads `done`, `total` and `grantedMachineIds` out of the
       * response, and it has no way to hear about a failure except a rejection
       * — so it needs the answer the old `startUpdate` gave, which was "the
       * plan has run until something is genuinely in flight".
       *
       * `whenSettled` is EXACTLY that and no more: every runner here hands its
       * work out and answers `running`, so the queue empties as soon as the plan
       * blocks. It is not a poll, it has no sleep, and it goes away with this
       * endpoint when the panel lands.
       */
      await engine.whenSettled(started.operationId)
      const operation =
        engine.active(LIFECYCLE_EXCLUSION_GROUP)?.operation ??
        engine.history(UPDATE_OPERATION_KIND, 1)[0]?.operation ??
        started.operation
      throwIfFailedOnStart(operation)
      return legacyConvergeResult(
        state.modules.updates,
        operation,
        serverBuildVersion(),
        state.store.hostMachineId,
      )
    }),
  }
}
