/**
 * POD-7163 — THE DEVICE FIXTURE: the real kernel Replica, loader, client
 * facade, row source and pool, composed as the app composes them
 * (assembly.ts), against the small collection server, with tiny budgets by
 * default and every load through the load recorder on a simulated clock.
 *
 * Screen tests open, leave and reopen screens on it (`screens.test.fixture.ts`)
 * and assert what the opening asked the server for (`requests`, `hops`) and
 * how long it showed LOADING (`loadingMs`), the design's testing rules
 * (POD-7157). `settle()` runs the device until nothing is due: the loader's
 * batch window and each answer's fake fetch time pass on the simulated clock,
 * and each install burst costs a frame.
 *
 * A test that needs a large budget passes `budgets: largeBudget(why)`.
 *
 * Memory shrinks only when the platform says so (POD-7161): the fixture is the
 * platform, and `idle()`, `background()` and `memoryWarning()` say it. The
 * Replica's clock is the simulated one, so `passGrace()` lets what was just
 * released leave its grace.
 */
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { CollectionServer, issue, WORLD_NOW } from '../../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../../sync/src/conformance/in-memory'
import { FRAME_MS, LoadRecorder, SimClock } from '../../../sync/src/conformance/load-recorder'
import {
  policyBudgets,
  TEST_BUDGETS,
  type TestBudgets,
} from '../../../sync/src/conformance/test-budgets'
import { CollectionLoader } from '../../../sync/src/replica/loader'
import { manualMemorySignals, WARM_GRACE_MS } from '../../../sync/src/replica/memory'
import { Replica } from '../../../sync/src/replica/replica'
import type { CachePolicy } from '../../../sync/src/replica/types'
import type { SyncUnitOfWork } from '../../../sync/src/span'
import { createWorklistPool } from '../create'
import { fixedLocals } from '../shared/locals-source'
import { createRowSource } from '../shared/row-source'

export const ISSUE = 'issueProjection'

/** The browser's policy, with the budgets of the test. */
export function devicePolicy(budgets: TestBudgets = TEST_BUDGETS): CachePolicy {
  return {
    clientType: 'browser',
    steps: [
      { step: 'always', collections: ['session.live'] },
      { step: 'view', collections: [] },
      { step: 'sidebar', collections: ['issueProjection.sidebar'] },
      { step: 'stubs', collections: ['issueProjection.stubs'] },
    ],
    recentDays: 30,
    ...policyBudgets(budgets),
  }
}

/** An issue value with the fields the readers of the screens read. */
export const issueValue = (id: string, fields: Record<string, unknown> = {}) =>
  issue(id, { repoPath: '/synthetic', createdAt: '2025-01-01T00:00:00Z', ...fields })

/** A closed issue: no policy collection holds it. */
export const closedValue = (id: string, fields: Record<string, unknown> = {}) =>
  issueValue(id, { stage: 'done', closedReason: 'completed', ...fields })

export interface DeviceOptions {
  readonly world?: (server: CollectionServer) => void
  /** Default: the tiny test budgets (`TEST_BUDGETS`). */
  readonly budgets?: TestBudgets
  readonly policy?: Partial<CachePolicy>
  readonly chunkRows?: number
  /** The fake fetch time of every answer, in simulated ms. */
  readonly fetchMs?: number
  /** The server answers what records come with in the same answer, as the real route does (default). */
  readonly serverComesWith?: boolean
  /** Wrap the store's unit of work (a held save, a slow disk). */
  readonly unitOfWork?: (inner: SyncUnitOfWork) => SyncUnitOfWork
}

