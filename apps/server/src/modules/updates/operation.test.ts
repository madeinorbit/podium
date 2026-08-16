import { asMachineId, type UpdateChannel } from '@podium/model'
import type { Operation, UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import {
  type OperationClock,
  OperationEngine,
  type OperationTimerHandle,
} from '../operations/engine'
import { OperationKindRegistry } from '../operations/kinds'
import { OperationStore } from '../operations/store'
import {
  classifyMachineFailure,
  createUpdateFleetBridge,
  DESKTOP_INSTALL_ASK,
  describeUpdateOperationFailure,
  LIFECYCLE_EXCLUSION_GROUP,
  planUpdateOperation,
  RELOAD_SURFACES_ASK,
  reconcileUpdateOperation,
  resetUpdateOperationState,
  STEP_HEARTBEAT_INTERVAL_MS,
  UPDATE_BUDGETS,
  UPDATE_OPERATION_KIND,
  UPDATE_STEP_DEADLINES,
  UPDATE_STEP_MACHINES,
  UPDATE_STEP_PREPARE,
  UPDATE_STEP_SERVER,
  UPDATE_STEP_WEB,
  type UpdateOperationContext,
  type UpdatePlanInput,
  updateOperationKind,
} from './operation'
import { UpdatesService } from './service'
import type { WaveMachine } from './wave'

/**
 * THE `update` KIND (POD-2098), proven the way the framework next door is: a
 * FAKE CLOCK and an injected scheduler, so nothing here sleeps. A `setTimeout`
 * before an assertion is a bug in this repo's unit lane, and it is also the
 * exact defect this whole epic is removing from the product.
 */

afterEach(() => {
  resetUpdateOperationState()
})

// ───────────────────────────── fixtures ──────────────────────────────

const WEB_DIGEST = 'abc1234'

function devTarget(over: Partial<UpdateTarget> = {}): UpdateTarget {
  return {
    version: 'dev+abc1234',
    critical: false,
    artifacts: { web: { digest: WEB_DIGEST } },
    ...over,
  } as UpdateTarget
}

/** The same dev target once the tarball has been packed for it. */
function packedTarget(): UpdateTarget {
  return devTarget({
    artifacts: {
      web: { digest: WEB_DIGEST },
      headless: { delivery: 'bundle', platforms: {} },
    },
  } as Partial<UpdateTarget>)
}

function machine(over: Partial<WaveMachine> & { id: string }): WaveMachine {
  return {
    name: over.id,
    version: '0.4.1',
    state: 'current',
    online: true,
    busy: false,
    ...over,
  }
}

const planInput = (over: Partial<UpdatePlanInput> = {}): UpdatePlanInput => ({
  target: devTarget(),
  channel: 'dev',
  fleet: [],
  channelOf: () => 'dev',
  appVersion: '0.4.1',
  servedWebDigest: 'older99',
  canPrepare: true,
  canRebuildWeb: true,
  canRestartServer: true,
  ...over,
})

const stepIds = (plan: { steps: Array<{ id: string }> }): string[] =>
  plan.steps.map((step) => step.id)

// ─────────────────────────── §3.1 the plan ───────────────────────────

describe('planUpdateOperation', () => {
  /**
   * THE STEP LIST IS THE PLAN, and the panel renders "step 2 of 4" straight off
   * it — so a step that was never going to do anything would make that sentence
   * a lie. Every row here is a claim about what is OMITTED as much as included.
   */
  const rows: Array<{ name: string; input: Partial<UpdatePlanInput>; steps: string[] }> = [
    {
      name: 'a dev identity behind everywhere plans all four steps, in dependency order',
      input: { fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'an already-packed target needs no preparation',
      input: { target: packedTarget(), fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a server already on the target keeps its machines and its website',
      input: { appVersion: 'dev+abc1234', fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_WEB],
    },
    {
      name: 'a website already at the target digest is not rebuilt',
      input: { servedWebDigest: WEB_DIGEST, fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_MACHINES, UPDATE_STEP_SERVER],
    },
    {
      name: 'a machine already at the target is not a step',
      input: { fleet: [machine({ id: 'vmi', version: 'dev+abc1234' })] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a machine on another channel is not this operation‘s business',
      input: { fleet: [machine({ id: 'vmi' })], channelOf: () => 'stable' as UpdateChannel },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
    {
      name: 'a server that cannot restart itself does not promise to',
      input: { canRestartServer: false, fleet: [] },
      steps: [UPDATE_STEP_PREPARE, UPDATE_STEP_WEB],
    },
    {
      name: 'an installation that can do nothing about its website omits the web step',
      input: {
        target: packedTarget(),
        canRestartServer: false,
        canRebuildWeb: false,
        canPrepare: false,
        appVersion: 'dev+abc1234',
        fleet: [machine({ id: 'vmi' })],
      },
      steps: [UPDATE_STEP_MACHINES],
    },
    {
      // A bare identity on a server with no publisher has no bytes to hand
      // anyone and nothing that will ever produce them, so a machines step
      // here would be a step that can never finish.
      name: 'a server that cannot pack does not promise a wave it cannot deliver',
      input: { canPrepare: false, fleet: [machine({ id: 'vmi' })] },
      steps: [UPDATE_STEP_SERVER, UPDATE_STEP_WEB],
    },
  ]

  for (const row of rows) {
    it(row.name, () => {
      expect(stepIds(planUpdateOperation(planInput(row.input)))).toEqual(row.steps)
    })
  }

  it('defers an offline machine instead of letting it hold the outcome open', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })] }),
    )
    const machines = plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)
    expect(machines?.places?.map((place) => place.id)).toEqual(['vmi'])
    expect(plan.deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
  })

  it('plans no machines step at all when every behind machine is asleep', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'laptop', online: false })] }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred).toHaveLength(1)
  })

  /**
   * A supervised daemon lives inside a signed application bundle. It is
   * EXCLUDED, not deferred: deferred means "we will do this later", and this one
   * is never ours to do (§4, P5 — no surface updates someone else's native app).
   */
  it('excludes a desktop-supervised daemon from the wave and from the deferred list', () => {
    const plan = planUpdateOperation(
      planInput({ fleet: [machine({ id: 'macbook', supervised: true })] }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred).toEqual([])
  })

  it('defers a machine that cannot take the packed artifact', () => {
    const plan = planUpdateOperation(
      planInput({
        target: packedTarget(),
        fleet: [machine({ id: 'src', deliveryCaps: ['update.delivery.git'] })],
      }),
    )
    expect(stepIds(plan)).not.toContain(UPDATE_STEP_MACHINES)
    expect(plan.deferred?.[0]).toMatchObject({ id: 'src', reason: 'cannot-take-delivery' })
  })

  /**
   * §5: in all-in-one the shell carries server + daemon + web atomically, so
   * there is nothing a runner may do. The plan is empty and the ask is REQUIRED,
   * which is precisely what makes the engine settle it into `waiting`.
   */
  it('plans an all-in-one install as a required ask and no steps at all', () => {
    const plan = planUpdateOperation(
      planInput({
        hostMachineId: 'macbook',
        fleet: [machine({ id: 'macbook', supervised: true, name: 'macbook' })],
      }),
    )
    expect(plan.steps).toEqual([])
    expect(plan.awaiting).toEqual([
      expect.objectContaining({ id: DESKTOP_INSTALL_ASK, required: true, place: 'macbook' }),
    ])
  })

  /**
   * The mirror image, and the distinction the whole `required` flag exists for:
   * an idle tab that has not reloaded is a straggler who self-serves on their
   * next load, so it must NOT hold the operation open (§3.5).
   */
  it('asks open tabs to reload without letting that ask hold the operation open', () => {
    const plan = planUpdateOperation(planInput())
    const reload = plan.awaiting?.find((ask) => ask.id === RELOAD_SURFACES_ASK)
    expect(reload).toBeDefined()
    expect(reload?.required).toBe(false)
  })

  it('plans only the remainder when a retry names one', () => {
    const plan = planUpdateOperation(
      planInput({
        fleet: [machine({ id: 'vmi' }), machine({ id: 'ludovico' })],
        onlyMachines: ['ludovico'],
        retryOf: 'op_1',
      }),
    )
    const machines = plan.steps.find((step) => step.id === UPDATE_STEP_MACHINES)
    expect(machines?.places?.map((place) => place.id)).toEqual(['ludovico'])
    expect(plan.retryOf).toBe('op_1')
  })

  it('carries the target and the version it is updating FROM into details', () => {
    const plan = planUpdateOperation(planInput())
    expect(plan.details).toMatchObject({
      target: expect.objectContaining({ version: 'dev+abc1234' }),
      channel: 'dev',
      fromVersion: '0.4.1',
    })
  })
})

