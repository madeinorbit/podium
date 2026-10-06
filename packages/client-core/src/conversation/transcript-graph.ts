import type { TranscriptItem } from '@podium/model'
import { action, computed, makeObservable, observable, type IComputedValue } from 'mobx'
import { LatestTranscriptId } from '../transcript/merge'
import { isAskUserQuestion } from '../values/ask-question'
import {
  isBatchableTool, isUserMediaMarker, pairToolResults, toolBatchTitle,
  type ChatBlock, type ChatRow,
} from '../values/chat'
import { rowSurvivesSummary, type ChatVerbosity } from '../values/chat-verbosity'
import type { TranscriptSearchState } from '../values/compose/chat'
import { promptsBeforeTheirReplies, type TranscriptComputeResult } from '../values/transcript-compute'
import { TranscriptSearchIndex } from './transcript-search-index'

export interface TranscriptGraphInsertion {
  readonly id: string
  /** The following item in file order; absent means append. */
  readonly before?: string
}

export interface TranscriptGraphChange {
  readonly changed: readonly TranscriptItem[]
  readonly insertions?: readonly TranscriptGraphInsertion[]
  readonly removed?: readonly string[]
}

interface ToolMembers { calls: string[]; results: string[] }

function relationship(item: TranscriptItem): string {
  const marker = isUserMediaMarker(item)
  const fileOnly = marker && !!item.tags?.length && item.tags.every(tag => tag.kind === 'file')
  return `${item.role}\0${item.toolUseId ?? ''}\0${item.toolResult !== undefined}\0${marker}\0${fileOnly}\0${item.event ?? ''}\0${item.ts ?? ''}`
}

function shape(block: ChatBlock): string {
  const item = block.item
  return `${item.role}\0${item.answer ?? ''}\0${item.systemKind ?? ''}\0${item.ts ?? ''}\0${item.toolName ?? ''}\0${item.cursor ?? ''}\0${item.event ?? ''}`
}

/**
 * The conversation's addressed pairing and row model. Ingestion owns membership
 * facts; each observed block and row derives its content from its own members.
 * Full arrays are explicit snapshot/export readers, never the stream producer.
 */
export class TranscriptGraph {
  readonly blockIds = observable.array<string>([], { deep: false })
  readonly rowIds = observable.array<string>([], { deep: false })
  readonly summaryRowIds = observable.array<string>([], { deep: false })
  private readonly items = observable.map<string, TranscriptItem>(undefined, { deep: false })
  private readonly children = observable.map<string, readonly string[]>(undefined, { deep: false })
  private readonly rowMembers = observable.map<string, readonly string[]>(undefined, { deep: false })
  private readonly skeletons = observable.map<string, ChatRow>(undefined, { deep: false })
  private readonly shapes = new Map<string, string>()
  private readonly rowShapes = new Map<string, readonly string[]>()
  private readonly failed = new Set<string>()
  private readonly failuresByRow = new Map<string, number>()
  private readonly owners = new Map<string, string>()
  private readonly rowByBlock = new Map<string, string>()
  private readonly toolMembers = new Map<string, ToolMembers>()
  private readonly blocks = new Map<string, IComputedValue<ChatBlock | undefined>>()
  private readonly rows = new Map<string, IComputedValue<ChatRow | undefined>>()
  private readonly queries = new Map<string, IComputedValue<readonly string[]>>()
  private fileIds: string[] = []
  private orderedIds: string[] = []
  private readonly ranks = new Map<string, number>()
  private offset = 0
  private orderVersion = 0
  private readonly answers = new LatestTranscriptId(id => this.rank(id))
  private readonly assistants = new LatestTranscriptId(id => this.rank(id))
  private readonly questions = new LatestTranscriptId(id => this.rank(id))
  latestAnswerId: string | undefined
  latestAssistantId: string | undefined
  pendingQuestionId: string | undefined
  readonly searchIndex = new TranscriptSearchIndex(id => this.rank(id))

