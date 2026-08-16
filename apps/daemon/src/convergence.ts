import { isProvablyNewer } from '@podium/protocol'
import { canonicalMigrationName } from '@podium/runtime/migration-ledger'
import type { PendingGrant } from './pending-grant'

export const MAX_CONVERGENCE_ATTEMPTS = 2

/**
 * THE REFUSAL A FOREGROUND ALL-IN-ONE OWES ITS OPERATOR (POD-2210).
 *
 * Every convergence in this system ends the same way: the daemon exits and
 * something starts it again. An INSTALLED all-in-one is safe because it is not
 * one process — systemd resolves it into server, janitor and daemon units, each
 * `Restart=always`, so the daemon's exit restarts the daemon alone and the
 * coordinating server is never touched (the shipped update unit `try-restart`s
 * that unit specifically). The desktop sidecar is safe for the same reason with
 * a different manager: the shell respawns the child it supervises.
 *
 * `podium all` — and a bare `podium` on a box with no persistence — is neither.
 * There the server and the daemon are ONE process, so the daemon's exit is the
 * server's exit, and nothing exists to start it again. Converging would take
 * down the server the operator is watching, from the browser it is serving, and
 * it would not come back.
 *
 * SO THE DAEMON DECLINES, IN THE FIRST PERSON, BEFORE ANYTHING IS FETCHED OR
 * MOVED. Not after: git delivery detaches the checkout the running server is
 * reading from — its web assets, its migrations, the `scripts/cli.ts` it spawns
 * lifecycle workers from — so a convergence that stops short of the restart
 * would leave a live old process reading new source. Nothing changed is the only
 * honest half-way state.
 *
 * AND NOT BY SELF-RESTARTING INSTEAD. A source checkout moved to a new commit
 * may not boot without an install or a build; that is precisely the gate the
 * redeploy unit runs before it restarts anything, and a foreground process has
 * nowhere to run it and nobody to catch it if the new code fails to start. A
 * re-exec would trade a server that always dies for one that sometimes dies —
 * and orphan the operator's terminal job on the way.
 *
 * The refusal is spelled like every other one the panel reads: a leading
 * `cannot converge:` and a stable token (`foreground-all-in-one`) the web copy
 * matches on, followed by the sentence itself.
 */
export const FOREGROUND_ALL_IN_ONE_REFUSAL =
  'cannot converge: foreground-all-in-one — this daemon shares its process with the ' +
  'Podium server and nothing would start that process again, so updating it here would ' +
  'stop the server and it would not come back'

export interface ProcessShape {
  /**
   * Does this daemon's exit also stop the coordinating server? Answered by the
   * composition root, which is the only place that knows which roles this PID
   * took (`apps/cli` — `daemonOptionsForPlan`).
   */
  exitStopsServer?: boolean
  env: NodeJS.ProcessEnv
}

/**
 * Will something start this process again if it exits?
 *
 * `INVOCATION_ID` is the same signal the SERVER uses to decide it may restart
 * itself (`apps/server/src/modules/updates/source-redeploy.ts` returns no
 * restart capability without it), and asking the same question two different
 * ways about the same process is how the two answers drift apart.
 * `PODIUM_DESKTOP_SUPERVISED` is the shell's, matching every other reader of
 * that flag.
 */
function restartedByAManager(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.INVOCATION_ID) || env.PODIUM_DESKTOP_SUPERVISED === '1'
}

/**
 * Why this daemon must not converge at all, or `undefined` when it may.
 *
 * Deliberately a sentence rather than a boolean: a refusal that reaches the
 * operator as "one or more machines cannot use this update" is a refusal nobody
 * can act on, and §6.2/§7 of the update spec require a failure to name itself.
 */
export function refuseConvergence(shape: ProcessShape): string | undefined {
  if (!shape.exitStopsServer) return undefined
  if (restartedByAManager(shape.env)) return undefined
  return FOREGROUND_ALL_IN_ONE_REFUSAL
}

