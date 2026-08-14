/**
 * THE DAEMON'S DRIVER REGISTRY (POD-1761 W3).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DECIDES, AND WHAT IT REFUSES TO
 * ---------------------------------------------------------------------------
 *
 * Two things, both small:
 *
 *   1. WHICH DRIVER a harness gets — read straight off `AgentManifest.runtime`,
 *      never invented here. The manifest is where per-harness variance lives
 *      (POD-303's whole argument), and a second table in the daemon would be the
 *      first place the two disagreed.
 *   2. WHETHER a session is driven through the contract at all — the flag, and
 *      nothing else. No heuristics, no "and also if the harness supports it": a
 *      parallel path that turned itself on would not be a parallel path.
 *
 *   3. WHICH DRIVER, now that there is a second answer (POD-2023). W3 declined to
 *      call `manifest.runtime.select(ctx)` because its answer was a constant, and
 *      "a call site that looks like a policy but is a constant is worse than no
 *      call at all". W5 ships `opencode-server`, so the call is now a real
 *      decision and {@link resolveRuntimeDriver} makes it — in ONE place, so the
 *      server planning a spawn and the machine performing one cannot disagree.
 */

import {
  AGENT_MANIFESTS,
  declaredValue,
  type DriverId,
  harnessNeedsSubmitVerification,
  harnessUsesRawFirstTurn,
  manifestFor,
  type SelectionContext,
} from '@podium/harness'
import type { AgentKind } from '@podium/model'
import type { RuntimeContractRequest } from '@podium/protocol'
import { runtimeDriverFor } from './flag'
import type { TerminalHarnessProfile } from './terminal-driver'

/**
 * The per-harness facts the terminal driver needs, resolved from the manifest.
 *
 * Returns undefined for a kind with no manifest — a shell, or a harness this
 * build does not know. That is a real answer, not a failure: a shell has no
 * turns, no transcript and no state channel, so there is nothing for a driver to
 * be honest ABOUT, and the flag simply does not reach it.
 */
export function terminalProfileFor(agentKind: AgentKind): TerminalHarnessProfile | undefined {
  const manifest = manifestFor(agentKind)
  if (!manifest) return undefined
  const terminal = manifest.runtime.terminal
  return {
    driverId: terminal.driverId,
    sendProof: terminal.sendProof,
    // HOOK-ANCHORED ACCEPT IS READ, NOT ASSUMED. A harness gets it exactly when
    // its manifest lists `hook` in the proof order it can actually produce —
    // which today is Claude and only Claude, because `UserPromptSubmit` is the
    // only causal accept signal in the fleet.
    hookAnchoredAccept: terminal.sendProof.includes('hook'),
    needsSubmitVerification: harnessNeedsSubmitVerification(agentKind),
    usesRawFirstTurn: harnessUsesRawFirstTurn(agentKind),
    // `export()` is byte-faithful only where the harness declares where its own
    // store lives. Where it does not, the capability says `unsupported` and the
    // verb refuses — rather than shipping an archive that cannot be imported.
    archivable: declaredValue(manifest.handoffTranscript) !== undefined,
    reportsContextPercent: manifest.capabilities.observationProvider !== 'none',
  }
}

// ---------------------------------------------------------------------------
// Which driver (POD-1761 W5)
// ---------------------------------------------------------------------------

/**
 * WHICH DRIVER IDS THIS MACHINE CAN ACTUALLY RUN RIGHT NOW.
 *
 * `SelectionContext.available` is documented as "binary present, version in the
 * pinned range", and that second half is the load-bearing one: honouring an
 * operator's preference for a driver whose harness is too old turns a settings
 * toggle into a session that fails at its first verb. So the probe is the
 * version GATE, not a `which`.
 *
 * The terminal ids are unconditionally available because their mechanism is
 * Podium's own — abduco and a PTY — and the harness binary's absence is already
 * a spawn error one layer down, reported there with the harness named.
 *
 * MEMOIZED VIA THE GATE ITSELF. `gateOpencodeVersion` is pure; the daemon-side
 * probe behind it (`opencodeVersionDiagnostic`) caches its one process spawn for
 * the daemon's life, because the binary on PATH does not change under a running
 * daemon.
 */
export function availableDriverIds(probe: {
  /**
   * Has the opencode version gate ADMITTED this machine's binary?
   *
   * A BOOLEAN, NOT A VERSION STRING, and the difference is not cosmetic: the
   * daemon already memoizes exactly one `opencode --version` behind
   * `opencodeVersionDiagnostic()`, and asking this function for a version would
   * mean either forking a 180MB binary per spawn or inventing a placeholder to
   * feed a gate that has already run. The gate's verdict is the fact; the
   * version string is how it was reached.
   */
  opencodeDrivable: boolean
}): readonly DriverId[] {
  const ids: DriverId[] = ['claude-pty', 'generic-pty']
  if (probe.opencodeDrivable) ids.push('opencode-server')
  return ids
}

/** Every driver id this build ships code for. An id outside this set is a typo
 *  or a driver from a newer build, and both must be REFUSED rather than
 *  silently ignored — a spawn that asked for `opencode-sever` and got a terminal
 *  session would look like the override did not work. */
