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
 *      never invented here. Server-capable harnesses default to their own
 *      admitted server driver; terminal remains their total fallback.
 *   2. WHETHER a TERMINAL fallback uses the receipt contract path — the flag,
 *      and nothing else. Server-family sessions necessarily bind through the
 *      contract; a no-preference fallback with the flag off stays on the legacy
 *      PTY path.
 *
 * `resolveRuntimeDriver` is the one policy call site, so the server planning a
 * spawn and the machine performing one cannot disagree.
 */

import {
  AGENT_MANIFESTS,
  type DriverId,
  declaredValue,
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
  /** Has the Grok ACP version gate admitted this machine's binary? */
  grokDrivable?: boolean
  /**
   * The same question for codex (POD-1761 W6), memoized the same way behind
   * `codexAppServerVersionDiagnostic()`.
   *
   * OPTIONAL, AND ABSENT MEANS "NOT AVAILABLE" rather than "assume yes". A
   * caller that has not probed must not have its silence read as a pass: this
   * driver's failure mode on an unpinned binary is a session that hangs on its
   * first tool call with no error anywhere, so the default has to be the one
   * that degrades to terminal.
   */
  codexDrivable?: boolean
}): readonly DriverId[] {
  const ids: DriverId[] = ['claude-pty', 'generic-pty']
  if (probe.opencodeDrivable) ids.push('opencode-server')
  if (probe.grokDrivable) ids.push('grok-acp')
  if (probe.codexDrivable) ids.push('codex-app-server')
  return ids
}

/** Every driver id this build ships code for. An id outside this set is a typo
 *  or a driver from a newer build, and both must be REFUSED rather than
 *  silently ignored — a spawn that asked for `opencode-sever` and got a terminal
 *  session would look like the override did not work. */
const IMPLEMENTED: ReadonlySet<string> = new Set<DriverId>([
  'claude-pty',
  'generic-pty',
  'grok-acp',
  'opencode-server',
  'codex-app-server',
])

export type DriverResolution = { ok: true; driverId: DriverId } | { ok: false; reason: string }

/**
 * Resolve the driver for one spawn: the explicit override if there is one, the
 * manifest's policy otherwise.
 *
 * THE OVERRIDE IS ROUTED THROUGH `select()` RATHER THAN AROUND IT. The shared
 * policy honours it only when the machine reports it available and the harness
 * declares it (either terminal id is accepted as the same PTY-family opt-out).
 * An unavailable server therefore resolves to the harness's ranked fallback;
 * the caller then refuses a per-spawn server id or visibly degrades a
 * machine/policy preference.
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
/**
 * The preference whose probe a spawn must consult. With no explicit or
 * machine-wide value, a server-capable harness contributes its own declared
 * server id; a terminal-only harness contributes nothing and skips probing.
 */
export function runtimeDriverIntentForSpawn(input: {
  agentKind: AgentKind
  perSpawn: RuntimeContractRequest | undefined
  machineDefault: string | undefined
}): { requested: string | undefined; preferred: string | undefined } {
  const requested = runtimeDriverFor(input.machineDefault, input.perSpawn)
  const manifest = manifestFor(input.agentKind)
  const declaredServer = manifest ? declaredValue(manifest.runtime.server) : undefined
  return { requested, preferred: requested ?? declaredServer?.driverId }
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
  return harnessOwningServerDriver(driverId) !== undefined
}

/**
 * WHICH HARNESS DECLARES THIS SERVER DRIVER — read off the manifests, never a
 * table here.
 *
 * The rule exists because W6 added a SECOND server driver with its own binary
 * and its own version probe, and the spawn path has to ask the probe belonging
 * to the driver that was actually requested. Consulting the wrong one lets one
 * harness's healthy probe vouch for another harness's binary — which turns an
 * explicit `codex-app-server` request on a box whose codex did not answer into
 * a silent terminal session, the exact failure POD-2056 measured and the
 * unprobeable/unsupported split exists to prevent.
 *
 * Named and exported rather than inlined as a string comparison so it is one
 * rule with one test, instead of a condition each call site gets right on its
 * own.
 */
export function harnessOwningServerDriver(driverId: string): AgentKind | undefined {
  for (const [kind, manifest] of Object.entries(AGENT_MANIFESTS)) {
    if (declaredValue(manifest.runtime.server)?.driverId === driverId) return kind as AgentKind
  }
  return undefined
}

/**
 * Did THIS SPAWN name a server driver at all? The id if so, undefined otherwise
 * (POD-2113).
 *
 * THE ONE PLACE THE REFUSE/DEGRADE RULE IS WRITTEN DOWN, and it exists because
 * having it written twice is how the spawn path drifted. `launchServerDriverSession`
 * refuses in two places — before resolution when a probe could not answer, and
 * after it when the driver was not the one picked — and the second keyed on the
 * per-spawn field while the FIRST keyed on `requested`, the env-folded value.
 * That gap turned one stale `PODIUM_RUNTIME_DRIVER` on a box whose binary is off
 * the daemon's PATH into a permanent refusal of every spawn of every harness:
 * ENOENT reads as `unprobeable`, and an unprobeable verdict is deliberately not
 * memoized, so it re-failed per spawn forever. Both refusals ask this function
 * now, so the rule cannot be half-applied again.
 *
 * SERVER FAMILY ONLY, and asked of the manifests rather than by matching a
 * substring, so a second server driver (W6's codex) is covered the day it is
 * declared rather than the day someone remembers this line.
 */
export function spawnNamedServerDriver(
  /** The per-spawn field ONLY. Folding the env default in defeats the point. */
  perSpawn: RuntimeContractRequest | undefined,
): string | undefined {
  if (typeof perSpawn !== 'string') return undefined
  return isServerDriverId(perSpawn) ? perSpawn : undefined
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
  return droppedDriverPreference({
    preference: spawnNamedServerDriver(input.perSpawn),
    resolved: input.resolved,
  })
}

/**
 * A SERVER-FAMILY PREFERENCE THAT RESOLUTION DID NOT HONOUR, whoever expressed
 * it. The id, or undefined when nothing was dropped (POD-2113).
 *
 * SEPARATE FROM WHO ASKED, on purpose. {@link unhonouredSpawnDriver} feeds this
 * the PER-SPAWN id only and refuses on the answer; the degrade path feeds it the
 * env-folded `requested` and merely LOGS the answer. Same question, two
 * consequences — which is the whole shape of this feature, and the reason it is
 * one function rather than two similar conditions that can drift.
 *
 * Shared by the warning and bind projection so requested-versus-actual cannot
 * disagree with the operator log. The focused test pins the emitted record as
 * well as the positive and negative guard decisions.
 */
export function droppedDriverPreference(input: {
  preference: string | undefined
  resolved: DriverId
}): string | undefined {
  const { preference, resolved } = input
  if (preference === undefined || preference === resolved) return undefined
  return isServerDriverId(preference) ? preference : undefined
}
