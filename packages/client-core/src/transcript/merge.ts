import type { TranscriptItem } from '@podium/model'
import { cursorInsertionIndex } from '../values/cursor-order'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in rightRecord && sameValue(leftRecord[key], rightRecord[key]))
  )
}

export function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  return sameValue(left, right)
}

export function sameTranscriptItems(
  left: readonly TranscriptItem[],
  right: readonly TranscriptItem[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every(
        (item, index) =>
          item.id === right[index]?.id && sameTranscriptItem(item, right[index] as TranscriptItem),
      ))
  )
}

/**
 * Merge by stable item id, replacing growing content in place. Cursors are
 * position anchors only: they order unseen items and never identify a row.
 * An identical frame preserves the held array to avoid re-rendering.
 */
export function mergeTranscriptFrame(
  held: readonly TranscriptItem[],
  frame: readonly TranscriptItem[],
): TranscriptItem[] {
  const positions = new Map<string, number>()
  held.forEach((item, index) => {
    positions.set(item.id, index)
  })
  return mergeIndexedTranscriptFrame(held, frame, positions)
}

/** The controller keeps this index across deltas; authority reads rebuild it. */
export function mergeIndexedTranscriptFrame(
  held: readonly TranscriptItem[],
  frame: readonly TranscriptItem[],
  positions: Map<string, number>,
): TranscriptItem[] {
  if (frame.length === 0) return held as TranscriptItem[]
  let next: TranscriptItem[] | null = null
  const additions = new Map<string, TranscriptItem>()

  for (const item of frame) {
    const key = item.id
    const position = positions.get(key)
    if (position !== undefined) {
      const current = (next ?? held)[position]
      if (current && !sameTranscriptItem(current, item)) {
        next ??= [...held]
        next[position] = item
      }
      continue
    }
    additions.set(key, item)
  }

  if (!next && additions.size === 0) return held as TranscriptItem[]
  const merged = next ?? [...held]
  for (const item of additions.values()) {
    const insertion = cursorInsertionIndex(merged, item)
    if (insertion < 0) {
      positions.set(item.id, merged.length)
      merged.push(item)
    } else {
      merged.splice(insertion, 0, item)
      for (let index = insertion; index < merged.length; index++) {
        const entry = merged[index]
        if (entry) positions.set(entry.id, index)
      }
    }
  }
  return merged
}

/**
 * Reconcile a newest-window read without dropping live items beyond its tail.
 * Resolve the paging cursor inside the snapshot, then match that item's id in
 * the held window. A changed cursor must not make the same row a replacement
 * conversation. An empty read preserves the window; an unknown tail replaces it.
 */
export function reconcileTranscriptSnapshot(
  held: readonly TranscriptItem[],
  snapshot: readonly TranscriptItem[],
  snapshotTail: string | undefined,
): TranscriptItem[] {
  if (snapshot.length === 0) return held as TranscriptItem[]
  const tail =
    snapshotTail === undefined
      ? snapshot.at(-1)
      : snapshot.find((item) => item.cursor === snapshotTail)
  const tailIndex = tail === undefined ? -1 : held.findIndex((item) => item.id === tail.id)
  const unique = dedupeTranscriptItems(snapshot)
  if (tailIndex < 0) return unique
  const newerHeld = held.slice(tailIndex + 1)
  return newerHeld.length === 0 ? unique : mergeTranscriptFrame(unique, newerHeld)
}

/** First occurrence wins, preserving page order. Identity is always item.id. */
export function dedupeTranscriptItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return unique.length === items.length ? (items as TranscriptItem[]) : unique
}

/** Exclude held ids and repeats within the older page; held live content wins. */
export function freshOlderTranscriptPage(
  page: readonly TranscriptItem[],
  held: readonly TranscriptItem[],
  heldIds?: Pick<ReadonlyMap<string, unknown>, 'has'>,
): TranscriptItem[] {
  if (page.length === 0) return page as TranscriptItem[]
  const seen = new Set(heldIds ? [] : held.map((item) => item.id))
  return page.filter((item) => {
    if (heldIds?.has(item.id) || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** Prepend an older page without replacing more recent held content. */
export function prependTranscriptItems(
  prev: TranscriptItem[],
  older: TranscriptItem[],
): TranscriptItem[] {
  const fresh = freshOlderTranscriptPage(older, prev)
  return fresh.length === 0 ? prev : [...fresh, ...prev]
}

/** IDs only, ordered by a maintained source fact. */
export class LatestTranscriptId {
  private readonly ids: string[] = []
  private readonly locations = new Map<string, number>()
  constructor(private readonly position: (id: string) => number) {}
  clear(): void {
    this.ids.length = 0
    this.locations.clear()
  }
  latest(): string | undefined {
    return this.ids[0]
  }
  private newer(a: number, b: number): boolean {
    return this.position(this.ids[a]!) > this.position(this.ids[b]!)
  }
  private swap(a: number, b: number): void {
    const first = this.ids[a]!,
      second = this.ids[b]!
    this.ids[a] = second
    this.ids[b] = first
    this.locations.set(first, b)
    this.locations.set(second, a)
  }
  private repair(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >>> 1
      if (!this.newer(at, parent)) break
      this.swap(at, parent)
      at = parent
    }
    for (;;) {
      const left = at * 2 + 1,
        right = left + 1
      let next = at
      if (left < this.ids.length && this.newer(left, next)) next = left
      if (right < this.ids.length && this.newer(right, next)) next = right
      if (next === at) return
      this.swap(at, next)
      at = next
    }
  }
  set(id: string, present: boolean): void {
    const location = this.locations.get(id)
    if (present) {
      if (location !== undefined) {
        this.repair(location)
        return
      }
      this.locations.set(id, this.ids.length)
      this.ids.push(id)
      this.repair(this.ids.length - 1)
      return
    }
    if (location === undefined) return
    const last = this.ids.pop()!
    this.locations.delete(id)
    if (location < this.ids.length) {
      this.ids[location] = last
      this.locations.set(last, location)
      this.repair(location)
    }
  }
}
