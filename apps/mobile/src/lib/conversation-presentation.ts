import type { TranscriptToolRun } from '@podium/client-core/conversation'
import { isAskUserQuestion, type ChatRow } from '@podium/client-core/values'
import { action, actionBound, compareShallow, observable, observableRef } from 'mobx'
import { companion, lazy } from '@podium/mobx-helpers'
import type { TranscriptGraph } from '@podium/client-core/conversation'
import { appendedTranscriptArrivals, positionMobileTranscriptSearch, type MobileTranscriptMatches, type MobileTranscriptRow } from './transcript-feed'

export type RetainedMobileTranscriptRow = MobileTranscriptRow & { readonly run?: TranscriptToolRun }
export interface MobileRowOptions { collapseContext?: boolean; hiddenQuestionId?: string | null; includeEmpty?: boolean }
export interface MobileRowPublication {
  readonly reset: boolean
  readonly changed: readonly string[]
  readonly removed: readonly string[]
}
interface RowOwner { id: string; ordinal: number }

/** Source ingestion owns row-key membership. Content and Find answers are
 * demanded through addressed computeds, with no reaction-maintained model. */
export class MobileConversationPresentation {
  readonly keys = observable.array<string>([], { deep: false })
  @observable accessor version = 0
  @observable accessor appendCount = 0
  @observableRef accessor arrivalKeys: ReadonlySet<string> = new Set()
  private readonly owners = observable.map<string, RowOwner>(undefined, { deep: false })
  private readonly members = observable.map<string, readonly string[]>(undefined, { deep: false })
  readonly rows = companion((record: NonNullable<ReturnType<TranscriptGraph['record']>>) =>
    new MobilePresentationRow(record.id, this))
  private readonly assistantIds = observable.array<string>([], { deep: false })
  private readonly seenKeys = new Set<string>()
  private hidden: string | null | undefined

  constructor(readonly graph: TranscriptGraph,
    private readonly shapeRow: (row: ChatRow, options: MobileRowOptions) => MobileTranscriptRow[],
    private readonly rankOf: (id: string) => number,
    private readonly options: { collapseContext?: boolean; hiddenQuestionId?: () => string | null | undefined } = {}) {
    this.hidden = options.hiddenQuestionId?.()
    this.reset()
  }

  row(key: string): RetainedMobileTranscriptRow | undefined {
    const owner = this.owners.get(key)
    return owner === undefined ? undefined : this.rowsFor(owner.id)[owner.ordinal]
  }

  /** A complete reader for semantic oracles; the viewport consumes keys. */
  snapshot(): MobileTranscriptRow[] {
    return this.keys.map(key => {
      const { run: _run, ...row } = this.row(key)!
      return row
    })
  }
  @lazy get latestAssistantKey(): string | undefined { return this.assistantIds.at(-1) }

  positionOfKey = (key: string): number | undefined => {
    this.version
    let owner = this.owners.get(key)
    if (!owner) {
      const rowId = this.graph.rowIdForBlock(key)
      const first = rowId === undefined ? undefined : this.members.get(rowId)?.[0]
      if (first === undefined) return undefined
      key = first
      owner = this.owners.get(key)
    }
    if (!owner) return undefined
    const at = this.insertion(owner)
    return this.keys[at] === key ? at : undefined
  }

  matches(query: string): MobileTranscriptMatches {
    const key = query.trim().toLowerCase()
        this.version
        const matches: number[] = []
        const matchingRows = new Set<number>()
        const firstRowByBlock = new Map<number, number>()
        for (const id of this.graph.matches(key)) {
          const index = this.graph.blockPosition(id)
          if (index === undefined) continue
          matches.push(index)
          const owner = this.graph.rowIdForBlock(id)
          for (const rowKey of owner === undefined ? [] : this.members.get(owner) ?? []) {
            const at = this.positionOfKey(rowKey)
            if (at === undefined) continue
            matchingRows.add(at)
            if (!firstRowByBlock.has(index)) firstRowByBlock.set(index, at)
          }
        }
        return { matches, matchingRows: new Set([...matchingRows].sort((a, b) => a - b)), firstRowByBlock }
  }
  search(query: string, cursor: number) { return positionMobileTranscriptSearch(this.matches(query), cursor) }

  @action reset(): void {
    const previous = [...this.keys]
    this.keys.clear()
    this.owners.clear()
    this.members.clear()
    this.assistantIds.clear()
    for (const id of this.graph.rowIds) this.refreshRow(id)
    const current = [...this.keys]
    this.arrivalKeys = appendedTranscriptArrivals(previous, this.seenKeys, current)
    this.appendCount += this.arrivalKeys.size
    for (const key of current) this.seenKeys.add(key)
    this.version++
  }

