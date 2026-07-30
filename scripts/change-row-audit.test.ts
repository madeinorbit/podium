/**
 * THE DETECTOR ITSELF — planted violations, one per syntax form.
 *
 * An instrument must say YES before its NO means anything. POD-1168's finding is
 * the reason this file is long: `instancePartitions` covered ONE spelling of its
 * concept (a key on an entity-shaped declaration) and missed another (a column on
 * a physical drizzle table, written as a call expression), and its probe kept
 * passing the whole time. So the concept here — "a change-row field list, written
 * out instead of composed" — is enumerated by SPELLING, and every spelling is
 * planted below and required to fire.
 *
 * The positive control at the bottom is not synthetic: it is verbatim text from
 * `packages/protocol/src/messages/sync.ts` as it stood before POD-305 composed
 * it, so the detector stays calibrated against the real debt it was redefined to
 * see rather than only against shapes invented to make it pass.
 *
 * The DECLARATION-versus-CONSTRUCTION block is the other half of the calibration.
 * Without it this detector counted 76 sites repo-wide, nearly all of them callers
 * building a change spec — uses of the shared type, which there are supposed to be
 * many of. A ratchet that counts uses cannot be driven to zero.
 */

import { describe, expect, it } from 'vitest'
import {
  CHANGE_ROW_KEYS,
  CHANGE_ROW_THRESHOLD,
  changeRowRestatements,
  isChangeRowRestatement,
  keyBlocks,
  literalFieldLists,
} from './change-row-audit'
import type { AuditContext } from './rearch-audit'

/** How many restatements does the detector see in this source? */
const count = (source: string): number => {
  const blocks = keyBlocks(source).filter(isChangeRowRestatement).length
  const literals = literalFieldLists(source).filter((l) => {
    if (!l.keys.has('op')) return false
    return (
      [...l.keys].filter((k) => k !== 'op' && CHANGE_ROW_KEYS.has(k)).length >=
      CHANGE_ROW_THRESHOLD
    )
  }).length
  return blocks + literals
}

// ---------------------------------------------------------------------------
// The vocabulary is the MODEL's, not this file's
// ---------------------------------------------------------------------------

