import type { TranscriptExecutionInput, TranscriptItem } from '@podium/model'
import type { ChatBlock } from './chat'

/** Render facts for one execution. Inputs share the canonical item's retained
 * strings; a result belongs to this execution, never to an inferred child. */
export interface ToolExecutionView {
  readonly inputs: readonly TranscriptExecutionInput[]
  readonly omittedInputs: number
  readonly kind: 'commands' | 'actions' | 'continuation'
  readonly count: number
  readonly label: string
  readonly output: {
    readonly text: string | undefined
    readonly capture: 'complete' | 'truncated' | 'unavailable' | 'unknown'
    readonly label: string
    readonly note: string | undefined
    readonly lines: number
  }
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted' | 'returned' | 'unknown'
  readonly exitCode: number | undefined
  readonly durationMs: number | undefined
}

/** Native APIs can update a call in place with its result. Retained inputs
 * establish that this remains the call; result-only records have no inputs. */
export function isToolResultOnly(item: TranscriptItem): boolean {
  return (
    item.role === 'tool' && item.toolResult !== undefined && !item.toolExecution?.inputs?.length
  )
}

/** A captured progress result does not finish an explicitly running tool. */
export function isToolPending(block: ChatBlock): boolean {
  const status = block.execution?.status ?? block.item.toolExecution?.status
  if (status === 'running') return true
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'returned'
  )
    return false
  return block.result === undefined && block.item.toolResult === undefined
}

/** A paired result adds outcome/capture facts without replacing the call's
 * inputs or recorded batch. Used by both the snapshot and incremental graph. */
export function withToolResult(call: TranscriptItem, result: TranscriptItem): TranscriptItem {
  const execution = result.toolExecution
  if (!execution && !result.toolEffects) return call
  return {
    ...call,
    ...(result.toolEffects ? { toolEffects: result.toolEffects } : {}),
    ...(execution
      ? {
          toolExecution: {
            ...call.toolExecution,
            ...execution,
            // A result without a native outcome still retires an in-progress state.
            status:
              execution.status ??
              (call.toolExecution?.status === 'running' ? undefined : call.toolExecution?.status),
          },
        }
      : {}),
  }
}

export function toolExecutionView(block: ChatBlock): ToolExecutionView | undefined {
  const { item } = block
  const source = item.toolExecution
  const inputs =
    source?.inputs ??
    ((item.toolName === 'Bash' || item.toolName === 'bash') && item.toolInput !== undefined
      ? [
          {
            kind: 'command' as const,
            toolName: 'Bash',
            text: item.toolInput,
            ...(item.toolTitle ? { description: item.toolTitle } : {}),
            capture: 'unknown' as const,
          },
        ]
      : undefined)
  if (!inputs?.length) return undefined
  const kind = source?.kind ?? 'commands'
  const omittedInputs = source?.omittedInputs ?? 0
  const count = inputs.length + omittedInputs
  const label =
    kind === 'continuation'
      ? 'Command continuation'
      : `${count} ${kind === 'commands' ? (count === 1 ? 'command' : 'commands') : count === 1 ? 'action' : 'actions'}`
  const text = block.result ?? item.toolResult
  const capture = source?.output?.capture ?? 'unknown'
  const outputLabel =
    capture === 'truncated'
      ? 'Partial output'
      : capture === 'complete' && text === ''
        ? 'No output'
        : text
          ? 'Output'
          : capture === 'unavailable'
            ? 'Output not captured'
            : 'Output unavailable'
  const note =
    source?.output?.note ??
    (capture === 'truncated'
      ? 'Output was truncated when recorded. Only the retained text is available.'
      : capture === 'unavailable'
        ? 'No text output was retained for this execution.'
        : text && !text.trim()
          ? 'The captured output contains only whitespace.'
          : !text && capture === 'unknown'
            ? 'The transcript does not establish whether output was returned.'
            : undefined)
  return {
    inputs,
    omittedInputs,
    kind,
    count,
    label,
    output: {
      text,
      capture,
      label: outputLabel,
      note,
      lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
    },
    status: item.toolEffects?.some((effect) => effect.kind === 'termination' && effect.interrupted)
      ? 'interrupted'
      : item.toolEffects?.some(
            (effect) => effect.kind === 'termination' && effect.timedOutAfterMs !== undefined,
          )
        ? 'failed'
        : (source?.status ?? (text !== undefined ? 'returned' : 'unknown')),
    exitCode: source?.exitCode,
    durationMs: source?.durationMs ?? item.durationMs,
  }
}

export interface ToolExecutionSection {
  readonly id: string
  readonly blocks: readonly ChatBlock[]
  readonly batchKind?: 'message' | 'step'
  readonly summary?: string
}

/** Quiet adjacency is only a presentation fold. Inside it, native batch ids
 * and exact summary membership delimit groups; descriptions never name them. */
export function toolExecutionSections(blocks: readonly ChatBlock[]): ToolExecutionSection[] {
  const available = new Set(
    blocks.flatMap((block) => (block.item.toolUseId ? [block.item.toolUseId] : [])),
  )
  const summaryKeys = new Map<string, string>()
  const seenSummaries = new Set<string>()
  for (const block of blocks) {
    const summary = block.harnessSummary
    if (summary && seenSummaries.has(summary.id)) continue
    if (summary) seenSummaries.add(summary.id)
    if (!summary?.toolUseIds?.length || !summary.toolUseIds.every((id) => available.has(id)))
      continue
    for (const id of summary.toolUseIds) summaryKeys.set(id, summary.id)
  }
  const sections: {
    id: string
    blocks: ChatBlock[]
    batchKind?: 'message' | 'step'
    summary?: string
  }[] = []
  for (const block of blocks) {
    const batch = block.item.toolBatch
    const summaryKey = block.item.toolUseId ? summaryKeys.get(block.item.toolUseId) : undefined
    const key = batch
      ? `${batch.kind}:${batch.id}`
      : summaryKey
        ? `summary:${summaryKey}`
        : `item:${block.item.id}`
    const previous = sections.at(-1)
    if (previous?.id === key) previous.blocks.push(block)
    else sections.push({ id: key, blocks: [block], ...(batch ? { batchKind: batch.kind } : {}) })
  }
  for (const section of sections) {
    const summary = section.blocks[0]?.harnessSummary
    if (!summary?.toolUseIds?.length) continue
    const members = new Set(section.blocks.map((block) => block.item.toolUseId))
    if (
      members.size === summary.toolUseIds.length &&
      summary.toolUseIds.every((id) => members.has(id)) &&
      section.blocks.every((block) => block.harnessSummary?.id === summary.id)
    )
      section.summary = summary.text
  }
  return sections
}