  @action apply(publication: MobileRowPublication): void {
    const hidden = this.options.hiddenQuestionId?.()
    const previousHidden = this.hidden
    this.hidden = hidden
    if (publication.reset) { this.reset(); return }
    const beforeVersion = this.version
    const beforeTail = this.keys.at(-1)
    const tailOwner = beforeTail === undefined ? undefined : this.owners.get(beforeTail)
    const arrivals = new Set<string>()
    for (const id of publication.removed) this.removeRow(id)
    const changed = new Set(publication.changed)
    for (const question of [previousHidden, hidden]) {
      if (question === undefined || question === null || previousHidden === hidden) continue
      const row = this.graph.rowIdForBlock(question)
      if (row) changed.add(row)
    }
    for (const id of changed) {
      for (const key of this.refreshRow(id)) {
        const owner = this.owners.get(key)!
        if (tailOwner && this.compare(owner, tailOwner) > 0 && !this.seenKeys.has(key)) arrivals.add(key)
        this.seenKeys.add(key)
      }
    }
    if (this.version === beforeVersion) return
    if (arrivals.size) this.appendCount += arrivals.size
    this.arrivalKeys = arrivals
  }

  private rowsFor(id: string): readonly RetainedMobileTranscriptRow[] {
    const record = this.graph.record(id)
    return record === undefined ? [] : this.rows(record).rows
  }

  deriveRows(id: string): readonly RetainedMobileTranscriptRow[] {
        const run = this.graph.run(id)
        if (run) {
          const first = run.firstBlock
          if (!first) return []
          const graph = this.graph
          return [{ key: id, kind: 'tools', item: first.item, run, turn: 'bind',
            get blocks() { return run.blocks },
            get blockIndices() { return run.ids.map(member => graph.blockPosition(member) ?? -1) } }]
        }
        const row = this.graph.row(id)
        if (!row) return []
        return this.shapeRow(row, { collapseContext: this.options.collapseContext,
          hiddenQuestionId: row.kind === 'block' && isAskUserQuestion(row.block.item)
            ? this.options.hiddenQuestionId?.() : undefined, includeEmpty: true })
  }

  private refreshRow(id: string): string[] {
    const rows = this.rowsFor(id)
    const assistantAt = this.assistantInsertion(id)
    const heldAssistant = this.assistantIds[assistantAt] === id
    const assistant = rows.some(row => row.kind === 'answer' || row.kind === 'prose')
    if (heldAssistant && !assistant) this.assistantIds.splice(assistantAt, 1)
    else if (!heldAssistant && assistant) this.assistantIds.splice(assistantAt, 0, id)
    const next = rows.map(row => row.key)
    const previous = this.members.get(id) ?? []
    if (next.length === previous.length && next.every((key, at) => previous[at] === key)) return []
    const held = new Set(previous)
    // Re-order only this message's slots. Removing them first avoids equal
    // ordinals while an envelope batch changes its internal order.
    for (const key of previous) this.removeKey(key)
    const added: string[] = []
    next.forEach((key, ordinal) => {
      const owner = { id, ordinal }
      this.owners.set(key, owner)
      this.keys.splice(this.insertion(owner), 0, key)
      if (!held.has(key)) added.push(key)
    })
    this.members.set(id, next)
    this.version++
    return added
  }

  private removeKey(key: string): void {
    const owner = this.owners.get(key)
    if (!owner) return
    const at = this.insertion(owner)
    if (this.keys[at] === key) this.keys.splice(at, 1)
    this.owners.delete(key)
  }
  private removeRow(id: string): void {
    const members = this.members.get(id) ?? []
    const assistantAt = this.assistantInsertion(id)
    if (this.assistantIds[assistantAt] === id) this.assistantIds.splice(assistantAt, 1)
    for (const key of members) this.removeKey(key)
    if (members.length) this.version++
    this.members.delete(id)
  }
  private assistantInsertion(id: string): number {
    let low = 0, high = this.assistantIds.length
    const rank = this.rankOf(id)
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.rankOf(this.assistantIds[middle]!) < rank) low = middle + 1
      else high = middle
    }
    return low
  }
  private compare(left: RowOwner, right: RowOwner): number {
    return this.rankOf(left.id) - this.rankOf(right.id) || left.ordinal - right.ordinal
  }
  private insertion(owner: RowOwner): number {
    let low = 0, high = this.keys.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const other = this.owners.get(this.keys[middle]!)!
      if (this.compare(other, owner) < 0) low = middle + 1
      else high = middle
    }
    return low
  }
  dispose(): void {}
}

class MobilePresentationRow {
  constructor(readonly id: string, private readonly presentation: MobileConversationPresentation) {}
  @lazy({ equals: compareShallow }) get rows(): readonly RetainedMobileTranscriptRow[] {
    return this.presentation.deriveRows(this.id)
  }
}

/** A Find reader belongs to one viewport, never to the warm conversation. */
export class MobileTranscriptSearch {
  @observable accessor query = ''
  @observable accessor cursor = 0
  constructor(readonly presentation: MobileConversationPresentation) {}
  @lazy get matches(): MobileTranscriptMatches { return this.presentation.matches(this.query) }
  @lazy get search() { return positionMobileTranscriptSearch(this.matches, this.cursor) }
  @actionBound setQuery(query: string): void { this.query = query; this.cursor = 0 }
  @actionBound setCursor(value: number | ((cursor: number) => number)): void {
    this.cursor = typeof value === 'function' ? value(this.cursor) : value
  }
  @actionBound moveCursor(delta: number): void { this.cursor += delta }
}
