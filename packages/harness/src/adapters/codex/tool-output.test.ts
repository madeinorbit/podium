import { describe, expect, it } from 'vitest'
import { codexToolOutput } from './tool-output.js'

describe('Codex native result framing', () => {
  it('separates the measured chunk metadata from command output before applying the display cap', () => {
    const output = codexToolOutput(
      'Chunk ID: abc123\nWall time: 0.125 seconds\nProcess exited with code 0\nOriginal token count: 420\nFinal output:\n' +
        'x'.repeat(2100),
    )
    expect(output.toolResult).toBe('x'.repeat(2000))
    expect(output.toolExecution).toMatchObject({
      status: 'completed',
      exitCode: 0,
      durationMs: 125,
      output: { capture: 'truncated' },
    })
    expect(output.toolResult).not.toContain('Original token count')
  })
  it('keeps explicitly empty output distinct from a record cut inside execution metadata', () => {
    expect(codexToolOutput('Exit code: 0\nWall time: 0 seconds\nOutput:\n')).toMatchObject({
      toolResult: '',
      toolExecution: { status: 'completed', output: { capture: 'complete' } },
    })
    expect(
      codexToolOutput(
        'Chunk ID: 1072b2\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal t',
      ),
    ).toMatchObject({
      toolResult: '',
      toolExecution: { status: 'failed', exitCode: 1, output: { capture: 'unavailable' } },
    })
  })
  it('keeps the outer script status and its printed JSON separate from child outcomes', () => {
    const json = '{"exit_code":1,"output":"printed data"}'
    expect(
      codexToolOutput(`Script completed\nWall time: 0.2 seconds\nOutput:\n${json}`),
    ).toMatchObject({ toolResult: json, toolExecution: { status: 'completed', durationMs: 200 } })
    expect(codexToolOutput(json)).toMatchObject({ toolResult: json })
    expect(codexToolOutput(json).toolExecution?.status).toBeUndefined()
    expect(
      codexToolOutput(`Script failed\nWall time 0.2 seconds\nOutput:\nScript error:\nfailed`),
    ).toMatchObject({ toolResult: 'Script error:\nfailed', toolExecution: { status: 'failed' } })
  })
  it('unwraps exactly once and preserves arbitrary or unfamiliar results', () => {
    const printed = 'Exit code: 1\nWall time: 3 seconds\nOutput:\nuser text'
    expect(
      codexToolOutput(`Exit code: 0\nWall time: 1 seconds\nOutput:\n${printed}`).toolResult,
    ).toBe(printed)
    for (const text of [
      'Script completed\nOutput:\nraw',
      'Chunk ID: user-printed\nordinary output',
      ' \n',
    ])
      expect(codexToolOutput(text).toolResult).toBe(text)
  })
  it('preserves explicitly running command status without manufacturing an exit code', () => {
    const item = codexToolOutput(
      'Chunk ID: abc123\nWall time: 0.1 seconds\nProcess running with session ID 42\nOutput:\nstill working',
    )
    expect(item).toMatchObject({
      toolResult: 'still working',
      toolExecution: { status: 'running' },
    })
    expect(item.toolExecution?.exitCode).toBeUndefined()
  })
})