  constructor(items: readonly TranscriptItem[] = []) {
    makeObservable<this, 'orderVersion'>(this, {
      orderVersion: observable,
      latestAnswerId: observable,
      latestAssistantId: observable,
      pendingQuestionId: observable,
      structuralRows: computed,
      reset: action,
      apply: action,
    })
    this.reset(items)
  }

  /** Stable list metadata. Content is read through block(id) or row(id). */
  get structuralRows(): ChatRow[] {
    return this.rowIds.map(id => this.skeletons.get(id)!)
  }

  block(id: string): ChatBlock | undefined {
    let value = this.blocks.get(id)
    if (!value) {
      value = computed<ChatBlock | undefined>(() => {
        const item = this.items.get(id)
        if (!item) return undefined
        const children = this.children.get(id)
        if (!children?.length) return { item }
        const related = [item]
        for (const child of children) {
          const item = this.items.get(child)
          if (item) related.push(item)
        }
        return pairToolResults(related)[0]
      })
      this.blocks.set(id, value)
    }
    return value.get()
  }

  row(id: string): ChatRow | undefined {
    let value = this.rows.get(id)
    if (!value) {
      value = computed<ChatRow | undefined>(() => {
        const members = this.rowMembers.get(id)
        if (!members?.length) return undefined
        const first = this.block(members[0]!)
        if (!first) return undefined
        const graph = this
        if (!isBatchableTool(first.item)) return {
          kind: 'block', block: first,
          get blockIndex() { return graph.blockPosition(first.item.id) ?? -1 },
        }
        const blocks: ChatBlock[] = []
        for (const member of members) {
          const block = this.block(member)
          if (block) blocks.push(block)
        }
        return {
          kind: 'tools', blocks, title: toolBatchTitle(blocks),
          get blockIndices() { return members.map(member => graph.blockPosition(member) ?? -1) },
        }
      })
      this.rows.set(id, value)
    }
    return value.get()
  }

  blockPosition(id: string): number | undefined {
    this.orderVersion
    const at = this.insertionPoint(this.blockIds, id)
    return this.blockIds[at] === id ? at : undefined
  }

  rowPosition(id: string, verbosity: ChatVerbosity = 'normal'): number | undefined {
    this.orderVersion
    const ids = verbosity === 'summary' ? this.summaryRowIds : this.rowIds
    const at = this.insertionPoint(ids, id)
    return ids[at] === id ? at : undefined
  }

  rowIdForBlock(id: string): string | undefined {
    this.orderVersion
    return this.rowByBlock.get(id)
  }

  matches(query: string): readonly string[] {
    const key = query.trim().toLowerCase()
    if (!key) return []
    let value = this.queries.get(key)
    if (!value) {
      value = computed<readonly string[]>(() => {
        this.orderVersion
        return this.searchIndex.find(key)
      })
      this.queries.set(key, value)
      // Unobserved old queries can be discarded without changing any observer.
      if (this.queries.size > 32) this.queries.delete(this.queries.keys().next().value!)
    }
    return value.get()
  }

  search(query: string, cursor: number, verbosity: ChatVerbosity = 'normal'): TranscriptSearchState {
    const ids = this.matches(query)
    const total = ids.length
    const selected = total ? ((cursor % total) + total) % total : -1
    const activeId = ids[selected]
    const rowId = activeId === undefined ? undefined : this.rowIdForBlock(activeId)
    const activeRow = rowId === undefined ? undefined : this.rowPosition(rowId, verbosity)
    return {
      matches: ids.map(id => this.blockPosition(id)!),
      activeMatch: activeId === undefined ? undefined : this.blockPosition(activeId),
      activeRow, position: selected + 1, total, filtering: query.trim() !== '',
    }
  }

