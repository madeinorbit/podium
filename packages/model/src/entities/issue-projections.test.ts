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

  it('opaque-reference is a NARROWING of the same head, not a second projection', () => {
    // The identity-only node an opaque reference needs is a pick of this very
    // projection. If any content member were folded into the identity head, this
    // pick would be impossible without leaking that content — which is why the
    // head is identity-only.
    const opaque = IssueGraphNode.pick({ id: true })
    expect(Object.keys(opaque.shape)).toStrictEqual(['id'])
    expect(opaque.safeParse({ id: 'iss_hidden' }).success).toBe(true)
    // And it carries no content: a title on an opaque node is not part of the shape.
    expect(Object.keys(opaque.shape)).not.toContain('title')
  })
})
