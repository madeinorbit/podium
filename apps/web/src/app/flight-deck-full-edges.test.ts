import { expect, it } from 'vitest'
import { dependencyEdges, dependencyHook, dependencyPoint } from './flight-deck-full-edges'

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
    x: 875,
    highlighted: false,
    path: 'M875 80 C884 80, 884 160, 875 160',
    arrow: 'M879 157 L875 160 L879 163',
  })
  // A dependency below its dependent reverses only y, never the semantics.
  expect(dependencyHook(points.get('dependent')!, points.get('dependency')!, 0)).toMatchObject({
    sourceY: 160,
    targetY: 80,
  })
})

it('staggers hooks 9/14/19px inside the reserved 28px gutter even at different depths', () => {
  const source = { right: 860, y: 0 },
    target = { right: 900, y: 100 }
  expect([0, 1, 2, 3].map((i) => dependencyHook(source, target, i).hook)).toEqual([9, 14, 19, 9])
  expect(dependencyHook(source, target, 2)).toMatchObject({
    x: 875,
    path: 'M875 0 C894 0, 894 100, 875 100',
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
