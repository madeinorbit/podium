import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { pairToolResults, toolBatchTitles } from './chat'
import { beforeExecutionInputs } from './execution-before.test.fixture'
import { toolExecutionSections, toolExecutionView } from './tool-execution'

const call = (id: string, commands = ['pwd']): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolUseId: id,
  toolName: commands.length > 1 ? 'Script' : 'Bash',
  toolInput: 'preview',
  toolExecution: {
    kind: 'commands',
    inputs: commands.map((text) => ({
      kind: 'command',
      toolName: 'Bash',
      text,
      capture: 'complete',
    })),
  },
})
const result = (
  id: string,
  text: string,
  capture: 'complete' | 'truncated' | 'unavailable' = 'complete',
): TranscriptItem => ({
  id: `${id}:result`,
  role: 'tool',
  text: '',
  toolUseId: id,
  toolResult: text,
  toolExecution: { output: { capture }, status: 'completed' },
})

describe('shared execution presentation', () => {
  it('pairs result facts without losing inputs and counts every listed command', () => {
    const [block] = pairToolResults([
      call('script', ['pwd', 'git status --short', 'bun --version']),
      result('script', ''),
    ])
    expect(block?.execution?.inputs.map((input) => input.text)).toEqual([
      'pwd',
      'git status --short',
      'bun --version',
    ])
    expect(block?.execution?.output.label).toBe('No output')
    expect(toolBatchTitles([block!]).summary).toBe('3 commands')
  })
  it('reserves No output for an explicitly confirmed empty captured result', () => {
    expect(toolExecutionView({ item: call('a') })?.output.label).toBe('Output unavailable')
    expect(toolExecutionView({ item: { ...call('a'), toolResult: '' } })?.output.label).toBe(
      'Output unavailable',
    )
    expect(
      pairToolResults([call('a'), result('a', '', 'unavailable')])[0]?.execution?.output.label,
    ).toBe('Output not captured')
    expect(
      pairToolResults([call('a'), result('a', 'more', 'truncated')])[0]?.execution?.output.label,
    ).toBe('Partial output')
  })
  it('preserves the former disclosure inputs when adapters supply typed facts', () => {
    for (const commands of [['pwd'], ['pwd', 'git status --short']]) {
      const previous = {
        ...call('a', commands),
        toolInputJson: JSON.stringify(
          commands.length === 1
            ? { kind: 'shell-command', command: commands[0] }
            : { kind: 'script-calls', calls: commands.map((input) => ({ tool: 'Bash', input })) },
        ),
      }
      const same = (candidate: TranscriptItem) =>
        expect(toolExecutionView({ item: candidate })?.inputs.map((input) => input.text)).toEqual(
          beforeExecutionInputs(previous),
        )
      same(previous)
      expect(() => same(call('a', ['wrong candidate']))).toThrow()
    }
  })
  it('keeps native batches separate inside one quiet stretch, with exact summary scope', () => {
    const a = { ...call('a'), toolBatch: { kind: 'message' as const, id: 'first' } }
    const b = { ...call('b'), toolBatch: { kind: 'message' as const, id: 'first' } }
    const c = { ...call('c'), toolBatch: { kind: 'message' as const, id: 'next' } }
    const blocks = pairToolResults([
      a,
      b,
      c,
      {
        id: 'summary',
        role: 'system',
        text: 'Inspect the workspace',
        systemKind: 'tool-summary',
        summarizes: ['a', 'b'],
      },
    ])
    const groups = toolExecutionSections(blocks)
    expect(groups.map((group) => group.blocks.map((block) => block.item.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    expect(groups[0]?.summary).toBe('Inspect the workspace')
    expect(groups[1]?.summary).toBeUndefined()
    expect(toolExecutionSections(blocks.slice(1))[0]?.summary).toBeUndefined()
    const wider = pairToolResults([
      a,
      b,
      c,
      {
        id: 'summary',
        role: 'system',
        text: 'Too broad',
        systemKind: 'tool-summary',
        summarizes: ['a', 'b', 'c'],
      },
    ])
    expect(toolExecutionSections(wider).every((group) => group.summary === undefined)).toBe(true)
  })
  it('does not promote command descriptions into a batch purpose', () => {
    const a = call('a')
    a.toolExecution!.inputs![0]!.description = 'Check the current directory'
    const groups = toolExecutionSections(pairToolResults([a, call('b')]))
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.summary === undefined)).toBe(true)
  })
})

it('keeps captured progress pending and honours completion even without retained text', async () => {
  const { isToolPending } = await import('./tool-execution')
  expect(
    isToolPending({
      item: {
        ...call('pending'),
        toolResult: 'progress',
        toolExecution: { ...call('pending').toolExecution, status: 'running' },
      },
    }),
  ).toBe(true)
  expect(
    isToolPending({
      item: {
        ...call('finished'),
        toolExecution: { ...call('finished').toolExecution, status: 'completed' },
      },
    }),
  ).toBe(false)
})
