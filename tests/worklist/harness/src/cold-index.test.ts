import { referenceState } from '../../diagnostics/reference-state'
/**
 * POD-5405 — the row source's cold index (`client-graph/src/shared/cold-index.ts`)
 * equals the rule over whole rows, at 1x and 4x and along generated change
 * sequences.
 *
 * The reference is the gate's own partition: `coldByRule` through
 * `tableColdContext` over the feed's CURRENT `snapshot(kind)` tables at the
 * engine's clock. That is the same reference `cold-rule.test.ts` holds both
 * pools to. Per comparison, every issue and session is checked one by one
 * (`coldByRule`), the resident set is checked whole (`residentCandidates`,
 * the attach question), and so are the counts.
 *
 * - Corpus cells: the fence corpus at 1x and 4x, at the engine clock and at
 *   later clocks (a day, a month, a year), then a rewind to the start.
 *   Deadlines only pass, so later clocks cool rows; the rewind exercises the
 *   index's re-file path.
 * - Sequences: the gate's generator (every change kind, a reload included)
 *   on the 1x generator corpus. The index lives in the feed and follows its
 *   publications; a reload rebinds the feed, so the next comparison reads
 *   the new feed's index. Compared after EVERY step.
 *
 * The scan of whole tables per comparison is the reference's cost, not the
 * index's. Planted faults (source mutations, restored after each run) are
 * recorded on POD-5405.
 */
import { describe, expect, it } from 'vitest'
import type { ColdQueries } from '@podium/client-graph/shared/cold-index'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '@podium/client-graph/shared/schema'
import { createRowSource } from '../../shared/src/row-source'
import type { RowSource } from '@podium/client-graph/shared/source'
import { gen, genCorpus } from '../../shared/src/gen/changes'
import { startGenRun } from '../../shared/src/gen/run'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { writeResult } from './results'

const DAY = 24 * 60 * 60 * 1000
const STEPS = Number(process.env['POD_COLD_INDEX_STEPS'] ?? 150)
const SEEDS = Number(process.env['POD_COLD_INDEX_SEEDS'] ?? 3)

type Kind = 'issue' | 'session' | 'worktree'

/** Every disagreement between the index and the rule over whole rows, at `now`. */
function differences(source: RowSource, cold: ColdQueries, now: number, label: string): string[] {
  const tables = new Map<Kind, Map<string, unknown>>()
  for (const kind of ['issue', 'session', 'worktree'] as const) {
    tables.set(
      kind,
      new Map(source.snapshot(kind).filter((r) => r.value !== undefined).map((r) => [r.id, r.value])),
    )
  }
  const ctx = tableColdContext(SCHEMA, (entity: EntityName) => tables.get(entity as Kind), now)
  const out: string[] = []
  const say = (line: string) => {
    if (out.length < 10) out.push(`${label}: ${line}`)
  }
  for (const entity of ['issue', 'session'] as const) {
    const rows = tables.get(entity)!
    const resident = new Set<string>()
    for (const [id, row] of rows) {
      const expected = coldByRule(SCHEMA, entity, row as object, ctx)
      if (!expected) resident.add(id)
      if (cold.coldByRule(entity, id, now) !== expected) say(`${entity}:${id} cold=${!expected} expected=${expected}`)
    }
    const answered = cold.residentCandidates(entity, now)
    const got = new Set(answered)
    if (got.size !== answered.length) say(`${entity} residentCandidates repeats an id`)
    for (const id of resident) if (!got.has(id)) say(`${entity}:${id} missing from residentCandidates`)
    for (const id of got) if (!resident.has(id)) say(`${entity}:${id} wrongly in residentCandidates`)
    if (cold.count(entity) !== rows.size) say(`${entity} count ${cold.count(entity)} expected ${rows.size}`)
  }
  return out
}

describe('cold index equals the rule over whole rows (POD-5405)', () => {
  it.each([1, 4] as const)('fence corpus at %ix, across clocks and a rewind', async (scale) => {
    const ctx = await startScenarioEngine(scale)
    const feed = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
    try {
      const raw = feed.source
      const cold = raw.cold!()
      const start = referenceState(ctx.engine).coarseNow
      const cells: Record<string, unknown>[] = []
      for (const [label, now] of [
        ['now', start],
        ['+1d', start + DAY],
        ['+30d', start + 30 * DAY],
        ['+365d', start + 365 * DAY],
        ['rewind', start],
      ] as const) {
        expect(differences(raw, cold, now, `${scale}x ${label}`)).toEqual([])
        cells.push({
          label,
          resident: {
            issue: cold.residentCandidates('issue', now).length,
            session: cold.residentCandidates('session', now).length,
          },
          known: { issue: cold.count('issue'), session: cold.count('session') },
        })
      }
      // The cell is useful only if the rule leaves most rows cold.
      expect((cells[0]!['resident'] as { issue: number }).issue).toBeLessThan(cold.count('issue'))
      writeResult(`cold-index-${scale}x`, { scale, cells })
    } finally {
      feed.dispose()
      ctx.dispose()
    }
  }, 900_000)

  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))('generated sequence, seed %i, every step', async (seed) => {
    const run = await startGenRun({ corpus: genCorpus(1), feedMode: 'pooled' })
    try {
      const sequence = gen(seed, STEPS)
      const now = () => referenceState(run.ctx.engine).coarseNow
      expect(differences(run.feed().source, run.feed().source.cold!(), now(), `seed ${seed} bootstrap`)).toEqual([])
      let compared = 0
      for (const change of sequence) {
        const step = await run.apply(change)
        const source = run.feed().source
        const found = differences(source, source.cold!(), now(), `seed ${seed} step ${step.index} ${change.kind}`)
        expect(found).toEqual([])
        compared += 1
      }
      expect(compared).toBe(STEPS)
    } finally {
      run.dispose()
    }
  }, 900_000)
})
