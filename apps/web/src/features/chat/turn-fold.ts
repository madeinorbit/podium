import type { ChatRow, RenderableRow } from '@podium/client-core/values'
import {
  isInteractiveTool,
  isOperatorQuestion,
  transcriptActivityFacts,
} from '@podium/client-core/values'
import { action, observable } from 'mobx'
import { formatWorkDuration, parseTs, rowTimestamp } from './transcript-time'
import { rowIdentity } from './use-feed-arrivals'

export interface TurnFold {
  /** The first work row owns the line throughout append, pause and settlement. */
  readonly key: string
  readonly boundary: number | undefined
  readonly start: number
  readonly anchor: number
  readonly rows: readonly RenderableRow[]
  readonly members: readonly number[]
  readonly memberKeys: readonly string[]
  readonly asks: ReadonlySet<number>
  readonly narration: string | undefined
  readonly narrationRow: ChatRow | undefined
  readonly updates: number
  readonly state: 'live' | 'paused' | 'done' | 'stopped'
  readonly startedAt: string | undefined
  readonly endedAt: string | undefined
  readonly durationMs: number | undefined
  readonly ending: number | undefined
  readonly questionSeam: boolean
}

export interface TurnFolds {
  readonly folds: readonly TurnFold[]
  readonly byMember: ReadonlyMap<number, TurnFold>
  readonly byKey: ReadonlyMap<string, TurnFold>
  readonly byStart: ReadonlyMap<string, TurnFold>
  readonly absorbed: ReadonlySet<number>
  readonly standIns: ReadonlySet<number>
  readonly endings: ReadonlySet<number>
  readonly trailing: TurnFold | undefined
}

export const NO_FOLDS: TurnFolds = {
  folds: [],
  byMember: new Map(),
  byKey: new Map(),
  byStart: new Map(),
  absorbed: new Set(),
  standIns: new Set(),
  endings: new Set(),
  trailing: undefined,
}

export function isProcessRow(row: ChatRow): boolean {
  if (row.kind === 'tools') return row.blocks.some((block) => block.item.role === 'tool')
  const { item } = row.block
  return item.role === 'assistant' ? !item.answer : item.role === 'tool' && !isInteractiveTool(item)
}

export const rowHasText = (row: ChatRow): boolean =>
  row.kind === 'block' && row.block.item.text.trim() !== ''

export function isReplyRow(row: ChatRow): boolean {
  return (
    row.kind === 'block' &&
    transcriptActivityFacts(row.block.item).envelopes?.envelopes.some(isOperatorQuestion) === true
  )
}

const answer = (row: ChatRow) =>
  row.kind === 'block' && row.block.item.role === 'assistant' && row.block.item.answer === true
const interrupt = (row: ChatRow) =>
  row.kind === 'block' && row.block.item.role === 'user' && row.block.item.event === 'interrupt'
const duration = (row: ChatRow) =>
  row.kind === 'block' &&
  row.block.item.role === 'system' &&
  row.block.item.systemKind === 'duration'
const question = (row: ChatRow) => row.kind === 'block' && isInteractiveTool(row.block.item)
const pending = (row: ChatRow) =>
  row.kind === 'block' && row.block.result === undefined && row.block.item.toolResult === undefined

export function foldable(row: ChatRow, isPrompt: (row: ChatRow) => boolean): boolean {
  if (question(row) || answer(row) || interrupt(row) || duration(row) || isPrompt(row)) return false
  return row.kind === 'tools' || row.block.item.role !== 'user' || !isPrompt(row)
}

/** POD-2285's segments, including the trailing live segment from its first event.
 * Narrow retained facts keep streaming text out of this structural derivation. */
