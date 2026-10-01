/** POD-5133 heap-snapshot ownership analyzer (measurement only).
 *
 * Reads a V8 `.heapsnapshot` (plain or gzip) as a stream and answers three
 * questions about one browser arm:
 *
 * 1. OWNERSHIP PARTITION. Named handles (`--meta` owners: name -> heap id)
 *    are barriers. One traversal starts at each handle and one at the GC root;
 *    none crosses into another handle. A live object reached by exactly one
 *    traversal is EXCLUSIVE to that owner; one reached by several is SHARED
 *    and reported by its set of reachers. Exclusive bytes over all owners plus
 *    shared bytes equal the live total, so nothing is double-counted.
 * 2. REMOVAL COUNTERFACTUALS. For each `--groups` entry (owner-name prefixes),
 *    the bytes that become unreachable when every handle in the group is cut:
 *    "what would this owner free". Groups may overlap; these do not add.
 * 3. ROW-COPY CENSUS. Every object with a string `id` property naming a
 *    synthetic issue or session row, grouped by its property-name signature:
 *    how many copies of each row exist and in which shape, with a retainer
 *    path for one sample of each shape.
 *
 * Liveness follows DevTools: weak edges never retain, and shortcut edges
 * retain only from the snapshot root. Sizes are V8 self sizes (shallow). */
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'

class U32 {
  data = new Uint32Array(1 << 20)
  length = 0
  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
  done() {
    return this.data.subarray(0, this.length)
  }
}

export interface ParsedSnapshot {
  meta: {
    node_fields: string[]
    node_types: [string[], ...unknown[]]
    edge_fields: string[]
    edge_types: [string[], ...unknown[]]
    location_fields: string[]
  }
  nodes: Uint32Array
  edges: Uint32Array
  locations: Uint32Array
  strings: string[]
}

/** Incremental parser: header JSON, the two number arrays, then the string table. */
export class SnapshotParser {
  private stage:
    | 'header'
    | 'nodes'
    | 'seekEdges'
    | 'edges'
    | 'seekLocations'
    | 'locations'
    | 'seekStrings'
    | 'strings'
    | 'done' = 'header'
  private text = ''
  private nodes = new U32()
  private edges = new U32()
  private locations = new U32()
  private number = -1
  private strings: string[] = []
  private inString = false
  private escaped = false
  private raw: string[] = []
  private meta: ParsedSnapshot['meta'] | undefined

  push(chunk: string) {
    let at = 0
    while (at < chunk.length && this.stage !== 'done') {
      if (
        this.stage === 'header' ||
        this.stage === 'seekEdges' ||
        this.stage === 'seekLocations' ||
        this.stage === 'seekStrings'
      ) {
        const marker = (
          {
            header: '"nodes":[',
            seekEdges: '"edges":[',
            seekLocations: '"locations":[',
            seekStrings: '"strings":[',
          } as const
        )[this.stage]
        const keep = this.text.length
        this.text += chunk.slice(at)
        const found = this.text.indexOf(marker)
        if (found < 0) {
          // Keep only a marker-sized tail outside the header.
          if (this.stage !== 'header') this.text = this.text.slice(-marker.length)
          return
        }
        if (this.stage === 'header') {
          const header = this.text.slice(0, found).replace(/,\s*$/, '')
          this.meta = JSON.parse(`${header}}`).snapshot.meta
        }
        at += found + marker.length - keep
        this.text = ''
        this.stage = (
          {
            header: 'nodes',
            seekEdges: 'edges',
            seekLocations: 'locations',
            seekStrings: 'strings',
          } as const
        )[this.stage]
        continue
      }
      if (this.stage === 'nodes' || this.stage === 'edges' || this.stage === 'locations') {
        const target =
          this.stage === 'nodes' ? this.nodes : this.stage === 'edges' ? this.edges : this.locations
        for (; at < chunk.length; at++) {
          const c = chunk.charCodeAt(at)
          if (c >= 48 && c <= 57) {
            this.number = (this.number < 0 ? 0 : this.number * 10) + (c - 48)
            continue
          }
          if (this.number >= 0) {
            if (this.number > 0xffffffff) throw new Error('Snapshot number exceeds 32 bits')
            target.push(this.number)
            this.number = -1
          }
          if (c === 93) {
            at++
            this.stage =
              this.stage === 'nodes'
                ? 'seekEdges'
                : this.stage === 'edges'
                  ? 'seekLocations'
                  : 'seekStrings'
            break
          }
        }
        continue
      }
      // strings: a JSON array of JSON strings; each is unescaped by JSON.parse.
      for (; at < chunk.length; at++) {
        const c = chunk.charCodeAt(at)
        if (!this.inString) {
          if (c === 34) {
            this.inString = true
            this.raw = []
            this.mark = at + 1
          } else if (c === 93) {
            this.stage = 'done'
            break
          }
          continue
        }
        if (this.escaped) {
          this.escaped = false
          continue
        }
        if (c === 92) {
          this.escaped = true
          continue
        }
        if (c === 34) {
          this.raw.push(chunk.slice(this.mark, at))
          this.strings.push(JSON.parse(`"${this.raw.join('')}"`))
          this.inString = false
        }
      }
      if (this.inString) {
        this.raw.push(chunk.slice(this.mark))
        this.mark = 0
      }
    }
  }
  private mark = 0

