/**
 * Server-side telemetry composition [spec:SP-f933].
 *
 * The server is the SOLE emitter (D10): joined daemons and clients are covered
 * by the hub's decision and never construct one of these. This module is the
 * only place that decides WHICH signals feed the counters — @podium/telemetry
 * owns what may be sent; this owns what we choose to count.
 *
 * Everything here is subscription-shaped and best-effort. A telemetry failure
 * must never affect a user-visible code path, so the bus (which isolates
 * listener errors per-listener) is the whole integration surface: no session
 * spawn, issue mutation, or shutdown can fail because of this file.
 */
import { resolveInstallDir, stateDir } from '@podium/runtime/config'
import { TelemetryEmitter } from '@podium/telemetry'
import type { EventBus } from './modules/bus'

export interface TelemetryWiringDeps {
  bus: EventBus
  /** Read at FLUSH time only — never retained between flushes. */
  machineCount: () => number
  /** Injected in tests; defaults to the real state dir / install root. */
  stateDir?: string
  installRoot?: string
}

export interface TelemetryWiring {
  emitter: TelemetryEmitter
  /** Unsubscribes and stops the flush timer. */
  stop: () => void
  /** Best-effort final flush for the graceful-shutdown path. */
  flush: () => Promise<void>
}

/**
 * Construct the emitter and subscribe it to the signals that feed the `usage`
 * tier. Consent is NOT checked here: the emitter re-reads it on every record
 * and every flush (D4/D9), so wiring is unconditional and a user who opts in
 * mid-run starts counting with no restart.
 *
 * The subscriptions map 1:1 onto the schema's closed `features` enum — there is
 * deliberately no generic "track this string" seam, because that is exactly how
 * a free-text field gets added by accident.
 */
export function wireTelemetry(deps: TelemetryWiringDeps): TelemetryWiring {
  const emitter = new TelemetryEmitter({
    stateDir: deps.stateDir ?? stateDir(),
    installRoot: deps.installRoot ?? resolveInstallDir(),
    // Must stay the literal `process.env.PODIUM_APP_VERSION`: build-bun's
    // --define only rewrites that exact expression, and a dynamic read would
    // leave shipped builds reporting 'dev' forever (the SP-f4b9 gotcha).
    version: process.env.PODIUM_APP_VERSION ?? 'dev',
    gauges: () => ({ machines: deps.machineCount() }),
  })

  const unsubscribes = [
    deps.bus.on('session.created', ({ agentKind }) => emitter.recordSession(agentKind)),
    // 'issues' = the tracker was used this window. Any issue mutation is proof
    // enough; the payload records only that the surface was touched, never by
    // whom, on what, or with what text.
    deps.bus.on('issue.updated', () => emitter.markFeature('issues')),
  ]

  emitter.start()

  return {
    emitter,
    stop: () => {
      for (const off of unsubscribes) off()
      emitter.stop()
    },
    flush: () => emitter.flush(),
  }
}