export function turnFolds(
  rows: readonly RenderableRow[],
  isPrompt: (row: ChatRow) => boolean,
  hasText: (row: ChatRow) => boolean = rowHasText,
  hasWork: (row: ChatRow) => boolean = isProcessRow,
  isPending: (row: ChatRow) => boolean = pending,
  startedAt: (row: ChatRow) => string | undefined = (row) =>
    row.kind === 'tools'
      ? row.blocks.find((block) => block.item.role === 'tool')?.item.ts
      : row.block.item.ts,
): TurnFolds {
  const folds: TurnFold[] = []
  const byMember = new Map<number, TurnFold>()
  const byKey = new Map<string, TurnFold>()
  const byStart = new Map<string, TurnFold>()
  const absorbed = new Set<number>()
  const standIns = new Set<number>()
  const endings = new Set<number>()
  let segment: number[] = []
  let boundary: string | undefined
  let boundaryIndex: number | undefined
  const update = (row: ChatRow) =>
    row.kind === 'block' &&
    row.block.item.role === 'assistant' &&
    !row.block.item.answer &&
    hasText(row)

  const settle = (closer: number | undefined, state: TurnFold['state']) => {
    const first = segment.findIndex((pos) => hasWork(rows[pos]!.row))
    const work = first < 0 ? [] : segment.slice(first)
    segment = []
    const kept = state === 'stopped' ? work.findLast((pos) => update(rows[pos]!.row)) : undefined
    const members = work.filter((pos) => pos !== kept && foldable(rows[pos]!.row, isPrompt))
    if (!work.length) return
    if (kept !== undefined) {
      standIns.add(rows[kept]!.index)
      endings.add(rows[kept]!.index)
    }
    const start = rows[work[0]!]!
    const end = closer === undefined ? undefined : rows[closer]!
    let durationMs: number | undefined
    if (state === 'done' && closer !== undefined) {
      for (let pos = closer + 1; pos < rows.length; pos++) {
        const row = rows[pos]!.row
        if (duration(row)) {
          if (row.kind === 'block') durationMs = row.block.item.durationMs
          absorbed.add(rows[pos]!.index)
          break
        }
        if (isPrompt(row) || hasWork(row) || answer(row) || question(row)) break
      }
    }
    const from = parseTs(startedAt(start.row))
    const to = end === undefined ? undefined : rowTimestamp(end.row)
    if (durationMs === undefined && from && to && to >= from)
      durationMs = to.getTime() - from.getTime()
    const latest = work.findLast((pos) => update(rows[pos]!.row))
    const fold: TurnFold = {
      key: boundary === undefined ? rowIdentity(start.row) : `${boundary}:work`,
      boundary: boundaryIndex,
      start: start.index,
      anchor: start.index,
      rows: members.map((pos) => rows[pos]!),
      members: members.map((pos) => rows[pos]!.index),
      memberKeys: members.map((pos) => rowIdentity(rows[pos]!.row)),
      asks: new Set(
        members.filter((pos) => isReplyRow(rows[pos]!.row)).map((pos) => rows[pos]!.index),
      ),
      narration: latest === undefined ? undefined : rowIdentity(rows[latest]!.row),
      narrationRow: latest === undefined ? undefined : rows[latest]!.row,
      updates: members.filter((pos) => update(rows[pos]!.row)).length,
      state,
      startedAt: from?.toISOString(),
      endedAt: to?.toISOString(),
      durationMs,
      ending: end?.index,
      questionSeam: end !== undefined && question(end.row),
    }
    folds.push(fold)
    byKey.set(fold.key, fold)
    byStart.set(rowIdentity(start.row), fold)
    for (const index of fold.members) byMember.set(index, fold)
    if (end && answer(end.row)) endings.add(end.index)
  }

  for (const [pos, { row }] of rows.entries()) {
    if (isPrompt(row)) {
      settle(pos, 'done')
      segment = []
      boundary = rowIdentity(row)
      boundaryIndex = rows[pos]!.index
    } else if (duration(row)) {
      settle(pos, 'done')
      segment = []
      boundary = rowIdentity(row)
      boundaryIndex = rows[pos]!.index
    } else if (answer(row)) {
      settle(pos, 'done')
      boundary = rowIdentity(row)
      boundaryIndex = rows[pos]!.index
    } else if (interrupt(row)) {
      settle(pos, 'stopped')
      boundary = rowIdentity(row)
      boundaryIndex = rows[pos]!.index
    } else if (question(row)) {
      settle(pos, isPending(row) ? 'paused' : 'done')
      boundary = rowIdentity(row)
      boundaryIndex = rows[pos]!.index
    } else segment.push(pos)
  }
  settle(undefined, 'live')
  return { folds, byMember, byKey, byStart, absorbed, standIns, endings, trailing: folds.at(-1) }
}

export const FOLD_GEOMETRY_EVENT = 'podium-transcript-fold-geometry'

export function foldLead(
  fold: Pick<TurnFold, 'durationMs' | 'state'> & { failed?: boolean },
): string {
  const verb = fold.failed
    ? 'Failed after'
    : fold.state === 'stopped'
      ? 'Stopped after'
      : 'Worked for'
  return fold.durationMs === undefined
    ? verb.replace(/ (for|after)$/, '')
    : `${verb} ${formatWorkDuration(fold.durationMs)}`
}

/** Only deliberate disclosure persists. Forced search/reveal opens are temporary. */
export class TurnFoldState {
  readonly opened = observable.set<string>()
  @observable accessor primed = false
  isOpen(key: string): boolean {
    return this.opened.has(key)
  }
  @action prime(): void {
    this.primed = true
  }
  @action open(key: string): void {
    this.opened.add(key)
  }
  @action toggle(key: string): void {
    if (this.opened.has(key)) this.opened.delete(key)
    else this.opened.add(key)
  }
}

export interface FoldLine {
  readonly fold: TurnFold
  readonly open: boolean
  readonly expanded: boolean
}
export interface FoldLayout {
  readonly hidden: ReadonlySet<number>
  readonly lines: ReadonlyMap<number, FoldLine>
}

export function foldLayout(
  folds: TurnFolds,
  state: TurnFoldState,
  forced: readonly (number | undefined)[],
  everyOpen = false,
): FoldLayout {
  const hidden = new Set(folds.absorbed)
  const lines = new Map<number, FoldLine>()
  const force = new Set(
    forced.map((index) => (index === undefined ? undefined : folds.byMember.get(index)?.key)),
  )
  for (const fold of folds.folds) {
    const open = everyOpen || state.isOpen(fold.key) || force.has(fold.key)
    // A single owner renders the flat list. Original row indices remain the
    // addresses for search and minimap; operator asks also retain their own row.
    for (const index of fold.members)
      if (index !== fold.start && !fold.asks.has(index)) hidden.add(index)
    lines.set(fold.start, { fold, open, expanded: open })
  }
  return { hidden, lines }
}