// ────────────────────── §3.4 / §8 reconciliation ─────────────────────

describe('reconcileUpdateOperation', () => {
  const operation = (steps: Operation['steps']): Operation => ({
    id: 'op_1',
    kind: UPDATE_OPERATION_KIND,
    state: 'running',
    details: { target: devTarget(), channel: 'dev' },
    steps,
  })

  const reality = (over: Partial<Parameters<typeof reconcileUpdateOperation>[1]> = {}) => ({
    appVersion: 'dev+abc1234',
    servedWebDigest: WEB_DIGEST,
    machineDirectory: [] as WaveMachine[],
    now: 1_000,
    ...over,
  })

  it('§8: the successor booted at the target, so the server step is done', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'running' }]),
      reality(),
    )
    expect(next.steps?.[0]?.state).toBe('done')
    expect(next.state).toBe('running')
  })

  /**
   * The case that today silently produces a FRESH DIALOG offering the same
   * update again, with nothing anywhere saying the swap failed.
   */
  it('§8: the successor booted on the wrong version, so the operation failed', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'running' }]),
      reality({ appVersion: '0.4.2' }),
    )
    expect(next.state).toBe('failed')
    expect(next.error?.code).toBe('server-did-not-reach-target')
    expect(next.error?.message).toContain('0.4.2')
    expect(next.finishedAt).toBe(1_000)
  })

  it('leaves a server step that had not started yet alone', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_SERVER, state: 'pending' }]),
      reality({ appVersion: '0.4.1' }),
    )
    expect(next.steps?.[0]?.state).toBe('pending')
    expect(next.state).toBe('running')
  })

  it('§8: re-derives a wave mid-flight from the machine directory, not from memory', () => {
    const next = reconcileUpdateOperation(
      operation([
        {
          id: UPDATE_STEP_MACHINES,
          state: 'running',
          progress: { done: 0, total: 2 },
          places: [
            { id: 'vmi', state: 'downloading' },
            { id: 'ludovico', state: 'granted' },
          ],
        },
      ]),
      reality({
        machineDirectory: [
          machine({ id: 'vmi', version: 'dev+abc1234' }),
          machine({ id: 'ludovico', version: '0.4.1', online: false }),
        ],
      }),
    )
    const step = next.steps?.[0]
    expect(step?.places).toEqual([
      expect.objectContaining({ id: 'vmi', state: 'current' }),
      expect.objectContaining({ id: 'ludovico', state: 'offline' }),
    ])
    expect(step?.progress).toEqual({ done: 1, total: 2 })
    // Not `done` — the runner re-ensures on resume and is the one place that
    // decides a wave has finished.
    expect(step?.state).toBe('pending')
  })

  it('finishes a wave whose every machine reports the target', () => {
    const next = reconcileUpdateOperation(
      operation([
        { id: UPDATE_STEP_MACHINES, state: 'running', places: [{ id: 'vmi', state: 'granted' }] },
      ]),
      reality({ machineDirectory: [machine({ id: 'vmi', version: 'dev+abc1234' })] }),
    )
    expect(next.steps?.[0]?.state).toBe('done')
  })

  it('takes a served website at the target digest as proof the web step is done', () => {
    const next = reconcileUpdateOperation(
      operation([{ id: UPDATE_STEP_WEB, state: 'running' }]),
      reality(),
    )
    expect(next.steps?.[0]?.state).toBe('done')
  })

  it('re-queues a build that died with its process rather than waiting for its report', () => {
    for (const stepId of [UPDATE_STEP_WEB, UPDATE_STEP_PREPARE]) {
      const next = reconcileUpdateOperation(
        operation([{ id: stepId, state: 'running' }]),
        reality({ servedWebDigest: 'older99' }),
      )
      expect(next.steps?.[0]?.state).toBe('pending')
    }
  })

  /**
   * An operation whose payload names no target cannot be reconciled against
   * anything. Failing it is what stops it wedging the lifecycle group forever.
   */
  it('fails bytes that do not name a target instead of leaving the group wedged', () => {
    const next = reconcileUpdateOperation(
      { id: 'op_1', kind: UPDATE_OPERATION_KIND, state: 'running', steps: [] },
      reality(),
    )
    expect(next.state).toBe('failed')
  })
})

