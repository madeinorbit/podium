import { runInAction } from 'mobx'
import type { NoticeSink } from '../notices'

export function commandFailureReporter(notices: NoticeSink): (error: unknown) => void {
  const reported = new WeakSet<object>()
  return (error) => {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return
      reported.add(error)
    }
    notices.error(error instanceof Error ? error.message : String(error))
  }
}

/** Observe failures without replacing a command's result or promise identity. */
export function reportCommandFailure<F extends (...args: never[]) => unknown>(
  command: F,
  report: (error: unknown) => void,
): F {
  return ((...args: never[]) => {
    try {
      const result = runInAction(() => command(...args))
      if (result instanceof Promise) void result.then(undefined, report)
      return result
    } catch (error) {
      report(error)
      throw error
    }
  }) as F
}
