/**
 * Resolving a machine REFERENCE a human typed — `--machine ludovico`, `--to quiet-box`,
 * `machine show <name|id>` (POD-1424).
 *
 * ONE RULE, THREE SURFACES. `podium machine show`, `podium session handoff --to` and
 * `podium issue start --machine` all take a name where the wire takes an id. Each
 * having its own matcher is how two of them come to disagree about which host a name
 * means, with nothing to report it; giving this function prefix matching turns tests
 * red at every call site from that single edit, which is the point of it being one
 * function rather than three copies.
 */

/** The fields a reference can be matched against. Callers pass their own richer rows. */
export interface NameableMachine {
  id: string
  name: string
  hostname?: string
}

/**
 * Match on id first, then exact name, then exact hostname.
 *
 * EXACT BY DESIGN — no prefix, no fuzzy, no unique-abbreviation fallback. Resolving
 * wrongly starts real work on a host the caller never named, where it looks like it
 * worked: the session appears, the agent answers, and the divergence only surfaces
 * later as a worktree nobody can find. An agent that guessed a name should be told it
 * guessed, and `podium machine list` prints the names to guess from.
 *
 * The list handed in is already scoped to what the caller may see, so an id typed for
 * an invisible machine is refused as unknown — which is also the answer that discloses
 * nothing about whether it exists.
 */
export function machineByRef<T extends NameableMachine>(
  machines: readonly T[],
  ref: string,
): T | undefined {
  return (
    machines.find((machine) => machine.id === ref) ??
    machines.find((machine) => machine.name === ref) ??
    machines.find((machine) => machine.hostname === ref)
  )
}
