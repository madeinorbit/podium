import { access } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/model'
import { fileTranscript, supported } from '../../manifest.js'
import { commandExecution, executionOutput } from '../shared/execution.js'
import { contentToText, isRecord, stringField } from '../shared/json-util.js'
import { transcriptPath } from './paths.js'

export function antigravityUserText(text: string): string {
  return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u.exec(text)?.[1] ?? text
}

export function antigravityRecordToItems(raw: unknown, previousRecord?: unknown): TranscriptItem[] {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.step_index)) return []
  const id = `agy:${String(raw.step_index)}`
  const ts = stringField(raw, 'created_at')
  const stamp = ts ? { ts } : {}
  const content = contentToText(raw.content)
  if (raw.type === 'USER_INPUT' && (raw.source === 'USER_EXPLICIT' || raw.source === 'USER')) {
    const text = antigravityUserText(content)
    return text ? [{ id, role: 'user', text, ...stamp }] : []
  }
  const items: TranscriptItem[] = []
  if (raw.type === 'PLANNER_RESPONSE') {
    if (content)
      items.push({
        id,
        role: 'assistant',
        text: content,
        ...stamp,
        ...(raw.status === 'DONE' && (!Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0)
          ? { answer: true }
          : {}),
      })
    if (Array.isArray(raw.tool_calls)) {
      for (const [index, call] of raw.tool_calls.entries()) {
        if (!isRecord(call) || typeof call.name !== 'string') continue
        const args = isRecord(call.args) ? call.args : {}
        const command = stringField(args, 'CommandLine')
        const toolUseId = stringField(call, 'id') ?? `${id}:tool:${index}`
        items.push({
          id: toolUseId,
          role: 'tool',
          text: '',
          toolName: call.name,
          toolUseId,
          toolInput: JSON.stringify(args).slice(0, 16_000),
          ...stamp,
          ...(command
            ? { toolExecution: commandExecution(command, stringField(args, 'toolSummary')) }
            : {}),
        })
      }
    }
    return items
  }
  if (raw.type === 'SYSTEM_MESSAGE')
    return content ? [{ id, role: 'system', text: content, ...stamp }] : []
  if (content && raw.type !== 'CONVERSATION_HISTORY') {
    // Native generic results have no call ID. Only a directly preceding,
    // single-call planner record establishes an unambiguous owner.
    const calls =
      isRecord(previousRecord) &&
      previousRecord.type === 'PLANNER_RESPONSE' &&
      previousRecord.step_index === Number(raw.step_index) - 1 &&
      Array.isArray(previousRecord.tool_calls)
        ? previousRecord.tool_calls
        : []
    const owner = calls.length === 1 && isRecord(calls[0]) ? calls[0] : undefined
    const toolUseId = owner
      ? (stringField(owner, 'id') ?? `agy:${String(Number(raw.step_index) - 1)}:tool:0`)
      : undefined
    const failed = raw.status === 'ERROR' || raw.status === 'INVALID'
    const exit = /^Command exited with code (-?\d+)\.$/mu.exec(content)?.[1]
    return [
      {
        id,
        role: 'tool',
        text: '',
        toolName: (owner && stringField(owner, 'name')) ?? stringField(raw, 'type') ?? 'tool',
        ...(toolUseId ? { toolUseId } : {}),
        ...executionOutput(content, {
          ...(failed ? { status: 'failed' as const } : {}),
          ...(exit !== undefined ? { exitCode: Number(exit) } : {}),
        }),
        ...stamp,
      },
    ]
  }
  if (raw.status === 'ERROR' || raw.status === 'INVALID')
    return [
      {
        id,
        role: 'system',
        text: stringField(raw, 'error') ?? 'Antigravity step failed',
        ...stamp,
      },
    ]
  return []
}

export const antigravityTranscript = supported(
  fileTranscript(
    async (input) => {
      if (!input.resumeValue) return []
      const full = transcriptPath(input.account.roots.state, input.resumeValue)
      if (!full) return []
      for (const path of [full, full.replace('transcript_full.jsonl', 'transcript.jsonl')]) {
        try {
          await access(path)
          return [path]
        } catch {
          /* Try the other native log. */
        }
      }
      return []
    },
    antigravityRecordToItems,
    (raw) => {
      if (!isRecord(raw)) return {}
      const model = stringField(raw, 'model')
      const effort = model ? /-(low|medium|high|xhigh|max)$/u.exec(model)?.[1] : undefined
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    },
  ),
)
