import { expect, it } from 'vitest'
import {
  DOT_CLEARANCE,
  dependencyDrawing,
  dependencyEdges,
  dependencyHook,
  dependencyPoint,
  FAN_IN,
} from './flight-deck-full-edges'

it.each([0.75, 1, 1.25, 2])('normalizes translated rects to layout pixels at zoom %s', (scale) => {
  expect(
    dependencyPoint(
      { right: 80 + 900 * scale, top: 40 + 64 * scale, height: 32 * scale },
      { left: 80, top: 40 },
      scale,
    ),
  ).toEqual({ right: 900, y: 80 })
})

it('paints stored dependent -> dependency links with the dot at dependency and arrow at dependent', () => {
  const points = new Map([
    ['dependency', { right: 900, y: 80 }],
    ['dependent', { right: 900, y: 160 }],
  ])
  const [edge] = dependencyEdges(
    [{ dependentId: 'dependent', dependencyId: 'dependency' }],
    points,
    true,
    null,
  )
  expect(edge).toMatchObject({
    sourceY: 80,
    targetY: 160,
    x: 903,
    highlighted: false,
    path: 'M903 80 C912 80, 912 160, 903 160',
    // Aimed along the curve's last 6px (down and left), not flat: a flat
    // arrowhead laid one arm across the line coming in from above.
    arrow: 'M902.8 155 L903 160 L907.7 158.4',
  })
  // A dependency below its dependent reverses only y, never the semantics.
  expect(dependencyHook(points.get('dependent')!, points.get('dependency')!, 0)).toMatchObject({
    sourceY: 160,
    targetY: 80,
    arrow: 'M907.7 81.6 L903 80 L902.8 85',
  })
})

it('merges three or more arriving lines into one arrowhead along their average direction', () => {
  const points = new Map([
    ['a', { right: 900, y: 0 }],
    ['b', { right: 900, y: 40 }],
    ['c', { right: 900, y: 80 }],
    ['target', { right: 900, y: 160 }],
    ['pair-1', { right: 900, y: 200 }],
    ['pair-2', { right: 900, y: 240 }],
    ['pair-target', { right: 900, y: 280 }],
  ])
  const links = [
    { dependentId: 'target', dependencyId: 'a' },
    { dependentId: 'target', dependencyId: 'b' },
    { dependentId: 'target', dependencyId: 'c' },
    { dependentId: 'pair-target', dependencyId: 'pair-1' },
    { dependentId: 'pair-target', dependencyId: 'pair-2' },
  ]
  expect(FAN_IN).toBe(3)
  const { edges, heads } = dependencyDrawing(links, points, true, null)
  const fan = edges.filter((e) => e.dependentId === 'target')
  // No line carries its own head; one shared head is drawn for the row.
  expect(fan.map((e) => e.arrow)).toEqual(['', '', ''])
  expect(heads.map((h) => h.dependentId)).toEqual(['target'])
  // All three end on the same tip, and their last control points lie on one
  // ray behind it: they meet the tip along one tangent and blend.
  const ends = fan.map((e) => e.curve[3])
  expect(new Set(ends.map((p) => `${p.x},${p.y}`)).size).toBe(1)
  const tip = ends[0]!
  expect(tip).toEqual({ x: 903, y: 160 })
  const bends = fan.map((e) => e.curve[2])
  expect(new Set(bends.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size).toBe(1)
  // The head points along that same tangent: down and to the left, since
  // every line comes from above.
  const bend = bends[0]!
  const d = { x: tip.x - bend.x, y: tip.y - bend.y }
  expect(d.x).toBeLessThan(0)
  expect(d.y).toBeGreaterThan(0)
  expect(heads[0]!.arrow).toContain(`L903 160 L`)
  // Two arriving lines keep their own heads.
  expect(edges.filter((e) => e.dependentId === 'pair-target').every((e) => e.arrow !== '')).toBe(
    true,
  )
  // The shared head lights with any of its lines.
  const lit = dependencyDrawing(links, points, true, 'b')
  expect(lit.heads[0]!.highlighted).toBe(true)
  expect(lit.edges.filter((e) => e.highlighted).map((e) => e.dependencyId)).toEqual(['b'])
})

it('stops an arrow just short of the start dot on a row that also starts a link', () => {
  const points = new Map([
    ['a', { right: 900, y: 0 }],
    ['b', { right: 900, y: 40 }],
    ['c', { right: 900, y: 80 }],
  ])
  const [ab, bc] = dependencyEdges(
    [
      { dependentId: 'b', dependencyId: 'a' },
      { dependentId: 'c', dependencyId: 'b' },
    ],
    points,
    true,
    null,
  )
  // b draws a start dot at (903, 40); a's arrow into b ends 3.5px short of it.
  const tip = (arrow: string) => arrow.split(' L')[1]!.split(' ').map(Number)
  const [bx, by] = tip(ab!.arrow)
  expect(Math.hypot(bx! - 903, by! - 40)).toBeCloseTo(DOT_CLEARANCE, 0)
  expect(ab!.path.endsWith(`${bx} ${by}`)).toBe(true)
  // c starts nothing, so b's arrow still reaches its row.
  expect(tip(bc!.arrow)).toEqual([903, 80])
})

it('staggers hooks 9/14/19px inside the reserved 28px gutter, starting 3px past the row even at different depths', () => {
  const source = { right: 860, y: 0 },
    target = { right: 900, y: 100 }
  expect([0, 1, 2, 3].map((i) => dependencyHook(source, target, i).hook)).toEqual([9, 14, 19, 9])
  expect(dependencyHook(source, target, 2)).toMatchObject({
    x: 903,
    path: 'M903 0 C922 0, 922 100, 903 100',
  })
})

it('requires both actual endpoints and below 860 shows only direct incoming/outgoing edges', () => {
  const links = [
    { dependentId: 'b', dependencyId: 'a' },
    { dependentId: 'c', dependencyId: 'b' },
    { dependentId: 'd', dependencyId: 'c' },
    { dependentId: 'b', dependencyId: 'external' },
  ]
  const points = new Map(['a', 'b', 'c', 'd'].map((id, i) => [id, { right: 900, y: i * 40 }]))
  expect(dependencyEdges(links, points, false, null)).toEqual([])
  expect(
    dependencyEdges(links, points, false, 'b').map((e) => [
      e.dependencyId,
      e.dependentId,
      e.highlighted,
    ]),
  ).toEqual([
    ['a', 'b', true],
    ['b', 'c', true],
  ])
  points.delete('c')
  expect(dependencyEdges(links, points, true, null)).toHaveLength(1)
})
