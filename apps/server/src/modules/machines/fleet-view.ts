/**
 * THE FLEET VIEW (POD-1424) — the machine list plus the checkout paths that make it
 * ACTIONABLE, for `podium machine list` and for resolving `--machine <name>`.
 *
 * An enumeration without repos cannot answer "which machine can take this work",
 * because work is placed into a checkout. But repo rows are stored unscoped —
 * `listRepos()` returns every row on every machine — so the join is where a
 * disclosure decision has to be taken, and {@link machinesWithUse} is where that
 * decision lives.
 */

import type { MachineWire } from '@podium/model'

/**
 * What a principal may do with a machine beyond seeing that it exists: `use` is the
 * code-execution question — "what can I run on your hardware, and as whom" — which
 * is the same question a machine's `inventory` and its registered checkout paths
 * answer.
 *
 * One member today. It is a union rather than a boolean so that adding the refusal
 * is a change to this type and to the places that must then handle it, rather than
 * an inversion of a flag whose call sites all read the wrong way round afterwards.
 */
export type MachineUseDecision = 'granted'

/** A machine row carrying this caller's `use` verdict. */
export type MachineWithUse = MachineWire & { use: MachineUseDecision }

/**
 * THE CAPABILITY SEAM — the one place a per-principal machine decision is taken.
 *
 * It answers 'granted' for every machine, and that is not a stub standing in for a
 * check that was skipped: it is what this schema can say truthfully. The `machines`
 * table here has id, name, hostname, token_hash, created_at, last_seen_at and
 * inventory_json — no owner column and no grants table — so there is no storage in
 * which a different answer could have been recorded, and nothing for a per-principal
 * projection to decide with. A deployment that cannot represent a second human
 * cannot represent a machine belonging to one.
 *
 * DO NOT WRITE A SCOPING TEST AGAINST THIS. A test asserting that a non-owner is
 * refused would be asserting against a function that cannot refuse — green forever,
 * and green for a reason unrelated to the property it names. When machine ownership
 * lands, the decision lands HERE, the `use` field starts carrying a second value,
 * and that is the change a scoping test can finally be written against.
 *
 * The field is stamped even while constant because its ABSENCE is not the same fact.
 * Downstream, "repos: not available to this session" is a fact about the CALLER and
 * "repos: none registered" is a fact about the MACHINE; both arrive on the wire as an
 * empty array, so the renderer needs the verdict to tell them apart. Drop the field
 * as redundant today and the distinction collapses with no test able to notice.
 */
export function machinesWithUse(machines: MachineWire[]): MachineWithUse[] {
  return machines.map((machine) => ({ ...machine, use: 'granted' as const }))
}

/** One registered checkout, as the fleet view reports it. */
export interface FleetRepoRow {
  machineId: string
  path: string
}

export interface FleetView {
  machines: MachineWithUse[]
  repos: FleetRepoRow[]
}

/**
 * The machine list with each machine's registered checkouts joined on.
 *
 * The join is cut to machines carrying `use: 'granted'` — the same line the model
 * draws around `inventory`, and the reason the cut is expressed against the verdict
 * rather than skipped: when {@link machinesWithUse} learns to refuse, the paths stop
 * flowing here without this function changing. Rows are narrowed to machineId+path
 * so an origin URL or repoId never rides along on a view whose job is placement.
 */
export function fleetViewFor(
  machines: MachineWire[],
  allRepos: readonly { machineId: string; path: string }[],
): FleetView {
  const scoped = machinesWithUse(machines)
  // `Set<string>`, not the inferred `Set<MachineId>`: the repo rows this is asked
  // about carry an unbranded `machineId` (the store has not branded that column),
  // and membership is the only question being put to the set.
  const usable = new Set<string>(scoped.filter((m) => m.use === 'granted').map((m) => m.id))
  return {
    machines: scoped,
    repos: allRepos
      .filter((repo) => usable.has(repo.machineId))
      .map((repo) => ({ machineId: repo.machineId, path: repo.path })),
  }
}
