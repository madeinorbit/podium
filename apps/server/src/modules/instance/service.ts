/**
 * THE INSTANCE SERVICE — one L3 seam over the deployment's own configuration.
 *
 * The eight instance commands (`setup.*`, `auth.*`, `telemetry.*`) are the only
 * family in this cutover whose implementation is NOT a method on a service in
 * `RegistryModules`. They call module-level functions in `@podium/runtime/setup`,
 * `@podium/telemetry` and `apps/server/src/auth-store` — process-wide functions
 * over `config.json` and the password store, with no instance to inject.
 *
 * That is exactly why this adapter exists rather than the handlers importing
 * those modules directly. The derived-family builder hands a handler its SERVICE
 * and nothing else, and the property that buys — a handler cannot reach state it
 * was not given — is only real if every family plays by it. A handler that
 * imported `setPassword` at module scope would be reaching around the seam in the
 * one file nobody would think to check.
 *
 * So the reach-through is confined HERE, in one named place, with the same shape
 * every other family's service has. Everything below is a straight forward to the
 * shipped function; there is no logic in this file, deliberately.
 */

import {
  hasPassword,
  clearPassword as storeClearPassword,
  setPassword as storeSetPassword,
  verifyPassword,
} from '@podium/runtime/auth-store'
import { loadConfig } from '@podium/runtime/config'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  NETWORK_OPTIONS,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
} from '@podium/runtime/setup'
import type { TelemetryEmitter } from '@podium/telemetry'
import {
  readTelemetryState,
  resetInstallId,
  setConsent,
  shouldAskForConsent,
} from '@podium/telemetry'
import { TRPCError } from '@trpc/server'

/** The one optional dependency that is genuinely per-request rather than
 *  process-wide: the telemetry emitter, present only when the server was
 *  assembled with one. `telemetry.preview` renders the REAL pending report from
 *  it so what the user is shown cannot drift from what is sent. */
export interface InstanceDeps {
  readonly emitter?: Pick<TelemetryEmitter, 'buildUsageReport'> | undefined
}

export class InstanceService {
  constructor(private readonly deps: InstanceDeps) {}

  // ---- setup ----

  /** Current deployment identity, for Settings → Network. */
  info() {
    const c = loadConfig()
    return {
      mode: c.mode ?? null,
      publicUrl: c.publicUrl ?? null,
      serverUrl: c.serverUrl ?? null,
      // Must stay the literal `process.env.PODIUM_APP_VERSION` read (build-bun
      // --define); the Machines panel compares each daemon's reported version
      // against this. [POD-838]
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }
  }

  options() {
    return NETWORK_OPTIONS
  }

  commandFor(
    option: 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual',
    port: number,
  ) {
    return networkOptionCommand(option, port)
  }

  channel() {
    return getUpdateChannel()
  }

  /**
   * The first-run "make this instance reachable" step. MOVED VERBATIM from the
   * router procedure — the validation order matters and is preserved: URL first,
   * then the no-password acknowledgement, then `applySetup`, then telemetry
   * (AFTER applySetup, so a consent write can never be lost to the config
   * round-trip that follows it), then the password LAST.
   */
  async complete(input: {
    publicUrl: string
    mode?: 'all-in-one' | 'server' | undefined
    password?: string | undefined
    acknowledgeNoPassword?: true | undefined
    telemetry?: { usage: 'on' | 'off'; crash: 'on' | 'off' } | undefined
  }) {
    const v = validatePublicUrl(input.publicUrl)
    if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error })
    const password = input.password?.trim()
    // Neither a new password NOR an explicit no-password ack is required when one
    // is ALREADY set — that's "keep the current password" (e.g. setting the URL
    // later from Settings → Machines). It is only a mandatory choice on a fresh,
    // password-less instance.
    if (!password && !input.acknowledgeNoPassword && !hasPassword()) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Confirm running without a login password.',
      })
    }
    const cfg = applySetup({
      publicUrl: v.normalized,
      ...(input.mode ? { mode: input.mode } : {}),
    })
    // Honours the kill switches: an env that says "do not track" wins over an
    // answer the UI should not have collected.
    if (input.telemetry && shouldAskForConsent()) setConsent(input.telemetry)
    if (password) await storeSetPassword(password)
    return cfg
  }

  /** Daemon onboarding: one pasted join code becomes daemon config. The same core
   *  `applyJoin` the CLI uses, so web and terminal flows stay identical. */
  join(code: string) {
    try {
      return applyJoin(code.trim())
    } catch (e) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
    }
  }

  connect(input: { mode: 'all-in-one' | 'client' | 'server'; serverUrl?: string | undefined }) {
    try {
      return applyMode(input)
    } catch (e) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
    }
  }

  setChannel(channel: 'stable' | 'edge') {
    return setUpdateChannel(channel)
  }

  // ---- auth ----

  status() {
    return { enabled: hasPassword() }
  }

  /** Requires the CURRENT password when one is set — defends against a hijacked
   *  session. In open mode the check is skipped (bootstrap). Shipped behaviour. */
  async setPassword(input: { current?: string | undefined; next: string }) {
    if (hasPassword() && !(input.current && (await verifyPassword(input.current)))) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
    }
    await storeSetPassword(input.next)
    return { enabled: true }
  }

  async clearPassword(input: { current: string; acknowledgeNoPassword?: true | undefined }) {
    if (!input.acknowledgeNoPassword) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Confirm running without a login password.',
      })
    }
    if (hasPassword() && !(await verifyPassword(input.current))) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
    }
    storeClearPassword()
    return { enabled: false }
  }

  // ---- telemetry ----

  /** Consent state is read from config.json, never from the request context — it
   *  must work with no server. */
  telemetryState() {
    return readTelemetryState(loadConfig())
  }

  setConsent(input: { usage?: 'on' | 'off' | undefined; crash?: 'on' | 'off' | undefined }) {
    return setConsent(input)
  }

  resetInstallId() {
    return resetInstallId()
  }

  /** The example report the Privacy page shows — rendered from the REAL emitter
   *  where one exists, so what the user is shown cannot drift from what is sent;
   *  null before anyone has opted in (there is no real report to show until
   *  then, by design). */
  previewReport() {
    return this.deps.emitter?.buildUsageReport() ?? null
  }
}