// ───────────────────────── §7 typed errors ───────────────────────────

describe('the error taxonomy', () => {
  const rows: Array<[string | undefined, string]> = [
    ['git delivery refused: dirty-working-tree', 'machine-dirty-checkout'],
    ['cannot converge: unsupported-delivery', 'machine-unsupported'],
    ['unsupported-platform', 'machine-unsupported'],
    ['no-artifact for linux-x64', 'machine-unsupported'],
    ['fetch failed', 'download-failed'],
    ['ECONNREFUSED 127.0.0.1:18787', 'download-failed'],
    ['The machine stopped reporting progress while updating.', 'machine-unreachable'],
    [undefined, 'machine-unreachable'],
  ]
  for (const [detail, code] of rows) {
    it(`reads ${JSON.stringify(detail)} as ${code}`, () => {
      expect(classifyMachineFailure(detail)).toBe(code)
    })
  }

  it('names the machine in the sentence a human reads', () => {
    const error = describeUpdateOperationFailure({
      code: 'machine-dirty-checkout',
      places: ['m_a'],
      names: ['vmi'],
      detail: 'dirty-working-tree',
    })
    expect(error.message).toContain('vmi')
    expect(error.places).toEqual(['m_a'])
    expect(error.detail).toBe('dirty-working-tree')
  })

  it('quotes the publisher‘s public reason for a preparation failure', () => {
    const error = describeUpdateOperationFailure({
      code: 'preparation-failed',
      detail: 'The website has not been built for HEAD yet.',
    })
    expect(error.message).toContain('The website has not been built for HEAD yet.')
  })
})

// ──────────────────────── the driven operation ───────────────────────

function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const clock: OperationClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const handle = ++seq
      pending.set(handle, { at: now + ms, fn })
      return handle
    },
    clearTimeout: (handle: OperationTimerHandle) => {
      pending.delete(handle as number)
    },
  }
  return {
    clock,
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!due || due[1].at > target) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

interface HarnessOptions {
  machines?: WaveMachine[]
  target?: UpdateTarget
  appVersion?: string
  servedWebDigest?: () => string | undefined
  requestDestBundle?: () => Promise<unknown>
  requestWebRebuild?: () => void
  requestCoordinatorRestart?: () => void
  preparation?: () => { webReady: boolean; bundleReady: boolean; failureDetail?: string }
  hostMachineId?: string
  /** POD-2101: how often a watched step says it is still there. */
  heartbeatIntervalMs?: number
}

/**
 * One store, one registry, and a REAL `UpdatesService` over fake transport —
 * the wave planner, the grant protocol and the convergence bookkeeping are the
 * muscle this issue drives, so they are exercised rather than mocked.
 */
