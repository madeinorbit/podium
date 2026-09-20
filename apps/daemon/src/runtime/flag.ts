/**
 * Driver preference readers (POD-4280).
 *
 * The contract itself is universal for agents: every agent launch/reconnect
 * admission requires a verified handle, and `bindRuntimeContract` always binds
 * one for profile-bearing kinds. Shell, login and profile-less terminals are
 * the permanent exemption — they have no turns to be honest about.
 *
 * What remains here is the OTHER question, which is permanent: WHICH driver.
 * Omitted intent means headed, true asks the manifest policy, and a concrete
 * ID preserves an explicit engine choice. The machine-wide `PODIUM_RUNTIME_DRIVER`
 * is that preference at machine scope; the per-spawn field wins over it, which
 * is the precedence every other per-session override in the daemon uses.
 */

import type { RuntimeContractRequest } from '@podium/protocol'

/** Machine preference used when a caller explicitly delegates to manifest policy.
 * Omitted per-spawn intent preserves the headed default regardless of this value. */
export const RUNTIME_DRIVER_ENV = 'PODIUM_RUNTIME_DRIVER'

/** The machine-wide driver preference, or undefined. Not validated here — the
 *  registry is the only place that can tell a typo from a driver this build does
 *  not ship, and it refuses there with the id named. */
export function runtimeDriverByEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[RUNTIME_DRIVER_ENV]?.trim()
  return raw ? raw : undefined
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
