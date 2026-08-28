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

import type { ServerReadiness, UserId } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import {
  type FleetUpdateChannel,
  loadConfig,
  resolveUpdateChannel,
  saveConfig,
} from '@podium/runtime/config'
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
import { serverBuildVersion } from '../../build-version'

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
  readonly callerUserId?: UserId | undefined
  /** `credentialsRequired()` from the composition root — see AuthRouteOptions.loginRequired. */
  readonly loginRequired?: (() => boolean) | undefined
  /**
   * Called after the fleet default channel is written (POD-1882). Machines with
   * no pin of their own resolve against that value, so their projected channel
   * and target go stale the instant it changes; the composition root uses this
   * to re-resolve targets and re-broadcast, rather than leaving the UI on the
   * previous answer until some unrelated broadcast happens along.
   *
   * ASYNC AND AWAITED, not fire-and-forget: the new channel's target has to be
   * loaded BEFORE the projection goes out, or clients get the new channel beside
   * the old channel's target chip and no second broadcast ever corrects it.
   */
  readonly onFleetChannelChanged?: ((channel: FleetUpdateChannel) => Promise<void>) | undefined
  /**
   * Live readiness, for `setup.activate` (POD-2766). READ AT APPLY, not captured
   * at construction: the whole point of the command is that it refuses an
   * instance that is no longer activation-pending, and a snapshot taken when the
   * service was built would let a second click on a stale screen restart a
   * deployment that had already recovered.
   */
  readonly readiness?: (() => ServerReadiness) | undefined
  /**
   * Replace this process so it adopts the config on disk — `requestCoordinatorRestart`
   * from the composition root, which resolves to the source redeploy unit or the
   * installed process-manager restart. Optional because a server can be assembled
   * without one (tests, the in-process MCP caller), and `activate` refuses rather
   * than pretending it restarted.
   */
  readonly requestCoordinatorRestart?: (() => void) | undefined
}

/** The slice of `UsersRepository` the auth commands need. */
export interface InstanceAccountStore {
  get(userId: UserId): { role: string } | undefined
  credentialFor(userId: UserId): { passwordHash: string | null } | undefined
  setPasswordHash(userId: UserId, passwordHash: string, updatedAt: string): void
}

/** The native updater must use the deployment's advertised HTTPS edge, not the page origin.
 *
 * An all-in-one desktop deliberately loads its page over loopback HTTP. Deriving the manifest
 * from that origin writes an endpoint Tauri release builds refuse, even when the deployment has
 * a usable public URL. This server-owned answer is the endpoint producer for the native writer.
 */