describe('the vocabulary', () => {
  it('is not empty', () => {
    // A broken import would make every count below a serene zero.
    expect(CHANGE_ROW_KEYS.size).toBeGreaterThan(5)
  })

  it('carries both spellings of the target-id key', () => {
    // The wire says `id`, storage says `entityId`. A detector that knew only one
    // would score every restatement on the other side one key too low, which is
    // how a threshold silently stops being met.
    expect(CHANGE_ROW_KEYS.has('id')).toBe(true)
    expect(CHANGE_ROW_KEYS.has('entityId')).toBe(true)
  })

  it('carries the ADR 2 D8 provenance triple, read from the model', () => {
    for (const key of ['originId', 'causationId', 'mutationId']) {
      expect(CHANGE_ROW_KEYS.has(key)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// EVERY SPELLING OF THE CONCEPT — each one planted, each one required to fire
// ---------------------------------------------------------------------------

describe('the detector fires on every spelling of a restatement', () => {
  it('a zod object literal', () => {
    expect(
      count(`export const Row = z.object({
        seq: z.number(),
        entity: z.literal('session'),
        id: z.string(),
        op: MetadataChangeOp,
        value: SessionMeta.optional(),
      })`),
    ).toBe(1)
  })

  it('a plain object TYPE literal', () => {
    expect(
      count("let row: { seq: number; entity: string; entityId: string; op: string }"),
    ).toBe(1)
  })

  it('an interface body', () => {
    expect(
      count(`export interface StoredChangeRow {
        seq: number
        entity: string
        entityId: string
        op: 'upsert' | 'remove'
        payload: string | null
      }`),
    ).toBe(1)
  })

  it('a type alias body, including optional members', () => {
    expect(
      count(`type Delta = {
        seq: number
        entity: string
        op?: 'upsert' | 'remove'
        payload?: unknown
      }`),
    ).toBe(1)
  })

  it('a drizzle table — a CALL EXPRESSION, the form POD-1168 caught missing', () => {
    // The one that motivated enumerating spellings at all. This is a physical
    // table, not a type, and its field list is just as much a restatement.
    expect(
      count(`export const changes = sqliteTable("changes", {
        seq: integer().primaryKey({ autoIncrement: true }),
        entity: text().notNull(),
        entityId: text("entity_id").notNull(),
        op: text().notNull(),
        payload: text(),
      })`),
    ).toBe(1)
  })

  it('a Pick<> naming the fields as string literals', () => {
    expect(count("type Narrow = Pick<ChangeRow, 'seq' | 'entity' | 'op' | 'payload'>")).toBe(1)
  })

  it('an Omit<> naming the fields as string literals', () => {
    expect(count("type Narrow = Omit<Full, 'seq' | 'entityId' | 'op' | 'payload'>")).toBe(1)
  })

  it('an `as const` array of field names', () => {
    expect(count("const KEYS = ['seq', 'entity', 'op', 'payload'] as const")).toBe(1)
  })

  it('a nested block — the inner shape is scored, not folded into its parent', () => {
    // If nested keys were attributed to the parent, `geometry` below would lend
    // the OUTER block two extra keys and score a false positive there instead.
    expect(
      count(`interface Outer {
        geometry: { cols: number; rows: number }
        row: { seq: number; entity: string; op: 'upsert' | 'remove' }
      }`),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// DECLARATION versus CONSTRUCTION — the line that keeps the item actionable
// ---------------------------------------------------------------------------

describe('a construction site is a USE of the type, not a restatement', () => {
  // The first cut of this detector counted these and reported 76 sites repo-wide,
  // most of them callers building a spec. A ratchet that counts uses cannot be
  // driven to zero and punishes the callers the shared type exists to serve.

  it('does not fire on a caller building a change spec', () => {
    expect(
      count("const spec = { entity: 'automation', id: automation.id, op: 'upsert', value: wire }"),
    ).toBe(0)
  })

  it('does not fire on a value read from a row', () => {
    expect(count('const c = { seq: r.seq, id: r.entityId, op: r.op, payload: r.payload }')).toBe(0)
  })

  it('does not fire on a CAST construction, even though the cast contains a union', () => {
    // Anchored at the start of the value for exactly this case: the text after
    // `op:` contains `'upsert' | 'remove'`, and it is still a construction.
    expect(
      count("const c = { seq: r.seq, id: r.entityId, op: r.op as 'upsert' | 'remove' }"),
    ).toBe(0)
  })

  it('fires on the same shape written as a DECLARATION', () => {
    // The counterfactual for the three above: same field list, declared. Without
    // this the construction assertions would pass against a detector that had
    // simply stopped matching anything at all.
    expect(
      count("interface C { seq: number; entityId: string; op: 'upsert' | 'remove' }"),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// And it does NOT fire on composition, which is the target state
// ---------------------------------------------------------------------------

describe('the detector leaves composition alone', () => {
  it('does not fire on a factory that composes the shared field schemas', () => {
    // The whole point of the redefinition: one composition site is the goal, and
    // a detector that punished it would push the code back toward restatement.
    // The factory below still has ONE inline field list — it is the composition
    // site — so exactly 1, not 5, is the honest count for five arms built from it.
    const source = `const arm = (entity, value) =>
        z.object({ seq: ChangeSeqField, entity, id: ChangeEntityIdField, op: MetadataChangeOp, value: value.optional() })
      export const Union = z.discriminatedUnion('entity', [
        arm(z.literal('session'), SessionMeta),
        arm(z.literal('issue'), IssueWire),
        arm(z.literal('conversation'), ConversationSummaryWire),
      ])`
    expect(count(source)).toBe(1)
  })

  it('does not fire on a record that has change keys but no `op`', () => {
    // `op` is what makes a record a CHANGE row. Without it this is any other
    // shape that happens to have an entity and a seq, and counting those is how
    // a detector acquires an allowlist longer than itself.
    expect(count("const r = { seq: 1, entity: 'session', entityId: 's1', payload: null }")).toBe(0)
  })

  it('does not fire on an `op` beside fewer than the threshold', () => {
    expect(count("const r = { op: 'upsert', entity: 'session' }")).toBe(0)
  })

  it('does not fire on an unrelated `op` key', () => {
    expect(count("const r = { op: 'add', lhs: 1, rhs: 2 }")).toBe(0)
  })

  it('is not confused by a brace inside a string literal', () => {
    expect(
      count(`interface R { message: "a { brace"; seq: number; entity: string; op: string }`),
    ).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// THE POSITIVE CONTROL — the real debt, read out of git
// ---------------------------------------------------------------------------

describe('calibration against the real pre-POD-305 protocol file', () => {
  /**
   * VERBATIM from `packages/protocol/src/messages/sync.ts` as it stood before
   * POD-305 composed it — three of the five strict arms plus the lenient
   * catch-all, copied rather than paraphrased.
   *
   * Frozen here rather than read out of git on purpose: a test that walks history
   * to find "the last revision without the factory" is an instrument whose answer
   * depends on the repository's shape, and it would go quiet on a shallow clone
   * exactly when nobody was watching. The live before/after measurement is the
   * BASELINE MOVEMENT recorded across this issue's two commits; this is the
   * frozen positive control that keeps the detector calibrated afterwards.
   */
  const PRE_POD305_SYNC_TS = `
export const MetadataChange = z.discriminatedUnion('entity', [
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('session'),
    id: z.string(),
    op: MetadataChangeOp,
    value: SessionMeta.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('issue'),
    id: z.string(),
    op: MetadataChangeOp,
    value: IssueWire.optional(),
  }),
  z.object({
    seq: z.number().int().positive(),
    entity: z.literal('conversation'),
    id: z.string(),
    op: MetadataChangeOp,
    value: ConversationSummaryWire.optional(),
  }),
])
export const UnknownMetadataChange = z.object({
  seq: z.number().int().positive(),
  entity: z.string().refine((e) => !MetadataEntityKind.options.includes(e)),
  id: z.string(),
  op: MetadataChangeOp,
  value: z.unknown().optional(),
})
`

  it('sees every restatement the old name-counting detector was blind to', () => {
    // The old item counted EXPORTED NAMES — two of them across this excerpt —
    // and reported the same number whether these four field lists were written
    // out or composed. This detector sees four, which is what makes deleting
    // them register at all.
    expect(count(PRE_POD305_SYNC_TS)).toBe(4)
  })

  it('sees ONE where the same four arms compose a factory', () => {
    const composed = `
const metadataChangeArm = (entity, value) =>
  z.object({
    seq: ChangeSeqField,
    entity,
    id: ChangeEntityIdField,
    op: MetadataChangeOp,
    value: value.optional(),
  })
export const MetadataChange = z.discriminatedUnion('entity', [
  metadataChangeArm(z.literal('session'), SessionMeta),
  metadataChangeArm(z.literal('issue'), IssueWire),
  metadataChangeArm(z.literal('conversation'), ConversationSummaryWire),
])
export const UnknownMetadataChange = metadataChangeArm(z.string(), z.unknown())
`
    expect(count(composed)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The collector's own plumbing
// ---------------------------------------------------------------------------

describe('changeRowRestatements', () => {
  const ctx = (files: { file: string; stripped: string; isTest?: boolean }[]): AuditContext =>
    ({
      repoRoot: '/repo',
      files: files.map((f) => ({ ...f, isTest: f.isTest ?? false })),
      listDir: () => [],
    }) as unknown as AuditContext

  it('scans apps and packages, and skips tests and everything else', () => {
    const body = 'interface R { seq: number; entity: string; entityId: string; op: string }'
    const sites = changeRowRestatements(
      ctx([
        { file: 'packages/sync/src/a.ts', stripped: body },
        { file: 'apps/server/src/b.ts', stripped: body },
        { file: 'packages/sync/src/c.test.ts', stripped: body, isTest: true },
        { file: 'scripts/d.ts', stripped: body },
      ]),
    )
    expect(sites.map((s) => s.file)).toEqual(['apps/server/src/b.ts', 'packages/sync/src/a.ts'])
  })

  it('reports the line the restatement opened on', () => {
    const sites = changeRowRestatements(
      ctx([
        {
          file: 'packages/sync/src/a.ts',
          stripped:
            '\n\ninterface R {\n  seq: number\n  entity: string\n  op: string\n}\n',
        },
      ]),
    )
    expect(sites).toHaveLength(1)
    expect(sites[0]?.line).toBe(3)
  })
})
