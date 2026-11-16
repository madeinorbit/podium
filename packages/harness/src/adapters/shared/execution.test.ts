import { describe, expect, it } from 'vitest'
import {
  commandExecution,
  EXECUTION_INPUT_LIMIT,
  EXECUTION_OUTPUT_LIMIT,
  executionInputs,
  executionOutput,
  executionText,
} from './execution.js'

describe('retained execution facts', () => {
  it('retains multiline inputs without converting previews into full commands', () => {
    const command = 'python3 - <<\'PY\'\nprint("hello")\nPY'
    expect(commandExecution(command, 'Print a greeting').inputs).toEqual([
      {
        kind: 'command',
        toolName: 'Bash',
        text: command,
        description: 'Print a greeting',
        capture: 'complete',
      },
    ])
  })
  it('bounds many inputs and records omissions without inventing child outcomes', () => {
    const result = executionInputs(
      Array.from({ length: 100 }, () => ({
        kind: 'command' as const,
        toolName: 'Bash',
        text: 'x'.repeat(20_000),
      })),
    )
    expect(result.inputs).toHaveLength(2)
    expect(result.omittedInputs).toBe(98)
    expect(result.inputs?.reduce((n, input) => n + input.text.length, 0)).toBeLessThan(
      EXECUTION_INPUT_LIMIT,
    )
    expect(result.inputs?.[1]?.capture).toBe('truncated')
    expect(
      executionInputs(
        Array.from({ length: 100 }, () => ({ kind: 'command', toolName: 'Bash', text: 'pwd' })),
      ).omittedInputs,
    ).toBe(36)
    expect(result.status).toBeUndefined()
    expect(result.output).toBeUndefined()
  })
  it('counts a process continuation as a continuation, not another command', () => {
    expect(
      executionInputs([{ kind: 'continuation', toolName: 'Bash', text: 'command session 42' }])
        .kind,
    ).toBe('continuation')
    expect(executionInputs([]).kind).toBe('actions')
  })
  it('distinguishes empty, whitespace-only, missing and clipped text', () => {
    expect(executionOutput('').toolExecution?.output?.capture).toBe('complete')
    expect(executionOutput(' \n').toolResult).toBe(' \n')
    expect(executionOutput(undefined).toolExecution?.output?.capture).toBe('unavailable')
    const clipped = executionOutput('x'.repeat(EXECUTION_OUTPUT_LIMIT + 10))
    expect(clipped.toolResult).toBe('x'.repeat(EXECUTION_OUTPUT_LIMIT))
    expect(clipped.toolExecution?.output?.capture).toBe('truncated')
    expect(executionOutput('{"status":"failed","output":"user data"}').toolResult).toBe(
      '{"status":"failed","output":"user data"}',
    )
    expect(executionOutput('Error: this is a string example').toolExecution?.status).toBeUndefined()
  })
  it('keeps native outcome, duration and capture independently', () => {
    expect(executionOutput('', { exitCode: 7, durationMs: 52 }).toolExecution).toMatchObject({
      status: 'failed',
      exitCode: 7,
      durationMs: 52,
      output: { capture: 'complete' },
    })
    expect(executionOutput(undefined, { status: 'interrupted' }).toolExecution).toMatchObject({
      status: 'interrupted',
      output: { capture: 'unavailable' },
    })
    expect(executionOutput('', { exitCode: NaN, durationMs: -1 }).toolExecution).not.toHaveProperty(
      'exitCode',
    )
  })
  it('does not call missing or media-only content empty output', () => {
    expect(executionText(undefined)).toBeUndefined()
    expect(executionText([{ type: 'image', source: {} }])).toBeUndefined()
    expect(executionText([])).toBe('')
    expect(executionText([{ type: 'text', text: '' }])).toBe('')
    expect(executionText([{ type: 'text', text: '\nhello\n' }])).toBe('\nhello\n')
  })
})