export function desktopUpdaterEndpoint(
  channel: FleetUpdateChannel,
  publicUrl: string | undefined,
): string | undefined {
  if (channel !== 'dev' || !publicUrl) return undefined
  let parsed: URL
  try {
    parsed = new URL(publicUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  return `${publicUrl.replace(/\/+$/, '')}/updates/feed/dev/latest.json`
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
      networkOption: c.networkOption ?? null,
      serverUrl: c.serverUrl ?? null,
      // Must stay the literal `process.env.PODIUM_APP_VERSION` read (build-bun
      // --define); the Machines panel compares each daemon's reported version
      // against this. [POD-838]
      appVersion: serverBuildVersion(),
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

  /**
   * The EFFECTIVE fleet default, not merely what config.json says. POD-1882:
   * `PODIUM_UPDATE_CHANNEL` wins over config in `resolveUpdateChannel`, which is
   * what MachinesService resolves machines against — so reporting the config
   * value here would let Settings → Updates display, and accept a write of, a
   * channel the fleet is not actually on. `envForced` is what lets the UI say so
   * instead of offering a mutation that cannot take effect.
   */
  channel() {
    const config = loadConfig()
    const channel = resolveUpdateChannel()
    const envForced = Boolean(process.env.PODIUM_UPDATE_CHANNEL)
    return {
      channel,
      envForced,
      configured: getUpdateChannel(),
      desktopUpdateEndpoint: desktopUpdaterEndpoint(channel, config.publicUrl),
    }
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
    networkOption?:
      | 'tailscale-funnel'
      | 'tailscale-serve'
      | 'cloudflare-tunnel'
      | 'manual'
      | undefined
    mode?: 'all-in-one' | 'server' | undefined
    password?: string | undefined
    acknowledgeNoPassword?: true | undefined
    telemetry?: { usage: 'on' | 'off'; crash: 'on' | 'off' } | undefined
  }) {
    const v = validatePublicUrl(input.publicUrl)
    if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error })
    // RAW, NOT TRIMMED (POD-1148). Nothing else in the product trims: `/auth/login` verifies
    // the string as typed and `auth.setPassword` hashes it as given. Trimming only here meant a
    // password pasted with a leading or trailing space — the ordinary password-manager case —
    // was stored as a string its owner could never enter again, and made this command and
    // Settings → Security store DIFFERENT credentials for identical keystrokes. Trimming at
    // login instead would be worse: it would silently rewrite what people already have and
    // break any password that legitimately contains whitespace. Empty is still no password.
    const password = input.password
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
      ...(input.networkOption ? { networkOption: input.networkOption } : {}),
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

  async setChannel(channel: FleetUpdateChannel) {
    if (process.env.PODIUM_UPDATE_CHANNEL) {
      // Refusing beats writing a value the environment overrides: a silent
      // no-op would read as success in the UI and leave the fleet elsewhere.
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          "PODIUM_UPDATE_CHANNEL is set in this deployment's environment and overrides the " +
          'configured channel. Unset it to choose the fleet default from Settings.',
      })
    }
    setUpdateChannel(channel)
    // A machine with no pin of its own resolves against this value, so its
    // projected channel and target are stale the moment it changes. AWAIT the
    // re-resolve so the mutation only answers once the fleet's new target is
    // loaded and broadcast — the caller's returned channel and the clients'
    // projection then describe the same moment (POD-1882).
    await this.deps.onFleetChannelChanged?.(channel)
    return this.channel()
  }

  /**
   * ADOPT THE SAVED CONFIG BY REPLACING THIS PROCESS (POD-2766).
   *
   * The command that keeps the remedy in front of the failure. `activation_pending`
   * blocks the data plane because this process is running config nobody asked it to
   * run; the restart that ends it used to be reachable only by getting a shell on
   * the box, so an operator looking at the readiness screen from a browser had no
   * way to comply with what the screen told them to do.
   *
   * THREE REFUSALS, EACH LOAD-BEARING:
   *
   * 1. NOT ACTIVATION-PENDING. This is not a general restart button, and refusing
   *    here is what stops it from becoming one — on a healthy instance there is
   *    nothing to activate, and a remote bounce lever is exactly what the control
   *    plane must not hand out. It also makes a double-click safe: by the time a
   *    second call arrives the state has usually already moved.
   * 2. NOT AN ADMIN. The contract's floor, enforced here because this family
   *    authorizes in its service (see `setLoginRequired`, which verifies the
   *    caller's own credential rather than leaning on the router). A member with a
   *    session must not be able to drop everyone else's transport.
   * 3. NO RESTART CAPABILITY. An installation that cannot replace its own process
   *    says so, rather than answering "restarting" and leaving the operator
   *    watching a screen that will never change.
   */
  activate() {
    const readiness = this.deps.readiness?.()
    if (!readiness) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This server cannot report its own readiness, so it cannot activate a change.',
      })
    }
    if (readiness.state !== 'activation_pending') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This instance is already running its saved setup; there is nothing to activate.',
      })
    }
    this.requireAdmin()
    const restart = this.deps.requestCoordinatorRestart
    if (!restart) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'This Podium installation cannot restart itself. Restart it on the server to activate ' +
          'the saved setup.',
      })
    }
    restart()
    // What the caller should now expect, and the identity being left behind — both
    // already public on /readiness, so this returns no new fact.
    return {
      state: 'restarting' as const,
      stale: readiness.stale ?? [],
      from: serverBuildVersion(),
    }
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
    const userId = this.deps.callerUserId
    return userId ? this.deps.users?.credentialFor(userId) : undefined
  }

  /** `{ loginRequired }` is instance policy; the other two are about the CALLER.
   *  Still never the password or its hash — there is nothing else to return. */
  status() {
    return {
      loginRequired: this.deps.loginRequired?.() ?? false,
      hasOwnCredential: Boolean(this.callerCredential?.passwordHash),
      canManageInstance:
        this.deps.callerUserId !== undefined &&
        this.deps.users?.get(this.deps.callerUserId)?.role === 'admin',
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

  /** The `admin` floor, enforced where this family enforces everything else — in
   *  the service. `status().canManageInstance` is the same question asked for the
   *  UI; this is the one that refuses. */
  private requireAdmin() {
    const { users, callerUserId } = this.requireAccountStore()
    if (users.get(callerUserId)?.role !== 'admin') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only an admin can restart this instance.',
      })
    }
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
