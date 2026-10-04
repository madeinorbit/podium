import { parseServedDescriptors, resolveDescriptors } from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'

/**
 * Caller-held descriptors normalized through the one blessed merge (POD-4737).
 *
 * `packages/harness/src/browser.ts` states the rule this module exists to
 * keep: "Clients always render through resolveDescriptors, never this [the
 * bundled] list directly." The bundled rows are only the fallback — a machine
 * running a newer daemon serves its own descriptors, and those must win by
 * kind. So no viewmodel reads the bundled list itself; every label below goes
 * through here.
 *
 * Accepts raw served frames (`useHarnessDescriptors().served`) or an
 * already-resolved list (`useResolvedDescriptors()`) — resolving twice is
 * idempotent — and undefined/empty, which renders the bundled copy. Callers
 * that hold no descriptors pass nothing and get exactly what they got before
 * this existed: the bundled fallback, never another harness's label and never
 * a throw. Unknown kinds are the caller's to render (the viewmodels fall back
 * to the raw kind); inventing a mark for a harness this build cannot name
 * would claim a brand.
 *
 * Internal to the viewmodels (deliberately NOT in `./index.ts`): it is the
 * shared lookup behind `agentLabel`/`panelLabel`/cost + ledger labels, not a
 * new public surface for screens to render through.
 */
export function resolvedHarnessDescriptors(
  served: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire[] {
  return resolveDescriptors(parseServedDescriptors(served ?? []))
}

/** The resolved row for a harness kind, or undefined when no row names it. */
export function harnessDescriptorFor(
  kind: string,
  served: readonly HarnessDescriptorWire[] | undefined,
): HarnessDescriptorWire | undefined {
  return resolvedHarnessDescriptors(served).find((descriptor) => descriptor.kind === kind)
}
