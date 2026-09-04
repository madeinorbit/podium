/**
 * POD-3371 — the await pass is a fixed point, checked rather than described.
 *
 * `awaitify.ts --pass=awaits` is a mechanical pass, and the method's oracle for a
 * mechanical pass is IDEMPOTENCE: re-running it over its own output must be a
 * no-op, so any proposed edit is a finding. POD-3262 found a real defect that way
 * — two awaits beginning at the same character, applied in the wrong order —
 * which was typecheck-clean, lane-green and invisible to every other check.
 *
 * The property could not be checked by anyone, because the pass only reaches its
 * fixed point when told which functions must stay synchronous, and that set lived
 * in a scratch file outside the repo. Run without it the pass proposes edits at
 * refusal sites, which reads as missing work; that false alarm has now been filed
 * twice (POD-3294, POD-3369). The set is `scripts/awaitify-keep-sync.txt`.
 *
 * TWO THINGS FAIL HERE, and the second is the one that bites:
 *
 *   1. A PROPOSED EDIT. The tree drifted from the pass's output — a store call
 *      arrived un-awaited, or the pass changed. `git merge-tree` reports the
 *      merge that does this as CLEAN, so nothing else asks anyone to look.
 *
 *   2. AN UNUSED KEEP-SYNC ENTRY. Entries address a function by byte offset, so
 *      an edit that moves the function turns its entry into a silent no-op — the
 *      pass stops refusing there and proposes the edit again. POD-3262 ran a
 *      round-4 list against round-5 code and it REGENERATED the bad form. A stale
 *      entry must be loud, so it is a failure here and not a warning.
 *
 * Either way the remedy is the same: `bun scripts/awaitify-derive-keep-sync.ts`,
 * which re-derives the set from the compiler at the current tip.
 *
 *   bun scripts/check-await-idempotence.ts
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readKeepSync, run } from './awaitify'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP_SYNC = join(ROOT, 'scripts/awaitify-keep-sync.txt')

export interface IdempotenceResult {
  /** Files the pass would rewrite. Empty is the property. */
  proposedFiles: string[]
  /** Await insertions behind those rewrites. */
  proposedSites: number
  /** Entries the run never consulted — the set has gone stale against the tree. */
  unusedKeepSync: string[]
  keepSyncSize: number
  refusals: number
}

export function checkIdempotence(keepSyncPath: string = KEEP_SYNC): IdempotenceResult {
  const keepSync = readKeepSync(keepSyncPath)
  const r = run({
    pass: 'awaits',
    // Never `apply`: a check must not be able to repair what it measures.
    apply: false,
    configPath: join(ROOT, 'apps/server/tsconfig.json'),
    keepSync,
  })
  return {
    proposedFiles: r.edited,
    proposedSites: r.sites,
    unusedKeepSync: r.unusedKeepSync,
    keepSyncSize: keepSync.size,
    refusals: r.refusals.length,
  }
}

function main(): void {
  const keepSyncPath =
    process.argv.find((a) => a.startsWith('--keep-sync='))?.slice(12) ?? KEEP_SYNC
  const r = checkIdempotence(keepSyncPath)
  console.log(
    `keep-sync=${r.keepSyncSize} refusals=${r.refusals} ` +
      `proposed-files=${r.proposedFiles.length} proposed-awaits=${r.proposedSites} ` +
      `unused-keep-sync=${r.unusedKeepSync.length}`,
  )
  let failed = false
  if (r.proposedFiles.length > 0) {
    failed = true
    console.error(`\nNOT A FIXED POINT — the pass wants ${r.proposedSites} await(s) in:`)
    for (const f of r.proposedFiles) console.error(`  ${f}`)
  }
  if (r.unusedKeepSync.length > 0) {
    failed = true
    console.error('\nSTALE REFUSAL SET — these entries addressed a function that has moved:')
    for (const k of r.unusedKeepSync) console.error(`  ${k}`)
  }
  if (failed) {
    console.error('\nRe-derive it: bun scripts/awaitify-derive-keep-sync.ts')
    process.exit(1)
  }
  console.log('the await pass is a fixed point at this tip')
}

if (import.meta.main) main()
