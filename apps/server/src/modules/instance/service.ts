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

import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { loadConfig, saveConfig } from '@podium/runtime/config'
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
  /**
   * THE ACCOUNT SEAM (POD-1554). `auth.*` stopped being process-wide the moment a
   * password belonged to a person rather than to the box, so this service now takes
   * the users repository and the caller's id. Both come from `FamilyState`; neither
   * is resolved here, and there is deliberately no second principal-to-user path at
   * this seam — `callerUserId(ctx)` in derived-family.ts is the only one.
   */
  readonly users?: InstanceAccountStore | undefined
  readonly callerUserId?: string | undefined
  /** `credentialsRequired()` from the composition root — see AuthRouteOptions.loginRequired. */
  readonly loginRequired?: (() => boolean) | undefined
}

/** The slice of `UsersRepository` the auth commands need. */
export interface InstanceAccountStore {
  get(userId: string): { role: string } | undefined
  credentialFor(userId: string): { passwordHash: string | null } | undefined
  setPasswordHash(userId: string, passwordHash: string, updatedAt: string): void
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
    // "Already set" is now the CALLER having a credential, not a file existing.
    if (!password && !input.acknowledgeNoPassword && !this.callerCredential?.passwordHash) {
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
    // Setup's optional password is the caller's own credential, same as auth.setPassword.
    if (password) {
      const { users, callerUserId } = this.requireAccountStore()
      users.setPasswordHash(callerUserId, await hashPassword(password), new Date().toISOString())
    }
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

  /**
   * WHO IS ASKING, and their own credential — never the instance's, because after
   * POD-1554 the instance does not have one. `deps.callerUserId` is
   * `FamilyState.caller.userId`, which `callerUserId(ctx)` in derived-family.ts
   * already resolved from the transport principal and which THROWS when there is
   * no authenticated human. That throw is why nothing below re-checks for one: an
   * unauthenticated caller cannot reach these methods at all.
   */
  private get callerCredential() {
    return this.deps.users?.credentialFor(this.deps.callerUserId ?? '')
  }

  /** `{ loginRequired }` is instance policy; the other two are about the CALLER.
   *  Still never the password or its hash — there is nothing else to return. */
  status() {
    return {
      loginRequired: this.deps.loginRequired?.() ?? false,
      hasOwnCredential: Boolean(this.callerCredential?.passwordHash),
      canManageInstance: this.deps.users?.get(this.deps.callerUserId ?? '')?.role === 'admin',
    }
  }

  /** MY OWN password. Requires the CURRENT one when the caller already has a
   *  credential — defends against a hijacked session. A caller with none yet skips
   *  the check (bootstrap). Shipped behaviour, now scoped to one account. */
  async setPassword(input: { current?: string | undefined; next: string }) {
    const { users, callerUserId } = this.requireAccountStore()
    const existing = users.credentialFor(callerUserId)?.passwordHash
    if (existing && !(input.current && (await verifyPasswordHash(input.current, existing)))) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
    }
    users.setPasswordHash(callerUserId, await hashPassword(input.next), new Date().toISOString())
    return { loginRequired: this.deps.loginRequired?.() ?? true }
  }

  /**
   * INSTANCE POLICY (POD-1554). Turning login off does NOT delete anyone's
   * credential — it writes `auth.openMode` in config.json — so turning it back on
   * restores every account's existing password rather than making everyone
   * re-enrol. `current` is the CALLER's own password, verified for the same
   * hijacked-session reason as `setPassword`.
   */
  async setLoginRequired(input: {
    required: boolean
    current: string
    acknowledgeNoPassword?: true | undefined
  }) {
    if (!input.required && !input.acknowledgeNoPassword) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Confirm running without a login password.',
      })
    }
    const { users, callerUserId } = this.requireAccountStore()
    const existing = users.credentialFor(callerUserId)?.passwordHash
    if (existing && !(await verifyPasswordHash(input.current, existing))) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is incorrect' })
    }
    const config = loadConfig()
    saveConfig({ ...config, auth: { ...config.auth, openMode: !input.required } })
    return { loginRequired: this.deps.loginRequired?.() ?? input.required }
  }

  /** A server assembled without a user store serves no credential writes. Refusing
   *  is the honest answer: there is no account for the password to belong to. */
  private requireAccountStore() {
    const users = this.deps.users
    const callerUserId = this.deps.callerUserId
    if (!users || !callerUserId) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'account store unavailable' })
    }
    return { users, callerUserId }
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