function harness(options: HarnessOptions = {}) {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  const store = new OperationStore(db)
  const clock = fakeClock()
  const sent: Array<{ machineId: string; message: UpdateGrantMessage }> = []
  const fleet = options.machines ?? [machine({ id: 'vmi' })]
  const updates = new UpdatesService({
    machines: () => fleet,
    send: (machineId, message) => sent.push({ machineId, message }),
    now: () => clock.clock.now(),
    nextGrantId: () => `grant_${sent.length + 1}`,
    concurrency: 3,
    fleetChannel: () => 'dev',
  })
  updates.setTarget('dev', options.target ?? devTarget())

  /** Deferred work the watchers schedule; drained explicitly, never slept on. */
  const scheduled: Array<() => void> = []
  let engine: OperationEngine
  const context = (): UpdateOperationContext => ({
    updates,
    channel: 'dev',
    appVersion: () => options.appVersion ?? '0.4.1',
    ...(options.hostMachineId ? { hostMachineId: options.hostMachineId } : {}),
    ...(options.servedWebDigest ? { servedWebDigest: options.servedWebDigest } : {}),
    ...(options.requestDestBundle ? { requestDestBundle: options.requestDestBundle } : {}),
    ...(options.requestWebRebuild ? { requestWebRebuild: options.requestWebRebuild } : {}),
    ...(options.requestCoordinatorRestart
      ? { requestCoordinatorRestart: options.requestCoordinatorRestart }
      : {}),
    ...(options.preparation ? { preparation: options.preparation } : {}),
    report: (id, stepId, patch) => {
      void engine.recordProgress(id, stepId, patch)
    },
    schedule: (fn) => {
      scheduled.push(fn)
    },
    // The watchers' own clock is the fake one, so a heartbeat is earned by the
    // clock being advanced and never by a test sleeping (POD-2101).
    now: () => clock.clock.now(),
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  })

  const registry = new OperationKindRegistry()
  registry.register(updateOperationKind())
  let minted = 0
  engine = new OperationEngine({
    store,
    registry,
    clock: clock.clock,
    newId: () => `op_${++minted}`,
  })

  return {
    store,
    registry,
    updates,
    clock,
    sent,
    context,
    get engine() {
      return engine
    },
    /** Run everything the watchers queued, and whatever that queues in turn. */
    async drain(): Promise<void> {
      for (let guard = 0; guard < 20 && scheduled.length > 0; guard++) {
        const due = scheduled.splice(0, scheduled.length)
        for (const fn of due) fn()
        await Promise.resolve()
      }
    },
    read(id = 'op_1'): Operation {
      const operation = store.get(id)?.operation
      if (!operation) throw new Error(`operation ${id} is not readable`)
      return operation
    },
    /** A second engine over the SAME store — the successor process (§3.4). */
    successor(): OperationEngine {
      return new OperationEngine({ store, registry, clock: clock.clock })
    },
  }
}

const stepState = (operation: Operation, id: string): string | undefined =>
  operation.steps?.find((step) => step.id === id)?.state

