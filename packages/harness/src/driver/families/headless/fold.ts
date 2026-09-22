// packages/harness/src/driver/families/headless/fold.ts
//
// READING A ONE-SHOT TURN'S OUTPUT (POD-4614).
//
// Two readers over the same stdout lines, per the adapter's declared output
// format: the LIVE one turns each line into the turn events a waiting caller
// sees while the turn runs (session id, tool activity, cumulative partial
// text), and the FINAL one folds the whole stdout into the outcome once the
// host reports the child's exit. Moved from apps/daemon/src/durable-headless.ts,
// where they read an abduco runner's journal files; they read the host ring
// now, a line at a time, and are the same readers whether the daemon watched
// the turn live or replayed it after a restart.

import { createPiStreamReducer } from '../../../registry.js'
import type { HarnessHeadless } from '../../../manifest.js'
import { HeadlessTurnError, type HeadlessEmit, type HeadlessTurnOutcome } from './types.js'

type OutputFormat = HarnessHeadless['outputFormat']

export interface HeadlessProgressReader {
  line(line: string): void
}

/**
 * Translate stdout lines into the same live events every one-shot driver
 * emits. Only JSON-line formats stream; `text` output (grok, cursor) has no
 * partial events — its whole stdout is the answer, reported at exit.
 */
export function createHeadlessProgressReader(
  outputFormat: OutputFormat,
  emit: HeadlessEmit,
): HeadlessProgressReader {
  let partialText = ''
  let partialItem = ''
  let opencodeText = ''
  const pi = outputFormat === 'pi-jsonl' ? createPiStreamReducer() : undefined

  const emitPartial = (text: string, itemHint?: string): void => {
    if (!text || (text === partialText && itemHint === partialItem)) return
    partialText = text
    partialItem = itemHint ?? ''
    emit({
      kind: 'partial-text',
      text,
      ...(itemHint ? { itemHint } : {}),
    })
  }

  const parseLine = (line: string): void => {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    if (pi) {
      const effect = pi.push(event)
      if (!effect) return
      if (effect.sessionId) {
        emit({ kind: 'status', status: 'running', harnessSessionId: effect.sessionId })
      }
      if (effect.toolLabel) emit({ kind: 'status', status: 'tool', label: effect.toolLabel })
      if (effect.partialText) emitPartial(effect.partialText, effect.itemHint)
      return
    }

    if (outputFormat === 'claude-stream-json') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
      if (event.type === 'system' && event.subtype === 'init') {
        emit({
          kind: 'status',
          status: 'running',
          ...(sessionId ? { harnessSessionId: sessionId } : {}),
        })
        return
      }
      if (event.type === 'stream_event') {
        const stream = event.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined
        if (stream?.type === 'message_start') {
          partialText = ''
          partialItem = ''
        } else if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
          emitPartial(
            partialText + (stream.delta.text ?? ''),
            typeof event.uuid === 'string' ? event.uuid : undefined,
          )
        }
        return
      }
      if (event.type === 'assistant') {
        const message = event.message as
          | { content?: Array<{ type?: string; text?: string; name?: string }> }
          | undefined
        const content = message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_use') {
            emit({ kind: 'status', status: 'tool', label: block.name ?? 'tool' })
          }
        }
        const text = content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('')
        emitPartial(text, typeof event.uuid === 'string' ? event.uuid : undefined)
      }
      return
    }

    if (outputFormat === 'codex-jsonl') {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        emit({
          kind: 'status',
          status: 'running',
          harnessSessionId: event.thread_id,
        })
        return
      }
      const item = event.item as
        | { id?: string; type?: string; text?: string; name?: string }
        | undefined
      if (event.type === 'item.started' && item?.type && item.type !== 'agent_message') {
        emit({
          kind: 'status',
          status: 'tool',
          label: item.name ?? item.type,
        })
      } else if (event.type === 'item.completed' && item?.type === 'agent_message') {
        emitPartial(item.text ?? '', item.id)
      }
      return
    }

    if (outputFormat === 'opencode-jsonl') {
      const sessionId = typeof event.sessionID === 'string' ? event.sessionID : undefined
      if (sessionId) {
        emit({ kind: 'status', status: 'running', harnessSessionId: sessionId })
      }
      const part = event.part as { type?: string; text?: string } | undefined
      if (event.type === 'text' && part?.type === 'text') {
        opencodeText += part.text ?? ''
        emitPartial(opencodeText)
      }
    }
  }

  return { line: parseLine }
}

/**
 * Fold a finished turn's whole stdout into its outcome, or throw the turn's
 * failure — carrying the harness session id whenever one is known, so an
 * errored turn never orphans its conversation.
 */
export function foldHeadlessOutcome(input: {
  outputFormat: OutputFormat
  stdout: string
  stderrTail: string
  exitCode: number
  /** The conversation the turn was pinned to before it ran, when known. */
  pinnedSessionId?: string
  /** Names the harness in the "no session id" failure. */
  agent: string
}): HeadlessTurnOutcome {
  const { outputFormat, stdout, exitCode } = input
  const stderr = input.stderrTail.trim()
  let harnessSessionId = input.pinnedSessionId ?? ''
  let output = ''
  let piError: string | undefined

  if (outputFormat === 'claude-stream-json') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          subtype?: string
          /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
          session_id?: string
          result?: string
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (event.session_id) harnessSessionId = event.session_id
        if (event.type === 'result' && typeof event.result === 'string') output = event.result
        if (event.type === 'assistant') {
          const text = event.message?.content
            ?.filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
          if (text) output = text
        }
      } catch {}
    }
  } else if (outputFormat === 'codex-jsonl') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          /** UNBRANDED BY DECISION: a provider/harness-native thread id, not a Podium messaging ThreadId. */
          thread_id?: string
          item?: { type?: string; text?: string }
        }
        if (event.type === 'thread.started' && event.thread_id) {
          harnessSessionId = event.thread_id
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          output = event.item.text ?? output
        }
      } catch {}
    }
  } else if (outputFormat === 'opencode-jsonl') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          sessionID?: string
          part?: { type?: string; text?: string }
        }
        if (event.sessionID) harnessSessionId = event.sessionID
        if (event.type === 'text' && event.part?.type === 'text') {
          output += event.part.text ?? ''
        }
      } catch {}
    }
    output = output.trim()
  } else if (outputFormat === 'pi-jsonl') {
    const reducer = createPiStreamReducer()
    for (const line of stdout.split('\n')) reducer.pushLine(line)
    const result = reducer.result()
    if (result.sessionId) harnessSessionId = result.sessionId
    output = result.output
    piError = result.error
  } else {
    output = stdout.trim()
  }

  if (exitCode !== 0) {
    throw new HeadlessTurnError(
      `harness exited ${Number.isNaN(exitCode) ? 'unknown' : exitCode}${stderr ? `: ${stderr.slice(-2000)}` : ''}`,
      harnessSessionId || undefined,
    )
  }
  // pi exits 0 on a provider/agent error; the verdict lives in its event stream.
  if (piError) throw new HeadlessTurnError(piError, harnessSessionId || undefined)
  if (!harnessSessionId) {
    throw new HeadlessTurnError(`${input.agent} turn ended without reporting a session id`)
  }
  return { harnessSessionId, output }
}
