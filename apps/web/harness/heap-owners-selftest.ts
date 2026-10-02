/** POD-5133: heap-owners.ts on a hand-built snapshot with known answers.
 *   bun apps/web/harness/heap-owners-selftest.ts   (exit 1 on any mismatch)
 * Proves: weak edges and the owner holder never retain; the snapshot is
 * parsed across arbitrary chunk boundaries (strings with escapes included);
 * dominator ownership; removal cuts by handle, MobX class, property set and
 * site; the row-copy census; and MobX debug names claimed apart. */
import { analyze, type Meta, SnapshotParser } from './heap-owners'

const nodeTypes = [
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
  'concatenated string',
  'sliced string',
  'symbol',
  'bigint',
  'object shape',
]
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']
const strings: string[] = []
const str = (s: string) => {
  const i = strings.indexOf(s)
  return i >= 0 ? i : strings.push(s) - 1
}
type Node = { type: string; name: string; size: number; edges: [string, string, string][] }
const graph: Record<string, Node> = {}
const node = (
  key: string,
  type: string,
  name: string,
  size: number,
  edges: [string, string, string][] = [],
) => {
  graph[key] = { type, name, size, edges }
}
// [edge type, edge name, target key]
node('root', 'synthetic', '', 0, [
  ['shortcut', '1', 'window'],
  ['element', '1', 'gcroots'],
])
node('gcroots', 'synthetic', '(GC roots)', 0)
node('window', 'object', 'Window', 10, [
  ['property', 'a', 'A'],
  ['property', 'c', 'C'],
  ['weak', 'w', 'W'],
  ['property', 'holder', 'H'],
  ['property', 'row', 'R'],
  ['property', 'mobx', 'M'],
])
node('A', 'object', 'Owned', 100, [
  ['property', 'b', 'B'],
  ['property', 'c2', 'C'],
])
node('B', 'object', 'Child', 50)
node('C', 'object', 'Shared', 30)
node('W', 'object', 'WeakOnly', 1000)
node('H', 'object', 'Pod5133OwnerHolder', 8, [
  ['property', 'pool', 'A'],
  ['property', 'onlyHeld', 'X'],
])
node('X', 'object', 'OnlyViaHolder', 500)
node('R', 'object', 'Object', 40, [
  ['property', 'id', 'idstr'],
  ['property', 'title', 'titlestr'],
])
node('idstr', 'string', 'i1', 16)
node('titlestr', 'string', 'Line "one"\n\\ two', 24)
node('M', 'object', 'ObservableValue', 60, [
  ['property', 'name_', 'N'],
  ['property', 'observers_', 'S'],
])
node('N', 'concatenated string', '', 20, [
  ['internal', 'first', 'N1'],
  ['internal', 'second', 'N2'],
])
node('N1', 'string', 'IssueModel@i1', 32)
node('N2', 'string', '.presence', 28)
node('S', 'object', 'Set', 16, [['internal', 'table', 'T']])
node('T', 'array', '', 64)

const keys = Object.keys(graph)
const fields = ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness']
const nodes: number[] = [],
  edges: number[] = []
keys.forEach((key, i) => {
  const n = graph[key]!
  nodes.push(nodeTypes.indexOf(n.type), str(n.name), i * 2 + 1, n.size, n.edges.length, 0)
  for (const [type, name, to] of n.edges)
    edges.push(
      edgeTypes.indexOf(type),
      type === 'element' ? Number(name) : str(name),
      keys.indexOf(to) * fields.length,
    )
})
const json = JSON.stringify({
  snapshot: {
    meta: {
      node_fields: fields,
      node_types: [nodeTypes],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [edgeTypes],
      location_fields: ['object_index', 'script_id', 'script_object_index', 'line', 'column'],
    },
    node_count: keys.length,
    edge_count: edges.length / 3,
  },
  nodes,
  edges,
  trace_function_infos: [],
  trace_tree: [],
  samples: [],
  locations: [],
  strings,
})

const failures: string[] = []
let checks = 0
const expect = (label: string, actual: unknown, wanted: unknown) => {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(wanted)}`)
}
for (const chunk of [7, 13, 4096]) {
  const parser = new SnapshotParser()
  for (let i = 0; i < json.length; i += chunk) parser.push(json.slice(i, i + chunk))
  const parsed = parser.finish()
  expect(`chunk ${chunk}: strings`, parsed.strings, strings)
  expect(`chunk ${chunk}: nodes`, [...parsed.nodes], nodes)
}
const parser = new SnapshotParser()
parser.push(json)
const meta: Meta = {
  ids: { issue: ['i1'], session: [] },
  censusFloor: 1,
  siteFloorBytes: 1,
  groups: {
    owner: { handles: ['pool'] },
    mobx: { mobx: true },
    props: { props: [['id', 'title']] },
    notProps: { props: [['id', '!title']] },
    names: { sites: '^\\(MobX debug names\\)$' },
  },
}
const result = analyze(parser.finish(), meta)
// Live: everything but W (weak only) and X (only via the ignored holder).
const live = 10 + 100 + 50 + 30 + 8 + 40 + 16 + 24 + 60 + 20 + 32 + 28 + 16 + 64
expect('live bytes', result.totals.liveBytes, live)
expect('owners resolved', result.owners.resolved, 2)
const pool = result.partition.find((p) => p.name === 'pool')!
expect('pool owns A and B only (C is shared with the window)', pool.ownBytes, 150)
const cut = (group: string) => result.counterfactuals.find((c) => c.group === group)!.freedBytes
expect('cut pool frees A and B', cut('owner'), 150)
expect('cut MobX frees M with its set and name', cut('mobx'), 60 + 16 + 64 + 20 + 32 + 28)
expect('cut by property set frees the row and its strings', cut('props'), 40 + 16 + 24)
expect('an absent-property rule excludes the row', cut('notProps'), 0)
expect('debug names are claimed apart', cut('names'), 20 + 32 + 28)
expect(
  'census finds the one issue row copy',
  result.rowCopies.map((r) => [r.kind, r.count, r.propertyNames]),
  [['issue', 1, 'id,title']],
)
expect(
  'MobX site named from its flattened debug name',
  result.sites.some((s) => s.key === 'ObservableValue IssueModel@*.presence'),
  true,
)
if (failures.length) {
  console.error(`heap-owners self-test RED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`heap-owners self-test green: ${checks} checks`)
