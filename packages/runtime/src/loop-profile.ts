/**
 * THE process's answer to "how much am I measuring my own event loop", resolved
 * once and read everywhere (loop-profile-levels design §3.4).
 *
 * Five modules used to each read `!!process.env.PODIUM_LOOP_PROFILE` for
 * themselves. That was one boolean answering one question, so the copies could
 * not disagree; four ordered levels can, and a server whose SQL seam thinks it
 * is profiling while its probe timer thinks it is off would produce records
 * that are wrong in a way nothing reports. So the resolution happens ONCE, at
 * this module's import, and every gate is `atLeast(...)` over that one value.
 *
 * Import-time is deliberate: the gates it feeds are themselves module-level
 * constants (`query-attribution`, `task-attribution`), installed before the
 * subsystems they wrap schedule anything. The cost is one config read on a path
 * that already reads config at boot.
 */
import { createLogger } from '@podium/logger'
import {
  LOOP_PROFILE_LEVELS,
  type LoopProfileLevel,
  type ResolvedLoopProfile,
  resolveLoopProfileLevel,
} from './config'

/** The resolved level plus which layer decided it and any refused env value. */
export const loopProfile: ResolvedLoopProfile = resolveLoopProfileLevel()

/** The level itself — the value every gate below compares against. */
export const loopProfileLevel: LoopProfileLevel = loopProfile.level

/**
 * Is this process at `level` or stronger? The comparison is over
 * `LOOP_PROFILE_LEVELS`' order, which is the whole meaning of a level: each one
 * installs what the weaker ones do and more.
 */
export function atLeast(level: LoopProfileLevel): boolean {
  return LOOP_PROFILE_LEVELS.indexOf(loopProfileLevel) >= LOOP_PROFILE_LEVELS.indexOf(level)
}

/** Just the one method this needs, so a test can hand it a spy. */
export interface LoopProfileWarnLog {
  warn(message: string, fields?: Record<string, unknown>): void
}

let warningReported = false

/**
 * Say once, through the logger, that the environment held something that is not
 * a level name — and therefore that this process is NOT profiling the way
 * whoever set that variable meant.
 *
 * It is a CALL rather than a side effect of this module's import because the
 * import happens before `configureProcessLogging` has registered a sink, and a
 * record emitted with no sink registered is not buffered anywhere: it is
 * dropped (packages/logger/src/sinks.ts `emissionGate`). Both components call
 * this from their boot path, at any level, since a refused value is exactly the
 * case where the level is not what the operator expects.
 */
export function reportLoopProfileWarning(
  log: LoopProfileWarnLog = createLogger('runtime:loop'),
): ResolvedLoopProfile['warning'] {
  if (warningReported || !loopProfile.warning) return undefined
  warningReported = true
  log.warn(loopProfile.warning, { level: loopProfileLevel, source: loopProfile.source })
  return loopProfile.warning
}