  /** An intentionally complete data reader, for exports and semantic oracles. */
  snapshot(verbosity: ChatVerbosity = 'normal'): TranscriptComputeResult {
    const blocks = this.blockIds.map(id => this.block(id)!)
    const rows: ChatRow[] = []
    for (const id of verbosity === 'summary' ? this.summaryRowIds : this.rowIds) {
      const row = this.row(id)
      if (row) rows.push(row.kind === 'tools'
        ? { ...row, blockIndices: [...row.blockIndices] }
        : { ...row })
    }
    return { blocks, rows, search: this.search('', 0) }
  }

  reset(items: readonly TranscriptItem[]): void {
    this.items.clear()
    this.children.clear()
    this.rowMembers.clear()
    this.skeletons.clear()
    this.shapes.clear()
    this.rowShapes.clear()
    this.failed.clear()
    this.failuresByRow.clear()
    this.owners.clear()
    this.rowByBlock.clear()
    this.toolMembers.clear()
    this.ranks.clear()
    this.answers.clear()
    this.assistants.clear()
    this.questions.clear()
    this.searchIndex.clear()
    this.fileIds = items.map(item => item.id)
    const ordered = promptsBeforeTheirReplies([...items])
    this.orderedIds = ordered.map(item => item.id)
    this.offset = 0
    this.blockIds.clear()
    this.rowIds.clear()
    this.summaryRowIds.clear()
    ordered.forEach((item, at) => { this.items.set(item.id, item); this.ranks.set(item.id, at) })
    for (const item of ordered) this.ingestIdentity(item.id)
    const dirty = new Set(this.blockIds)
    for (const id of dirty) this.indexBlock(id)
    this.repairRows(dirty)
    for (const id of this.blocks.keys()) if (!this.items.has(id)) this.blocks.delete(id)
    for (const id of this.rows.keys()) if (!this.rowMembers.has(id)) this.rows.delete(id)
    this.publishFacts()
    this.orderVersion++
  }