describe('the update operation, driven', () => {
  it('runs the plan in order and reaches its first blocking step', async () => {
    const restart = vi.fn()
    const h = harness({
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: restart,
    })
    const started = await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    expect(started.started).toBe(true)
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(stepIds({ steps: operation.steps ?? [] })).toEqual([
      UPDATE_STEP_MACHINES,
      UPDATE_STEP_SERVER,
    ])
    // The wave is in flight, so the server step has NOT been reached: the old
    // choreography expressed this ordering as a 250 ms poll loop; it is now
    // simply the order of the plan.
    expect(stepState(operation, UPDATE_STEP_MACHINES)).toBe('running')
    expect(stepState(operation, UPDATE_STEP_SERVER)).toBe('pending')
    expect(restart).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
  })

  /**
   * SINGLE-FLIGHT (P6, §8's "two tabs / two users click Update"). The second
   * caller is handed the SAME operation, not an error: both tabs then render one
   * panel, which is the behaviour the whole spec is built around.
   */
  it('gives two concurrent starts one operation', async () => {
    const h = harness({ target: packedTarget(), servedWebDigest: () => WEB_DIGEST })
    const [first, second] = await Promise.all([
      h.engine.start(UPDATE_OPERATION_KIND, h.context()),
      h.engine.start(UPDATE_OPERATION_KIND, h.context()),
    ])
    const ids = [first, second].map((r) =>
      r.started ? r.operation.id : 'alreadyRunning' in r ? r.alreadyRunning : 'refused',
    )
    expect(new Set(ids).size).toBe(1)
    expect(h.store.history(UPDATE_OPERATION_KIND).length).toBe(1)
  })

  it('settles an all-in-one operation into waiting on its required ask', async () => {
    const h = harness({
      machines: [machine({ id: 'macbook', supervised: true })],
      hostMachineId: 'macbook',
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const operation = h.read()
    expect(operation.state).toBe('waiting')
    expect(operation.awaiting?.[0]?.id).toBe(DESKTOP_INSTALL_ASK)
  })

  it('completes rather than waiting on a voluntary reload ask', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    // Nothing is behind except the ask itself; the plan is empty and the
    // voluntary ask must not hold it open.
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })
})

describe('the step runners', () => {
  it('prepare: packs once however many times ensure() runs', async () => {
    let resolvePack: (() => void) | undefined
    const requestDestBundle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePack = resolve
        }),
    )
    const h = harness({
      machines: [],
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_PREPARE)).toBe('running')
    expect(requestDestBundle).toHaveBeenCalledTimes(1)

    // The engine re-enters `ensure()` on a stall retry; idempotence means the
    // second call joins the build in flight rather than starting a second one.
    h.clock.advance(21 * 60_000)
    await h.engine.whenSettled('op_1')
    expect(requestDestBundle).toHaveBeenCalledTimes(1)

    resolvePack?.()
    await h.engine.whenSettled('op_1')
  })

  it('prepare: does nothing at all when the package already exists', async () => {
    const requestDestBundle = vi.fn(() => Promise.resolve())
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().steps?.some((step) => step.id === UPDATE_STEP_PREPARE)).toBe(false)
    expect(requestDestBundle).not.toHaveBeenCalled()
  })

  it('prepare: a refused pack fails the operation with the publisher‘s own words', async () => {
    const refusal = Object.assign(new Error('internal diagnostic with paths'), {
      publicReason: 'The website has not been built for HEAD (abc1234) yet.',
    })
    const h = harness({
      machines: [],
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestDestBundle: () => Promise.reject(refusal),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('preparation-failed')
    expect(operation.error?.message).toContain('The website has not been built for HEAD')
    expect(operation.error?.message).not.toContain('internal diagnostic')
  })

  it('server: is persisted as running BEFORE the restart is requested', async () => {
    const seen: string[] = []
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {
        // Read the store from inside the restart request: this is the exact
        // instant the process may stop existing, so what is on disk here is
        // everything the successor will have (§3.4).
        seen.push(stepState(h.read(), UPDATE_STEP_SERVER) ?? 'absent')
      },
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(seen).toEqual(['running'])
  })

  it('server: a server already on the target does not restart', async () => {
    const restart = vi.fn()
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: restart,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(restart).not.toHaveBeenCalled()
    expect(h.read().state).toBe('done')
  })

  it('web: rebuilds once and finishes when the served stamp catches up', async () => {
    let served = 'older99'
    const requestWebRebuild = vi.fn(() => {
      /* the builder is asynchronous; the stamp flips below */
    })
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => served,
      requestWebRebuild,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')
    expect(requestWebRebuild).toHaveBeenCalledTimes(1)

    // Still building: the watcher re-reads and re-arms, it does not conclude.
    await h.drain()
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')

    served = WEB_DIGEST
    await h.drain()
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })

  it('web: a failed build is a typed failure, not an indefinite wait', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => 'older99',
      requestWebRebuild: () => {},
      preparation: () => ({
        webReady: false,
        bundleReady: false,
        failureDetail: 'The website could not be rebuilt for dev+abc1234. See the server log.',
      }),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    await h.drain()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('web-build-failed')
  })

  it('machines: a rejected machine fails the operation with a typed, named error', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates })
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'rejected',
      version: '0.4.1',
      detail: 'cannot converge: dirty-working-tree',
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('machine-dirty-checkout')
    expect(operation.error?.message).toContain('vmi3407763')
  })

  it('machines: a daemon reporting the target advances the step to done', async () => {
    const fleet = [machine({ id: 'vmi' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')

    // The daemon reconnects on the new build: the machine DIRECTORY is the proof.
    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates }).onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })
})

// ───────────────────── §3.4 the kill-and-adopt drill ─────────────────

describe('surviving the coordinator restart', () => {
  /**
   * THE ACCEPTANCE DRILL. An operation is started, the server step is marked
   * running, the engine driving it is torn down as the process would be, and a
   * NEW engine over the same store adopts it against successor reality.
   */
  async function killAfterServerStep(appVersion: string) {
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {},
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_SERVER)).toBe('running')
    // The process ends here. Nothing in memory survives; the row does.
    h.engine.stop()

    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion,
        servedWebDigest: WEB_DIGEST,
        machineDirectory: [] as WaveMachine[],
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    return h.read()
  }

  it('resumes and completes when the successor is at the target', async () => {
    const operation = await killAfterServerStep('dev+abc1234')
    expect(stepState(operation, UPDATE_STEP_SERVER)).toBe('done')
    expect(operation.state).toBe('done')
  })

  it('fails with server-did-not-reach-target when the successor is not', async () => {
    const operation = await killAfterServerStep('0.4.1')
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('server-did-not-reach-target')
  })

  it('adopts across a restart that happened mid-wave and finishes the wave', async () => {
    const fleet = [machine({ id: 'vmi' })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    h.engine.stop()

    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion: 'dev+abc1234',
        servedWebDigest: WEB_DIGEST,
        machineDirectory: fleet,
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    expect(h.read().state).toBe('done')
  })

  /**
   * THE ALL-IN-ONE ACCEPTANCE (§5, POD-2104): one click, one restart, the SAME
   * operation id reading `done` on the other side.
   *
   * This is the one shape with no steps at all, so every assertion the drills
   * above make is unavailable — there is no `server` step whose state proves the
   * restart happened. The ask is the whole operation, and the successor's own
   * version is the only evidence that it was answered.
   */
  async function killWaitingOnTheDesktopAsk(appVersion: string) {
    const h = harness({
      machines: [machine({ id: 'macbook', supervised: true })],
      hostMachineId: 'macbook',
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().state).toBe('waiting')
    // The user pressed Restart Podium. The shell installs and execs; this
    // process — the embedded server — dies with it.
    h.engine.stop()

    const successor = h.successor()
    await successor.adoptOnBoot(
      () => ({
        appVersion,
        servedWebDigest: WEB_DIGEST,
        machineDirectory: [machine({ id: 'macbook', supervised: true, version: appVersion })],
        now: h.clock.clock.now(),
      }),
      () => h.context(),
    )
    await successor.whenSettled('op_1')
    return h.read()
  }

  it('completes the all-in-one operation when the shell came back at the target', async () => {
    const operation = await killWaitingOnTheDesktopAsk('dev+abc1234')
    expect(operation.state).toBe('done')
    expect(operation.awaiting ?? []).toEqual([])
  })

  /**
   * The shell restarted without installing (a crash, a declined dialog, a
   * failed swap). Answering the ask here would tell the user an update they
   * never got had been applied, and the panel would stop offering the one
   * button that could still finish it.
   */
  it('keeps the desktop ask when the shell came back on the old version', async () => {
    const operation = await killWaitingOnTheDesktopAsk('0.4.1')
    expect(operation.state).toBe('waiting')
    expect(operation.awaiting?.[0]?.id).toBe(DESKTOP_INSTALL_ASK)
  })
})

