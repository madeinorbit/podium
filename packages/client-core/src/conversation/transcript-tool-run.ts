import { action, computed, makeObservable, observable } from 'mobx'
import { toolBatchTitleFromClauses, toolCategory, toolSubject, toolVerdict, toolRunElapsedMs, type ChatBlock, type ToolTitleClause } from '../values/chat'

interface Category {
  verb: string
  noun: string
  ids: string[]
  subjects: Map<string, string[]>
  subjectOrder: string[]
}

/** The run owns category/subject membership; collapsed readers demand a title. */
export class TranscriptToolRun {
  private readonly categories = observable.map<string, Category>(undefined, { deep: false })
  private readonly categoryOrder = observable.array<string>([], { deep: false })
  private readonly entries = new Map<string, { category: string; subject: string | undefined }>()
  private readonly failed = new Set<string>()
  private failedCount = 0
  private readonly durations = new Map<string, number>()
  durationMs = 0

  constructor(readonly ids: readonly string[], private readonly readBlock: (id: string) => ChatBlock | undefined,
    private readonly rankOf: (id: string) => number) {
    makeObservable<this, 'failedCount'>(this, {
      durationMs: observable, failedCount: observable, failures: computed, title: computed, count: computed,
      blocks: computed, firstBlock: computed, lastBlock: computed, update: action, remove: action,
    })
    for (const id of ids) {
      const block = readBlock(id)
      if (block) this.update(id, block)
    }
  }

  get count(): number { return this.ids.length }
  get failures(): number { return this.failedCount }
  get firstBlock(): ChatBlock | undefined {
    const id = this.ids[0]
    return id === undefined ? undefined : this.readBlock(id)
  }
  get lastBlock(): ChatBlock | undefined {
    const id = this.ids.at(-1)
    return id === undefined ? undefined : this.readBlock(id)
  }
  /** Only an unfolded run or a complete snapshot demands all children. */
  get blocks(): ChatBlock[] { return this.ids.map(id => this.readBlock(id)!) }
  get title(): string { return toolBatchTitleFromClauses(this.clauses()) }
  elapsed(now?: number): number | undefined {
    const first = this.firstBlock, last = this.lastBlock
    return first && last ? toolRunElapsedMs([first, last], now) : undefined
  }

  update(id: string, block: ChatBlock): void {
    const duration = block.item.durationMs ?? 0
    this.durationMs += duration - (this.durations.get(id) ?? 0)
    this.durations.set(id, duration)
    const failure = toolVerdict(block.result ?? block.item.toolResult, block.item.toolEffects) === 'err'
    const failed = this.failed.has(id)
    if (failure !== failed) {
      if (failure) this.failed.add(id)
      else this.failed.delete(id)
      this.failedCount += failure ? 1 : -1
    }
    const { verb, noun } = toolCategory(block.item)
    const key = verb + '|' + noun
    const subject = toolSubject(block.item)
    const previous = this.entries.get(id)
    if (previous?.category === key && previous.subject === subject) return
    if (previous) this.removeMembership(id, previous)
    let category = this.categories.get(key)
    if (!category) {
      category = { verb, noun, ids: observable.array<string>([], { deep: false }),
        subjects: observable.map<string, string[]>(undefined, { deep: false }), subjectOrder: observable.array<string>([], { deep: false }) }
      this.categories.set(key, category)
    }
    this.reorderCategory(key, category, () => {
      category.ids.splice(this.insertion(category.ids, id), 0, id)
      if (subject) this.reorderSubject(category, subject, () => {
        let members = category.subjects.get(subject)
        if (!members) { members = observable.array<string>([], { deep: false }); category.subjects.set(subject, members) }
        members.splice(this.insertion(members, id), 0, id)
      })
    })
    this.entries.set(id, { category: key, subject })
  }

  remove(id: string): void {
    this.durationMs -= this.durations.get(id) ?? 0
    this.durations.delete(id)
    const previous = this.entries.get(id)
    if (previous) this.removeMembership(id, previous)
    this.entries.delete(id)
    if (this.failed.delete(id)) this.failedCount--
  }

  private *clauses(): Generator<ToolTitleClause> {
    for (const key of this.categoryOrder) {
      const category = this.categories.get(key)!
      yield { verb: category.verb, noun: category.noun, count: category.ids.length,
        subjects: category.subjectOrder.slice(0, 2) }
    }
  }

  private insertion(ids: readonly string[], id: string): number {
    return this.insertionBy(ids, this.rankOf(id), member => this.rankOf(member))
  }
  private insertionBy(ids: readonly string[], rank: number, rankOf: (id: string) => number): number {
    let low = 0, high = ids.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (rankOf(ids[middle]!) < rank) low = middle + 1
      else high = middle
    }
    return low
  }

  private reorderCategory(key: string, category: Category, update: () => void): void {
    const rankOf = (key: string) => this.rankOf(this.categories.get(key)!.ids[0]!)
    const before = category.ids[0]
    if (before !== undefined) {
      const at = this.insertionBy(this.categoryOrder, this.rankOf(before), rankOf)
      if (this.categoryOrder[at] === key) this.categoryOrder.splice(at, 1)
    }
    update()
    const first = category.ids[0]
    if (first === undefined) { this.categories.delete(key); return }
    this.categoryOrder.splice(this.insertionBy(this.categoryOrder, this.rankOf(first), rankOf), 0, key)
  }

  private reorderSubject(category: Category, subject: string, update: () => void): void {
    const rankOf = (subject: string) => this.rankOf(category.subjects.get(subject)![0]!)
    const before = category.subjects.get(subject)?.[0]
    if (before !== undefined) {
      const at = this.insertionBy(category.subjectOrder, this.rankOf(before), rankOf)
      if (category.subjectOrder[at] === subject) category.subjectOrder.splice(at, 1)
    }
    update()
    const first = category.subjects.get(subject)?.[0]
    if (first === undefined) { category.subjects.delete(subject); return }
    category.subjectOrder.splice(this.insertionBy(category.subjectOrder, this.rankOf(first), rankOf), 0, subject)
  }

  private removeMembership(id: string, previous: { category: string; subject: string | undefined }): void {
    const category = this.categories.get(previous.category)!
    this.reorderCategory(previous.category, category, () => {
      const at = this.insertion(category.ids, id)
      if (category.ids[at] === id) category.ids.splice(at, 1)
      if (previous.subject) this.reorderSubject(category, previous.subject, () => {
        const members = category.subjects.get(previous.subject!)!
        const at = this.insertion(members, id)
        if (members[at] === id) members.splice(at, 1)
      })
    })
  }
}
