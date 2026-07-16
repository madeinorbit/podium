/**
 * Consent: the tri-state, its kill switches, and the only writer of
 * `config.telemetry` [spec:SP-f933].
 *
 * Tri-state per tier (D2): `on` | `off` | ABSENT. Absent and `off` both send
 * nothing; the distinction exists so `podium setup` knows whether it has ever
 * asked. Absent ≠ off ≠ on — collapsing absent into off would lose the "never
 * asked" fact, and collapsing it into on would be the thing this whole feature
 * exists not to do.
 *
 * State lives in config.json, not the settings blob (D8), so `podium telemetry
 * off` works whether or not the server is running — and so a user can turn this
 * off with a text editor and no daemon at all.
 *
 * Kill switches (checked before ANYTHING else, including the setup prompt):
 *   - DO_NOT_TRACK=1        the community standard (consoledonottrack.com)
 *   - PODIUM_TELEMETRY=off  our own escape hatch
 * They suppress sending AND asking: a box that has declared it doesn't want to
 * be tracked must not be nagged about being tracked.
 */
import { randomUUID } from 'node:crypto'
import { type EnvSource, loadConfig, type PodiumConfig, saveConfig } from '@podium/runtime/config'
import type { TelemetryTier } from './schema'
import { TELEMETRY_TIERS } from './schema'

/** The baked-in default relay endpoint (D7 — first-party, IP-dropping). */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.podium.dev'

/** A tier's resolved consent. 'absent' = never asked. */
export type ConsentState = 'on' | 'off' | 'absent'

/** Why telemetry is force-disabled, for UI that must explain itself. */
export type SuppressionReason = 'DO_NOT_TRACK' | 'PODIUM_TELEMETRY'

export interface TelemetryState {
  usage: ConsentState
  crash: ConsentState
  /** Present once the user has opted into anything (minted on first opt-in, not at install). */
  installId?: string
  /** Epoch ms the clock started — set with installId on first opt-in (D5). */
  since?: number
  /** Set ⇒ both tiers are forced off regardless of the stored values. */
  suppressedBy?: SuppressionReason
  /** Where reports would be POSTed (resolved through the full precedence). */
  endpoint: string
}

/**
 * The hard kill switches, checked before anything else. Returns the reason so
 * the CLI/UI can say WHICH one is in force rather than a mystery "disabled".
 */
export function telemetrySuppressedBy(env: EnvSource = process.env): SuppressionReason | undefined {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase()
  if (dnt === '1' || dnt === 'true') return 'DO_NOT_TRACK'
  if (env.PODIUM_TELEMETRY?.trim().toLowerCase() === 'off') return 'PODIUM_TELEMETRY'
  return undefined
}

/**
 * The relay endpoint, highest wins (design "Endpoint configuration"):
 *   1. PODIUM_TELEMETRY_ENDPOINT (env)
 *   2. config.telemetry.endpoint
 *   3. the signed update manifest's value, when the caller has one
 *   4. the baked-in default
 * The manifest layer is safe because whoever controls the update channel can
 * already ship arbitrary code — but it stays SUBORDINATE to consent, and an
 * unsigned response can never reach this function (the updater verifies first).
 */
export function resolveTelemetryEndpoint(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
  manifestEndpoint?: string,
): string {
  return (
    env.PODIUM_TELEMETRY_ENDPOINT ??
    config.telemetry?.endpoint ??
    manifestEndpoint ??
    DEFAULT_TELEMETRY_ENDPOINT
  )
}

/** Resolve the full telemetry state. Kill switches win over stored consent. */
export function readTelemetryState(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): TelemetryState {
  const t = config.telemetry
  const suppressedBy = telemetrySuppressedBy(env)
  return {
    usage: t?.usage ?? 'absent',
    crash: t?.crash ?? 'absent',
    ...(t?.installId ? { installId: t.installId } : {}),
    ...(t?.since ? { since: t.since } : {}),
    ...(suppressedBy ? { suppressedBy } : {}),
    endpoint: resolveTelemetryEndpoint(config, env),
  }
}

/**
 * THE send gate. Every emit path must pass through this — never through a
 * cached boot-time copy (D9): it is read fresh at flush time so `podium
 * telemetry off` takes effect on a running server without a restart.
 */
export function isTierOn(
  tier: TelemetryTier,
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): boolean {
  if (telemetrySuppressedBy(env)) return false
  return config.telemetry?.[tier] === 'on'
}

/** True when NOTHING may be sent — the cheap check the emitter takes first. */
export function allTiersOff(
  config: PodiumConfig = loadConfig(),
  env: EnvSource = process.env,
): boolean {
  return !TELEMETRY_TIERS.some((tier) => isTierOn(tier, config, env))
}

/**
 * Whether `podium setup` should ask (D11). A kill switch suppresses the PROMPT,
 * not just the sending — asking a DO_NOT_TRACK box would be exactly the
 * repeating-notice mistake Homebrew got complaints for.
 *
 * Deliberately does NOT check whether consent already exists: re-running
 * `podium setup` is an explicit user action, and the design says it asks again.
 * The bare-`podium` path never reaches here at all.
 */
export function shouldAskForConsent(env: EnvSource = process.env): boolean {
  return telemetrySuppressedBy(env) === undefined
}

/**
 * Write one tier's consent. Minting rules (D5): the installId and its clock are
 * created on the first OPT-IN — not at install, and never by an opt-out — so a
 * user who says no never gets an identifier at all.
 *
 * Returns the resulting state. Callers write through this rather than
 * hand-patching config.json so the minting rule has exactly one home.
 */
export function setConsent(
  updates: Partial<Record<TelemetryTier, 'on' | 'off'>>,
  now: number = Date.now(),
): TelemetryState {
  const config = loadConfig()
  const current = config.telemetry ?? {}
  const next = { ...current, ...updates }
  const optingIn = TELEMETRY_TIERS.some((tier) => next[tier] === 'on')
  if (optingIn && !next.installId) {
    next.installId = randomUUID()
    next.since = now
  }
  saveConfig({ ...config, telemetry: next })
  return readTelemetryState(loadConfig())
}

/**
 * `podium telemetry reset-id` — a new random installId, unlinkable from the old
 * one. Also restarts the clock: an installAge carried across a reset would
 * re-link the two identities in the aggregate, which is the whole point of
 * being able to reset.
 */
export function resetInstallId(now: number = Date.now()): TelemetryState {
  const config = loadConfig()
  const current = config.telemetry ?? {}
  saveConfig({
    ...config,
    telemetry: { ...current, installId: randomUUID(), since: now },
  })
  return readTelemetryState(loadConfig())
}