  finish(): ParsedSnapshot {
    if (this.stage !== 'done' || !this.meta)
      throw new Error(`Truncated snapshot (stage ${this.stage})`)
    return {
      meta: this.meta,
      nodes: this.nodes.done(),
      edges: this.edges.done(),
      locations: this.locations.done(),
      strings: this.strings,
    }
  }
}

export async function readSnapshot(path: string): Promise<ParsedSnapshot> {
  const parser = new SnapshotParser()
  const stream = path.endsWith('.gz')
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path)
  stream.setEncoding('utf8')
  for await (const chunk of stream) parser.push(chunk as string)
  return parser.finish()
}

/** What a removal counterfactual blocks: handles by name (`x*` = prefix), every
 * MobX object, closures by `script:line:col`, nodes by claimed site, objects
 * by property sets, ephemeron values keyed by a handle, closure-context slots. */
export interface Cut {
  handles?: string[]
  mobx?: boolean
  scripts?: string
  sites?: string
  /** Objects matching any property set; `!name` in a set means absent. */
  props?: string[][]
  weakValuesOf?: string[]
  contextVars?: string[]
}

export interface Meta {
  ids: { issue: string[]; session: string[] }
  /** Smallest copy count the census reports (default 20). */
  censusFloor?: number
  /** Smallest site the report lists, in bytes (default 2048). */
  siteFloorBytes?: number
  groups?: Record<string, Cut>
  [key: string]: unknown
}

const MiB = 1024 * 1024

