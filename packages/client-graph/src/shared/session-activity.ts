/** Scalar history question. Storage can answer the same maximum without
 * exposing session rows or a history map to its caller. */
export interface SessionActivityQuestion {
  kind: 'commandRootActivity'
  roots: readonly string[]
  match?: 'within' | 'exact'
  excluded?: readonly string[] | ReadonlySet<string>
}

type Entry = { id: string; at: number }
const better = (a: Entry, b: Entry) => a.at > b.at || (a.at === b.at && a.id < b.id)

class Maximum {
  private readonly entries: Entry[] = []
  private readonly positions = new Map<string, number>()
  get size() {
    return this.entries.length
  }
  private swap(a: number, b: number) {
    const first = this.entries[a]!,
      second = this.entries[b]!
    this.entries[a] = second
    this.entries[b] = first
    this.positions.set(first.id, b)
    this.positions.set(second.id, a)
  }
  private repair(at: number) {
    while (at > 0) {
      const parent = (at - 1) >>> 1
      if (!better(this.entries[at]!, this.entries[parent]!)) break
      this.swap(at, parent)
      at = parent
    }
    for (;;) {
      const left = at * 2 + 1,
        right = left + 1
      let best = at
      if (left < this.size && better(this.entries[left]!, this.entries[best]!)) best = left
      if (right < this.size && better(this.entries[right]!, this.entries[best]!)) best = right
      if (best === at) break
      this.swap(at, best)
      at = best
    }
  }
  set(id: string, at: number | undefined): boolean {
    const position = this.positions.get(id)
    if (position !== undefined && this.entries[position]?.at === at) return false
    if (position !== undefined) {
      const last = this.entries.pop()!
      this.positions.delete(id)
      if (position < this.size) {
        this.entries[position] = last
        this.positions.set(last.id, position)
        this.repair(position)
      }
    }
    if (at !== undefined) {
      const next = this.size
      this.entries.push({ id, at })
      this.positions.set(id, next)
      this.repair(next)
    }
    return position !== undefined || at !== undefined
  }
  answer(excluded: ReadonlySet<string>, visit: () => void): number {
    const frontier = this.size ? [0] : []
    while (frontier.length) {
      frontier.sort((a, b) => (better(this.entries[a]!, this.entries[b]!) ? -1 : 1))
      const position = frontier.shift()!,
        entry = this.entries[position]!
      visit()
      if (!excluded.has(entry.id)) return entry.at
      if (position * 2 + 1 < this.size) frontier.push(position * 2 + 1)
      if (position * 2 + 2 < this.size) frontier.push(position * 2 + 2)
    }
    return 0
  }
}

/** Per-path numerical maxima, not summaries. Collapsed members never enter
 * a heap; a winner flip updates only the affected members' filed paths. */
export function createSessionActivityIndex(collapsed: (id: string) => boolean) {
  const facts = new Map<string, { keys: readonly string[]; at: number }>()
  const maxima = new Map<string, Maximum>()
  const revisions = new Map<string, number>()
  let version = 0,
    replacement = 0,
    visits = 0
  const key = (match: string, root: string) => `${match}:${root}`
  function file(id: string, keys: readonly string[], at: number | undefined) {
    for (const root of keys) {
      let maximum = maxima.get(root)
      if (!maximum && at !== undefined) {
        maximum = new Maximum()
        maxima.set(root, maximum)
      }
      if (maximum?.set(id, at)) revisions.set(root, ++version)
      if (maximum?.size === 0) maxima.delete(root)
    }
  }
  return {
    get visits() {
      return visits
    },
    clear() {
      facts.clear()
      maxima.clear()
      revisions.clear()
      replacement = ++version
    },
    set(id: string, row: Readonly<Record<string, unknown>> | undefined) {
      const before = facts.get(id)
      const cwd = row?.cwd
      const roots = typeof cwd === 'string' ? [key('exact', cwd), key('within', cwd)] : []
      if (typeof cwd === 'string')
        for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1))
          roots.push(key('within', cwd.slice(0, at)))
      const keys = [...new Set(roots)],
        next = row ? { keys, at: Date.parse(String(row.lastActiveAt ?? '')) || 0 } : undefined
      if (before)
        file(
          id,
          before.keys.filter((root) => !keys.includes(root)),
          undefined,
        )
      if (next) {
        facts.set(id, next)
        file(id, keys, collapsed(id) ? undefined : next.at)
      } else facts.delete(id)
    },
    visibilityChanged(id: string) {
      const held = facts.get(id)
      if (held) file(id, held.keys, collapsed(id) ? undefined : held.at)
    },
    revision(question: SessionActivityQuestion): number {
      return Math.max(
        replacement,
        ...question.roots.map((root) => revisions.get(key(question.match ?? 'within', root)) ?? 0),
      )
    },
    answer(question: SessionActivityQuestion): number {
      const excluded = question.excluded instanceof Set ? question.excluded : new Set(question.excluded)
      return Math.max(
        0,
        ...question.roots.map(
          (root) =>
            maxima.get(key(question.match ?? 'within', root))?.answer(excluded, () => visits++) ??
            0,
        ),
      )
    },
  }
}