  apply(change: TranscriptGraphChange): void {
    const insertions = change.insertions ?? []
    const removed = change.removed ?? []
    const beforeHead = insertions.length > 0 && insertions[0]!.before === this.fileIds[0]
    const append = insertions.every(insertion => insertion.before === undefined)
    const identityChanged = change.changed.some(item => {
      const held = this.items.get(item.id)
      return held !== undefined && relationship(held) !== relationship(item)
    })
    // An authoritative topology edit remains a cold replacement. Ordinary
    // frames and one-sided pages preserve all unaffected cells and indexes.
    if (removed.length || identityChanged || (!append && !beforeHead)) {
      const items = new Map(this.items)
      for (const item of change.changed) items.set(item.id, item)
      const removedIds = new Set(removed)
      const order = this.fileIds.filter(id => !removedIds.has(id))
      for (const insertion of insertions) {
        const at = insertion.before === undefined ? order.length : order.indexOf(insertion.before)
        order.splice(at < 0 ? order.length : at, 0, insertion.id)
      }
      this.reset(order.map(id => items.get(id)!))
      return
    }
    const dirty = new Set<string>()
    for (const item of change.changed) {
      const owner = this.owners.get(item.id) ?? item.id
      this.items.set(item.id, item)
      dirty.add(owner)
    }
    if (insertions.length) {
      const ids = insertions.map(insertion => insertion.id)
      const ordered = promptsBeforeTheirReplies(ids.map(id => this.items.get(id)!))
      if (beforeHead) {
        this.fileIds.unshift(...ids)
        this.orderedIds.unshift(...ordered.map(item => item.id))
        this.offset += ordered.length
        ordered.forEach((item, at) => this.ranks.set(item.id, at - this.offset))
      } else {
        this.fileIds.push(...ids)
        const start = this.orderedIds.length
        this.orderedIds.push(...ordered.map(item => item.id))
        ordered.forEach((item, at) => this.ranks.set(item.id, start + at - this.offset))
      }
      // Timestamp repair at the seam can move a prompt through the adjacent
      // reply span. Re-index only that span, rather than sorting the transcript.
      const prompts = ordered.filter(item => item.role === 'user').map(item => item.id)
      if (beforeHead) {
        const firstHeld = this.orderedIds[ordered.length]
        if (firstHeld && this.items.get(firstHeld)?.role === 'user') prompts.push(firstHeld)
      }
      for (const id of prompts) this.liftPrompt(id, dirty)
      const sorted = ids.sort((a, b) => this.rank(a) - this.rank(b))
      for (const id of sorted) this.ingestIdentity(id, dirty)
      // A page may supply the missing call for a previously orphaned result,
      // or the user turn into which the old head's media marker now folds.
      if (beforeHead) {
        let at = ordered.length
        while (at < this.orderedIds.length) {
          const id = this.orderedIds[at++]!
          const item = this.items.get(id)!
          if (isUserMediaMarker(item)) this.ingestMedia(id, dirty)
          else if (!this.owners.has(id)) break
        }
      }
      this.orderVersion++
    }
    const rowsToRepair = new Set<string>()
    for (const id of dirty) {
      const block = this.block(id)
      if (!block || !this.isEmitted(id)) { this.searchIndex.remove(id); continue }
      if (this.shapes.get(id) !== shape(block)) {
        const at = this.insertionPoint(this.blockIds, id)
        for (const neighbor of [this.blockIds[at - 1], id, this.blockIds[at + 1]])
          if (neighbor) rowsToRepair.add(neighbor)
      }
      this.indexBlock(id)
    }
    // New membership and changed row kind are source facts. Updating ordinary
    // prose leaves the list skeleton and unrelated row computeds untouched.
    for (const insertion of insertions) {
      const owner = this.owners.get(insertion.id) ?? insertion.id
      rowsToRepair.add(owner)
    }
    if (insertions.length) for (const id of dirty) rowsToRepair.add(id)
    if (rowsToRepair.size) this.repairRows(rowsToRepair)
    const changedRows = new Set<string>()
    for (const id of dirty) {
      const row = this.rowByBlock.get(id)
      if (row) changedRows.add(row)
    }
    for (const id of changedRows) this.updateSummary(id)
    this.publishFacts()
  }

  private rank(id: string): number { return (this.ranks.get(id) ?? Infinity) + this.offset }