export function analyze(snapshot: ParsedSnapshot, meta: Meta) {
  const { nodes, edges, strings } = snapshot
  const nf = snapshot.meta.node_fields,
    ef = snapshot.meta.edge_fields
  const F = nf.length,
    EF = ef.length
  const T = nf.indexOf('type'),
    NAME = nf.indexOf('name'),
    ID = nf.indexOf('id'),
    SELF = nf.indexOf('self_size'),
    EC = nf.indexOf('edge_count')
  const ET = ef.indexOf('type'),
    EN = ef.indexOf('name_or_index'),
    TO = ef.indexOf('to_node')
  const nodeTypes = snapshot.meta.node_types[0],
    edgeTypes = snapshot.meta.edge_types[0]
  const N = nodes.length / F
  const first = new Uint32Array(N + 1)
  for (let n = 0, e = 0; n < N; n++) {
    first[n] = e
    e += nodes[n * F + EC]! * EF
    first[n + 1] = e
  }
  if (first[N] !== edges.length)
    throw new Error(`Edge count mismatch ${first[N]} vs ${edges.length}`)
  const WEAK = edgeTypes.indexOf('weak'),
    SHORTCUT = edgeTypes.indexOf('shortcut')
  const ELEMENT = edgeTypes.indexOf('element'),
    HIDDEN = edgeTypes.indexOf('hidden'),
    PROPERTY = edgeTypes.indexOf('property'),
    INTERNAL = edgeTypes.indexOf('internal')
  const typeOf = (n: number) => nodeTypes[nodes[n * F + T]!]!
  const nameOf = (n: number) => strings[nodes[n * F + NAME]!]!
  const selfOf = (n: number) => nodes[n * F + SELF]!
  let holder = -1
  const essential = (from: number, type: number) =>
    from !== holder && type !== WEAK && (type !== SHORTCUT || from === 0)
  const holders: number[] = []
  for (let n = 0; n < N; n++)
    if (typeOf(n) === 'object' && nameOf(n) === 'Pod5133OwnerHolder') holders.push(n)
  if (holders.length !== 1)
    throw new Error(`Expected one Pod5133OwnerHolder, found ${holders.length}`)
  holder = holders[0]!

  const STRINGISH = new Set(['string', 'concatenated string', 'sliced string'])
  const classOf = (n: number): string => {
    const type = typeOf(n)
    if (type === 'object' || type === 'native')
      return nameOf(n)
        .replace(/ \/ .*$/, '')
        .slice(0, 80)
    if (type === 'closure') return `closure ${nameOf(n) || '(anonymous)'}`.slice(0, 80)
    if (STRINGISH.has(type)) return '(string)'
    if (type === 'array') return `(array) ${nameOf(n)}`.slice(0, 80)
    if (type === 'hidden' || type === 'synthetic') return `(${type}) ${nameOf(n)}`.slice(0, 80)
    return `(${type})`
  }
  const edgeName = (e: number) => {
    const type = edges[e + ET]!
    return type === ELEMENT || type === HIDDEN ? `[${edges[e + EN]}]` : strings[edges[e + EN]!]!
  }

  // Base liveness from the root, with a BFS tree for retainer paths.
  const queue = new Uint32Array(N)
  const live = new Uint8Array(N)
  const parent = new Int32Array(N).fill(-1)
  const parentEdge = new Int32Array(N).fill(-1)
  let head = 0,
    tail = 0
  live[0] = 1
  queue[tail++] = 0
  while (head < tail) {
    const n = queue[head++]!
    for (let e = first[n]!; e < first[n + 1]!; e += EF) {
      if (!essential(n, edges[e + ET]!)) continue
      const to = edges[e + TO]! / F
      if (live[to]) continue
      live[to] = 1
      parent[to] = n
      parentEdge[to] = e
      queue[tail++] = to
    }
  }
  let total = 0,
    liveCount = 0,
    nativeBytes = 0
  const typeTotals = new Map<string, number>()
  const classTotals = new Map<string, { bytes: number; count: number }>()
  for (let n = 0; n < N; n++) {
    if (!live[n]) continue
    const size = selfOf(n)
    total += size
    liveCount++
    const type = typeOf(n)
    if (type === 'native') nativeBytes += size
    typeTotals.set(type, (typeTotals.get(type) ?? 0) + size)
    const key = classOf(n)
    const entry = classTotals.get(key) ?? { bytes: 0, count: 0 }
    entry.bytes += size
    entry.count++
    classTotals.set(key, entry)
  }

  const labelOf = (n: number) =>
    typeOf(n) === 'closure'
      ? `closure ${nameOf(n)}`
      : STRINGISH.has(typeOf(n))
        ? 'string'
        : `${typeOf(n) === 'object' ? '' : `(${typeOf(n)}) `}${nameOf(n)
            .replace(/ \/ .*$/, '')
            .slice(0, 48)}`
  const pathTo = (n: number, hops = 14) => {
    const steps: string[] = []
    for (let at = n; parent[at]! >= 0 && steps.length < 64; at = parent[at]!) {
      const label =
        typeOf(at) === 'closure'
          ? `closure ${nameOf(at)}`
          : STRINGISH.has(typeOf(at))
            ? 'string'
            : nameOf(at)
                .replace(/ \/ .*$/, '')
                .slice(0, 40)
      steps.push(`.${edgeName(parentEdge[at]!)}(${label})`)
    }
    steps.reverse()
    return steps.length > hops ? ['…', ...steps.slice(-hops)].join(' ') : steps.join(' ')
  }

  // Owner handles: the property edges of the fixture's Pod5133OwnerHolder.
  // One object may carry several names (an alias): keep the first name as owner.
  const ownerOf = new Int32Array(N).fill(-1)
  const aliases: Record<string, string> = {}
  const owners: { name: string; node: number }[] = []
  for (let e = first[holder]!; e < first[holder + 1]!; e += EF) {
    if (edges[e + ET] !== PROPERTY) continue
    const name = strings[edges[e + EN]!]!,
      node = edges[e + TO]! / F
    if (ownerOf[node]! >= 0) {
      aliases[name] = owners[ownerOf[node]!]!.name
      continue
    }
    ownerOf[node] = owners.length
    owners.push({ name, node })
  }
  const missing: string[] = []
  const notLive = owners.filter((o) => !live[o.node]).map((o) => o.name)

  // Dominator tree (Cooper-Harvey-Kennedy over postorder), as DevTools'
  // retained size. Each live object belongs to its NEAREST dominating owner
  // handle; an object two owners both reach belongs to a common dominator.
  const order = queue.slice(0, tail) // base BFS order: an idom precedes its nodes
  const post = new Int32Array(N).fill(-1)
  const byPost = new Uint32Array(tail)
  {
    const cursor = new Uint32Array(N),
      stack = new Uint32Array(N),
      seen = new Uint8Array(N)
    let top = 0,
      next = 0
    stack[top++] = 0
    seen[0] = 1
    cursor[0] = first[0]!
    while (top > 0) {
      const n = stack[top - 1]!
      let pushed = false
      for (let e = cursor[n]!; e < first[n + 1]!; e += EF) {
        if (!essential(n, edges[e + ET]!)) continue
        const to = edges[e + TO]! / F
        if (seen[to]) continue
        cursor[n] = e + EF
        seen[to] = 1
        cursor[to] = first[to]!
        stack[top++] = to
        pushed = true
        break
      }
      if (!pushed) {
        top--
        post[n] = next
        byPost[next++] = n
      }
    }
  }
  const predStart = new Uint32Array(tail + 1)
  for (let n = 0; n < N; n++)
    if (live[n])
      for (let e = first[n]!; e < first[n + 1]!; e += EF)
        if (essential(n, edges[e + ET]!)) predStart[post[edges[e + TO]! / F]! + 1]!++
  for (let i = 0; i < tail; i++) predStart[i + 1]! += predStart[i]!
  const preds = new Uint32Array(predStart[tail]!),
    fill = predStart.slice(0, tail)
  for (let n = 0; n < N; n++)
    if (live[n])
      for (let e = first[n]!; e < first[n + 1]!; e += EF)
        if (essential(n, edges[e + ET]!)) preds[fill[post[edges[e + TO]! / F]!]!++] = post[n]!
  const rootPost = tail - 1
  const idomPost = new Int32Array(tail).fill(-1)
  idomPost[rootPost] = rootPost
  for (let changed = true; changed; ) {
    changed = false
    for (let b = rootPost - 1; b >= 0; b--) {
      let chosen = -1
      for (let i = predStart[b]!; i < predStart[b + 1]!; i++) {
        let p = preds[i]!
        if (idomPost[p] === -1) continue
        if (chosen === -1) {
          chosen = p
          continue
        }
        let q = chosen
        while (p !== q) {
          while (p < q) p = idomPost[p]!
          while (q < p) q = idomPost[q]!
        }
        chosen = p
      }
      if (chosen !== -1 && idomPost[b] !== chosen) {
        idomPost[b] = chosen
        changed = true
      }
    }
  }
  const idom = new Int32Array(N).fill(-1)
  for (let i = 0; i < tail; i++) idom[byPost[i]!] = byPost[idomPost[i]!]!
  const retained = new Float64Array(N)
  for (let i = tail - 1; i >= 0; i--) {
    const n = order[i]!
    retained[n]! += selfOf(n)
    if (n !== 0) retained[idom[n]!]! += retained[n]!
  }
  const K = owners.length
  const nearest = new Int32Array(N).fill(-1) // owner index, or -1 for the rest of the app
  for (let i = 1; i < tail; i++) {
    const n = order[i]!,
      d = idom[n]!
    nearest[n] = ownerOf[n]! >= 0 ? ownerOf[n]! : ownerOf[d]! >= 0 ? ownerOf[d]! : nearest[d]!
  }
  const labels = [...owners.map((o) => o.name), '(app: not under any named owner)']
  const own = new Float64Array(K + 1),
    ownCount = new Float64Array(K + 1)
  const ownClasses = Array.from({ length: K + 1 }, () => new Map<string, number>())
  for (let i = 0; i < tail; i++) {
    const n = order[i]!,
      s = nearest[n]! < 0 ? K : nearest[n]!
    own[s]! += selfOf(n)
    ownCount[s]!++
    const key = classOf(n)
    ownClasses[s]!.set(key, (ownClasses[s]!.get(key) ?? 0) + selfOf(n))
  }
  const top = (map: Map<string, number>, limit: number) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, bytes]) => ({ key, MiB: +(bytes / MiB).toFixed(3) }))
  const partition = labels
    .map((name, s) => ({
      name,
      ownBytes: own[s]!,
      ownMiB: +(own[s]! / MiB).toFixed(3),
      objects: ownCount[s]!,
      retainedMiB: s < K ? +(retained[owners[s]!.node]! / MiB).toFixed(3) : null,
      dominatedBy: s < K && idom[owners[s]!.node]! >= 0 ? labelOf(idom[owners[s]!.node]!) : null,
      path: s < K ? pathTo(owners[s]!.node, 8) : null,
      topClasses: top(ownClasses[s]!, 8),
    }))
    .sort((a, b) => b.ownMiB - a.ownMiB)
  if (Math.abs(own.reduce((sum, v) => sum + v, 0) - total) > 1)
    throw new Error('Partition does not add up to the live total')
  // Unnamed branch points outside every owner: big dominators with no single
  // dominated child carrying most of their bytes (linear chains are skipped).
  const biggestChild = new Float64Array(N)
  for (let i = 1; i < tail; i++) {
    const n = order[i]!
    const d = idom[n]!
    if (retained[n]! > biggestChild[d]!) biggestChild[d] = retained[n]!
  }
  const unnamed: {
    node: string
    retainedMiB: number
    selfKiB: number
    biggestChildMiB: number
    path: string
  }[] = []
  for (let i = 1; i < tail; i++) {
    const n = order[i]!
    if (
      nearest[n]! >= 0 ||
      ownerOf[n]! >= 0 ||
      retained[n]! < 0.25 * MiB ||
      biggestChild[n]! > 0.8 * retained[n]!
    )
      continue
    unnamed.push({
      node: labelOf(n),
      retainedMiB: +(retained[n]! / MiB).toFixed(3),
      selfKiB: +(selfOf(n) / 1024).toFixed(1),
      biggestChildMiB: +(biggestChild[n]! / MiB).toFixed(3),
      path: pathTo(n, 10),
    })
  }
  unnamed.sort((a, b) => b.retainedMiB - a.retainedMiB)
  // Who holds each big class: immediate-dominator labels and sample paths.
  const holdersOf = new Map<string, { idoms: Map<string, number>; samples: number[] }>()
  const bigClasses = new Set(
    [...classTotals]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 60)
      .map(([key]) => key),
  )
  for (let i = 1; i < tail; i++) {
    const n = order[i]!,
      key = classOf(n)
    if (!bigClasses.has(key)) continue
    const entry = holdersOf.get(key) ?? { idoms: new Map<string, number>(), samples: [] }
    const d = labelOf(idom[n]!)
    entry.idoms.set(d, (entry.idoms.get(d) ?? 0) + selfOf(n))
    if (entry.samples.length < 3 && (i * 2654435761) % 97 === 0) entry.samples.push(n)
    holdersOf.set(key, entry)
  }
  const holders_ = Object.fromEntries(
    [...holdersOf].map(([key, v]) => [
      key,
      {
        idoms: top(v.idoms, 6),
        samples: v.samples.map((n) => pathTo(n, 16)),
      },
    ]),
  )
  // Creation sites. A closure's site is its source location; a MobX object's
  // site is its debug name, or its derivation's location when the name is
  // generic. Helper objects it owns (observers_ Set and table, observing_,
  // a map's data_/hasMap_) are claimed with it; a closure claims its context.
  // Everything else is labelled by the last hops of its shortest path.
  const lf = snapshot.meta.location_fields
  const LO = lf.indexOf('object_index'),
    LS = lf.indexOf('script_object_index'),
    LL = lf.indexOf('line'),
    LC = lf.indexOf('column')
  const scriptNames = new Map<number, string>()
  const scriptName = (script: number) => {
    let name = scriptNames.get(script)
    if (name !== undefined) return name
    name = '?'
    for (let e = first[script]!; e < first[script + 1]!; e += EF) {
      const edge = strings[edges[e + EN]!]
      if ((edge === 'name' || edge === 'source_url') && STRINGISH.has(typeOf(edges[e + TO]! / F))) {
        name = nameOf(edges[e + TO]! / F).replace(/^.*\//, '')
        break
      }
    }
    scriptNames.set(script, name)
    return name
  }
  const location = new Map<number, string>()
  const { locations } = snapshot
  for (let i = 0; i + lf.length <= locations.length; i += lf.length) {
    const object = locations[i + LO]! / F,
      script = LS >= 0 ? locations[i + LS]! / F : -1
    location.set(
      object,
      `${script >= 0 ? scriptName(script) : '?'}:${locations[i + LL]! + 1}:${locations[i + LC]! + 1}`,
    )
  }
  const edgeTo = (n: number, name: string) => {
    for (let e = first[n]!; e < first[n + 1]!; e += EF) {
      const type = edges[e + ET]!
      if (
        (type === PROPERTY || type === INTERNAL || type === edgeTypes.indexOf('context')) &&
        strings[edges[e + EN]!] === name
      )
        return edges[e + TO]! / F
    }
    return -1
  }
  const flat = (n: number, depth = 0): string => {
    if (typeOf(n) !== 'concatenated string') return nameOf(n)
    if (depth > 48) return '…'
    const a = edgeTo(n, 'first'),
      b = edgeTo(n, 'second')
    return (a >= 0 ? flat(a, depth + 1) : '') + (b >= 0 ? flat(b, depth + 1) : '')
  }
  const normalize = (name: string) => name.replace(/(^|[.:@/#])[^.:@/#]*\d[^.:@/#]*/g, '$1*')
  const MOBX = new Set([
    'ObservableValue',
    'ComputedValue',
    'Atom',
    'Reaction',
    'ObservableMap',
    'ObservableSet',
    'ObservableObjectAdministration',
    'ObservableArrayAdministration',
  ])
  const claimed = new Uint8Array(N)
  const siteIndex = new Int32Array(N)
  const siteOf = new Map<string, { count: number; bytes: number; index: number }>()
  const claim = (key: string, n: number, counts: boolean) => {
    if (n < 0 || claimed[n] || !live[n]) return
    claimed[n] = 1
    const entry = siteOf.get(key) ?? { count: 0, bytes: 0, index: siteOf.size }
    siteIndex[n] = entry.index
    entry.bytes += selfOf(n)
    if (counts) entry.count++
    siteOf.set(key, entry)
  }
  const claimTable = (key: string, n: number) => {
    if (n < 0) return
    claim(key, n, false)
    claim(key, edgeTo(n, 'table'), false)
  }
  for (let i = 0; i < tail; i++) {
    const n = order[i]!,
      type = typeOf(n)
    if (type === 'object' && MOBX.has(nameOf(n))) {
      const nameNode = edgeTo(n, 'name_')
      let label =
        nameNode >= 0 && STRINGISH.has(typeOf(nameNode))
          ? normalize(flat(nameNode)).slice(0, 120)
          : ''
      const fn = edgeTo(n, nameOf(n) === 'Reaction' ? 'onInvalidate_' : 'derivation')
      if (
        fn >= 0 &&
        (!label || /^(ComputedValue|Reaction|Autorun|ObservableValue)@?\*?$/.test(label))
      )
        label = `${label} fn ${nameOf(fn) || '(anonymous)'} @ ${location.get(fn) ?? '?'}`
      const key = `${nameOf(n)} ${label}`
      claim(key, n, true)
      for (const helper of [
        'observers_',
        'data_',
        'hasMap_',
        'values_',
        'keysAtom_',
        'changeListeners_',
        'interceptors_',
      ])
        claimTable(key, edgeTo(n, helper))
      for (const listeners of ['onBUOL', 'onBOL']) {
        const set = edgeTo(n, listeners)
        if (set < 0) continue
        claimTable(`${key} (unobserve listeners)`, set)
        const table = edgeTo(set, 'table')
        if (table >= 0)
          for (let e = first[table]!; e < first[table + 1]!; e += EF) {
            const fn = edges[e + TO]! / F
            if (typeOf(fn) === 'closure') {
              claim(`${key} (unobserve listeners)`, fn, false)
              claim(`${key} (unobserve listeners)`, edgeTo(fn, 'context'), false)
            }
          }
      }
      const enhancer = edgeTo(n, 'enhancer_')
      if (enhancer >= 0 && typeOf(enhancer) === 'closure') {
        claim(key, enhancer, false)
        claim(key, edgeTo(enhancer, 'context'), false)
      }
      const claimName = (at: number, depth: number) => {
        if (at < 0 || depth > 48 || !STRINGISH.has(typeOf(at))) return
        claim('(MobX debug names)', at, false)
        if (typeOf(at) === 'concatenated string') {
          claimName(edgeTo(at, 'first'), depth + 1)
          claimName(edgeTo(at, 'second'), depth + 1)
        }
      }
      claimName(nameNode, 0)
      if (nameOf(n) === 'ComputedValue') {
        // A computed's cached result is derived data the legacy arm does not hold;
        // a borrowed row (an object with an id) is never claimed here.
        const value = edgeTo(n, 'value_')
        if (
          value >= 0 &&
          (typeOf(value) === 'object' || typeOf(value) === 'array') &&
          edgeTo(value, 'id') < 0
        ) {
          claim(`${key} (cached value)`, value, false)
          claim(`${key} (cached value)`, edgeTo(value, 'properties'), false)
          claim(`${key} (cached value)`, edgeTo(value, 'elements'), false)
        }
      }
      const observing = edgeTo(n, 'observing_')
      claim(key, observing, false)
      const newObserving = edgeTo(n, 'newObserving_')
      claim(key, newObserving, false)
    }
  }
  for (let i = 0; i < tail; i++) {
    const n = order[i]!
    if (typeOf(n) !== 'closure') continue
    const key = `closure ${nameOf(n) || '(anonymous)'} @ ${location.get(n) ?? '?'}`
    claim(key, n, true)
    claim(key, edgeTo(n, 'context'), false)
  }
  const pathKey = (n: number) => {
    const hops: string[] = []
    for (let at = n; parent[at]! >= 0 && hops.length < 4; at = parent[at]!) {
      const e = parentEdge[at]!
      const type = edges[e + ET]!
      hops.push(
        type === ELEMENT || type === HIDDEN
          ? '[]'
          : normalize(strings[edges[e + EN]!]!)
              .replace(/ \/ part of key.*$/, ' (weak entry)')
              .slice(0, 40),
      )
    }
    return hops.reverse().join('.')
  }
  for (let i = 0; i < tail; i++) {
    const n = order[i]!
    if (claimed[n]) continue
    claim(`${classOf(n)} at …${pathKey(n)}`, n, true)
  }
  const sites = [...siteOf]
    .filter(([, v]) => v.bytes >= (meta.siteFloorBytes ?? 2048))
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([key, v]) => ({ key, count: v.count, MiB: +(v.bytes / MiB).toFixed(4) }))
  const nearestLabel = (n: number) => (nearest[n]! < 0 ? '(app)' : labels[nearest[n]!]!)

  // Removal counterfactuals: block every node a cut selects, then measure
  // what is no longer reachable from the root. Cuts may overlap; they do not add.
  const counterfactuals: {
    group: string
    blocked: number
    freedBytes: number
    freedMiB: number
    topSites: { key: string; MiB: number }[]
    topClasses: { key: string; MiB: number }[]
  }[] = []
  const stamp = new Uint8Array(N)
  const siteKeys = [...siteOf.keys()]
  /** `names` must all be present, except `!name`, which must be absent. */
  const hasProps = (n: number, names: string[]) => {
    const want = names.filter((x) => !x.startsWith('!')),
      avoid = names.filter((x) => x.startsWith('!')).map((x) => x.slice(1))
    let found = 0
    for (let e = first[n]!; e < first[n + 1]!; e += EF) {
      if (edges[e + ET] !== PROPERTY) continue
      const name = strings[edges[e + EN]!]!
      if (avoid.includes(name)) return false
      if (want.includes(name)) found++
    }
    return found === want.length
  }
  for (const [group, cut] of Object.entries(meta.groups ?? {})) {
    stamp.fill(0)
    let blocked = 0
    const block = (n: number) => {
      if (n >= 0 && live[n] && stamp[n] !== 2) {
        stamp[n] = 2
        blocked++
      }
    }
    const named = (pattern: string, name: string) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
    for (const o of owners) if (cut.handles?.some((p) => named(p, o.name))) block(o.node)
    const siteRule = cut.sites ? new RegExp(cut.sites) : null
    const siteHit = siteRule
      ? new Uint8Array(siteKeys.map((key) => (siteRule.test(key) ? 1 : 0)))
      : null
    const scriptRule = cut.scripts ? new RegExp(cut.scripts) : null
    const weak = owners.filter((o) => cut.weakValuesOf?.some((p) => named(p, o.name)))
    for (const o of weak)
      for (let e = first[o.node]!; e < first[o.node + 1]!; e += EF)
        if (strings[edges[e + EN]!]?.includes('/ part of key')) block(edges[e + TO]! / F)
    for (let n = 0; n < N; n++) {
      if (!live[n]) continue
      const type = typeOf(n)
      if (cut.mobx && type === 'object' && MOBX.has(nameOf(n))) block(n)
      else if (siteHit && siteHit[siteIndex[n]!]) block(n)
      else if (scriptRule && type === 'closure' && scriptRule.test(location.get(n) ?? '')) block(n)
      else if (cut.props && type === 'object' && cut.props.some((names) => hasProps(n, names)))
        block(n)
      if (
        cut.contextVars &&
        (type === 'object' || type === 'closure' || nameOf(n) === 'system / Context')
      )
        for (let e = first[n]!; e < first[n + 1]!; e += EF)
          if (
            edges[e + ET] === edgeTypes.indexOf('context') &&
            cut.contextVars.includes(strings[edges[e + EN]!]!)
          )
            block(edges[e + TO]! / F)
    }
    head = 0
    tail = 0
    if (stamp[0] !== 2) {
      stamp[0] = 1
      queue[tail++] = 0
    }
    while (head < tail) {
      const n = queue[head++]!
      for (let e = first[n]!; e < first[n + 1]!; e += EF) {
        if (!essential(n, edges[e + ET]!)) continue
        const to = edges[e + TO]! / F
        if (stamp[to]) continue
        stamp[to] = 1
        queue[tail++] = to
      }
    }
    let freed = 0
    const classes = new Map<string, number>(),
      bySite = new Map<string, number>()
    for (let n = 0; n < N; n++)
      if (live[n] && stamp[n] !== 1) {
        freed += selfOf(n)
        const key = classOf(n)
        classes.set(key, (classes.get(key) ?? 0) + selfOf(n))
        const site = siteKeys[siteIndex[n]!]!
        bySite.set(site, (bySite.get(site) ?? 0) + selfOf(n))
      }
    counterfactuals.push({
      group,
      blocked,
      freedBytes: freed,
      freedMiB: +(freed / MiB).toFixed(3),
      topSites: top(bySite, 40),
      topClasses: top(classes, 12),
    })
  }

  // Row-copy census.
  const indexOf = new Map<string, number>()
  strings.forEach((s, i) => {
    if (!indexOf.has(s)) indexOf.set(s, i)
  })
  const idName = indexOf.get('id'),
    sessionIdName = indexOf.get('sessionId')
  const rowKind = new Map<number, 'issue' | 'session'>()
  for (const kind of ['issue', 'session'] as const)
    for (const id of meta.ids[kind]) {
      const i = indexOf.get(id)
      if (i !== undefined) rowKind.set(i, kind)
    }
  const shapes = new Map<
    string,
    {
      kind: string
      count: number
      ids: Set<number>
      self: number
      backing: number
      sample: number
      owner: Map<string, number>
    }
  >()
  for (let n = 0; n < N; n++) {
    if (!live[n] || typeOf(n) !== 'object') continue
    let kind: 'issue' | 'session' | undefined,
      rowId = -1
    const props: string[] = []
    let backing = 0
    for (let e = first[n]!; e < first[n + 1]!; e += EF) {
      const type = edges[e + ET]!
      if (type === PROPERTY) {
        props.push(strings[edges[e + EN]!]!)
        if (edges[e + EN] === idName && kind === undefined) {
          const to = edges[e + TO]! / F
          if (STRINGISH.has(typeOf(to))) {
            kind = rowKind.get(nodes[to * F + NAME]!)
            rowId = nodes[to * F + NAME]!
          }
        } else if (edges[e + EN] === sessionIdName) {
          // Session rows are keyed by sessionId; any string value counts.
          const to = edges[e + TO]! / F
          if (STRINGISH.has(typeOf(to))) {
            kind = 'session'
            rowId = nodes[to * F + NAME]!
          }
        }
      } else if (type === INTERNAL) {
        const name = strings[edges[e + EN]!]
        if (name === 'properties' || name === 'elements') backing += selfOf(edges[e + TO]! / F)
      }
    }
    if (kind === undefined) continue
    const signature = `${kind}|${nameOf(n)}|${props.sort().join(',')}`
    const entry = shapes.get(signature) ?? {
      kind,
      count: 0,
      ids: new Set<number>(),
      self: 0,
      backing: 0,
      sample: n,
      owner: new Map(),
    }
    entry.count++
    entry.ids.add(rowId)
    entry.self += selfOf(n)
    entry.backing += backing
    const label = nearestLabel(n)
    entry.owner.set(label, (entry.owner.get(label) ?? 0) + 1)
    shapes.set(signature, entry)
  }
  const rowCopies = [...shapes]
    .filter(([, v]) => v.count >= (meta.censusFloor ?? 20))
    .sort((a, b) => b[1].self + b[1].backing - (a[1].self + a[1].backing))
    .slice(0, 40)
    .map(([signature, v]) => {
      const [, className, props] = signature.split('|')
      const names = props!.split(',')
      return {
        kind: v.kind,
        constructor: className,
        properties: names.length,
        propertyNames: names.join(','),
        count: v.count,
        distinctIds: v.ids.size,
        shallowMiB: +((v.self + v.backing) / MiB).toFixed(3),
        bytesPerCopy: Math.round((v.self + v.backing) / v.count),
        owners: Object.fromEntries(v.owner),
        samplePath: pathTo(v.sample, 10),
      }
    })

  return {
    totals: {
      liveBytes: total,
      liveMiB: +(total / MiB).toFixed(3),
      liveObjects: liveCount,
      nativeMiB: +(nativeBytes / MiB).toFixed(3),
      jsMiB: +((total - nativeBytes) / MiB).toFixed(3),
      nodes: N,
      edges: edges.length / EF,
      byType: Object.fromEntries(
        [...typeTotals].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / MiB).toFixed(3)]),
      ),
    },
    owners: { resolved: owners.length, missing, notLive, aliases },
    partition,
    unnamed: unnamed.slice(0, 40),
    holders: holders_,
    sites,
    counterfactuals,
    classes: Object.fromEntries(
      [...classTotals]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 400)
        .map(([k, v]) => [k, { MiB: +(v.bytes / MiB).toFixed(4), count: v.count }]),
    ),
    rowCopies,
  }
}

if (import.meta.main) {
  const arg = (name: string) =>
    process.argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=')
  const snapshotPath = arg('snapshot'),
    metaPath = arg('meta'),
    outPath = arg('out')
  if (!snapshotPath || !metaPath || !outPath)
    throw new Error(
      'usage: heap-owners.ts --snapshot=<f.heapsnapshot[.gz]> --meta=<f.meta.json> --out=<f.analysis.json>',
    )
  const began = performance.now()
  const snapshot = await readSnapshot(snapshotPath)
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Meta
  const result = analyze(snapshot, meta)
  await writeFile(
    outPath,
    JSON.stringify(
      { snapshot: snapshotPath, meta: { ...meta, owners: undefined, ids: undefined }, ...result },
      null,
      2,
    ),
  )
  console.log(
    `${outPath}: live ${result.totals.liveMiB} MiB in ${result.totals.liveObjects} objects; ${result.owners.resolved} owners; ${((performance.now() - began) / 1000).toFixed(1)} s`,
  )
}
