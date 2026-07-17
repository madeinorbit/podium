import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { asSessionId } from '../ids'
import { minimalIssue, populatedIssue } from './__fixtures__/issues'
import { toWire } from './mapping'

/**
 * GOLDEN WIRE FIXTURES for `IssueProjection` [ADR 4 §6 risk row: "Wire fixtures
 * break → POD-360 golden fixtures"; §7: "Wire golden fixtures stay green across
 * re-derivation"].
 *
 * ## Provenance
 *
 * The `.json` files in `./__fixtures__/` are GENERATED, not hand-authored: they
 * are `JSON.stringify(toWire(fixture, derived), null, 2)` for the two aggregates
 * in `./__fixtures__/issues.ts`. Regenerate with:
 *
 *     PODIUM_UPDATE_GOLDEN=1 bun --bun vitest run packages/model/src/issue/issue.golden.test.ts
 *
 * and READ THE DIFF — that diff is the whole value of the fixture. Regenerating
 * without reading it converts this test from a gate into a rubber stamp.
 *
 * ## What this actually gates — and what it does NOT
 *
 * A comparison of the exact wire bytes, so it catches what a `toEqual` misses:
 *   - the key ORDER, which is deterministic because `toWire` returns
 *     `IssueProjection.parse(...)` output and zod emits keys in shape-declaration
 *     order — so a reordering of the vocabulary is visible rather than silent;
 *   - the null→absent rule's actual effect on the payload (the `minimal` fixture
 *     is almost entirely absent keys — that IS the assertion);
 *   - value encodings, including the `panel` structure and JSON escaping.
 *
 * It does NOT, on its own, catch a new field. Verified by mutation, not assumed:
 * adding `mutationProbe: z.string().nullable()` to a group leaves both fixtures
 * byte-identical, because the field becomes an OPTIONAL wire key that neither
 * fixture sets — and these two tests stay GREEN. The key-set gate is the other
 * three, which the same mutation does trip: `tsgo --noEmit` (2 errors),
 * `issue.compose.test.ts`'s shape comparison, and `issue.mapping.test.ts`'s "sets
 * every durable field" coverage guard (10 failures across the file). What makes
 * the golden meaningful is that the coverage guard FORCES the fixtures to set
 * every field — so once a field exists, its bytes are frozen here. The golden and
 * the guard are one gate in two halves; neither is sufficient alone.
 *
 * The 71-key `IssueWire` this supersedes has no such fixture, which is precisely
 * why "does the re-derivation change the wire?" has never been answerable by
 * anything but reading the serializer.
 */

/**
 * Reads the recorded fixture (and rewrites it under `PODIUM_UPDATE_GOLDEN=1`).
 *
 * Returns the PARSED value, not the file's bytes, and the assertions below
 * re-serialize both sides compactly to compare them. That is deliberate on two
 * counts. First, the file is pretty-printed for a readable diff, but the real
 * wire bytes are `JSON.stringify(payload)` with no indentation — so comparing the
 * file's literal bytes would gate the rendering, not the payload. Second, biome
 * formats `.json` and wants short arrays collapsed onto one line, which
 * `JSON.stringify(…, null, 2)` never emits: a byte comparison against the file
 * would mean `biome check --write .` silently rewrites the fixture and reds this
 * test for a reason that has nothing to do with the wire. Comparing re-serialized
 * values is immune to both, and loses nothing — key set, key ORDER and value
 * encodings all survive `JSON.stringify`, and whitespace is not a wire property.
 */
const readGolden = (name: string, actual: unknown): unknown => {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url)
  if (process.env.PODIUM_UPDATE_GOLDEN === '1') {
    writeFileSync(url, `${JSON.stringify(actual, null, 2)}\n`)
  }
  return JSON.parse(readFileSync(url, 'utf8'))
}

const expectMatchesGolden = (name: string, actual: unknown): void => {
  const golden = readGolden(name, actual)
  // Structural first — it produces the readable field-level diff on failure...
  expect(actual).toEqual(golden)
  // ...then the exact wire bytes, which is the assertion `toEqual` cannot make:
  // it pins KEY ORDER, and key order is shape-declaration order.
  expect(JSON.stringify(actual)).toBe(JSON.stringify(golden))
}

describe('IssueProjection golden wire fixtures', () => {
  it('serializes a fully-populated issue exactly as recorded', () => {
    expectMatchesGolden(
      'issue-projection.populated.json',
      toWire(populatedIssue, {
        memberSessionIds: [asSessionId('sess_7b3e91'), asSessionId('sess_c40d2a')],
      }),
    )
  })

  it('serializes an all-nulls issue exactly as recorded', () => {
    expectMatchesGolden(
      'issue-projection.minimal.json',
      toWire(minimalIssue, { memberSessionIds: [] }),
    )
  })
})
