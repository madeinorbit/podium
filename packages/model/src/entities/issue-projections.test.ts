import { describe, expect, it } from 'vitest'
import {
  EpicStatus,
  IssueGraph,
  IssueGraphNode,
  IssueWire,
  LintFinding,
  OrphanIssue,
} from '../index'

/**
 * KEY-ORDER PINS for the issue read projections that POD-367 re-derived from
 * `IssueWireCore` instead of restating.
 *
 * Why order and not just the field set: zod emits keys in SHAPE order, so a
 * projection assembled by APPENDING a picked group rather than splicing it at
 * its historical position changes the encoded JSON while the field set stays
 * identical. `wire-golden.json` pins the frame families, but these five ride
 * tRPC results rather than frames and are covered by NO golden fixture — so
 * without this file the composition had no instrument at all, and a green suite
 * would have meant only that nothing was looking.
 *
 * The expected arrays below were captured from the schemas BEFORE the
 * composition and are unchanged after it.
 */
describe('composed issue projections emit their historical key order', () => {
  it('IssueGraphNode', () => {
    expect(Object.keys(IssueGraphNode.shape)).toStrictEqual([
      'id',
      'seq',
      'title',
      'stage',
      'priority',
      'type',
      'ready',
      'blocked',
    ])
  })

  it('OrphanIssue', () => {
    expect(Object.keys(OrphanIssue.shape)).toStrictEqual(['id', 'seq', 'title', 'ref'])
  })

  it('EpicStatus', () => {
    expect(Object.keys(EpicStatus.shape)).toStrictEqual([
      'id',
      'childCount',
      'childDoneCount',
      'complete',
    ])
  })

  it('LintFinding', () => {
    expect(Object.keys(LintFinding.shape)).toStrictEqual(['id', 'seq', 'findings'])
  })
})

describe('composed issue projections inherit their constraints from IssueWire', () => {
  /**
   * The point of the composition: a projection cannot drift from the aggregate's
   * own definition of a field. Each case feeds a value the AGGREGATE rejects and
   * asserts the projection rejects it too — a restated `z.number()` would accept
   * the non-integer seq, and a restated `z.string()` id would accept a bare one.
   */
  it('rejects a non-integer seq, because IssueWire constrains seq to an int', () => {
    expect(IssueWire.shape.seq.safeParse(1.5).success).toBe(false)
    for (const s of [IssueGraphNode, OrphanIssue, LintFinding]) {
      expect(s.shape.seq.safeParse(1.5).success).toBe(false)
      expect(s.shape.seq.safeParse(7).success).toBe(true)
    }
  })

  it('rejects a stage outside the aggregate vocabulary', () => {
    expect(IssueGraphNode.shape.stage.safeParse('not-a-stage').success).toBe(false)
    expect(IssueGraphNode.shape.stage.safeParse('backlog').success).toBe(true)
  })

  it('carries the aggregate id field, so a graph node id parses like an issue id', () => {
    expect(IssueGraphNode.shape.id.safeParse('iss_abc').success).toBe(true)
    expect(OrphanIssue.shape.id.safeParse('iss_abc').success).toBe(true)
    expect(EpicStatus.shape.id.safeParse('iss_abc').success).toBe(true)
  })
})

describe('the graph projection keeps BOTH cross-boundary edge answers open', () => {
  /**
   * docs/multi-user-readiness.md §3.1.2 leaves the choice between hiding an edge
   * to an invisible issue and showing an opaque reference OPEN, handed to POD-290.
   * These two tests assert the projection precludes NEITHER — they are the
   * evidence for that acceptance criterion, not a decision about it.
   */
  it('hide-the-edge needs no new shape: a graph with the node and its edges omitted parses', () => {
    // Two nodes and an edge between them; then the same graph with one node and
    // the edge suppressed. Both are valid IssueGraph values, so the authority can
    // hide an edge by omission without a second projection function.
    const visible = { id: 'iss_a', seq: 1, title: 'A', stage: 'backlog', priority: 2, type: 'task', ready: true, blocked: false }
    const invisible = { ...visible, id: 'iss_b', seq: 2, title: 'B' }
    expect(
      IssueGraph.safeParse({
        nodes: [visible, invisible],
        edges: [{ from: 'iss_a', to: 'iss_b', type: 'blocks' }],
      }).success,
    ).toBe(true)
    expect(IssueGraph.safeParse({ nodes: [visible], edges: [] }).success).toBe(true)
  })

  it('an edge may name an id absent from nodes — no referential integrity is enforced', () => {
    // THIS is what keeps the opaque-reference answer available: the projection does
    // NOT require that every edge endpoint appear in `nodes`. So the authority can
    // emit "blocked by an issue you cannot see" as an edge whose target it withheld,
    // without inventing a second projection function.
    //
    // Mutation-testable: add a cross-field refinement enforcing integrity and this
    // reds. (The earlier version of this test asserted
    // `Object.keys(IssueGraphNode.pick({id:true}).shape) === ['id']`, which is a
    // fact about zod's `pick` rather than about this schema — no product change
    // could red it. Replaced rather than supplemented, so the vacuous claim does
    // not survive wearing the old name.)
    const visible = { id: 'iss_a', seq: 1, title: 'A', stage: 'backlog', priority: 2, type: 'task', ready: true, blocked: false }
    expect(
      IssueGraph.safeParse({
        nodes: [visible],
        edges: [{ from: 'iss_a', to: 'iss_withheld', type: 'blocks' }],
      }).success,
    ).toBe(true)
  })

  it('the projection stays a plain object schema, so it CAN be narrowed', () => {
    // The narrowing an opaque reference uses (`IssueGraphNode.pick({id:true})`)
    // only exists while IssueGraphNode is a plain ZodObject. Wrapping it in a
    // cross-field refinement makes it a ZodEffects, which has no `.pick` — at
    // which point expressing an opaque node WOULD need a second, separately
    // written projection, which is what the criterion forbids.
    expect(typeof (IssueGraphNode as { pick?: unknown }).pick).toBe('function')
    expect(IssueGraphNode.pick({ id: true }).safeParse({ id: 'iss_withheld' }).success).toBe(true)
  })
})
