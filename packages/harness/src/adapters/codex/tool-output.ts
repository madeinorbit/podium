import type { TranscriptToolExecution } from '@podium/model'
import { executionOutput, executionText } from '../shared/execution.js'

type Outcome = {
  status?: TranscriptToolExecution['status']
  exitCode?: number
  durationMs?: number
}

/** Only complete, anchored native framing is decoded. JSON printed by a
 * command, including JSON describing another tool's result, stays literal. */
export function codexToolOutput(value: unknown): ReturnType<typeof executionOutput> {
  const text = executionText(value)
  if (text === undefined) return executionOutput(undefined)
  // Rollout fixtures carry both the unified-exec chunk frame and apply_patch's
  // exit/wall-time frame. The script frame belongs to the outer code-mode run.
  const chunk =
    /^Chunk ID: [A-Za-z0-9_-]+\r?\nWall time: (\d+(?:\.\d+)?) seconds\r?\n(?:Process exited with code (-?\d+)|Process running with session ID [A-Za-z0-9_-]+)\r?\n/.exec(
      text,
    )
  if (chunk) {
    const facts: Outcome = {
      durationMs: Number(chunk[1]) * 1000,
      ...(chunk[2] !== undefined ? { exitCode: Number(chunk[2]) } : { status: 'running' }),
    }
    const remainder = text.slice(chunk[0].length)
    const separator =
      /^(?:Original token count: \d+\r?\n)?(?:Final output|Output):(?:\r?\n|$)/.exec(remainder)
    if (separator) return executionOutput(remainder.slice(separator[0].length), facts)
    // The bounded native corpus includes frames cut off inside this metadata
    // line. That is no evidence of empty command output.
    if (remainder === '' || /^Original t(?:oken count: ?\d*)?$/.test(remainder))
      return executionOutput(undefined, {
        ...facts,
        note: 'The record contains execution details, but no command output was retained.',
      })
    return executionOutput(text, {
      ...facts,
      note: 'This retained result includes execution details that could not be separated from its output.',
    })
  }
  const exited =
    /^Exit code: (-?\d+)\r?\nWall time: (\d+(?:\.\d+)?) seconds\r?\nOutput:(?:\r?\n|$)/.exec(text)
  if (exited)
    return executionOutput(text.slice(exited[0].length), {
      exitCode: Number(exited[1]),
      durationMs: Number(exited[2]) * 1000,
    })
  const script =
    /^Script (completed|failed)\r?\nWall time:?\s*(\d+(?:\.\d+)?) seconds\r?\nOutput:(?:\r?\n|$)/.exec(
      text,
    )
  if (script)
    return executionOutput(text.slice(script[0].length), {
      status: script[1] === 'failed' ? 'failed' : 'completed',
      durationMs: Number(script[2]) * 1000,
    })
  return executionOutput(text)
}
