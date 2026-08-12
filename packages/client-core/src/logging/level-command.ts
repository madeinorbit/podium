import { createLogger, type LogLevel, setLogLevel } from '@podium/logger'

/**
 * THE CLIENT END OF THE OPERATOR'S KNOB (POD-1920, chunk 7 of
 * [spec:2026-08-11-logging-strategy-design]).
 *
 * The server pushes `setLogLevel` down the client socket; this applies it. It is
 * in `client-core` rather than in `apps/web` and `apps/mobile` for the reason
 * the whole composition root is: two implementations get the non-obvious halves
 * right only if both authors remember them, and the non-obvious halves here are
 * the TTL and the fact that there is exactly one call to `setLogLevel`.
 *
 * ---------------------------------------------------------------------------
 * ONE CALL, SO ONE KNOB
 * ---------------------------------------------------------------------------
 * `setLogLevel` is the whole mechanism. The forwarding sink pins no `minLevel`
 * of its own, so raising the level raises what the console shows AND what the
 * client forwards, together — the spec's "raising a client to `debug` forwards
 * `debug` too" as one control. Nothing here may grow a second threshold for the
 * forwarding side: two controls that can disagree about what a client is
 * currently reporting is precisely the failure this design refuses, and nothing
 * would fail to tell you it had happened.
 *
 * ---------------------------------------------------------------------------
 * EVERY RAISE EXPIRES
 * ---------------------------------------------------------------------------
 * A client left at `debug` forever forwards a firehose off a user's machine that
 * nobody asked for and nobody reads. So a raise carries a deadline from the
 * moment it lands, and there are three ways back, in increasing order of how
 * little they depend on anybody remembering:
 *
 *   1. the operator sends `level: null` (or the user presses the affordance);
 *   2. the TTL expires and the client puts itself back;
 *   3. the page reloads, and a fresh boot is at the default again.
 *
 * (3) is why the raise is deliberately NOT persisted. It is state that exists to
 * be temporary, and the strongest reset available is the one that happens by
 * itself.
 *
 * ---------------------------------------------------------------------------
 * THE RAISE ANNOUNCES ITSELF
 * ---------------------------------------------------------------------------
 * Every transition logs at `warn`, which is at or above every default this ships
 * with — so the raise, and its expiry, land in the client's own forwarded log
 * file next to the records they explain. An operator reading
 * `~/.podium/logs/clients/<origin>.ndjson` can therefore tell "this client had
 * nothing more to say" from "this client was never turned up", which is the
 * question they would otherwise answer by guessing.
 */

const log = createLogger('client-core:log-level')

/** Applied when a raise names no duration. Long enough to reproduce a problem
 *  on a call, short enough that a forgotten raise costs one bounded hour. */
export const DEFAULT_LEVEL_TTL_MS = 30 * 60 * 1000

/** The wire caps this too (`MAX_LOG_LEVEL_TTL_MS`); clamping again here is what
 *  makes the bound a property of the CLIENT rather than of the last schema that
 *  validated the frame. */
export const MAX_LEVEL_TTL_MS = 24 * 60 * 60 * 1000

/** What the server asks for. Structurally the protocol's `SetLogLevelMessage`
 *  minus its `type` — restated so this subpath keeps importing nothing. */
export interface LogLevelCommand {
  /** `null` restores the boot default. */
  level: LogLevel | null
  ttlMs?: number
}

/** What the client is doing right now, for an affordance to render. */
export interface LogLevelStatus {
  /** The level in force. */
  level: LogLevel
  /** What this client boots at, and what it returns to. */
  boot: LogLevel
  /** Epoch ms at which the raise lifts, or `null` when nothing is raised. */
  expiresAt: number | null
}

export interface LevelController {
  apply(command: LogLevelCommand): void
  status(): LogLevelStatus
  dispose(): void
}

interface ControllerDeps {
  /** The level this client booted at — what a reset returns to. */
  boot: LogLevel
  now?: () => number
}

/**
 * Build the controller for one client installation.
 *
 * `now` is injectable because the tests drive the expiry with fake timers and a
 * status assertion that read a real clock would be a flake waiting for a slow
 * machine.
 */
export function createLevelController(deps: ControllerDeps): LevelController {
  const now = deps.now ?? (() => Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiresAt: number | null = null
  let level: LogLevel = deps.boot

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const toBoot = (reason: 'reset' | 'expired'): void => {
    clearTimer()
    expiresAt = null
    const from = level
    level = deps.boot
    setLogLevel(deps.boot)
    // At `warn` on purpose: below the boot default this line would vanish from
    // the forwarded stream exactly when it is the explanation for why the stream
    // went quiet again.
    log.warn('client log level restored', { from, to: deps.boot, reason })
  }

  return {
    apply(command) {
      if (command.level === null) {
        toBoot('reset')
        return
      }
      const ttlMs = Math.min(command.ttlMs ?? DEFAULT_LEVEL_TTL_MS, MAX_LEVEL_TTL_MS)
      clearTimer()
      level = command.level
      expiresAt = now() + ttlMs
      // THE ONE CALL. Console and forwarding move together because this is the
      // only threshold either of them consults.
      setLogLevel(command.level)
      // `to`, NOT `level`: the record shape OWNS `level`, and a caller field
      // under a reserved name is DROPPED rather than merged — this line would
      // have reported the raise without saying what it raised to.
      log.warn('client log level raised', { to: command.level, ttlMs })
      timer = setTimeout(() => toBoot('expired'), ttlMs)
      // A pending expiry must not hold a Node-like runtime open; browsers have
      // no `unref` and need none.
      ;(timer as { unref?: () => void }).unref?.()
    },
    status: () => ({ level, boot: deps.boot, expiresAt }),
    dispose: clearTimer,
  }
}

/**
 * THE LIVE CONTROLLER, reachable from the socket transport.
 *
 * Same indirection, and same reason, as `setActiveCrashReporter`: the frame
 * arrives in code that has no way to be handed the installation. A NO-OP before
 * boot is correct — a raise addressed at a client whose logging is not installed
 * has nothing to raise.
 */
let active: LevelController | null = null

export function setActiveLevelController(controller: LevelController | null): void {
  active = controller
}

/** Apply a server-pushed level command to this client. */
export function applyServerLogLevel(command: LogLevelCommand): void {
  active?.apply(command)
}

/** This client's level state, or `null` before logging is installed. */
export function logLevelStatus(): LogLevelStatus | null {
  return active?.status() ?? null
}
