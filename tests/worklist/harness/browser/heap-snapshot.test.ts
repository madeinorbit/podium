// POD-4747: the streaming heap-snapshot reader, over snapshots cut into chunks anywhere.
import { describe, expect, it } from 'vitest'
import { HeapSnapshotReader } from './heap-snapshot'

/** A V8-shaped snapshot: seven node fields, the edges and trace arrays between nodes and strings. */
function snapshot(
  nodes: Array<[type: number, name: number, id: number, size: number]>,
  strings: string[],
): string {
  const meta = {
    node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
    node_types: [
      [
        'hidden',
        'array',
        'string',
        'object',
        'code',
        'closure',
        'regexp',
        'number',
        'native',
        'synthetic',
      ],
      'string',
      'number',
    ],
    edge_fields: ['type', 'name_or_index', 'to_node'],
  }
  const flat = nodes.flatMap(([t, n, id, size]) => [t, n, id, size, 1, 0, 0])
  return (
    `{"snapshot":{"meta":${JSON.stringify(meta)},"node_count":${nodes.length},"edge_count":2,"trace_function_count":0},\n` +
    `"nodes":[${flat.join(',')}],\n"edges":[1,2,7,1,3,14],\n"trace_function_infos":[],\n"trace_tree":[[1,[2]]],\n` +
    `"samples":[],\n"locations":[],\n"strings":[${strings.map((s) => JSON.stringify(s)).join(',\n')}]}`
  )
}

const STRINGS = ['', 'IssueNode', 'Map', 'say "hi"\\ é \n', 'ObservableValue', '(GC roots)']
const TEXT = snapshot(
  [
    [9, 5, 1, 0], // synthetic root: never grouped
    [3, 2, 3, 64], // Map, old
    [3, 1, 5, 120], // IssueNode, old
    [3, 1, 7, 120], // IssueNode, new
    [3, 1, 9, 120], // IssueNode, new
    [3, 4, 11, 32], // ObservableValue, new
    [5, 3, 13, 40], // closure, new
    [2, 3, 15, 1000], // string, new
    [1, 0, 17, 16], // array, new
  ],
  STRINGS,
)

function read(text: string, cuts: number[], newSince?: number) {
  const reader = new HeapSnapshotReader(newSince === undefined ? {} : { newSince })
  let at = 0
  for (const cut of [...cuts, text.length]) {
    reader.push(text.slice(at, cut))
    at = cut
  }
  return reader.finish()
}

describe('HeapSnapshotReader', () => {
  it('sums self sizes by constructor over the nodes created since the previous snapshot', () => {
    const summary = read(TEXT, [], 5)
    expect(summary.nodeCount).toBe(9)
    expect(summary.maxId).toBe(17)
    expect(summary.selfSize).toBe(64 + 120 * 3 + 32 + 40 + 1000 + 16)
    expect(summary.newCount).toBe(6)
    expect(summary.newSelfSize).toBe(120 * 2 + 32 + 40 + 1000 + 16)
    expect(summary.byConstructor).toEqual([
      { name: '(string)', count: 1, selfSize: 1000 },
      { name: 'IssueNode', count: 2, selfSize: 240 },
      { name: '(closure)', count: 1, selfSize: 40 },
      { name: 'ObservableValue', count: 1, selfSize: 32 },
      { name: '(array)', count: 1, selfSize: 16 },
    ])
  })

  it('reads the same summary however the stream is cut (markers, numbers, escapes)', () => {
    const whole = read(TEXT, [])
    for (let step = 1; step <= 13; step += 3) {
      const cuts: number[] = []
      for (let at = step; at < TEXT.length; at += step) cuts.push(at)
      expect(read(TEXT, cuts)).toEqual(whole)
    }
    // Cut inside the escaped string and inside the `"strings":[` marker.
    const inEscape = TEXT.indexOf('\\"hi') + 1
    const inMarker = TEXT.indexOf('"strings":[') + 4
    expect(read(TEXT, [inMarker, inEscape])).toEqual(whole)
  })

  it('refuses a truncated snapshot', () => {
    const reader = new HeapSnapshotReader()
    reader.push(TEXT.slice(0, TEXT.indexOf('"strings":[')))
    expect(() => reader.finish()).toThrow(/truncated/)
  })
})
