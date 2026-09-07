/**
 * Where a @podium/server test shard records what it actually ran, and how to read it back
 * (POD-3531).
 *
 * The shard split (POD-520) made `@podium/server#test` an AGGREGATE: five shard tasks do
 * the running, and the aggregate's own body only verifies the roster. Under Turbo that is
 * honest, because `dependsOn` will not let the aggregate run until all five have. Run by
 * hand — `cd apps/server && bun run test` — it was not: the aggregate printed "445 unit
 * files across 5 shards" and exited 0 having run none of them.
 *
 * A `dependsOn` edge is not evidence a human can see, so the fix does not rely on one. Each
 * shard now writes a Vitest JSON report naming every file it executed, and the aggregate
 * reconciles those reports against the roster it announced. That is the same accounting
 * shape POD-3517 landed for typecheck: the run has to account for itself, and a total it
 * cannot account for is refused rather than reported.
 *
 * The path is FIXED rather than passed in, and that is load-bearing. Turbo runs tasks in a
 * strict environment and the shards run as siblings the aggregate never spawns, so there is
 * no environment the aggregate could hand them. Both sides therefore agree here, in one
 * module, imported by `vitest.shard.ts` (which writes) and `scripts/server-test-shards.ts`
 * (which reads).
 *
 * Dot-prefixed on purpose: `unitLaneTestFiles` and the drift guard's `walkServerFiles` both
 * skip dot entries, so the reports can never be mistaken for lane files or shard inputs.
 */
import { join, relative } from 'node:path'

/** Repo-relative directory the shard reports are written to. Gitignored; Turbo task output. */
export const SHARD_REPORT_DIR = 'apps/server/.test-shard-reports'

/** Same directory, package-relative — the spelling `apps/server/turbo.json` `outputs` uses. */
export const SHARD_REPORT_DIR_IN_PACKAGE = '.test-shard-reports'

/**
 * Probe seam: relocates the whole report directory.
 *
 * Read by BOTH sides — the shard config that writes and the aggregate that reads and clears
 * — so a test can drive the real runner without touching the checkout's own reports.
 * It cannot affect the gated lane: Turbo runs tasks in a strict environment and passes a
 * task nothing it has not declared, so under Turbo this is always unset and the path is
 * always {@link SHARD_REPORT_DIR}.
 */
export const SHARD_REPORT_DIR_ENV = 'PODIUM_SERVER_SHARD_REPORT_DIR'

/** Absolute path of the directory the shard reports live in. */
export function shardReportDir(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[SHARD_REPORT_DIR_ENV]
  return override && override.trim() !== '' ? override : join(root, SHARD_REPORT_DIR)
}

/** Absolute path of one shard's report. */
export function shardReportPath(
  root: string,
  shardId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(shardReportDir(root, env), `${shardId}.json`)
}

/** The subset of Vitest's JSON reporter output this file depends on. */
export interface VitestJsonReport {
  success?: unknown
  testResults?: { name?: unknown; assertionResults?: { status?: unknown }[] }[]
}

/**
 * Every test file the report says ran, repo-relative and sorted.
 *
 * Vitest names files by absolute path and emits one `testResults` entry per collected file; only files with a passed or failed assertion
 * count as executed, so a filtered or entirely skipped file cannot read as green.
 *
 * the two shard projects (reused/isolated) partition the roster, so a file appears once. A
 * malformed or empty report yields an empty set, which the caller reports as an unrun shard
 * rather than as a pass — the whole point being that "nothing to see" must never read green.
 */
export function executedTestFiles(root: string, report: VitestJsonReport): string[] {
  const files = new Set<string>()
  for (const result of report.testResults ?? []) {
    if (typeof result?.name !== 'string' || result.name === '') continue
    if (
      !result.assertionResults?.some((test) => test.status === 'passed' || test.status === 'failed')
    )
      continue
    files.add(relative(root, result.name))
  }
  return [...files].sort()
}
