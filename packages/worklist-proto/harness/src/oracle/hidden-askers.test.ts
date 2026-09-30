/**
 * POD-4549 (L1d) — unit cases for the bubbling rule on the oracle projection:
 * an ask bubbles through the VISIBLE formal subtree only (spec R-SUM).
 *
 * Each case cuts the 1x corpus down to a few issues (a hidden asker's root and
 * child, plus what the case adds) so the root's `asking` has one possible
 * source. Real corpus rows, not hand-written wire rows, so the legacy
 * derivation reads exactly the shapes the fixture feeds the arms.
 *
 * ARMED. The planted formal-subtree rule (`plantFormalSubtreeBubbling`) turns
 * the same roots amber, and un-hiding the child makes the oracle itself turn
 * them amber: the check can fail, and the case is edged rather than vacuous.
 */
import { describe, expect, it } from 'vitest'
import type { SliceLocals } from '@podium/client-graph/shared/slice-types'
import { buildCorpus, type EdgedAsker, FIXED_NOW, type FixtureCorpus } from '../fixture/index'
import { plantFormalSubtreeBubbling, rootsAskingOverHiddenAskers } from './hidden-askers'
import { expectedSnapshot } from './index'

const LOCALS: SliceLocals = { selectedIssueId: null, coarseNow: FIXED_NOW }
const corpus = buildCorpus(1, 4443)

type Row = { id: unknown; archived?: unknown; stage?: unknown }

function issueOf(id: string) {
  return corpus.issues.find((issue) => issue.id === id)!
}

function askerWhere(hidden: (child: ReturnType<typeof issueOf>) => boolean): EdgedAsker {
  return corpus.edgedAskers.find((asker) => hidden(issueOf(asker.childId)))!
}

const archivedAsker = askerWhere((child) => child.archived === true)
const proposedAsker = askerWhere((child) => !child.archived && child.stage === 'proposed')

/** The corpus with only `askers`' roots and children, and their own sessions. */
function isolate(askers: EdgedAsker[]): FixtureCorpus {
  const ids = new Set(askers.flatMap((asker) => [asker.rootId, asker.childId]))
  const keep = <T extends Row>(rows: T[]): T[] => rows.filter((row) => ids.has(row.id as string))
  return {
    ...corpus,
    issues: keep(corpus.issues),
    issueProjections: keep(corpus.issueProjections),
    sessions: corpus.sessions.filter((s) => s.issueId != null && ids.has(s.issueId)),
    issueDeps: [],
    edgedAskers: askers,
  }
}

/** `rows` with `id` rewritten by `patch` (wire and projection spellings alike). */
function patchRows<T extends Row>(rows: T[], id: string, patch: Record<string, unknown>): T[] {
  return rows.map((row) => (row.id === id ? ({ ...row, ...patch } as T) : row))
}

describe('an ask on a hidden child does not reach its visible root', () => {
  for (const [label, asker] of [
    ['archived', archivedAsker],
    ['proposed', proposedAsker],
  ] as const) {
    it(`${label} child: no row, and the root reads quiet`, () => {
      expect(asker, `the fixture carries a ${label} asker`).toBeDefined()
      const cut = isolate([asker])
      const snapshot = expectedSnapshot(cut, LOCALS)
      expect(Object.keys(snapshot.rowsById)).toEqual([asker.rootId])
      expect(snapshot.rowsById[asker.rootId]!.asking).toBe(false)
      expect(snapshot.rowsById[asker.rootId]!.phase).not.toBe('waiting')
      expect(rootsAskingOverHiddenAskers(cut, snapshot)).toEqual([])
    })

    it(`${label} child, control: the planted formal-subtree rule makes the root ask`, () => {
      const cut = isolate([asker])
      const planted = plantFormalSubtreeBubbling(cut, expectedSnapshot(cut, LOCALS))
      expect(rootsAskingOverHiddenAskers(cut, planted)).toEqual([asker.rootId])
    })

    it(`${label} child, control: un-hiding the child makes the oracle root ask`, () => {
      const cut = isolate([asker])
      const shown = { archived: false, stage: 'in_progress' }
      const snapshot = expectedSnapshot(
        {
          ...cut,
          issues: patchRows(cut.issues, asker.childId, shown),
          issueProjections: patchRows(cut.issueProjections, asker.childId, shown),
        },
        LOCALS,
      )
      expect(snapshot.rowsById[asker.childId]?.asking).toBe(true)
      expect(snapshot.rowsById[asker.rootId]!.asking).toBe(true)
    })
  }
})

describe('a visible grandchild under a hidden child still reaches the root', () => {
  // Hiding detaches the hidden issue's OWN sessions, not its visible
  // descendants: nesting walks past a rowless parent to the nearest visible
  // ancestor (rows.ts:275-284). A rule that prunes the whole hidden branch
  // would leave this root quiet.
  it('the root reads asking through the rowless archived child', () => {
    const cut = isolate([archivedAsker])
    const grandchildId = 'iss_4549_grandchild'
    const seq = Math.max(...corpus.issues.map((issue) => issue.seq)) + 1
    const grandchild = {
      id: grandchildId,
      seq,
      archived: false,
      stage: 'in_progress',
      parentId: archivedAsker.childId,
    }
    const clone = <T extends Row>(rows: T[]): T[] => [
      ...rows,
      { ...rows.find((row) => row.id === archivedAsker.childId)!, ...grandchild } as T,
    ]
    const snapshot = expectedSnapshot(
      {
        ...cut,
        issues: clone(cut.issues),
        issueProjections: clone(cut.issueProjections),
        // The asking session moves from the hidden child to the grandchild,
        // so the grandchild is the only possible source of the root's ask.
        sessions: cut.sessions.map((s) =>
          s.sessionId === archivedAsker.sessionId
            ? ({ ...s, issueId: grandchildId } as typeof s)
            : s,
        ),
      },
      LOCALS,
    )
    expect(snapshot.rowsById[archivedAsker.childId]).toBeUndefined()
    expect(snapshot.rowsById[grandchildId]?.asking).toBe(true)
    expect(snapshot.rowsById[archivedAsker.rootId]!.asking).toBe(true)
  })
})
