/**
 * THE FLAG THAT MAKES THE PARALLEL PATH REACHABLE (POD-1761 W3).
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
 */

/** The machine-wide switch, read ONCE at bootstrap. Re-reading `process.env` per
 *  session would let a session's driving change under it mid-life, which is a
 *  worse failure than either setting. */
export const RUNTIME_CONTRACT_ENV = 'PODIUM_RUNTIME_CONTRACT'

/** Truthy exactly for `1` and `true`. A flag that accepted anything non-empty
 *  would treat `PODIUM_RUNTIME_CONTRACT=0` as on, which is the single most
 *  common way an env-var flag lies. */
export function runtimeContractEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RUNTIME_CONTRACT_ENV]
  return raw === '1' || raw === 'true'
}

/** The per-session answer: the machine-wide switch OR this session's own field. */
export function runtimeContractEnabledFor(
  machineWide: boolean,
  perSession: boolean | undefined,
): boolean {
  return machineWide || perSession === true
}
