/**
 * THE LEDGER GUARDS BOTH MIGRATION CHAINS SHARE [spec:SP-4428, POD-1621, POD-6981].
 *
 * The SQLite runner (`./index.ts`) and the Postgres runner (`./pg/index.ts`) read
 * different ledgers on different engines, but they decide the same two questions the
 * same way, so the decisions live here, as pure functions of migration names:
 *
 * - the DOWNGRADE GUARD: a database that has applied a migration this build does not
 *   define is newer than the build, and the runner refuses to touch it;
 * - the OUT-OF-ORDER GUARD: a pending migration that sorts before the newest applied one
 *   is the signature of a second lineage arriving late.
 *
 * What each runner does with an out-of-order migration differs, and that is the
 * runner's call: SQLite warns and repairs (a late table rebuild can drop columns,
 * POD-1621), Postgres warns, and refuses only a migration marked as a rewrite
 * (`ALTER TABLE` does not rebuild, design 2.7).
 */

/**
 * THE OUT-OF-ORDER GUARD [POD-1621]. Names every pending migration that sorts
 * BEFORE the highest already-applied name — the exact signature of a second
 * lineage arriving late.
 *
 * Out-of-order on its own is harmless: two branches generate timestamps
 * independently and merge, and most such migrations are additive. It becomes the
 * POD-1621 hazard when the late migration REBUILDS a table (SQLite's
 * create/copy/drop/rename pattern), because its column list was written without
 * knowledge of anything the other lineage added. The ledger cannot see the loss:
 * every migration ran exactly once.
 *
 * So the signature is worth surfacing on its own, before knowing whether damage
 * followed — it is cheap, it is exact, and a boot log naming it turns "auth has
 * been throwing for hours" into a five-minute diagnosis.
 */
export function outOfOrderPending(
  appliedNames: Iterable<string>,
  pendingNames: readonly string[],
): string[] {
  const highestApplied = [...appliedNames].sort((a, b) => a.localeCompare(b)).at(-1)
  if (highestApplied === undefined) return []
  return pendingNames.filter((name) => name.localeCompare(highestApplied) < 0)
}

/**
 * The names a build recognises in a ledger: its own migrations, plus every alias
 * whose canonical migration the build carries. An alias without its canonical
 * migration stays unknown, so the downgrade guard remains strict for it.
 */
export function knownMigrationNames(
  migrationNames: Iterable<string>,
  aliases: ReadonlyMap<string, string> = new Map(),
): Set<string> {
  const known = new Set(migrationNames)
  for (const [alias, canonical] of aliases) {
    if (known.has(canonical)) known.add(alias)
  }
  return known
}

/**
 * THE DOWNGRADE GUARD. The applied names this build does not define, in ledger
 * order; empty when the build knows every one.
 */
export function unknownAppliedMigrations(
  appliedNames: Iterable<string>,
  known: ReadonlySet<string>,
): string[] {
  return [...appliedNames].filter((name) => !known.has(name))
}

/** The refusal for a database that is newer than the build. */
export function newerDatabaseMessage(name: string): string {
  return (
    `database has applied migration '${name}', which this build does not define. ` +
    `The database is newer than this build — upgrade the Podium server ` +
    `(downgrades are not supported).`
  )
}

/**
 * drizzle's `created_at`: the folder-name's 14-digit `YYYYMMDDHHMMSS` UTC prefix
 * as epoch millis, matching what drizzle's migrators record for the same
 * migration on either engine.
 */
export function folderMillis(name: string): number {
  const s = name.slice(0, 14)
  const millis = Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  )
  return Number.isNaN(millis) ? 0 : millis
}
