/**
 * THE REPO TREE INHERITS MACHINE SCOPING (POD-407, readiness §3.1.1 / §3.1.4).
 *
 * Repos, prefixes and worktrees are per-machine FACTS. They carry no visibility
 * class of their own — "everything that is a fact *about a machine* inherits that
 * machine's scoping rather than carrying its own" (§3.1.1, owned compute). So the
 * project and repo structure the worklist renders is bounded by the machines the
 * principal may SEE, and the spawn affordances within it by `use`
 * (`machineViewsFromWire` + `resolveSpawnTargetMachine` handle that half).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ON THE CLIENT AT ALL
 * ---------------------------------------------------------------------------
 *
 * The machine LIST the client holds is already per-principal: the server's
 * `machinesForPrincipal` projection filters on `canSeeMachine` before broadcast.
 * Repo rows are not — `listRepos()` returns every row on every machine, which the
 * fleet view calls out in as many words and works around by joining against the
 * scoped machine list rather than trusting the repo table.
 *
 * This is the same join, for the worklist. It is a RENDERING bound, not a
 * security boundary: the rows have already crossed the wire, and the Authority
 * re-authorizes every write regardless (ADR 3 D8). What it buys is that the tree
 * stops naming checkout paths on machines the principal cannot see — §3.1.2's
 * existence-leak class, arriving at a concrete surface. Closing it properly is a
 * server-side scoping of the repo broadcast, which is not this issue's to write.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS NOT DENIAL — AND THIS IS THE PARITY HINGE
 * ---------------------------------------------------------------------------
 *
 * A repo row with NO `machineId` is not a repo on a machine you cannot see; it is
 * a row from before the field existed, or a local registration the server never
 * stamped. Dropping those would empty the sidebar on exactly the deployments that
 * have no scoping to enforce, so an unstamped row is KEPT.
 *
 * This mirrors — deliberately — the reading `machineViewsFromWire` applies to
 * `use`: the gate engages only where the server is actually answering the
 * question. An EMPTY machine list is therefore also treated as "not scoped"
 * rather than "see nothing", because a client that has not yet received
 * `machinesChanged` holds an empty list, and a sidebar that blanks itself during
 * boot is a worse failure than one that shows a repo a moment early.
 */
import type { GitRepositoryWire, MachineWire } from '@podium/model'

/**
 * The repo rows whose machine this principal may SEE.
 *
 * ONE PASS IS ENOUGH, and the wire is why. `GitWorktreeWire` carries no
 * `machineId`: a repo ROW is one machine's checkout, and its worktrees are that
 * machine's by construction. (The cross-machine aggregation people think of —
 * one `RepoView` folding several clones of the same origin together — happens
 * downstream in `reposToViews`, over whatever survives here. Filtering the rows
 * on the way in is therefore what bounds the aggregate too.)
 */
export function reposVisibleOnMachines(
  repos: readonly GitRepositoryWire[],
  machines: readonly MachineWire[] | undefined,
): GitRepositoryWire[] {
  // No machine list yet => nothing to scope against. See the header: not scoped
  // is not the same as see-nothing.
  //
  // UNDEFINED as well as empty, and it is the same answer for the same reason.
  // A store assembled without the field (every worklist fixture that predates
  // this, and any consumer built from a partial Store) must not have its repo
  // tree silently emptied by a scoping pass it never opted into.
  if (machines === undefined || machines.length === 0) return [...repos]
  const visible = new Set<string>(machines.map((m) => m.id))
  // An unstamped row is kept — absence is not denial (see the header).
  return repos.filter((repo) => repo.machineId === undefined || visible.has(repo.machineId))
}