/**
 * Should the daemon's `restartAfterUpdate` seam — whose default is
 * `process.exit(0)` — be replaced by one that refuses to exit?
 *
 * The grant path never reaches it (the refusal above lands first), so this is
 * about the OTHER caller and any future one: the protocol-mismatch self-update
 * in `connection-state`, whose restart is the same fatal exit in the same shape.
 * Disarming the seam makes "this process must not stop itself to finish an
 * update" a property of the process rather than of one code path.
 *
 * `provided` wins outright: an embedder or test that passed its own restart has
 * said what happens instead of an exit, and second-guessing it would break every
 * harness that drives a co-hosted daemon.
 */
export function disarmExitSeam(input: { provided?: () => void; shape: ProcessShape }): boolean {
  if (input.provided !== undefined) return false
  return refuseConvergence(input.shape) !== undefined
}

/**
 * THE REFUSAL A MACHINE WITH A MIGRATED DATABASE OWES ITS OPERATOR (POD-2213).
 *
 * Two things this system promises collide here, and the bug was executing the
 * first without consulting the second.
 *
 * ONE: a daemon converges to TARGET EQUALITY, up or down — see
 * `planConvergence`, which exists precisely so rollback is structurally
 * possible. TWO: §13 of the update design says a database whose schema is newer
 * than the running code MUST refuse to open, and that a schema-advanced
 * rollback HALTS and reports rather than proceeding.
 *
 * Executed alone, the first rule bricks an install in four seconds: the daemon
 * swaps the install its co-located server runs from, the older server refuses
 * the migrated database, the supervisor crash-loops, and NOTHING INSIDE PODIUM
 * CAN FIX IT — the thing that would apply an update is the server that will not
 * start. `podium update` on the swapped install answers "already up to date",
 * because the feed really has nothing newer.
 *
 * So the gate is here, before a byte is fetched, and it asks the only question
 * that matters: can the build we are about to swap in OPEN THIS DATABASE? The
 * answer needs two facts — what this database has applied (read from its
 * ledger) and what the target build defines (declared by whoever published the
 * target). A target that does not say cannot be proven safe, and an unprovable
 * swap on a machine that owns a database is exactly the swap that bricked.
 *
 * A downgrade whose schema did NOT advance still converges. That is the
 * rollback path the design deliberately keeps, and releases are expand-only
 * (§13.2) so it is the common case.
 *
 * AND NEITHER DOES AN UPGRADE PAY FOR THIS. The first cut of this gate refused
 * every target that would not declare, in both directions, and no release
 * published to date declares anything — so it would have left no installed
 * machine able to accept ANY published release until a new one was cut. That is
 * a worse failure than the one being fixed, and a dev-only drive would never
 * have seen it, because dev targets DO declare.
 *
 * So unprovable-and-BEHIND and unprovable-and-AHEAD are separate cases, and only
 * the first is a hazard. A step forward cannot brick anything: the database is
 * moved only by migrations the NEW build carries, so the build being swapped in
 * defines every migration it will find. The formal version: the server running
 * now OPENED this database, so what it has applied is within what the current
 * build defines; releases are expand-only, so a newer build defines at least
 * what the current one does; therefore a newer build defines everything applied.
 * Neither link holds backwards, which is exactly why the direction decides it.
 */
const SCHEMA_ADVANCED = 'schema-advanced'
const SCHEMA_UNKNOWN = 'schema-unknown'
const SCHEMA_UNREADABLE = 'schema-unreadable'

/**
 * Why this daemon must not converge to THIS target, or `undefined` when it may.
 *
 * Pure: the ledger read and the target's declaration are both facts the caller
 * gathers, so the decision itself is testable in a table.
 */
