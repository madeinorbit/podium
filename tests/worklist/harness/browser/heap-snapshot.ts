/**
 * POD-4747 — a streaming reader for V8 heap snapshots (the JSON Chromium's
 * `HeapProfiler.takeHeapSnapshot` streams in chunks), summarised BY
 * CONSTRUCTOR. A snapshot of a history-x10 page is too large to hold as one
 * string, so the reader parses the chunks as they arrive and keeps four
 * numbers per node (type, name, id, self size) in a typed array; the edges
 * are skipped, the string table is read last.
 *
 * Heap object ids are stable across snapshots of one page, and an object
 * first seen by a later snapshot gets a larger id than every object an
 * earlier one saw. So the objects a boot stage created and still holds are
 * the nodes of the stage's snapshot with ids above the previous snapshot's
 * largest (`newSince`): a layer is what its stage added, by constructor.
 */

/** One constructor's objects: how many, and their own (shallow) size. */
export interface ConstructorTotal {
  name: string
  count: number
  selfSize: number
}

export interface SnapshotSummary {
  nodeCount: number
  /** Sum of every node's self size. */
  selfSize: number
  /** The largest heap object id in the snapshot (the next stage's `newSince`). */
  maxId: number
  /** Nodes with an id above `newSince`: what was created since that snapshot. */
  newCount: number
  newSelfSize: number
  /** The new nodes by constructor, largest self size first. */
  byConstructor: ConstructorTotal[]
}

/** Names grouped the way DevTools' summary groups them: an object by its
 *  constructor, everything else by its kind. */
function groupName(type: string, name: string): string | null {
  switch (type) {
    case 'object':
    case 'native':
      return name === '' ? '(anonymous object)' : name
    case 'closure':
      return '(closure)'
    case 'array':
      return '(array)'
    case 'string':
    case 'concatenated string':
    case 'sliced string':
      return '(string)'
    case 'code':
      return '(compiled code)'
    case 'number':
    case 'heap number':
      return '(number)'
    case 'synthetic':
      return null
    default:
      return `(${type})`
  }
}

const FIELDS_KEPT = 4

/** Feed the snapshot's chunks in order (`push`), then `finish`. */
export class HeapSnapshotReader {
  private readonly newSince: number
  private head = ''
  private state: 'head' | 'nodes' | 'seek-strings' | 'strings' | 'done' = 'head'
  private fieldCount = 0
  private typeAt = 0
  private nameAt = 0
  private idAt = 0
  private sizeAt = 0
  private nodeTypes: string[] = []
  private nodes = new Uint32Array(0)
  /** Values parsed into the current node (0..fieldCount-1) and nodes done. */
  private field = 0
  private node = 0
  private number = -1
  private seekTail = ''
  private strings: string[] = []
  private token: string | null = null
  private escaped = false

  constructor(options: { newSince?: number } = {}) {
    this.newSince = options.newSince ?? -1
  }

  push(chunk: string): void {
    let at = 0
    while (at < chunk.length && this.state !== 'done') {
      if (this.state === 'head') at = this.readHead(chunk, at)
      else if (this.state === 'nodes') at = this.readNodes(chunk, at)
      else if (this.state === 'seek-strings') at = this.seekStrings(chunk, at)
      else at = this.readStrings(chunk, at)
    }
  }

  private readHead(chunk: string, at: number): number {
    this.head += chunk.slice(at)
    const marker = this.head.indexOf('"nodes":[')
    if (marker < 0) return chunk.length
    const prefix = this.head.slice(0, marker).trim()
    // `{"snapshot":{...},` — close the object after the snapshot entry.
    const meta = JSON.parse(`${prefix.replace(/,$/, '')}}`) as {
      snapshot: {
        meta: { node_fields: string[]; node_types: [string[], ...unknown[]] }
        node_count: number
      }
    }
    const fields = meta.snapshot.meta.node_fields
    this.fieldCount = fields.length
    this.typeAt = fields.indexOf('type')
    this.nameAt = fields.indexOf('name')
    this.idAt = fields.indexOf('id')
    this.sizeAt = fields.indexOf('self_size')
    if ([this.typeAt, this.nameAt, this.idAt, this.sizeAt].some((i) => i < 0))
      throw new Error(`[heap-snapshot] node fields without type/name/id/self_size: ${fields}`)
    this.nodeTypes = meta.snapshot.meta.node_types[0]
    this.nodes = new Uint32Array(meta.snapshot.node_count * FIELDS_KEPT)
    this.state = 'nodes'
    // Continue right after the marker, inside this chunk.
    const consumed = this.head.length - (chunk.length - at)
    const resumeAt = marker + '"nodes":['.length - consumed
    this.head = ''
    return at + resumeAt
  }

