/**
 * THE FLAG THAT MAKES THE PARALLEL PATH REACHABLE (POD-1761 W3; extended by W5).
 *
 * ---------------------------------------------------------------------------
 * FLAG OFF MEANS ZERO DIFF, AND THAT IS AN ARCHITECTURAL CLAIM, NOT A HOPE
 * ---------------------------------------------------------------------------
 *
 * The terminal driver does not replace anything. It sits BESIDE the existing
 * spawn/observe/inject stack and composes the same machinery, so an unflagged
 * session never constructs a driver handle, never allocates a queue, never
 * registers an observer tap and never emits a `runtime*` frame. The one thing an
 * unflagged session pays is a `Map.has` on the daemon's outbound frame tap,
 * which is why the tap is a lookup rather than a translation.
 *
 * TWO SOURCES, OR-ED. A machine-wide env var is what an operator flips to try
 * the path; a per-spawn field is what lets ONE session be flagged while every
 * other session on the same daemon stays on the legacy path — which is exactly
 * what the e2e lane needs to prove the flag-on behaviour without a second
 * daemon. Neither is authoritative over the other: either one turning it on
 * turns it on, because both mean the same thing.
 *
 * ---------------------------------------------------------------------------
 * W5 WIDENED THE PER-SPAWN FIELD RATHER THAN ADDING A SECOND ONE
 * ---------------------------------------------------------------------------
 *
 * The same field now also carries a DRIVER ID, which is the operator's explicit
 * per-spawn choice of driver (spec §9 phase 3). `true` still means "drive this
 * through the contract, with whatever the manifest's policy picks"; a string
 * means "…with this driver". The default is untouched by both: a spawn that says
 * nothing gets the legacy path, and a spawn that says `true` gets the terminal
 * driver, because that is what every manifest's `select()` still ranks first.
 */

import type { RuntimeContractRequest } from '@podium/protocol'

/** The machine-wide switch, read ONCE at bootstrap. Re-reading `process.env` per
 *  session would let a session's driving change under it mid-life, which is a
 *  worse failure than either setting. */
export const RUNTIME_CONTRACT_ENV = 'PODIUM_RUNTIME_CONTRACT'

/**
 * The machine-wide DEFAULT DRIVER, for an operator who wants every contract
 * session on one driver without editing each spawn.
 *
 * SEPARATE FROM THE BOOLEAN because it answers a different question. The boolean
 * is "is the parallel path on at all"; this is "which driver does it use when a
 * spawn does not say". A machine with this set but the boolean off still drives
 * nothing through the contract, which is the honest reading of two independent
 * switches.
 */
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

/** The per-session answer: the machine-wide switch OR this session's own field.
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