// ────────────────── §3.2 single-flight and nextTarget ────────────────

describe('a version published mid-operation', () => {
  function service(active: () => boolean) {
    const sent: string[] = []
    const updates = new UpdatesService({
      machines: () => [machine({ id: 'vmi' })],
      send: (machineId) => sent.push(machineId),
      now: () => 0,
      nextGrantId: () => 'grant_1',
      concurrency: 3,
      fleetChannel: () => 'dev',
      exclusiveOperationActive: active,
    })
    return { updates, sent }
  }

  it('queues a NEW version instead of mutating the running wave', () => {
    let running = false
    const { updates } = service(() => running)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    expect(updates.target('dev')?.version).toBe('0.4.3')

    updates.authorize('dev')
    running = true
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    // The running wave is untouched…
    expect(updates.target('dev')?.version).toBe('0.4.3')
    // …and the newcomer is waiting its turn, visibly.
    expect(updates.nextTarget('dev')?.version).toBe('0.4.4')
  })

  it('publishes the queued version when the operation terminates, as an OFFER', () => {
    let running = false
    const { updates, sent } = service(() => running)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    updates.authorize('dev')
    const grantsBefore = sent.length

    running = true
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    running = false
    expect(updates.publishNextTargets()).toEqual(['dev'])

    expect(updates.target('dev')?.version).toBe('0.4.4')
    expect(updates.nextTarget('dev')).toBeUndefined()
    // An offer, not an operation: nothing was granted by the publication.
    expect(sent.length).toBe(grantsBefore)
  })

  /**
   * The one publication that must NOT be queued: the development identity
   * acquiring the tarball it is about to deliver. It is the SAME version, and
   * the running operation is waiting for exactly those bytes.
   */
  it('lets the same version gain its packed artifact mid-operation', () => {
    let running = false
    const { updates } = service(() => running)
    updates.setTarget('dev', devTarget())
    running = true
    updates.setTarget('dev', packedTarget())
    expect(updates.target('dev')?.artifacts.headless).toBeDefined()
    expect(updates.nextTarget('dev')).toBeUndefined()
  })

  /**
   * THE DELETED BEHAVIOUR (spec §10.2). Re-publishing a descriptor used to also
   * tick an authorized wave, which made publishing a way to start granting.
   * Sequencing belongs to the operation now.
   */
  it('does not grant anything just because a descriptor was re-published', () => {
    const { updates, sent } = service(() => false)
    updates.setTarget('dev', devTarget())
    updates.markAuthorized('dev')
    const before = sent.length
    updates.setTarget('dev', packedTarget())
    expect(sent.length).toBe(before)
  })

  it('drops a queued version for a channel that can no longer advertise one', () => {
    const { updates } = service(() => true)
    updates.setTarget('dev', devTarget({ version: '0.4.3' }))
    updates.setTarget('dev', devTarget({ version: '0.4.4' }))
    expect(updates.nextTarget('dev')).toBeDefined()
    updates.setTargetUnavailable('dev', 'nothing published for this commit')
    expect(updates.nextTarget('dev')).toBeUndefined()
  })
})

