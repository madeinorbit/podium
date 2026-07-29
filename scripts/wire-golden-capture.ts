/**
 * Regenerate `packages/protocol/src/messages/wire-golden.json` from the
 * fixtures beside it.
 *
 * The golden pins the exact JSON a schema PARSE produces for each fixture —
 * field names, values, field order, and `.default()` / `.catch()` / refinement
 * behaviour. It is the wire-compatibility contract that POD-300's relocation of
 * the entity schemas into `@podium/model` was proven against.
 *
 * RUN THIS ONLY FOR A DELIBERATE, REVIEWED WIRE CHANGE. A golden that moves
 * during a refactor means the refactor changed the wire — a stop condition, not
 * a fixture to update. The same baseline is what later proves POD-1075's
 * owner/visibility additions (docs/multi-user-readiness.md §3.2) are purely
 * additive, so silently rebasing it destroys that proof.
 *
 *   bun scripts/wire-golden-capture.ts
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIRE_FIXTURES } from '../packages/protocol/src/messages/wire-golden.fixtures'

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/protocol/src/messages/wire-golden.json',
)

const next: Record<string, string> = {}
for (const fixture of WIRE_FIXTURES) {
  // The JSON round trip mirrors the test: a fixture can never smuggle a
  // non-wire value (Date, undefined, symbol) past its schema.
  next[fixture.name] = JSON.stringify(
    fixture.schema.parse(JSON.parse(JSON.stringify(fixture.value))),
  )
}

writeFileSync(GOLDEN_PATH, `${JSON.stringify(next, null, 2)}\n`)
console.log(`wrote ${Object.keys(next).length} golden fixtures to ${GOLDEN_PATH}`)