export function refuseSchemaRegression(input: {
  /**
   * Migration names this machine's database has applied, or `undefined` when
   * this machine holds no database at all. The difference decides the case:
   * §13.3 — "a daemon owns no database", so its rollback is always safe, and
   * every remote worker machine keeps automatic rollback because of this line.
   */
  applied: readonly string[] | undefined
  /** Migration names the target build defines, or `undefined` if it did not say. */
  targetDefines: readonly string[] | undefined
  currentVersion: string
  targetVersion: string
}): string | undefined {
  const { applied, targetDefines, currentVersion, targetVersion } = input
  if (applied === undefined || applied.length === 0) return undefined

  const staysPut =
    `Nothing was fetched and nothing was swapped; this machine stays on ${currentVersion}, ` +
    `which is the version that works here.`

  if (targetDefines === undefined) {
    /**
     * The one thing left to ask about a target that will not say: is it at
     * least AHEAD of us? `isProvablyNewer` fails closed, so `false` covers both
     * "older" and "these two labels have no order at all" — a `dev+<sha>` on
     * either side is not evidence of anything and is refused. That costs a dev
     * checkout nothing, because the development publisher declares its schema
     * from the commit it advertises.
     */
    if (isProvablyNewer(targetVersion, currentVersion)) return undefined
    return (
      `cannot converge: ${SCHEMA_UNKNOWN} — ${targetVersion} does not declare which schema ` +
      `migrations it can open, it is not a version this machine can prove is newer than the ` +
      `${currentVersion} it runs, and this machine's database has ${applied.length} applied, so ` +
      `nothing here can tell whether that build would start against it. ${staysPut} An update ` +
      `that moves FORWARD needs no declaration and is not affected by this; going back to a ` +
      `build published before this check existed is what cannot be proven safe.`
    )
  }

  const defined = new Set(targetDefines.map(canonicalMigrationName))
  const missing = applied.filter((name) => !defined.has(canonicalMigrationName(name))).sort()
  if (missing.length === 0) return undefined

  const [first] = missing
  const alsoOthers = missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''
  return (
    `cannot converge: ${SCHEMA_ADVANCED} — this machine's database has applied migration ` +
    `'${first}'${alsoOthers}, which ${targetVersion} does not define, so that build would ` +
    `refuse to open the database and the server would not come back. ${staysPut} Going back ` +
    `across a migration is not something Podium can do for you — it needs a database restore ` +
    `by hand (docs/data-and-upgrades.md), because restoring silently would discard every ` +
    `write made since the schema advanced.`
  )
}

/**
 * The refusal seam `applyGrant` calls, bound to this machine's ledger.
 *
 * The read is a thunk rather than a value because it has to be FRESH: a daemon
 * lives across upgrades of its own server, so the set of applied migrations at
 * grant time is not the set at boot time.
 *
 * A read that throws refuses. An unreadable ledger is not the same answer as
 * "this machine owns no database", and reading it as one would let through
 * exactly the swap this gate exists to stop.
 */
export function createSchemaGate(deps: {
  readApplied: () => readonly string[] | undefined
  currentVersion: string
}): (target: { version: string; schema?: { migrations: string[] } }) => string | undefined {
  return (target) => {
    let applied: readonly string[] | undefined
    try {
      applied = deps.readApplied()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return (
        `cannot converge: ${SCHEMA_UNREADABLE} — this machine's database could not be read ` +
        `(${detail}), so there is no way to tell whether ${target.version} could open it. ` +
        `Nothing was fetched and nothing was swapped; this machine stays on ` +
        `${deps.currentVersion}.`
      )
    }
    return refuseSchemaRegression({
      applied,
      targetDefines: target.schema?.migrations,
      currentVersion: deps.currentVersion,
      targetVersion: target.version,
    })
  }
}

export type BootVerdict =
  | { action: 'confirm'; state: 'current' }
  | { action: 'retry'; attempts: number }
  | { action: 'rollback'; state: 'rejected' | 'stuck'; detail: string }

export function resolveOnBoot(ctx: {
  pending: PendingGrant | null
  runningVersion: string
}): BootVerdict | null {
  const { pending, runningVersion } = ctx
  if (!pending) return null

  // The bound limits failures, not successes: a daemon that arrived on its last
  // permitted attempt is current.
  if (runningVersion === pending.targetVersion) return { action: 'confirm', state: 'current' }

  if (pending.attempts < MAX_CONVERGENCE_ATTEMPTS) {
    return { action: 'retry', attempts: pending.attempts + 1 }
  }

  return {
    action: 'rollback',
    state: 'stuck',
    detail:
      `did not reach ${pending.targetVersion} after ${pending.attempts} attempt(s); ` +
      `running ${runningVersion}, pinned to last-known-good`,
  }
}
