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
 * WHAT IT REFUSES TO DECIDE: the SELECTION between families. `manifest.runtime
 * .select(ctx)` is the policy, it is pure, and both the server (planning a spawn)
 * and the machine (performing one) must get the same answer from it. W3 ships
 * only the terminal family, so calling it here would be a call whose answer is
 * known — and a call site that looks like a policy but is a constant is worse
 * than no call at all. W5 wires it when there is a second answer.
 */

import {
  declaredValue,
  harnessNeedsSubmitVerification,
  harnessUsesRawFirstTurn,
  manifestFor,
} from '@podium/harness'
import type { AgentKind } from '@podium/model'
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
