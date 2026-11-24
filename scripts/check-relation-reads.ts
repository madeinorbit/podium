/**
 * POD-7547 — the relation-read check, in the lean gate (`bun run test`).
 *
 * Fails when a schema relation can read a record that is not guaranteed to be
 * on the device without holding and loading it, unless the relation is listed
 * with its reason in `IN_MEMORY_RELATIONS`
 * (`packages/client-graph/src/shared/relation-reads.ts`, which explains the
 * classification).
 */

export {}

/** What this script reads of the check; the module itself is typechecked in client-graph. */
interface RelationReadsModule {
  relationReadProblems(): string[]
  relationReads(): readonly { readonly read: { readonly kind: string } }[]
}

// A path the scripts project does not follow: the client schema's module
// augmentations resolve only in the client-graph project.
const modulePath: string = '../packages/client-graph/src/shared/relation-reads.ts'
const { relationReadProblems, relationReads } = (await import(modulePath)) as RelationReadsModule

const problems = relationReadProblems()
if (problems.length > 0) {
  console.error('Relation reads that do not hold or load what they read:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
const counts = new Map<string, number>()
for (const row of relationReads()) counts.set(row.read.kind, (counts.get(row.read.kind) ?? 0) + 1)
console.log(
  `relation reads: ${[...counts].map(([kind, count]) => `${count} ${kind}`).join(', ')} (unprotected ones listed with their reasons)`,
)
