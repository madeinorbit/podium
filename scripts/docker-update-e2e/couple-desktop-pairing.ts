/**
 * PUT BACK THE COUPLING POD-2794 REMOVED, so the row that proves its absence can
 * be watched failing.
 *
 * `real-release-headless-only` asserts that a release publishing NO desktop build
 * still reaches an install. A row like that is worth nothing until it has been
 * seen to go red for the right reason: green is what it prints whether it is
 * wired to the product or to nothing at all.
 *
 * The coupling is one condition. Decoupled, the resolver consults `latest.json`
 * only when the release states `minRequired.desktop` or `desktopBridge`; coupled,
 * it consults it on every resolve, so a headless-only release 404s on the desktop
 * manifest and the whole target — headless included — is retracted. Restoring
 * that one condition is therefore the smallest edit that reproduces the original
 * defect, and it reproduces it in the SOURCE THE TARGET BUILD COMPILES rather
 * than by mocking anything.
 *
 * WHY IT REFUSES RATHER THAN PATCHES LOOSELY: a control that silently matched
 * nothing would leave the row green, and a green row under a deliberate-failure
 * control reads as "this row cannot be armed" — the exact false comfort the
 * control exists to remove. So the condition must appear exactly once, the file
 * must actually change, and the result is reported for the caller to assert on.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** The condition as it stands after POD-2794. */
const DECOUPLED =
  'if (feed.desktopManifestUrl && (minimumShell !== undefined || minimumBridge !== undefined)) {'
/** The condition as it stood before — consulted on every resolve. */
const COUPLED = 'if (feed.desktopManifestUrl) {'

export function coupleDesktopPairing(source: string): { source: string; occurrences: number } {
  const occurrences = source.split(DECOUPLED).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one decoupled pairing condition in the resolver, found ${occurrences}`,
    )
  }
  return { source: source.replace(DECOUPLED, COUPLED), occurrences }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error('usage: couple-desktop-pairing.ts <release-target.ts>')
  const before = readFileSync(target, 'utf8')
  const { source, occurrences } = coupleDesktopPairing(before)
  if (source === before) throw new Error('the substitution changed nothing')
  writeFileSync(target, source)
  console.log(
    JSON.stringify({
      occurrences,
      // The coupled form is shorter, so a shrinking file is the expected sign.
      bytesRemoved: before.length - source.length,
      coupled: source.includes(COUPLED),
      decoupledGone: !source.includes(DECOUPLED),
    }),
  )
}
