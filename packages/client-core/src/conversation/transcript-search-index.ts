import { action, createAtom, makeObservable, observable } from 'mobx'

/** Normalized source text stays resident; postings exist only for watched search. */
export class TranscriptSearchIndex {
  private readonly texts = observable.map<string, string>(undefined, { deep: false })
  private readonly postings = observable.map<string, Set<string>>(undefined, { deep: false })
  private readonly gramsById = new Map<string, Set<string>>()
  private indexed = false
  private readonly searchDemand = createAtom('TranscriptSearchIndex.search', undefined,
    () => this.releasePostings())

  constructor(private readonly positionOf: (id: string) => number) {
    makeObservable<this, 'buildPostings' | 'releasePostings'>(this, {
      set: action, remove: action, clear: action,
      buildPostings: action, releasePostings: action,
    })
  }

  set(id: string, text: string): void {
    const normalized = text.toLowerCase()
    if (this.texts.get(id) === normalized) return
    if (this.indexed) this.updatePostings(id, normalized)
    this.texts.set(id, normalized)
  }

  private updatePostings(id: string, normalized: string): void {
    const previous = this.gramsById.get(id)
    const next = this.grams(normalized)
    for (const gram of previous ?? []) if (!next.has(gram)) this.removePosting(gram, id)
    for (const gram of next) {
      if (previous?.has(gram)) continue
      let members = this.postings.get(gram)
      if (!members) {
        members = observable.set<string>([], { deep: false })
        this.postings.set(gram, members)
      }
      members.add(id)
    }
    this.gramsById.set(id, next)
  }

  remove(id: string): void {
    for (const gram of this.gramsById.get(id) ?? []) this.removePosting(gram, id)
    this.gramsById.delete(id)
    this.texts.delete(id)
  }

  clear(): void {
    this.releasePostings()
    this.texts.clear()
  }

  private releasePostings(): void {
    this.indexed = false
    this.postings.clear()
    this.gramsById.clear()
  }

  private buildPostings(): void {
    for (const [id, text] of this.texts) this.updatePostings(id, text)
    this.indexed = true
  }

  find(query: string): string[] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    // A snapshot search has no lifetime in which to retain an index. Watched
    // searches keep their incremental buckets until the last reader leaves.
    if (!this.searchDemand.reportObserved())
      return [...this.texts].filter(([,text]) => text.includes(normalized))
        .map(([id]) => id).sort((a,b) => this.positionOf(a)-this.positionOf(b))
    if (!this.indexed) this.buildPostings()
    const width = Math.min(3, normalized.length)
    const grams = new Set<string>()
    for (let at = 0; at <= normalized.length - width; at++)
      grams.add(normalized.slice(at, at + width))
    const candidates: Set<string>[] = []
    for (const gram of grams) {
      const members = this.postings.get(gram)
      if (!members) return []
      candidates.push(members)
    }
    candidates.sort((a, b) => a.size - b.size)
    const first = candidates[0]
    if (!first) return []
    const matches: string[] = []
    for (const id of first)
      if (candidates.every(members => members.has(id)) && this.texts.get(id)?.includes(normalized))
        matches.push(id)
    return matches.sort((a, b) => this.positionOf(a) - this.positionOf(b))
  }

  private grams(text: string): Set<string> {
    const keys = new Set<string>()
    for (let width = 1; width <= 3; width++)
      for (let at = 0; at <= text.length - width; at++) keys.add(text.slice(at, at + width))
    return keys
  }

  private removePosting(gram: string, id: string): void {
    const members = this.postings.get(gram)
    members?.delete(id)
    if (members?.size === 0) this.postings.delete(gram)
  }
}