const IMPLEMENTED: ReadonlySet<string> = new Set<DriverId>([
  'claude-pty',
  'generic-pty',
  'opencode-server',
])

export type DriverResolution =
  | { ok: true; driverId: DriverId }
  | { ok: false; reason: string }

/**
 * Resolve the driver for one spawn: the explicit override if there is one, the
 * manifest's policy otherwise.
 *
 * THE OVERRIDE IS ROUTED THROUGH `select()` RATHER THAN AROUND IT, and that is
 * the point of the design. `selectRuntimeDriver` already honours
 * `ctx.preference` ahead of its ranking AND only when the machine reports the
 * driver available — so an operator naming `opencode-server` on a box whose
 * opencode is missing or out of range falls through to the terminal driver
 * instead of getting a session that cannot start. Bypassing the policy would
 * have meant re-implementing that rule here, differently.
 *
 * The one thing decided outside the policy is an UNKNOWN id, because `select()`
 * cannot distinguish "this build does not ship that driver" from "this machine
 * cannot run it" — and those want opposite answers. A typo is refused with the
 * id named; an unavailable driver degrades.
 */
export function resolveRuntimeDriver(input: {
  agentKind: AgentKind
  /** The per-spawn field, widened by W5 to carry a driver id. */
  requested: RuntimeContractRequest | undefined
  /** `PODIUM_RUNTIME_DRIVER`, the machine-wide default. */
  machineDefault: string | undefined
  available: readonly DriverId[]
  platform: NodeJS.Platform
  auth?: SelectionContext['auth']
}): DriverResolution {
  const manifest = manifestFor(input.agentKind)
  if (!manifest) return { ok: false, reason: `no manifest for harness '${input.agentKind}'` }
  const preference = runtimeDriverFor(input.machineDefault, input.requested)
  if (preference !== undefined && !IMPLEMENTED.has(preference)) {
    return { ok: false, reason: `unknown runtime driver '${preference}'` }
  }
  const ctx: SelectionContext = {
    auth: input.auth ?? 'unknown',
    platform: input.platform,
    available: input.available,
    ...(preference ? { preference: preference as DriverId } : {}),
  }
  return { ok: true, driverId: manifest.runtime.select(ctx) }
}

/** Does this harness declare a server driver at all, and is it the one selected?
 *  Read off the manifest rather than by comparing strings at each call site. */
export function isServerDriver(agentKind: AgentKind, driverId: DriverId): boolean {
  const server = manifestFor(agentKind)?.runtime.server
  return server !== undefined && declaredValue(server)?.driverId === driverId
}

/**
 * Is this driver id a SERVER-family one, judged from the id alone?
 *
 * Deliberately not {@link isServerDriver}, which asks a HARNESS whether a
 * resolved driver is its server one. The spawn path needs the question one step
 * earlier — before resolution, while it still holds what the caller ASKED for —
 * so that an explicit server-driver request can be refused rather than silently
 * resolved into a terminal session when the machine could not be probed
 * (POD-2056's measurement). Reads the manifests rather than matching on a
 * substring, so a driver id is server-family exactly when some harness declares
 * it as one.
 */
export function isServerDriverId(driverId: string): boolean {
  return Object.values(AGENT_MANIFESTS).some(
    (manifest) => declaredValue(manifest.runtime.server)?.driverId === driverId,
  )
}

/**
 * Did THIS SPAWN name a server driver that resolution did not give it? Returns
 * the id it named, for the refusal message; undefined when there is nothing to
 * refuse (POD-2113).
 *
 * WHY THIS IS NOT INSIDE `resolveRuntimeDriver`. That function is handed a
 * preference with the machine-wide default already folded in, and the whole
 * decision here turns on which of the two the id came from:
 *
 *   - A MACHINE-WIDE `PODIUM_RUNTIME_DRIVER` degrades. It is a setting, it can
 *     go stale under a machine whose opencode moved out of range, and refusing
 *     on it would break every spawn on that box at once.
 *   - A PER-SPAWN ID REFUSES. Nobody puts a driver id on one spawn frame by
 *     accident; it is the operator testing whether that driver works, and the
 *     honest answer to "it cannot run here" is to say so. Answering with a
 *     working terminal session instead is the one reply indistinguishable from
 *     the success they were looking for — which is exactly how the dropped
 *     override survived so long.
 *
 * SERVER FAMILY ONLY. The terminal ids all reach the same PTY launch, so a spawn
 * that named one and resolved to its sibling got what it asked for in every
 * observable way, and refusing there would be pedantry about a label.
 */
export function unhonouredSpawnDriver(input: {
  /** The per-spawn field ONLY. Folding the env default in here defeats the
   *  point — see above. */
  perSpawn: RuntimeContractRequest | undefined
  resolved: DriverId
}): string | undefined {
  const { perSpawn, resolved } = input
  if (typeof perSpawn !== 'string') return undefined
  if (perSpawn === resolved) return undefined
  return isServerDriverId(perSpawn) ? perSpawn : undefined
}
