import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, observable } from 'mobx'
import { type ActivitySingletonDisplay, activitySingletonDisplay } from '../values/activity-display'
import {
  type ChatBlock,
  type ToolTitleClause,
  toolActivityCount,
  toolBatchTitleFromClauses,
  toolCategory,
  toolRunElapsedMs,
  toolSubject,
  toolVerdict,
} from '../values/chat'

class Category {
  readonly ids = observable.array<string>([], { deep: false })
  readonly subjects = observable.map<string, string[]>(undefined, { deep: false })
  readonly subjectOrder = observable.array<string>([], { deep: false })
  @observable accessor count = 0
  constructor(
    readonly verb: string,
    readonly noun: string,
  ) {}
}

interface Membership {
  category: string
  subject: string | undefined
  count: number
  call: boolean
}

/** The run owns category/subject membership; collapsed readers demand a title. */
export class TranscriptActivityRun {
  private readonly categories = observable.map<string, Category>(undefined, { deep: false })
  private readonly categoryOrder = observable.array<string>([], { deep: false })
  private readonly entries = new Map<string, Membership>()
  private readonly calls = observable.array<string>([], { deep: false })
  private readonly failed = new Set<string>()
  @observable private accessor failedCount = 0
  private readonly durations = new Map<string, number>()
  @observable accessor durationMs = 0

  constructor(
    readonly ids: readonly string[],
    private readonly readBlock: (id: string) => ChatBlock | undefined,
    private readonly rankOf: (id: string) => number,
  ) {
    for (const id of ids) {
      const block = readBlock(id)
      if (block) this.update(id, block)
    }
  }

  @lazy get count(): number {
    return this.ids.length
  }
  @lazy get failures(): number {
    return this.failedCount
  }
  @lazy get toolCount(): number {
    return this.calls.length
  }
  @lazy get firstTool(): ChatBlock | undefined {
    const id = this.calls[0]
    return id === undefined ? undefined : this.readBlock(id)
  }
  @lazy get lastTool(): ChatBlock | undefined {
    const id = this.calls.at(-1)
    return id === undefined ? undefined : this.readBlock(id)
  }
  @lazy get leadingNotes(): number {
    const id = this.calls[0]
    return id === undefined ? this.count : this.insertion(this.ids, id)
  }
  @lazy({ equals: compareShallow }) get summaryClauses(): readonly ToolTitleClause[] {
    return [...this.clauses(false)]
  }
  @lazy get firstBlock(): ChatBlock | undefined {
    const id = this.ids[0]
    return id === undefined ? undefined : this.readBlock(id)
  }
  @lazy get lastBlock(): ChatBlock | undefined {
    const id = this.ids.at(-1)
    return id === undefined ? undefined : this.readBlock(id)
  }
  @lazy get singletonDisplay(): ActivitySingletonDisplay | undefined {
    if (this.count !== 1) return undefined
    const block = this.firstBlock
    return block ? activitySingletonDisplay(block) : undefined
  }
  /** Only an unfolded run or a complete snapshot demands all children. */
  @lazy({ equals: compareShallow }) get blocks(): ChatBlock[] {
    return this.ids.map((id) => this.readBlock(id)!)
  }
  @lazy get title(): string {
    return toolBatchTitleFromClauses(this.clauses())
  }
  /** Count-only face for the folded row; see `toolBatchTitles`. */
  @lazy get summary(): string {
    return toolBatchTitleFromClauses(this.summaryClauses)
  }
  elapsed(now?: number): number | undefined {
    const first = this.firstBlock,
      last = this.lastBlock
    return first && last ? toolRunElapsedMs([first, last], now) : undefined
  }

  @action update(id: string, block: ChatBlock): void {
    const duration = block.item.durationMs ?? 0
    this.durationMs += duration - (this.durations.get(id) ?? 0)
    this.durations.set(id, duration)
    const failure =
      toolVerdict(block.result ?? block.item.toolResult, block.item.toolEffects) === 'err'
    const failed = this.failed.has(id)
    if (failure !== failed) {
      if (failure) this.failed.add(id)
      else this.failed.delete(id)
      this.failedCount += failure ? 1 : -1
    }
    const { verb, noun } = toolCategory(block.item)
    const key = `${verb}|${noun}`
    const subject = toolSubject(block.item)
    const count = toolActivityCount(block.item)
    const previous = this.entries.get(id)
    const call = block.item.role === 'tool'
    if (call !== (previous?.call ?? false)) {
      const at = this.insertion(this.calls, id)
      if (call) this.calls.splice(at, 0, id)
      else if (this.calls[at] === id) this.calls.splice(at, 1)
    }
    if (
      previous?.category === key &&
      previous.subject === subject &&
      previous.count === count &&
      previous.call === call
    )
      return
    if (previous) this.removeMembership(id, previous)
    let category = this.categories.get(key)
    if (!category) {
      category = new Category(verb, noun)
      this.categories.set(key, category)
    }
    this.reorderCategory(key, category, () => {
      category.ids.splice(this.insertion(category.ids, id), 0, id)
      category.count += count
      if (subject)
        this.reorderSubject(category, subject, () => {
          let members = category.subjects.get(subject)
          if (!members) {
            members = observable.array<string>([], { deep: false })
            category.subjects.set(subject, members)
          }
          members.splice(this.insertion(members, id), 0, id)
        })
    })
    this.entries.set(id, { category: key, subject, count, call })
  }

  @action remove(id: string): void {
    this.durationMs -= this.durations.get(id) ?? 0
    this.durations.delete(id)
    const previous = this.entries.get(id)
    if (previous) this.removeMembership(id, previous)
    if (previous?.call) {
      const at = this.insertion(this.calls, id)
      if (this.calls[at] === id) this.calls.splice(at, 1)
    }
    this.entries.delete(id)
    if (this.failed.delete(id)) this.failedCount--
  }

  private *clauses(named = true): Generator<ToolTitleClause> {
    for (const key of this.categoryOrder) {
      const category = this.categories.get(key)!
      yield {
        verb: category.verb,
        noun: category.noun,
        count: category.count,
        subjects: named ? category.subjectOrder.slice(0, 2) : [],
      }
    }
  }

  private insertion(ids: readonly string[], id: string): number {
    return this.insertionBy(ids, this.rankOf(id), (member) => this.rankOf(member))
  }
  private insertionBy(
    ids: readonly string[],
    rank: number,
    rankOf: (id: string) => number,
  ): number {
    let low = 0,
      high = ids.length
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
    if (first === undefined) {
      this.categories.delete(key)
      return
    }
    this.categoryOrder.splice(
      this.insertionBy(this.categoryOrder, this.rankOf(first), rankOf),
      0,
      key,
    )
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
    if (first === undefined) {
      category.subjects.delete(subject)
      return
    }
    category.subjectOrder.splice(
      this.insertionBy(category.subjectOrder, this.rankOf(first), rankOf),
      0,
      subject,
    )
  }

  private removeMembership(id: string, previous: Membership): void {
    const category = this.categories.get(previous.category)!
    this.reorderCategory(previous.category, category, () => {
      const at = this.insertion(category.ids, id)
      if (category.ids[at] === id) category.ids.splice(at, 1)
      category.count -= previous.count
      if (previous.subject)
        this.reorderSubject(category, previous.subject, () => {
          const members = category.subjects.get(previous.subject!)!
          const at = this.insertion(members, id)
          if (members[at] === id) members.splice(at, 1)
        })
    })
  }
}

/** Source compatibility for the existing run API. */
export { TranscriptActivityRun as TranscriptToolRun }
