import { isProvablyNewer } from '@podium/protocol'
import { canonicalMigrationName } from './migration-ledger'

/**
 * Did this target carry migrations this machine has not applied?
 *
 * Undefined is intentionally a real answer: an undeclared target has not
 * proved the fact needed for rollback, so the parent must keep refusing. No
 * local ledger means this is a daemon-only machine with no database to migrate,
 * which is the one case where `false` is proven without comparing names.
 */
export function releaseCarriesNewMigrations(
  target: { schema?: { migrations?: readonly string[] } },
  applied: readonly string[] | undefined,
): boolean | undefined {
  const defines = target.schema?.migrations
  if (defines === undefined) return undefined
  if (applied === undefined) return false
  const have = new Set(applied.map(canonicalMigrationName))
  return defines.some((name) => !have.has(canonicalMigrationName(name)))
}

const SCHEMA_ADVANCED = 'schema-advanced'
const SCHEMA_UNKNOWN = 'schema-unknown'
const SCHEMA_UNREADABLE = 'schema-unreadable'

/**
 * Refuse a target that cannot be proven able to open this machine's database.
 * Forward semver moves are safe without a declaration because releases are
 * expand-only; backwards or unordered moves must declare every applied migration.
 */
export function refuseSchemaRegression(input: {
  applied: readonly string[] | undefined
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

/** Bind the pure refusal to a fresh read of this instance's migration ledger. */
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
