import type { TranscriptItem } from '@podium/model'
import { action, computed, makeObservable, observable, type IComputedValue, type IObservableArray } from 'mobx'
import { LatestTranscriptId } from '../transcript/merge'
import { isAskUserQuestion } from '../values/ask-question'
import {
  isBatchableTool, isUserMediaMarker, pairToolResults,
  type ChatBlock, type ChatRow,
} from '../values/chat'
import { rowSurvivesSummary, type ChatVerbosity } from '../values/chat-verbosity'
import { isOperatorPrompt, type LastAnswer, type TranscriptSearchState } from '../values/compose/chat'
import { parseEnvelopeBatch } from '../values/message-envelope'
import { promptsBeforeTheirReplies, type TranscriptComputeResult } from '../values/transcript-compute'
import { TranscriptSearchIndex } from './transcript-search-index'
import { TranscriptToolRun } from './transcript-tool-run'

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
  private readonly children = observable.map<string, IObservableArray<string>>(undefined, { deep: false })
  private readonly effectChildren = observable.map<string, IObservableArray<string>>(undefined, { deep: false })
  private readonly rowMembers = observable.map<string, string[]>(undefined, { deep: false })
  private readonly runs = observable.map<string, TranscriptToolRun>(undefined, { deep: false })
  private readonly skeletons = observable.map<string, ChatRow>(undefined, { deep: false })
  private readonly blockSkeletons = observable.map<string, ChatBlock>(undefined, { deep: false })
  private readonly shapes = new Map<string, string>()
  private readonly rowShapes = new Map<string, string[]>()
  private readonly failed = new Set<string>()
  private readonly failuresByRow = new Map<string, number>()
  private readonly owners = new Map<string, string>()
  private readonly rowByBlock = new Map<string, string | TranscriptToolRun>()
  private readonly toolMembers = new Map<string, ToolMembers>()
  private readonly blocks = new Map<string, IComputedValue<ChatBlock | undefined>>()
  private readonly rows = new Map<string, IComputedValue<ChatRow | undefined>>()
  private readonly queries = new Map<string, IComputedValue<readonly string[]>>()
  private fileIds: string[] = []
  private orderedIds: string[] = []
  private readonly ranks = new Map<string, number>()
  private offset = 0
  private orderVersion = 0
  private operatorVersion = 0
  private readonly operatorIds = [[], []] as [string[], string[]]
  private readonly cursorMembers = new Map<string, string[]>()
  private readonly aliasById = new Map<string, string>()
  private readonly answers = new LatestTranscriptId(id => this.rank(id))
  private readonly assistants = new LatestTranscriptId(id => this.rank(id))
  private readonly prose = new LatestTranscriptId(id => this.rank(id))
  private readonly questions = new LatestTranscriptId(id => this.rank(id))
  latestAnswerId: string | undefined
  latestAssistantId: string | undefined
  latestProseId: string | undefined
  pendingQuestionId: string | undefined
  readonly searchIndex = new TranscriptSearchIndex(id => this.rank(id))

  constructor(items: readonly TranscriptItem[] = []) {
    makeObservable<this, 'orderVersion' | 'operatorVersion'>(this, {
      orderVersion: observable,
      operatorVersion: observable,
      latestAnswerId: observable,
      latestAssistantId: observable,
      latestProseId: observable,
      pendingQuestionId: observable,
      structuralRows: computed,
      structuralBlocks: computed,
      lastAnswer: computed,
      reset: action,
      apply: action,
    })
    this.reset(items)
  }

  /** Stable list metadata. Content is read through block(id) or row(id). */
  get structuralRows(): ChatRow[] {
    return this.rowIds.map(id => this.skeletons.get(id)!)
  }

  get structuralBlocks(): ChatBlock[] { return this.blockIds.map(id => this.blockSkeletons.get(id)!) }
  get version(): number { return this.orderVersion }
  structuralRow(id: string): ChatRow | undefined { return this.skeletons.get(id) }
  run(id: string): TranscriptToolRun | undefined { return this.runs.get(id) }
  get lastAnswer(): LastAnswer {
    const answer = this.latestAnswerId
    const prose = this.latestProseId
    return { blockIndex: answer === undefined ? -1 : this.blockPosition(answer) ?? -1,
      text: prose === undefined ? '' : this.block(prose)?.item.text ?? '' }
  }

  operatorBefore(rowIndex: number, collapseContext: boolean): string | undefined {
    this.operatorVersion
    this.orderVersion
    const first = this.rowIds[rowIndex]
    const ids = this.operatorIds[collapseContext ? 1 : 0]
    if (first === undefined) return ids.at(-1)
    return ids[this.insertionPoint(ids, first) - 1]
  }

  revealRow(key: string): number | undefined {
    this.orderVersion
    const block = this.cursorMembers.get(key)?.[0]
    const row = block === undefined ? undefined : this.rowOwner(block)
    return row === undefined ? undefined : this.rowPosition(row)
  }

  block(id: string): ChatBlock | undefined {
    let value = this.blocks.get(id)
    if (!value) {
      value = computed<ChatBlock | undefined>(() => {
        const item = this.items.get(id)
        if (!item) return undefined
        const children = this.children.get(id)
        if (!children?.length) return { item }
        if (item.role === 'tool' && item.toolUseId) {
          const result = this.items.get(children.at(-1)!)?.toolResult
          const effectId = this.effectChildren.get(id)?.at(-1)
          const effects = effectId === undefined ? undefined : this.items.get(effectId)?.toolEffects
          return { item: effects ? { ...item, toolEffects: effects } : item, result }
        }
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
        const run = this.runs.get(id)
        if (!run) return undefined
        return {
          kind: 'tools',
          get blocks() { return run.blocks },
          get title() { return run.title },
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
    return this.rowOwner(id)
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
    this.effectChildren.clear()
    this.rowMembers.clear()
    this.runs.clear()
    this.skeletons.clear()
    this.blockSkeletons.clear()
    this.shapes.clear()
    this.rowShapes.clear()
    this.failed.clear()
    this.failuresByRow.clear()
    this.owners.clear()
    this.rowByBlock.clear()
    this.toolMembers.clear()
    this.operatorIds[0].length = this.operatorIds[1].length = 0
    this.cursorMembers.clear()
    this.aliasById.clear()
    this.ranks.clear()
    this.answers.clear()
    this.assistants.clear()
    this.prose.clear()
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
    const beforeHead = insertions.length > 0 && insertions.every(insertion => insertion.before === this.fileIds[0])
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
      if (this.owners.has(item.id)) this.indexChildEffects(item.id, this.owners.get(item.id)!)
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
        let at = ordered.length
        while (at < this.orderedIds.length && this.items.get(this.orderedIds[at]!)?.role === 'user')
          prompts.push(this.orderedIds[at++]!)
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
      const row = this.rowOwner(id)
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
      const rowId = this.rowOwner(id)
      if (rowId) dirty.add(rowId)
      this.blockIds.splice(at, 1)
      const run = this.rowByBlock.get(id)
      if (run && typeof run !== 'string') run.remove(id)
      this.searchIndex.remove(id)
      this.shapes.delete(id)
      this.blockSkeletons.delete(id)
      this.answers.set(id, false)
      this.assistants.set(id, false)
      this.prose.set(id, false)
      this.questions.set(id, false)
      this.setFailure(id, false)
      this.indexOperators(id, undefined)
      this.indexAlias(id, undefined)
    }
    for (const neighbor of [this.blockIds[at - 1], this.blockIds[at], id])
      if (neighbor) dirty.add(neighbor)
  }

  private attach(child: string, owner: string | undefined, dirty: Set<string>): void {
    const previous = this.owners.get(child)
    if (previous === owner) return
    if (previous) {
      const ids = this.children.get(previous)!
      const at = this.insertionPoint(ids, child)
      if (ids[at] === child) ids.splice(at, 1)
      this.indexChildEffects(child, previous, false)
      dirty.add(previous)
    }
    if (owner) {
      let ids = this.children.get(owner)
      if (!ids) { ids = observable.array<string>([], { deep: false }); this.children.set(owner, ids) }
      ids.splice(this.insertionPoint(ids, child), 0, child)
      this.indexChildEffects(child, owner)
      this.owners.set(child, owner)
      dirty.add(owner)
    } else this.owners.delete(child)
    this.emit(child, owner === undefined, dirty)
  }

  private indexChildEffects(child: string, owner: string, enabled = !!this.items.get(child)?.toolEffects): void {
    let ids = this.effectChildren.get(owner)
    if (!ids && !enabled) return
    if (!ids) { ids = observable.array<string>([], { deep: false }); this.effectChildren.set(owner, ids) }
    const at = this.insertionPoint(ids, child)
    const held = ids[at] === child
    if (held && !enabled) ids.splice(at, 1)
    else if (!held && enabled) ids.splice(at, 0, child)
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
    const broken = new Set<TranscriptToolRun>()
    for (const id of dirty) {
      const owner = this.rowByBlock.get(id)
      if (owner && typeof owner !== 'string' &&
        (!this.isEmitted(id) || !isBatchableTool(this.items.get(id)!))) broken.add(owner)
    }
    for (const id of dirty) {
      if (this.repairToolRow(id, broken)) continue
      const point = this.insertionPoint(this.blockIds, id)
      let start = Math.max(0, Math.min(point, this.blockIds.length - 1))
      if (this.blockIds.length === 0) continue
      let end = start + 1
      const oldRows = new Set<string>()
      const addOld = (row: string | undefined) => {
        if (!row || oldRows.has(row)) return
        oldRows.add(row)
        for (const member of this.rowMembers.get(row) ?? []) {
          const at = this.insertionPoint(this.blockIds, member)
          if (this.blockIds[at] === member) { start = Math.min(start, at); end = Math.max(end, at + 1) }
        }
      }
      addOld(this.rowOwner(id))
      // Closing over the previous and current run boundaries handles a split,
      // merge or newly paired orphan. Only this affected run is rebuilt.
      let previousStart = -1, previousEnd = -1
      while (start !== previousStart || end !== previousEnd) {
        previousStart = start; previousEnd = end
        while (start > 0 && isBatchableTool(this.items.get(this.blockIds[start]!)!) &&
          isBatchableTool(this.items.get(this.blockIds[start - 1]!)!)) start--
        while (end < this.blockIds.length && isBatchableTool(this.items.get(this.blockIds[end - 1]!)!) &&
          isBatchableTool(this.items.get(this.blockIds[end]!)!)) end++
        for (let at = start; at < end; at++) addOld(this.rowOwner(this.blockIds[at]!))
      }
      const members = this.blockIds.slice(start, end)
      const first = members[0]!
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
        this.runs.delete(old)
        this.skeletons.delete(old)
        this.rowShapes.delete(old)
        this.failuresByRow.delete(old)
      }
      let at = 0
      while (at < members.length) {
        const first = members[at]!
        const tools = isBatchableTool(this.items.get(first)!)
        let end = at + 1
        if (tools) while (end < members.length && isBatchableTool(this.items.get(members[end]!)!)) end++
        const ownedMembers = observable.array<string>(members.slice(at, end), { deep: false })
        this.rowMembers.set(first, ownedMembers)
        this.rowShapes.set(first, ownedMembers.map(member => this.shapes.get(member)!))
        let failures = 0
        for (const member of ownedMembers) if (this.failed.has(member)) failures++
        this.failuresByRow.set(first, failures)
        const run = tools ? new TranscriptToolRun(ownedMembers, id => this.block(id), id => this.rank(id)) : undefined
        if (run) this.runs.set(first, run)
        for (const member of ownedMembers) this.rowByBlock.set(member, run ?? first)
        this.skeletons.set(first, run ? this.toolSkeleton(run) : this.row(first)!)
        this.rowIds.splice(this.insertionPoint(this.rowIds, first), 0, first)
        this.updateSummary(first)
        at = end
      }
      this.orderVersion++
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
    if (this.shapes.get(id) !== shape(block)) this.blockSkeletons.set(id, block)
    this.shapes.set(id, shape(block))
    this.setFailure(id, rowSurvivesSummary({ kind: 'tools', blocks: [block], blockIndices: [0], title: '' }))
    this.searchIndex.set(id, [block.item.text, block.item.toolName ?? '', block.item.toolInput ?? '',
      block.result ?? block.item.toolResult ?? ''].join('\n'))
    this.answers.set(id, block.item.role === 'assistant' && block.item.answer === true)
    this.assistants.set(id, block.item.role === 'assistant')
    this.prose.set(id, block.item.role === 'assistant' && block.item.text.trim() !== '')
    this.questions.set(id, isAskUserQuestion(block.item) && !block.item.toolResult && block.result === undefined)
    this.indexOperators(id, block.item)
    this.indexAlias(id, block.item.cursor ?? id)
    const run = this.rowByBlock.get(id)
    if (run && typeof run !== 'string') run.update(id, block)
  }

  private publishFacts(): void {
    this.latestAnswerId = this.answers.latest()
    this.latestAssistantId = this.assistants.latest()
    this.latestProseId = this.prose.latest()
    this.pendingQuestionId = this.questions.latest()
  }

  private indexOperators(id: string, item: TranscriptItem | undefined): void {
    const operatorText = item?.role === 'user' ? parseEnvelopeBatch(item.text)?.operatorText : undefined
    for (const collapse of [false, true]) {
      const ids = this.operatorIds[collapse ? 1 : 0]
      const at = this.insertionPoint(ids, id)
      const held = ids[at] === id
      const next = item !== undefined && isOperatorPrompt(item, {
        collapseMachineContext: collapse, operatorTextOf: () => operatorText,
      })
      if (held && !next) { ids.splice(at, 1); this.operatorVersion++ }
      else if (!held && next) { ids.splice(at, 0, id); this.operatorVersion++ }
    }
  }

  private indexAlias(id: string, alias: string | undefined): void {
    const previous = this.aliasById.get(id)
    if (previous === alias) return
    if (previous !== undefined) {
      const ids = this.cursorMembers.get(previous)!
      const at = this.insertionPoint(ids, id)
      if (ids[at] === id) ids.splice(at, 1)
      if (!ids.length) this.cursorMembers.delete(previous)
    }
    if (alias === undefined) this.aliasById.delete(id)
    else {
      let ids = this.cursorMembers.get(alias)
      if (!ids) { ids = []; this.cursorMembers.set(alias, ids) }
      ids.splice(this.insertionPoint(ids, id), 0, id)
      this.aliasById.set(id, alias)
    }
    this.orderVersion++
  }

  private setFailure(id: string, failed: boolean): void {
    const previous = this.failed.has(id)
    if (previous === failed) return
    if (failed) this.failed.add(id)
    else this.failed.delete(id)
    const row = this.rowOwner(id)
    if (row) this.failuresByRow.set(row, (this.failuresByRow.get(row) ?? 0) + (failed ? 1 : -1))
  }

  private rowOwner(id: string): string | undefined {
    const owner = this.rowByBlock.get(id)
    return typeof owner === 'string' ? owner : owner?.ids[0]
  }

  private toolSkeleton(run: TranscriptToolRun, blocks = observable.array<ChatBlock>(
    run.ids.map(id => this.blockSkeletons.get(id)!), { deep: false },
  )): ChatRow {
    const graph = this
    return { kind: 'tools', blocks,
      get title() { return run.title },
      get blockIndices() { return run.ids.map(id => graph.blockPosition(id) ?? -1) },
    }
  }

  /** Add/change one child of an existing quiet run without walking its members. */
  private repairToolRow(id: string, broken: ReadonlySet<TranscriptToolRun>): boolean {
    const item = this.items.get(id)
    if (!item || !isBatchableTool(item) || !this.isEmitted(id)) return false
    const own = this.rowByBlock.get(id)
    if (typeof own === 'string') return false
    const point = this.insertionPoint(this.blockIds, id)
    const groups = new Set<TranscriptToolRun>()
    for (const neighbor of [this.blockIds[point - 1], id, this.blockIds[point + 1]]) {
      if (!neighbor || !isBatchableTool(this.items.get(neighbor)!)) continue
      const group = this.rowByBlock.get(neighbor)
      if (group && typeof group !== 'string') groups.add(group)
    }
    if (groups.size !== 1) return false
    const run = groups.values().next().value!
    if (broken.has(run)) return false
    const before = run.ids[0]!
    const members = this.rowMembers.get(before)!
    const at = this.insertionPoint(members, id)
    const inserted = members[at] !== id
    const signatures = this.rowShapes.get(before)!
    if (!inserted && signatures[at] === this.shapes.get(id)) return true
    const skeleton = this.skeletons.get(before)!
    if (skeleton.kind !== 'tools') return false
    const blocks = skeleton.blocks as IObservableArray<ChatBlock>
    if (inserted) {
      members.splice(at, 0, id)
      blocks.splice(at, 0, this.blockSkeletons.get(id)!)
      signatures.splice(at, 0, this.shapes.get(id)!)
      this.rowByBlock.set(id, run)
      run.update(id, this.block(id)!)
      if (this.failed.has(id)) this.failuresByRow.set(before, (this.failuresByRow.get(before) ?? 0) + 1)
    } else {
      blocks[at] = this.blockSkeletons.get(id)!
      signatures[at] = this.shapes.get(id)!
    }
    const first = members[0]!
    if (before !== first) {
      const rowAt = this.insertionPoint(this.rowIds, before)
      if (this.rowIds[rowAt] === before) this.rowIds.splice(rowAt, 1)
      const summaryAt = this.insertionPoint(this.summaryRowIds, before)
      if (this.summaryRowIds[summaryAt] === before) this.summaryRowIds.splice(summaryAt, 1)
      this.rowMembers.delete(before)
      this.rowShapes.delete(before)
      this.runs.delete(before)
      this.skeletons.delete(before)
      const failures = this.failuresByRow.get(before) ?? 0
      this.failuresByRow.delete(before)
      this.failuresByRow.set(first, failures)
      this.rowMembers.set(first, members)
      this.rowShapes.set(first, signatures)
      this.runs.set(first, run)
      this.rowIds.splice(this.insertionPoint(this.rowIds, first), 0, first)
    }
    this.skeletons.set(first, this.toolSkeleton(run, blocks))
    this.updateSummary(first)
    this.orderVersion++
    return true
  }

  dispose(): void {
    this.blocks.clear()
    this.rows.clear()
    this.queries.clear()
  }
}