  private readNodes(chunk: string, at: number): number {
    for (let i = at; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i)
      if (c >= 48 && c <= 57) {
        this.number = this.number < 0 ? c - 48 : this.number * 10 + (c - 48)
        continue
      }
      if (this.number >= 0) {
        this.store(this.number)
        this.number = -1
      }
      if (c === 93 /* ] */) {
        if (this.field !== 0) throw new Error('[heap-snapshot] nodes array ends mid-node')
        this.state = 'seek-strings'
        return i + 1
      }
    }
    return chunk.length
  }

  private store(value: number): void {
    const f = this.field
    const base = this.node * FIELDS_KEPT
    if (f === this.typeAt) this.nodes[base] = value
    else if (f === this.nameAt) this.nodes[base + 1] = value
    else if (f === this.idAt) this.nodes[base + 2] = value
    else if (f === this.sizeAt) this.nodes[base + 3] = value
    this.field = f + 1
    if (this.field === this.fieldCount) {
      this.field = 0
      this.node += 1
    }
  }

  private seekStrings(chunk: string, at: number): number {
    const marker = '"strings":['
    const text = this.seekTail + chunk.slice(at)
    const found = text.indexOf(marker)
    if (found < 0) {
      this.seekTail = text.slice(-marker.length)
      return chunk.length
    }
    const consumedTail = this.seekTail.length
    this.seekTail = ''
    this.state = 'strings'
    return at + found + marker.length - consumedTail
  }

  private readStrings(chunk: string, at: number): number {
    let start = at
    for (let i = at; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i)
      if (this.token === null) {
        if (c === 34 /* " */) {
          this.token = ''
          start = i
          this.escaped = false
        } else if (c === 93 /* ] */) {
          this.state = 'done'
          return chunk.length
        }
        continue
      }
      if (this.escaped) {
        this.escaped = false
        continue
      }
      if (c === 92 /* \ */) {
        this.escaped = true
        continue
      }
      if (c === 34) {
        const raw = this.token + chunk.slice(start, i + 1)
        this.strings.push(JSON.parse(raw) as string)
        this.token = null
      }
    }
    if (this.token !== null) {
      this.token += chunk.slice(start)
    }
    return chunk.length
  }

  finish(): SnapshotSummary {
    if (this.state !== 'done') throw new Error(`[heap-snapshot] truncated (${this.state})`)
    const totals = new Map<string, ConstructorTotal>()
    let selfSize = 0
    let maxId = 0
    let newCount = 0
    let newSelfSize = 0
    for (let n = 0; n < this.node; n++) {
      const base = n * FIELDS_KEPT
      const type = this.nodeTypes[this.nodes[base] as number] ?? '?'
      const id = this.nodes[base + 2] as number
      const size = this.nodes[base + 3] as number
      selfSize += size
      if (id > maxId) maxId = id
      // Zero-size entries (numbers the snapshot lists by value) are not objects.
      if (id <= this.newSince || size === 0) continue
      const name = groupName(type, this.strings[this.nodes[base + 1] as number] ?? '')
      if (name === null) continue
      newCount += 1
      newSelfSize += size
      const total = totals.get(name) ?? { name, count: 0, selfSize: 0 }
      total.count += 1
      total.selfSize += size
      totals.set(name, total)
    }
    return {
      nodeCount: this.node,
      selfSize,
      maxId,
      newCount,
      newSelfSize,
      byConstructor: [...totals.values()].sort(
        (a, b) => b.selfSize - a.selfSize || a.name.localeCompare(b.name),
      ),
    }
  }
}
