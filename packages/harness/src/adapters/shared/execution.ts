import type {
  TranscriptExecutionInput,
  TranscriptItem,
  TranscriptToolExecution,
} from '@podium/model'

/** Bounds apply to retained content, never to an inferred execution outcome. */
export const EXECUTION_INPUT_LIMIT = 24_000
export const EXECUTION_OUTPUT_LIMIT = 2_000
const INPUT_COUNT_LIMIT = 64

type InputSource = Omit<TranscriptExecutionInput, 'capture'> & {
  capture?: TranscriptExecutionInput['capture']
}

/** Called only after a driver has identified its native input vocabulary. */
export function executionInputs(inputs: readonly InputSource[]): TranscriptToolExecution {
  let remaining = EXECUTION_INPUT_LIMIT
  const retained: TranscriptExecutionInput[] = []
  for (const input of inputs.slice(0, INPUT_COUNT_LIMIT)) {
    const toolName = input.toolName.slice(0, 128)
    if (remaining < toolName.length || remaining === 0) break
    remaining -= toolName.length
    const description = input.description?.slice(0, Math.min(1_000, remaining))
    remaining -= description?.length ?? 0
    const text = input.text.slice(0, remaining)
    remaining -= text.length
    retained.push({
      kind: input.kind,
      toolName,
      text,
      ...(description ? { description } : {}),
      capture:
        text.length < input.text.length || input.capture === 'truncated'
          ? 'truncated'
          : (input.capture ?? 'complete'),
    })
  }
  const kind =
    inputs.length > 0 && inputs.every((input) => input.kind === 'command')
      ? 'commands'
      : inputs.length === 1 && inputs[0]?.kind === 'continuation'
        ? 'continuation'
        : 'actions'
  return {
    kind,
    inputs: retained,
    ...(retained.length < inputs.length ? { omittedInputs: inputs.length - retained.length } : {}),
  }
}

export function commandExecution(command: string, description?: string): TranscriptToolExecution {
  return executionInputs([
    { kind: 'command', toolName: 'Bash', text: command, ...(description ? { description } : {}) },
  ])
}

interface OutputFacts {
  status?: TranscriptToolExecution['status']
  exitCode?: number
  durationMs?: number
  truncated?: boolean
  note?: string
}

/** The caller supplies native output, without trimming it or guessing whether
 * arbitrary JSON printed by a command is a transport envelope. */
export function executionOutput(
  text: string | undefined,
  facts: OutputFacts = {},
): Pick<TranscriptItem, 'toolResult' | 'toolExecution'> {
  const clipped = text !== undefined && text.length > EXECUTION_OUTPUT_LIMIT
  const exitCode =
    typeof facts.exitCode === 'number' && Number.isSafeInteger(facts.exitCode)
      ? facts.exitCode
      : undefined
  const durationMs =
    typeof facts.durationMs === 'number' &&
    Number.isFinite(facts.durationMs) &&
    facts.durationMs >= 0
      ? facts.durationMs
      : undefined
  return {
    // Even a non-text result remains a result, so it pairs with its real owner.
    toolResult: text?.slice(0, EXECUTION_OUTPUT_LIMIT) ?? '',
    toolExecution: {
      ...(facts.status || exitCode !== undefined
        ? {
            status: facts.status ?? (exitCode === 0 ? ('completed' as const) : ('failed' as const)),
          }
        : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      output: {
        capture:
          text === undefined
            ? 'unavailable'
            : clipped || facts.truncated
              ? 'truncated'
              : 'complete',
        ...(facts.note ? { note: facts.note.slice(0, 1_000) } : {}),
      },
    },
  }
}

/** Only native text content is retained. Missing or media-only content is not
 * evidence that a command printed nothing; an explicit empty array is. */
export function executionText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    if (content.length === 0) return ''
    const texts = content.map(executionText).filter((text): text is string => text !== undefined)
    return texts.length ? texts.join('\n') : undefined
  }
  if (!content || typeof content !== 'object') return undefined
  const part = content as Record<string, unknown>
  if (typeof part.text === 'string') return part.text
  if (part.content !== undefined) return executionText(part.content)
  return undefined
}
