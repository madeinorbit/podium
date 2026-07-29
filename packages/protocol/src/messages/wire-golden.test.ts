/**
 * Wire-compatibility gate for POD-300 (entity schemas → `@podium/model`).
 *
 * `wire-golden.json` was captured BEFORE the relocation. Every fixture must
 * still parse to a byte-identical JSON string after it. Field order counts:
 * zod emits object keys in schema-shape order, so reordering a schema changes
 * the golden and therefore changes the wire.
 *
 * If a golden fails, the relocation changed the wire. That is a stop condition
 * — do NOT regenerate to make it pass. Regenerating is only correct for a
 * deliberate, reviewed wire change:  bun scripts/wire-golden-capture.ts
 */

import { HandoffManifest } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { WIRE_FIXTURES } from './wire-golden.fixtures'
import golden from './wire-golden.json'

/** Parse through a JSON round trip so a fixture can never smuggle a non-wire
 *  value (Date, undefined, symbol) past the schema. */
function encodedParse(schema: { parse: (v: unknown) => unknown }, value: unknown): string {
  return JSON.stringify(schema.parse(JSON.parse(JSON.stringify(value))))
}

describe('golden wire fixtures', () => {
  it('has exactly the fixtures the golden file records', () => {
    // A dropped fixture is a silently unproven schema, so the sets must match
    // in both directions.
    expect([...WIRE_FIXTURES.map((f) => f.name)].sort()).toEqual(Object.keys(golden).sort())
  })

  for (const fixture of WIRE_FIXTURES) {
    it(`encodes ${fixture.name} byte-identically`, () => {
      expect(golden[fixture.name as keyof typeof golden]).toBeDefined()
      expect(encodedParse(fixture.schema, fixture.value)).toBe(
        golden[fixture.name as keyof typeof golden],
      )
    })
  }

  // Refinements are wire behaviour too: the manifest's containment check must
  // survive the move to @podium/model, not just its field list.
  it('still rejects worktree locations that escape the repository', () => {
    const base = {
      format: 1 as const,
      sessionId: 'sess-1',
      agentKind: 'codex' as const,
      resume: { kind: 'codex-thread', value: 'thread-1' },
      transcriptFilename: 'rollout.jsonl',
      repoId: 'repo-1',
      branch: 'issue/300',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true as const,
      worktreeName: 'issue-300',
      bundleBase: ['c'.repeat(40)],
      sourceMachineId: 'machine-1',
      exportedAt: '2026-07-30T10:00:00.000Z',
    }
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '../elsewhere' })).toThrow()
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '/tmp/x' })).toThrow()
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: 'a\\b' })).toThrow()
  })
})