describe('the fleet bridge', () => {
  it('is silent when no update operation is running', () => {
    const h = harness()
    const recordProgress = vi.fn(() => Promise.resolve())
    const admitDeferred = vi.fn(() => Promise.resolve())
    createUpdateFleetBridge({
      engine: { active: () => undefined, recordProgress, admitDeferred },
      updates: h.updates,
    }).onFleetChanged()
    expect(recordProgress).not.toHaveBeenCalled()
    expect(admitDeferred).not.toHaveBeenCalled()
  })

  it('stamps the heartbeat on every accepted fleet event', async () => {
    const h = harness({
      machines: [machine({ id: 'vmi' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const before = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.lastProgressAt

    h.clock.advance(1_000)
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'downloading',
      version: '0.4.1',
    })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.lastProgressAt).toBeGreaterThan(before ?? 0)
    expect(step?.places?.[0]).toMatchObject({ id: 'vmi', state: 'downloading' })
  })

  /**
   * §3.6, THE MID-OPERATION RECONNECT. A machine that was asleep at plan time is
   * `deferred` — the operation's honest note that it is not waiting for it. If
   * it wakes up while its own step is STILL RUNNING, that note stops being true,
   * and it has to stop being true in one move: a place in neither list is
   * invisible, and a place in both is counted twice by everyone reading the
   * operation.
   */
  it('admits a deferred machine that reconnects while the wave is still running', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])

    fleet[1] = machine({ id: 'laptop' })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.deferred).toEqual([])
    const step = operation.steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.places?.map((place) => place.id)).toEqual(['vmi', 'laptop'])
    expect(step?.progress).toEqual({ done: 0, total: 2 })
  })

  /**
   * …and the other half of the same sentence: once the wave is over it stays
   * deferred, because the operation is no longer the thing that would carry it.
   * The standing reconciler is, and that is the honest outcome rather than a
   * fallback.
   */
  it('leaves a machine deferred when it reconnects after the wave finished', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    // `vmi` arrives, which is the whole of the planned wave.
    fleet[0] = machine({ id: 'vmi', version: 'dev+abc1234' })
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('done')

    fleet[1] = machine({ id: 'laptop' })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
  })

  /** A daemon that became desktop-supervised while it slept is the SHELL's now,
   *  whatever the plan said when it was still an ordinary fleet machine (§4, P5). */
  it('does not admit a reconnected machine a desktop app has since claimed', async () => {
    const fleet = [machine({ id: 'vmi' }), machine({ id: 'laptop', online: false })]
    const h = harness({
      machines: fleet,
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    fleet[1] = machine({ id: 'laptop', supervised: true })
    createUpdateFleetBridge({ engine: h.engine, updates: h.updates }).onFleetChanged()
    await h.engine.whenSettled('op_1')

    expect(h.read().deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])
    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.places?.map((place) => place.id)).toEqual(['vmi'])
  })
})

describe('§3.2 the cancel boundary', () => {
  it('allows cancel while the wave is the step in flight', async () => {
    const h = harness({ target: packedTarget(), servedWebDigest: () => WEB_DIGEST })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_MACHINES)).toBe('running')
    expect(h.engine.cancel('op_1')).toMatchObject({ canceled: true })
  })

  it('refuses cancel from the server swap onward', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      servedWebDigest: () => WEB_DIGEST,
      requestCoordinatorRestart: () => {},
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_SERVER)).toBe('running')
    expect(h.engine.cancel('op_1')).toMatchObject({
      canceled: false,
      refused: 'irreversible',
      step: UPDATE_STEP_SERVER,
    })
  })
})

describe('the exclusion group', () => {
  it('is the one a server move will join, not one per kind', () => {
    expect(updateOperationKind().exclusionGroup).toBe(LIFECYCLE_EXCLUSION_GROUP)
    expect(LIFECYCLE_EXCLUSION_GROUP).toBe('lifecycle')
  })
})

// ──────────────────── §3.3 liveness (POD-2101) ────────────────────

/**
 * ONE TABLE, AND IT HAS TO NEST. Every number below belongs to a different
 * process — a daemon's download timeout, its git budget, this server's step
 * deadlines — and the only thing that keeps them coherent is that somebody
 * asserts the order they have to be in.
 */
describe('the budgets nest', () => {
  const machines = UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]
  const prepare = UPDATE_STEP_DEADLINES[UPDATE_STEP_PREPARE]
  const web = UPDATE_STEP_DEADLINES[UPDATE_STEP_WEB]
  const server = UPDATE_STEP_DEADLINES[UPDATE_STEP_SERVER]

  it('lets a daemon fail on its OWN deadline before the coordinator gives up on it', () => {
    // Otherwise the machine's real reason — a dead remote, a refused checkout —
    // is replaced by the coordinator's guess that it went quiet.
    expect(UPDATE_BUDGETS.downloadTimeoutMs).toBeLessThan(machines?.silenceMs ?? 0)
    expect(UPDATE_BUDGETS.gitConvergenceMs).toBeLessThan(machines?.silenceMs ?? 0)
  })

  it('measures the wave against the LONGEST legitimate silence, not the cadence', () => {
    // A daemon that predates `percent` reports `downloading` once and works in
    // silence for its whole budget. Judging the step on the heartbeat cadence
    // would stall and re-grant that machine mid-transfer, every time.
    expect(machines?.silenceMs).toBe(
      UPDATE_BUDGETS.gitConvergenceMs + UPDATE_BUDGETS.machineSilenceMarginMs,
    )
    expect(UPDATE_BUDGETS.downloadHeartbeatMs).toBeLessThan(machines?.silenceMs ?? 0)
  })

  it('keeps every silence budget inside its own step total', () => {
    for (const budget of [machines, prepare, web, server]) {
      if (budget?.silenceMs === undefined || budget.totalMs === undefined) continue
      expect(budget.silenceMs).toBeLessThan(budget.totalMs)
    }
  })

  it('beats faster than the panel calls a step stale', () => {
    // The panel's threshold is sixty seconds (POD-2102); four beats inside it
    // means one lost tick never reads as trouble.
    expect(STEP_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000 / 4)
    for (const budget of [prepare, web]) {
      expect(STEP_HEARTBEAT_INTERVAL_MS).toBeLessThan(budget?.silenceMs ?? Infinity)
    }
  })
})

