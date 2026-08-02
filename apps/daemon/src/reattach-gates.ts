/** Reattach burst limits: bridge wiring stays wider than transcript seeding. */
const REATTACH_CONCURRENCY = 6
const TAIL_SEED_CONCURRENCY = 2

export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const release = (): void => {
    active--
    queue.shift()?.()
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++
        fn().then(resolve, reject).finally(release)
      }
      if (active < max) run()
      else queue.push(run)
    })
}

function createPriorityLimiter(
  max: number,
): <T>(priority: number, fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queues: Array<Array<() => void>> = [[], [], [], []]
  const release = (): void => {
    active--
    for (const queue of queues) {
      const next = queue.shift()
      if (!next) continue
      // Cross a macrotask boundary before the next allocation/parse unit so
      // watchdog timers can run during a large reconnect burst. [spec:SP-c29e]
      active++
      setTimeout(() => {
        active--
        next()
      }, 0)
      return
    }
  }
  return <T>(priority: number, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++
        fn().then(resolve, reject).finally(release)
      }
      if (active < max) run()
      else (queues[priority] ?? queues[3]!).push(run)
    })
}

/**
 * Split gates keep every durable bridge typable before heavy transcript seeds
 * begin, while still pacing both fork fan-out and parsing pressure (POD-612).
 */
export function createReattachGates(opts?: { reattachMax?: number; tailSeedMax?: number }): {
  reattachGate: <T>(fn: () => Promise<T>) => Promise<T>
  tailSeedGate: (fn: () => Promise<void>, priority?: number) => Promise<void>
} {
  const reattachLimit = createLimiter(opts?.reattachMax ?? REATTACH_CONCURRENCY)
  const tailSeedLimit = createPriorityLimiter(opts?.tailSeedMax ?? TAIL_SEED_CONCURRENCY)
  let reattachPending = 0
  const settledWaiters: Array<() => void> = []
  const reattachGate = <T>(fn: () => Promise<T>): Promise<T> => {
    reattachPending++
    return reattachLimit(fn).finally(() => {
      reattachPending--
      if (reattachPending === 0) for (const waiter of settledWaiters.splice(0)) waiter()
    })
  }
  const whenReattachSettled = (): Promise<void> =>
    reattachPending === 0 ? Promise.resolve() : new Promise((resolve) => settledWaiters.push(resolve))
  const tailSeedGate = (fn: () => Promise<void>, priority = 3): Promise<void> =>
    whenReattachSettled().then(() => tailSeedLimit(priority, fn))
  return { reattachGate, tailSeedGate }
}
