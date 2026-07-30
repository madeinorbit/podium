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
 * deliberate, reviewed wire change:  bun --conditions @podium/source scripts/wire-golden-capture.ts
 */

import { HandoffManifest, asSessionId } from '@podium/model'
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

  // POD-1153's compatibility acceptance, made EXECUTABLE rather than documented.
  // "keep a v1 fixture in the corpus permanently" is enforced by nothing if the
  // only thing holding it there is a comment: deleting both v1 cases and keeping
  // the v2 one leaves every other test in this file green, and the corpus would
  // then pin only the format nobody has on disk. So the presence of a
  // `format: 1` manifest fixture is itself asserted.
  it('still carries a format 1 manifest fixture, which is the proof old bundles open', () => {
    const v1 = WIRE_FIXTURES.filter(
      (f) => (f.value as { format?: unknown } | null)?.format === 1 && f.name.startsWith('handoffManifest'),
    )
    expect(v1.map((f) => f.name)).toEqual(['handoffManifest.full', 'handoffManifest.minimal'])
    // And their bytes are in the golden — a fixture present but unpinned proves
    // nothing about the encoding.
    for (const f of v1) expect(golden[f.name as keyof typeof golden]).toContain('"format":1')
    // The counterfactual: the corpus also carries the NEW format, so "v1 is
    // present" is not merely "nothing has changed here yet".
    expect(Object.keys(golden)).toContain('handoffManifest.v2')
    expect(golden['handoffManifest.v2' as keyof typeof golden]).toContain('"format":2')
  })

  // Refinements are wire behaviour too: the manifest's containment check must
  // survive the move to @podium/model, not just its field list.
  it('still rejects worktree locations that escape the repository', () => {
    const base = {
      format: 1 as const,
      sessionId: asSessionId('sess-1'),
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
