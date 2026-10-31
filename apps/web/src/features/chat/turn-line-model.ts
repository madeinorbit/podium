import type { HeadlessOverlay, TurnPreview } from '@podium/client-core/conversation'
import type { ChatBlock, ChatRow, ToolTitleClause } from '@podium/client-core/values'
import {
  isInteractiveTool,
  toolActivityCount,
  toolBatchTitleFromClauses,
  toolCategory,
  toolSubject,
  toolVerdict,
} from '@podium/client-core/values'
import { streamItemIdOf } from '@podium/harness/browser'
import { lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import type { ConversationPresentation } from './conversation-presentation'
import type { TurnFold } from './turn-fold'
import { rowIdentity } from './use-feed-arrivals'

export interface TurnMember {
  readonly id: string
  readonly index: number
  readonly block: ChatBlock
  readonly key: string
  readonly blockIndex?: number
}

export function buildTurnPreviewMembers(
  sessionId: string,
  preview: TurnPreview | null | undefined,
  overlay: HeadlessOverlay | null | undefined,
): TurnMember[] {
  const entries =
    preview?.items.filter((item) => item.kind === 'text' || !isInteractiveTool(item.item)) ?? []
  if (entries.length)
    return entries.map((entry) => ({
      id: entry.kind === 'text' ? entry.itemId : entry.item.id,
      key: entry.itemId,
      index: -1,
      block: {
        item:
          entry.kind === 'text'
            ? { id: entry.itemId, role: 'assistant', text: entry.text }
            : entry.item,
      },
    }))
  return overlay?.text === undefined
    ? []
    : [
        {
          id: `overlay:${sessionId}`,
          key: `overlay:${sessionId}`,
          index: -1,
          block: { item: { id: `overlay:${sessionId}`, role: 'assistant', text: overlay.text } },
        },
      ]
}

/** A view companion, keyed by the first structural row. Live text and result
 * facts are demanded separately from segmentation and the closed line's counts. */
export class PresentedTurn {
  constructor(
    readonly row: ChatRow,
    private readonly presentation?: ConversationPresentation,
    private readonly snapshot?: TurnFold,
  ) {}
  @lazy get fold(): TurnFold | undefined {
    return this.presentation?.turnFolds?.byStart.get(rowIdentity(this.row)) ?? this.snapshot
  }
  @lazy get narration(): string {
    const fold = this.fold
    const id = fold?.narration
    const row = fold?.narrationRow
    return id === undefined
      ? ''
      : ((
          this.presentation?.block(id) ?? (row?.kind === 'block' ? row.block : undefined)
        )?.item.text.trim() ?? '')
  }
  @lazy get leadingNotes(): number {
    if (this.row.kind !== 'tools') return 0
    return (
      this.presentation?.run(rowIdentity(this.row))?.leadingNotes ??
      Math.max(
        0,
        this.row.blocks.findIndex((block) => block.item.role === 'tool'),
      )
    )
  }
  @lazy({ equals: compareShallow }) get prefix(): ChatBlock[] {
    if (this.row.kind !== 'tools' || this.leadingNotes === 0) return []
    const run = this.presentation?.run(rowIdentity(this.row))
    return run
      ? run.ids.slice(0, this.leadingNotes).map((id) => this.presentation!.block(id)!)
      : this.row.blocks.slice(0, this.leadingNotes)
  }
  @lazy get currentTool(): ChatBlock | undefined {
    for (const { row } of [...(this.fold?.rows ?? [])].reverse()) {
      const block =
        row.kind === 'tools'
          ? (this.presentation?.run(rowIdentity(row))?.lastTool ??
            row.blocks.findLast((block) => block.item.role === 'tool'))
          : row.block.item.role === 'tool'
            ? (this.presentation?.block(row.block.item.id) ?? row.block)
            : undefined
      if (block)
        return block.result === undefined && block.item.toolResult === undefined ? block : undefined
    }
    return undefined
  }
  @lazy get firstEvent(): ChatBlock | undefined {
    for (const { row } of this.fold?.rows ?? []) {
      if (row.kind === 'tools')
        return this.presentation?.run(rowIdentity(row))?.firstTool ?? row.blocks[this.leadingNotes]
      if (row.block.item.role !== 'assistant')
        return this.presentation?.block(row.block.item.id) ?? row.block
    }
    return undefined
  }
  @lazy({ equals: compareShallow }) get clauses(): readonly ToolTitleClause[] {
    const counts = new Map<string, ToolTitleClause>()
    const add = (clause: ToolTitleClause, sign = 1) => {
      const key = `${clause.verb}|${clause.noun}`
      const previous = counts.get(key)
      counts.set(key, {
        ...clause,
        count: (previous?.count ?? 0) + sign * clause.count,
        subjects: [],
      })
    }
    for (const { row } of this.fold?.rows ?? []) {
      if (row.kind === 'tools') {
        const run = this.presentation?.run(rowIdentity(row))
        if (run) for (const clause of run.summaryClauses) add(clause)
        else
          for (const block of row.blocks)
            add({ ...toolCategory(block.item), count: toolActivityCount(block.item), subjects: [] })
      } else if (row.block.item.role !== 'assistant') {
        const item = row.block.item
        add({
          ...(item.role === 'system' ? { verb: 'Read', noun: 'note' } : toolCategory(item)),
          count: toolActivityCount(item),
          subjects: [],
        })
      }
    }
    for (const block of this.prefix)
      add({ ...toolCategory(block.item), count: toolActivityCount(block.item), subjects: [] }, -1)
    return [...counts.values()].filter((clause) => clause.count > 0)
  }
  @lazy get eventCount(): number {
    return this.clauses.reduce((sum, clause) => sum + clause.count, 0)
  }
  @lazy get summary(): string {
    const text = toolBatchTitleFromClauses(this.clauses)
    return text ? text[0]!.toLowerCase() + text.slice(1) : ''
  }
  @lazy get failures(): number {
    return (this.fold?.rows ?? []).reduce((sum, { row }) => {
      if (row.kind === 'tools')
        return (
          sum +
          (this.presentation?.run(rowIdentity(row))?.failures ??
            row.blocks.filter(
              (block) =>
                toolVerdict(block.result ?? block.item.toolResult, block.item.toolEffects) ===
                'err',
            ).length)
        )
      const block = this.presentation?.block(row.block.item.id) ?? row.block
      return (
        sum +
        (block.item.role === 'tool' &&
        toolVerdict(block.result ?? block.item.toolResult, block.item.toolEffects) === 'err'
          ? 1
          : 0)
      )
    }, 0)
  }
  @lazy get eventPhrase(): string {
    const block = this.firstEvent
    if (!block) return 'Working'
    const subject = toolSubject(block.item, Infinity)
    return block.item.toolName === 'Bash' && subject
      ? subject
      : toolBatchTitleFromClauses([
          {
            ...toolCategory(block.item),
            subjects: subject ? [subject] : [],
            count: toolActivityCount(block.item),
          },
        ])
  }
  /** Only the opened list reads member identities; collapsed runs never read blocks. */
  @lazy({ equals: compareShallow }) get members(): readonly TurnMember[] {
    const members: TurnMember[] = []
    for (const { row, index } of this.fold?.rows ?? []) {
      if (row.kind === 'tools') {
        const run = this.presentation?.run(rowIdentity(row))
        const skip = row === this.row ? this.leadingNotes : 0
        if (run)
          for (const [at, id] of run.ids.slice(skip).entries()) {
            const block = row.blocks[skip + at]!
            members.push({
              id,
              index,
              block,
              key: streamItemIdOf(block.item),
              blockIndex: this.presentation?.blockIndex?.(id),
            })
          }
        else
          for (const [at, block] of row.blocks.slice(skip).entries())
            members.push({
              id: block.item.id,
              index,
              block,
              key: streamItemIdOf(block.item),
              blockIndex: row.blockIndices[skip + at],
            })
      } else
        members.push({
          id: row.block.item.id,
          index: row.blockIndex < 0 ? -1 : index,
          block: row.block,
          key: streamItemIdOf(row.block.item),
          blockIndex: row.blockIndex,
        })
    }
    return members
  }
}
