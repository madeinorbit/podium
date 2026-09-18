/**
 * Compatibility readers for historical rollout settings and driver preferences.
 * Agent launch/reconnect admission no longer consults the boolean: every agent
 * needs a verified handle. Shell, login and profile-less terminals are exempt.
 * Driver selection remains separate: omitted intent means headed, true asks the
 * manifest policy, and a concrete ID preserves an explicit engine choice.
 */

import type { RuntimeContractRequest } from '@podium/protocol'

/** The machine-wide switch, read ONCE at bootstrap. Re-reading `process.env` per
 *  session would let a session's driving change under it mid-life, which is a
 *  worse failure than either setting. */
export const RUNTIME_CONTRACT_ENV = 'PODIUM_RUNTIME_CONTRACT'

/** Machine preference used when a caller explicitly delegates to manifest policy.
 * Omitted per-spawn intent preserves the headed default regardless of this value. */
export const RUNTIME_DRIVER_ENV = 'PODIUM_RUNTIME_DRIVER'

/** Truthy exactly for `1` and `true`. A flag that accepted anything non-empty
 *  would treat `PODIUM_RUNTIME_CONTRACT=0` as on, which is the single most
 *  common way an env-var flag lies. */
export function runtimeContractEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RUNTIME_CONTRACT_ENV]
  return raw === '1' || raw === 'true'
}

/** The machine-wide driver preference, or undefined. Not validated here — the
 *  registry is the only place that can tell a typo from a driver this build does
 *  not ship, and it refuses there with the id named. */
export function runtimeDriverByEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[RUNTIME_DRIVER_ENV]?.trim()
  return raw ? raw : undefined
}

/** Historical rollout answer, retained for compatibility readers and tests.
 *  This is not agent admission: launch and reconnect always require a handle.
 *
 *  A DRIVER ID IMPLIES THE CONTRACT IS ON. Naming a driver and then not being
 *  driven by it is not a state anyone means to ask for. */
export function runtimeContractEnabledFor(
  machineWide: boolean,
  perSession: RuntimeContractRequest | undefined,
): boolean {
  if (typeof perSession === 'string') return perSession.length > 0
  return machineWide || perSession === true
}

/**
 * Which driver this session asked for, or undefined for "let the manifest
 * decide".
 *
 * The per-spawn field wins over the machine-wide default, which is the
 * precedence every other per-session override in the daemon uses: the more
 * specific statement is the more recent decision.
 */
export function runtimeDriverFor(
  machineWide: string | undefined,
  perSession: RuntimeContractRequest | undefined,
): string | undefined {
  if (typeof perSession === 'string' && perSession.length > 0) return perSession
  return machineWide
}