describe('a step that hands work off still says it is there', () => {
  it('prepare: heartbeats with elapsed time while the pack runs', async () => {
    // A pack is quiet for minutes; the panel calls sixty seconds of quiet
    // trouble. Both were true before this, which is why it said "stuck".
    const h = harness({ requestDestBundle: () => new Promise(() => {}) })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const before = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt ?? 0

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS)
    await h.drain()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)
    expect(step?.state).toBe('running')
    expect(step?.lastProgressAt).toBeGreaterThan(before)
    expect(step?.detail).toContain('15s')
  })

  it('prepare: says nothing more once the pack has answered', async () => {
    let settle = (): void => {}
    const h = harness({
      requestDestBundle: () => new Promise<void>((resolve) => (settle = resolve)),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')

    settle()
    await Promise.resolve()
    await h.engine.whenSettled('op_1')
    const settledAt = h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt ?? 0

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS * 4)
    await h.drain()
    await h.engine.whenSettled('op_1')

    // The outcome came from the pack settling, not from a watcher still ticking.
    expect(h.read().steps?.find((s) => s.id === UPDATE_STEP_PREPARE)?.lastProgressAt).toBe(
      settledAt,
    )
  })

  it('web: heartbeats with elapsed time while the rebuild runs', async () => {
    const h = harness({
      machines: [],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => 'older99',
      requestWebRebuild: () => {},
      preparation: () => ({ webReady: false, bundleReady: false }),
    })
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(stepState(h.read(), UPDATE_STEP_WEB)).toBe('running')

    h.clock.advance(STEP_HEARTBEAT_INTERVAL_MS)
    await h.drain()
    await h.engine.whenSettled('op_1')

    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_WEB)
    expect(step?.state).toBe('running')
    expect(step?.detail).toContain('Rebuilding the app')
    expect(step?.detail).toContain('15s')
  })
})

/**
 * THE DRILL THE OLD DESIGN COULD NOT PASS. Nothing here reads `fleet()`, no
 * panel is open, no poller exists: the only thing that happens is that time
 * passes. The grant deadline used to age inside a `fleet()` read, so this whole
 * sequence would have produced exactly nothing.
 */
describe('a silent grant, with nobody watching', () => {
  const silentWave = () =>
    harness({
      machines: [machine({ id: 'vmi', name: 'vmi3407763' })],
      target: packedTarget(),
      appVersion: 'dev+abc1234',
      servedWebDigest: () => WEB_DIGEST,
    })
  const silenceMs = UPDATE_STEP_DEADLINES[UPDATE_STEP_MACHINES]?.silenceMs ?? 0

  it('stalls visibly, re-issues the grant once, then fails', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    expect(h.sent).toHaveLength(1)

    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')

    // ONE retry, and a retry here MEANS re-issuing the grant: the wave planner
    // skips a machine it believes is mid-grant, so a plain tick would have
    // granted nobody and changed nothing.
    const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
    expect(step?.stalls).toBe(1)
    expect(step?.state).toBe('running')
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.machineId).toBe('vmi')

    h.clock.advance(silenceMs)
    await h.engine.whenSettled('op_1')

    const operation = h.read()
    expect(operation.state).toBe('failed')
    expect(operation.error?.code).toBe('stalled')
    // And the coordinator stops believing in the grant it was waiting on, so
    // the machine is not excluded from every future wave (POD-2101).
    expect(h.updates.releaseInFlightGrants()).toEqual(['vmi'])
  })

  it('a heartbeat re-arms the deadline, so a slow download is not a stalled one', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates })

    for (const percent of [20, 55, 91]) {
      h.clock.advance(silenceMs - 60_000)
      h.updates.onStatus(asMachineId('vmi'), {
        type: 'updateStatus',
        grantId: 'grant_1',
        state: 'downloading',
        version: '0.4.1',
        percent,
      })
      bridge.onFleetChanged()
      await h.engine.whenSettled('op_1')

      const step = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)
      expect(step?.state).toBe('running')
      expect(step?.stalls ?? 0).toBe(0)
      // "vmi3407763 downloading 62%" (§6.2) — the number the panel renders.
      expect(step?.places?.[0]).toMatchObject({ id: 'vmi', state: 'downloading', percent })
    }
    // Three quarters of an hour of a healthy download, never once stalled.
    expect(h.read().state).toBe('running')
  })

  it('drops the percentage from a place that is no longer moving', async () => {
    const h = silentWave()
    await h.engine.start(UPDATE_OPERATION_KIND, h.context())
    await h.engine.whenSettled('op_1')
    const bridge = createUpdateFleetBridge({ engine: h.engine, updates: h.updates })

    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'downloading',
      version: '0.4.1',
      percent: 62,
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')
    h.updates.onStatus(asMachineId('vmi'), {
      type: 'updateStatus',
      grantId: 'grant_1',
      state: 'restarting',
      version: '0.4.1',
    })
    bridge.onFleetChanged()
    await h.engine.whenSettled('op_1')

    const place = h.read().steps?.find((s) => s.id === UPDATE_STEP_MACHINES)?.places?.[0]
    expect(place).toMatchObject({ state: 'restarting' })
    expect(place).not.toHaveProperty('percent')
  })
})