export type Device = Awaited<ReturnType<typeof openDevice>>

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export async function openDevice(options: DeviceOptions = {}) {
  const clock = new SimClock()
  const recorder = new LoadRecorder({
    clock,
    ...(options.fetchMs === undefined ? {} : { fetchMs: options.fetchMs }),
  })
  const server = new CollectionServer()
  const budgets = options.budgets ?? TEST_BUDGETS
  server.policy = { ...devicePolicy(budgets), ...options.policy }
  server.chunkRows = options.chunkRows ?? 50
  // The real route answers what records come with in the same answer (POD-7168).
  server.answerComesWith = options.serverComesWith ?? true
  options.world?.(server)
  recorder.attach(server)
  const storage = await inMemoryInstantiation.open()
  const { cache } = storage.viewFor('u-ada')
  let loader: CollectionLoader | undefined
  let replica: Replica | undefined
  const facade = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    exits: (entity, id) => replica?.exitKind(entity, id),
    collections: () => replica,
    loader: () => loader,
  })
  // Progress the fixture watches to know the device is quiet.
  let events = 0
  let bursts = 0
  const unitOfWork = options.unitOfWork?.(storage.unitOfWork)
  const memory = manualMemorySignals()
  replica = new Replica({
    store: cache,
    authority: server,
    ...(unitOfWork === undefined ? {} : { unitOfWork }),
    now: () => WORLD_NOW + clock.now(),
    memory: { signals: memory, warmInstances: budgets.warmInstances },
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      events += 1
      facade.onKernelEvent(event)
      loader?.onEvent(event)
    },
    // As the app composes it (assembly.ts): the facade's rows, then the
    // loader's markers and stubs, once per burst (POD-7165). Each burst is a
    // main-thread task and a render: a frame of simulated time.
    batchEvents: (emit) => {
      bursts += 1
      clock.spend(FRAME_MS)
      const batch = (loader as { batch?: (run: () => void) => void } | undefined)?.batch
      if (batch === undefined) facade.batch(emit)
      else batch.call(loader, () => facade.batch(emit))
    },
  })
  loader = new CollectionLoader({ replica, schedule: clock.schedule })
  const rows = createRowSource({ principal: { userId: 'u-ada' } }, facade, {
    pending: { byRow: () => new Map() },
  })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: WORLD_NOW })
  const handle = createWorklistPool(rows.source, locals.source, { schedule: () => () => {} })
  const kernel = replica
  const theLoader = loader
  const progress = () => events + bursts + recorder.loads.length + recorder.chunks
  /** Run the device's own asynchronous work until it waits only on the simulated clock. */
  const quiet = async () => {
    let seen = progress()
    for (let still = 0, turn = 0; still < 3 && turn < 2_000; turn += 1) {
      await tick()
      const now = progress()
      if (now === seen) still += 1
      else {
        still = 0
        seen = now
      }
    }
  }
  const publish = () => {
    rows.flush()
    handle.pool.hydrate()
  }
  /**
   * Run until nothing is due on the simulated clock; false when the device was
   * still busy after `rounds`, or past `untilMs` of simulated time (a chain of
   * loads that never ends).
   */
  const settle = async (rounds = 200, untilMs = Number.POSITIVE_INFINITY): Promise<boolean> => {
    for (let round = 0; round < rounds; round += 1) {
      await quiet()
      publish()
      await quiet()
      publish()
      if (clock.now() > untilMs) return false
      if (!clock.next()) return true
    }
    return false
  }
  const disposers: (() => void)[] = []
  kernel.connect()
  if (!(await settle())) throw new Error('the first download never finished')
  return {
    server,
    replica: kernel,
    loader: theLoader,
    pool: handle.pool,
    rows,
    recorder,
    clock,
    settle,
    /** The instances whose rows are in memory now (the disk index's view), by instance key. */
    memoryInstances(): ReadonlySet<string> {
      return new Set(cache.readDiskIndex().memoryInstances())
    },
    /** Cut the connection: the loader stops, and every load attempted is refused and counted. */
    offline(): void {
      recorder.offline = true
      kernel.disconnect()
    },
    online(): void {
      recorder.offline = false
      kernel.connect()
    },
    /**
     * Unload what memory holds but no view reads, keeping it on the device's
     * disk: POD-7159's test hook. Until it lands this throws, and the tests
     * that need it are pending (`PENDING_UNLOAD`).
     */
    async unload(): Promise<void> {
      const hook = (kernel as unknown as { unloadForTest?: () => Promise<void> }).unloadForTest
      if (hook === undefined) throw new Error('unload needs POD-7159 (the disk layer)')
      await hook.call(kernel)
      await settle()
    },
    /**
     * An idle moment: memory shrinks the warm set to its budget, keeping what
     * was released within the grace. The platform reports one when memory
     * asked for it; when it has not, the fixture reports one anyway.
     */
    async idle(): Promise<void> {
      if (memory.idle() === 0) await kernel.shrinkMemory('idle')
      await kernel.settled()
      await settle()
    },
    /** The page or app goes to the background. */
    async background(): Promise<void> {
      memory.background()
      await kernel.settled()
      await settle()
    },
    /** The platform warns of low memory: the grace does not hold. */
    async memoryWarning(): Promise<void> {
      memory.memoryWarning()
      await kernel.settled()
      await settle()
    },
    /** Let simulated time pass the warm set's grace (what was released is then oldest-first fair game). */
    passGrace(): void {
      clock.spend(WARM_GRACE_MS + 1)
    },
    /** Run `dispose` when the device is closed. */
    onDispose(dispose: () => void): void {
      disposers.push(dispose)
    },
    dispose(): void {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      kernel.disconnect()
      rows.dispose()
      locals.dispose()
      handle.dispose()
    },
  }
}
