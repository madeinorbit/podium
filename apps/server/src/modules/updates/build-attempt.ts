import { AsyncLocalStorage } from 'node:async_hooks'

export const DEV_BUILD_TIMEOUT_MS = 20 * 60_000

export class BuildTimeoutError extends Error {}

type BuildAttempt = {
  controller: AbortController
  expiresAt: number
  error: BuildTimeoutError
  completed: boolean
}
const attempts = new AsyncLocalStorage<BuildAttempt>()

function currentAttempt(): BuildAttempt | undefined {
  const attempt = attempts.getStore()
  // Detached observations can outlive a successful build. Expired work keeps
  // its cancellation fence; observations of a completed build get no old budget.
  return attempt?.completed && !attempt.controller.signal.aborted ? undefined : attempt
}

/** The same absolute deadline follows every step, without restarting a timer. */
export function buildDeadlineAt(): number | undefined {
  return currentAttempt()?.expiresAt
}

export function buildSignal(): AbortSignal | undefined {
  return currentAttempt()?.controller.signal
}

/** After cancellation, metadata cleanup may finish after failure was reported. */
export async function buildCleanup<T>(task: () => Promise<T>): Promise<T> {
  return await attempts.exit(task)
}

export function throwIfBuildAborted(): void {
  const attempt = currentAttempt()
  if (attempt && Date.now() >= attempt.expiresAt) attempt.controller.abort(attempt.error)
  attempt?.controller.signal.throwIfAborted()
}

/** Interrupt a pending await and fence any result arriving after the deadline. */
export async function buildTask<T>(task: () => Promise<T> | T): Promise<T> {
  throwIfBuildAborted()
  const signal = buildSignal()
  if (!signal) return await task()
  let onAbort: () => void = () => {}
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        throwIfBuildAborted()
        return task()
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    throwIfBuildAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Keep the same timer while approval hands admitted work to its background job. */
export function createBuildAttempt(timeoutMs = DEV_BUILD_TIMEOUT_MS): {
  run<T>(task: () => Promise<T> | T): Promise<T>
  dispose(): void
} {
  const error = new BuildTimeoutError(
    `Development build and publication timed out after ${Math.ceil(timeoutMs / 1_000)}s; the attempt was stopped.`,
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(error), timeoutMs)
  const attempt = { controller, expiresAt: Date.now() + timeoutMs, error, completed: false }
  return {
    run: (task) => attempts.run(attempt, () => buildTask(task)),
    dispose: () => {
      clearTimeout(timer)
      attempt.completed = true
    },
  }
}

/** One timer for preparation, compilation, publication, and normal teardown. */
export async function withBuildAttempt<T>(
  task: () => Promise<T> | T,
  timeoutMs = DEV_BUILD_TIMEOUT_MS,
): Promise<T> {
  if (currentAttempt()) return await buildTask(task)
  const attempt = createBuildAttempt(timeoutMs)
  try {
    return await attempt.run(task)
  } finally {
    attempt.dispose()
  }
}
