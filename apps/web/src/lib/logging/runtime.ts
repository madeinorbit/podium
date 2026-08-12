import type { CrashReporter } from './crash'

/**
 * THE ONE CRASH REPORTER THIS PAGE HAS, reachable from code that has no way to
 * be handed one.
 *
 * React error boundaries are the reason this indirection exists: they are class
 * components rendered deep inside gates and lists, and threading a reporter down
 * to every one of them through props would mean every intermediate component
 * knows about crash reporting. A module-scoped delegate keeps the boundaries
 * saying `reportCrash(error, { componentStack })` and leaves the wiring to boot.
 *
 * NO-OP BEFORE `installWebLogging` RUNS, deliberately. A crash before boot has
 * no transport to ship on and no buffer to ship — the correct behaviour is to
 * do nothing rather than to construct a fallback that reports to nowhere.
 */

let active: CrashReporter | null = null

export function setActiveCrashReporter(reporter: CrashReporter | null): void {
  active = reporter
}

export function reportCrash(error: unknown, context?: Record<string, unknown>): void {
  active?.report(error, context)
}