  private insertionPoint(ids: readonly string[], id: string): number {
    const rank = this.rank(id)
    let low = 0, high = ids.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.rank(ids[middle]!) < rank) low = middle + 1
      else high = middle
    }
    return low
  }

  private isEmitted(id: string): boolean {
    const at = this.insertionPoint(this.blockIds, id)
    return this.blockIds[at] === id
  }

  private emit(id: string, emitted: boolean, dirty: Set<string>): void {
    const at = this.insertionPoint(this.blockIds, id)
    const held = this.blockIds[at] === id
    if (held === emitted) return
    if (emitted) this.blockIds.splice(at, 0, id)
    else {
      const rowId = this.rowByBlock.get(id)
      if (rowId) dirty.add(rowId)
      this.blockIds.splice(at, 1)
      this.searchIndex.remove(id)
      this.shapes.delete(id)
      this.answers.set(id, false)
      this.assistants.set(id, false)
      this.questions.set(id, false)
      this.setFailure(id, false)
    }
    for (const neighbor of [this.blockIds[at - 1], this.blockIds[at], id])
      if (neighbor) dirty.add(neighbor)
  }

  private attach(child: string, owner: string | undefined, dirty: Set<string>): void {
    const previous = this.owners.get(child)
    if (previous === owner) return
    if (previous) {
      this.children.set(previous, (this.children.get(previous) ?? []).filter(id => id !== child))
      dirty.add(previous)
    }
    if (owner) {
      const ids = [...(this.children.get(owner) ?? [])]
      ids.splice(this.insertionPoint(ids, child), 0, child)
      this.children.set(owner, ids)
      this.owners.set(child, owner)
      dirty.add(owner)
    } else this.owners.delete(child)
    this.emit(child, owner === undefined, dirty)
  }

  private ingestIdentity(id: string, dirty = new Set<string>()): void {
    const item = this.items.get(id)!
    if (isUserMediaMarker(item)) { this.ingestMedia(id, dirty); return }
    if (item.role !== 'tool' || !item.toolUseId) { this.emit(id, true, dirty); return }
    let members = this.toolMembers.get(item.toolUseId)
    if (!members) { members = { calls: [], results: [] }; this.toolMembers.set(item.toolUseId, members) }
    if (item.toolResult !== undefined) {
      members.results.splice(this.insertionPoint(members.results, id), 0, id)
      const at = this.insertionPoint(members.calls, id)
      this.attach(id, members.calls[at - 1], dirty)
      if (!this.owners.has(id)) this.emit(id, true, dirty)
    } else {
      const at = this.insertionPoint(members.calls, id)
      members.calls.splice(at, 0, id)
      this.emit(id, true, dirty)
      const next = members.calls[at + 1]
      for (let at = this.insertionPoint(members.results, id); at < members.results.length; at++) {
        const result = members.results[at]!
        if (next && this.rank(result) >= this.rank(next)) break
        this.attach(result, id, dirty)
      }
    }
  }

  private ingestMedia(id: string, dirty: Set<string>): void {
    const at = this.insertionPoint(this.blockIds, id)
    const previous = this.blockIds[at - 1]
    const item = this.items.get(id)!
    const prev = previous === undefined ? undefined : this.items.get(previous)
    const owner = prev?.role === 'user' && prev.event === undefined ? previous : undefined
    this.attach(id, owner, dirty)
    if (!owner) {
      const tags = item.tags ?? []
      this.emit(id, !(tags.length > 0 && tags.every(tag => tag.kind === 'file')), dirty)
    }
  }

  private liftPrompt(id: string, dirty: Set<string>): void {
    const item = this.items.get(id)!
    const stamp = item.ts ? Date.parse(item.ts) : NaN
    if (!Number.isFinite(stamp)) return
    const at = this.rank(id)
    let start = at
    while (start > 0) {
      const above = this.items.get(this.orderedIds[start - 1]!)!
      const aboveStamp = above.ts ? Date.parse(above.ts) : NaN
      if (above.role === 'user' || !Number.isFinite(aboveStamp) || aboveStamp <= stamp) break
      start--
    }
    if (start === at) return
    const held = this.insertionPoint(this.blockIds, id)
    const emitted = this.blockIds[held] === id
    if (emitted) this.blockIds.splice(held, 1)
    this.orderedIds.splice(at, 1)
    this.orderedIds.splice(start, 0, id)
    for (let index = start; index <= at; index++)
      this.ranks.set(this.orderedIds[index]!, index - this.offset)
    // A held user moved through newly prefixed replies; restore block order
    // in that affected span before new membership is inserted.
    if (emitted) {
      this.blockIds.splice(this.insertionPoint(this.blockIds, id), 0, id)
      dirty.add(id)
    }
  }

  private repairRows(dirty: ReadonlySet<string>): void {
    const visited = new Set<string>()
    for (const id of dirty) {
      const point = this.insertionPoint(this.blockIds, id)
      let start = Math.max(0, Math.min(point, this.blockIds.length - 1))
      if (this.blockIds.length === 0) continue
      while (start > 0 && isBatchableTool(this.items.get(this.blockIds[start]!)!) &&
        isBatchableTool(this.items.get(this.blockIds[start - 1]!)!)) start--
      let end = start + 1
      if (isBatchableTool(this.items.get(this.blockIds[start]!)!))
        while (end < this.blockIds.length && isBatchableTool(this.items.get(this.blockIds[end]!)!)) end++
      const first = this.blockIds[start]!
      if (visited.has(first)) continue
      visited.add(first)
      const members = this.blockIds.slice(start, end)
      const oldRows = new Set<string>()
      const removedRow = this.rowByBlock.get(id)
      if (removedRow) oldRows.add(removedRow)
      for (const member of members) {
        const row = this.rowByBlock.get(member)
        if (row) oldRows.add(row)
      }
      const previous = this.rowMembers.get(first)
      const oldShapes = this.rowShapes.get(first)
      if (oldRows.size === 1 && oldRows.has(first) && previous?.length === members.length &&
        members.every((member, at) => previous[at] === member && oldShapes?.[at] === this.shapes.get(member)))
        continue
      for (const old of oldRows) {
        const at = this.insertionPoint(this.rowIds, old)
        if (this.rowIds[at] === old) this.rowIds.splice(at, 1)
        const summary = this.insertionPoint(this.summaryRowIds, old)
        if (this.summaryRowIds[summary] === old) this.summaryRowIds.splice(summary, 1)
        for (const member of this.rowMembers.get(old) ?? []) this.rowByBlock.delete(member)
        this.rowMembers.delete(old)
        this.skeletons.delete(old)
        this.rowShapes.delete(old)
        this.failuresByRow.delete(old)
      }
      this.rowMembers.set(first, members)
      this.rowShapes.set(first, members.map(member => this.shapes.get(member)!))
      let failures = 0
      for (const member of members) if (this.failed.has(member)) failures++
      this.failuresByRow.set(first, failures)
      for (const member of members) this.rowByBlock.set(member, first)
      const row = this.row(first)!
      this.skeletons.set(first, row)
      this.rowIds.splice(this.insertionPoint(this.rowIds, first), 0, first)
      this.updateSummary(first)
    }
  }

  private updateSummary(id: string): void {
    const members = this.rowMembers.get(id)
    const first = members?.[0] === undefined ? undefined : this.block(members[0])
    const at = this.insertionPoint(this.summaryRowIds, id)
    const held = this.summaryRowIds[at] === id
    const kept = first !== undefined && (isBatchableTool(first.item)
      ? (this.failuresByRow.get(id) ?? 0) > 0
      : rowSurvivesSummary({ kind: 'block', block: first, blockIndex: 0 }))
    if (held && !kept) this.summaryRowIds.splice(at, 1)
    else if (!held && kept) this.summaryRowIds.splice(at, 0, id)
  }

  private indexBlock(id: string): void {
    const block = this.block(id)
    if (!block) return
    this.shapes.set(id, shape(block))
    this.setFailure(id, rowSurvivesSummary({ kind: 'tools', blocks: [block], blockIndices: [0], title: '' }))
    this.searchIndex.set(id, [block.item.text, block.item.toolName ?? '', block.item.toolInput ?? '',
      block.result ?? block.item.toolResult ?? ''].join('\n'))
    this.answers.set(id, block.item.role === 'assistant' && block.item.answer === true)
    this.assistants.set(id, block.item.role === 'assistant')
    this.questions.set(id, isAskUserQuestion(block.item) && !block.item.toolResult && block.result === undefined)
  }

  private publishFacts(): void {
    this.latestAnswerId = this.answers.latest()
    this.latestAssistantId = this.assistants.latest()
    this.pendingQuestionId = this.questions.latest()
  }

  private setFailure(id: string, failed: boolean): void {
    const previous = this.failed.has(id)
    if (previous === failed) return
    if (failed) this.failed.add(id)
    else this.failed.delete(id)
    const row = this.rowByBlock.get(id)
    if (row) this.failuresByRow.set(row, (this.failuresByRow.get(row) ?? 0) + (failed ? 1 : -1))
  }

  dispose(): void {
    this.blocks.clear()
    this.rows.clear()
    this.queries.clear()
  }
}
