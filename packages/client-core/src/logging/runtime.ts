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

/**
 * THE SAME INDIRECTION, FOR THE FLUSH (POD-3224 follow-up).
 *
 * `lib/navigate.ts` is the one seam every self-triggered reload goes through,
 * and it is a plain function in `lib/` with no access to the installation. It
 * has to be able to say "get what you are holding onto the wire, now" one line
 * before it replaces the document — otherwise the record naming the navigation
 * is lost to that navigation, which is what the first live traces showed.
 *
 * NO-OP BEFORE `installWebLogging` RUNS, and after `dispose`, for the reason the
 * reporter above is: a flush with no transport is not a fallback worth having.
 */
let activeFlush: (() => number) | null = null

export function setActiveLogFlusher(flush: (() => number) | null): void {
  activeFlush = flush
}

/**
 * Hand the forwarding buffer to the browser NOW. Returns how many records went.
 *
 * Synchronous: callers are about to navigate, and there is no turn after this.
 */
export function flushLogsBeforeUnload(): number {
  try {
    return activeFlush?.() ?? 0
  } catch {
    // Logging must never be the reason a navigation does not happen.
    return 0
  }
}
