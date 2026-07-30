/**
 * Generates `docs/rearch-visibility-mutability-inventory.md` — the per-class
 * inventory of "is visibility mutable after create, and by which verb" that
 * POD-304 owes POD-1077 in writing (multi-user readiness §3.1 item 2, ADR 9 D2
 * rule 5).
 *
 * DERIVED, NEVER RESTATED. ADR 4 D7 forbids storing derived state twice, so the
 * document is generated from `OWNERSHIP_MATRIX` rather than hand-written beside
 * it — a hand-written copy is a second source of truth that drifts the first
 * time a row changes. `--check` fails when the committed file no longer matches
 * the matrix, the same discipline as `bun run migration:manifest --check`.
 *
 *   bun scripts/visibility-mutability-inventory.ts            # write
 *   bun scripts/visibility-mutability-inventory.ts --check    # CI / test gate
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP_MATRIX } from '../packages/model/src/annotations/matrix'
import type { MatrixRow } from '../packages/model/src/annotations/ownership'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const OUTPUT_PATH = join(REPO_ROOT, 'docs/rearch-visibility-mutability-inventory.md')

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function section(rows: readonly MatrixRow[], mutable: boolean): string {
  const subset = rows.filter((r) => r.visibilityMutability.mutable === mutable)
  const lines = subset.map((row) => {
    const verbs = row.visibilityMutability.verbs
    return `| \`${row.id}\` | ${cell(row.title)} | ${row.visibility} | ${
      verbs.length > 0 ? verbs.map((v) => `\`${v}\``).join(' ') : '—'
    } | ${cell(row.visibilityMutability.note)} |`
  })
  return [
    '| Row | Class | Visibility class | Verbs that change who can see it | Note |',
    '|---|---|---|---|---|',
    ...lines,
  ].join('\n')
}

export function render(rows: readonly MatrixRow[] = OWNERSHIP_MATRIX): string {
  const mutable = rows.filter((r) => r.visibilityMutability.mutable)
  const immutable = rows.filter((r) => !r.visibilityMutability.mutable)
  return `# Visibility mutability inventory — handed from POD-304 to POD-1077

<!-- GENERATED FILE. Do not edit by hand.
     Source of truth: packages/model/src/annotations/matrix.ts (the ownership matrix).
     Regenerate:  bun scripts/visibility-mutability-inventory.ts
     Verify:      bun scripts/visibility-mutability-inventory.ts --check
     ADR 4 D7 forbids storing derived state twice, so this document is derived. -->

## Why this document exists

**Visibility changes are not entity changes.** Granting or revoking a share makes
entities appear or disappear for a principal **without that entity's \`revision\`
moving** (ADR 9 D2 rule 5, readiness §3.1 item 2). A feed that filters per client
cannot express that today, and ADR 2 is explicit that adding the filter without
watermarks is **a protocol break, not an optimization**: every suppressed row
becomes an invisible permanent gap that triggers an endless heal loop.

So POD-1077 must build **watermarks** plus a **rescope / \`evict\` signal distinct
from \`remove\`** — a removal from *your view*, not a deletion. \`remove\` cannot be
reused: the replica would render it as "deleted", and ADR 2 D5 already warns that
soft-delete and tombstone "look identical from a distance and are not". This is a
third member of that family.

**POD-304 builds none of that.** It records which classes have the property, per
class, because that set is the input to Phase 2's scoped-feed conformance suite.
The rows marked *mutable* below are exactly the classes whose appearance or
disappearance a scoped feed must be able to signal.

## What POD-1077 should read off this

1. **${mutable.length} of ${rows.length} classes have mutable visibility.** This is the majority of
   the matrix, which is the quantitative form of "the machinery is load-bearing
   from day one, not inert" (readiness header decision).
2. **The \`change-log\` row is the one the whole inventory is for.** Its delivery
   is per-principal scoped while it is substrate at rest; that split is where
   watermarks live.
3. **The \`grant-edge\` row IS the visibility event.** It is a durable change with
   a global \`seq\`, which is the anchor a watermark advance and a rescope signal
   hang off — you do not need to invent an event, you need to interpret that one.
4. **Two classes change visibility through a verb that is not a share.** Machine
   grants (\`see\` / \`use\` / \`manage\`) and account-level acts
   (\`account-role-change\` / \`account-disable\`) both move a principal's visible
   set without any entity being shared. A conformance suite built only around
   \`share\` / \`unshare\` will miss both.
5. **Per-user state is never mutable, by construction** — non-grantable, so no
   verb can change who sees it. Those rows need no signal, which is a real
   saving: it is why keying by user is a simplification and not just a re-shape.
6. **Machine absence is not machine deletion.** A machine the principal cannot
   \`see\` is *absent*, and any reference to it must fail identically to a
   nonexistent machine id (ADR 9 D6 M5 / D7 clause 2). Revoking \`see\` therefore
   needs the evict path, not a \`remove\`.

## Mutable after create — Phase 2 must be able to signal these

${section(rows, true)}

## Not mutable after create — no signal needed

${section(rows, false)}

## What is deliberately NOT decided here

Which existence facts leak (O1), whether a cross-boundary graph edge is hidden or
shown as an opaque "blocked by something you cannot see" reference (O2), whether
\`reparent\` is a permission-affecting operation (O3), and the multi-parent case of
owner/grant inheritance on create (O4). Those are recorded on the matrix rows
that make them concrete and are answered by their owners, not here.
`
}

const isCheck = process.argv.includes('--check')
const rendered = render()

if (isCheck) {
  let existing = ''
  try {
    existing = readFileSync(OUTPUT_PATH, 'utf8')
  } catch {
    console.error(`missing ${OUTPUT_PATH} — run: bun scripts/visibility-mutability-inventory.ts`)
    process.exit(1)
  }
  if (existing !== rendered) {
    console.error(
      'docs/rearch-visibility-mutability-inventory.md is STALE against the ownership matrix.\n' +
        'Regenerate: bun scripts/visibility-mutability-inventory.ts',
    )
    process.exit(1)
  }
  console.log('visibility-mutability inventory: up to date')
} else if (import.meta.main) {
  writeFileSync(OUTPUT_PATH, rendered)
  console.log(`wrote ${OUTPUT_PATH}`)
}
