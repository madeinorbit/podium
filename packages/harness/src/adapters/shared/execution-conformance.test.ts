import { describe, expect, it } from 'vitest'
import { threadItemToItems } from '../../driver/families/codex/map.js'
import { partToItems } from '../../driver/families/opencode/map.js'
import { claudeRecordToItems } from '../claude-code/transcript.js'
import { codexRecordToItems } from '../codex/transcript.js'
import { grokRecordToItems } from '../grok/transcript.js'
import { type OpencodeMessagePartRow, opencodeRowsToItems } from '../opencode/transcript.js'
import { piRecordToItems } from '../pi/transcript.js'

const response = (payload: unknown) => ({ type: 'response_item', payload })
const row = (id: string, part: unknown): OpencodeMessagePartRow => ({
  sessionId: 'session',
  messageId: 'message',
  partId: id,
  timeCreated: 100,
  timeUpdated: 100,
  messageData: JSON.stringify({ role: 'assistant' }),
  partData: JSON.stringify(part),
})

describe('normalized execution ownership', () => {
  it('keeps a Claude description on its command and the real message batch', () => {
    const [a, b] = claudeRecordToItems({
      type: 'assistant',
      uuid: 'record',
      message: {
        id: 'native-message',
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'Bash',
            input: { command: 'pwd', description: 'Check working directory' },
          },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git status --short' } },
        ],
      },
    })
    expect(a?.toolExecution?.inputs?.[0]).toMatchObject({
      text: 'pwd',
      description: 'Check working directory',
    })
    expect(b?.toolExecution?.inputs?.[0]).not.toHaveProperty('description')
    expect(a?.toolBatch).toEqual({ id: 'native-message', kind: 'message' })
    expect(b?.toolBatch).toEqual(a?.toolBatch)
  })
  it('keeps many Codex script inputs under their single captured outer result', () => {
    const [call] = codexRecordToItems(
      response({
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'outer',
        input:
          'await Promise.all([tools.exec_command({cmd:"pwd"}), tools.exec_command({cmd:"git status --short"})])',
      }),
    )
    const [result] = codexRecordToItems(
      response({ type: 'custom_tool_call_output', call_id: 'outer', output: 'one outer result' }),
    )
    expect(call?.toolExecution?.inputs?.map((input) => input.text)).toEqual([
      'pwd',
      'git status --short',
    ])
    expect(call?.toolExecution?.kind).toBe('commands')
    expect(call?.toolExecution?.status).toBeUndefined()
    expect(result?.toolUseId).toBe(call?.toolUseId)
    expect(result?.toolResult).toBe('one outer result')
    expect(result?.toolExecution?.output?.capture).toBe('complete')
  })
  it('does not give a Codex continuation a new command count', () => {
    const [call] = codexRecordToItems(
      response({
        type: 'function_call',
        name: 'write_stdin',
        call_id: 'poll',
        arguments: '{"session_id":42}',
      }),
    )
    expect(call?.toolExecution?.kind).toBe('continuation')
  })
  it('keeps Codex app-server results on their individual command, including empty results', () => {
    const [item] = threadItemToItems(
      {
        type: 'commandExecution',
        id: 'cmd',
        command: 'true',
        status: 'completed',
        aggregatedOutput: '',
        exitCode: 0,
        durationMs: 18,
      },
      undefined,
    )
    expect(item?.toolResult).toBe('')
    expect(item?.toolExecution).toMatchObject({
      inputs: [{ text: 'true' }],
      status: 'completed',
      exitCode: 0,
      durationMs: 18,
      output: { capture: 'complete' },
    })
    const [missing] = threadItemToItems(
      {
        type: 'commandExecution',
        id: 'failed',
        command: 'false',
        status: 'failed',
        aggregatedOutput: null,
        exitCode: 1,
      },
      undefined,
    )
    expect(missing?.toolExecution?.output?.capture).toBe('unavailable')
  })
  it('retains Pi message batches and confirmed empty command results', () => {
    const [call] = piRecordToItems({
      type: 'message',
      id: 'batch',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'true' } }],
      },
    })
    const [result] = piRecordToItems({
      type: 'message',
      id: 'result',
      message: { role: 'toolResult', toolCallId: 'call', content: [], isError: false },
    })
    expect(call?.toolBatch).toEqual({ kind: 'message', id: 'batch' })
    expect(call?.toolExecution?.inputs?.[0]?.text).toBe('true')
    expect(result?.toolExecution?.output?.capture).toBe('complete')
    expect(result?.toolResult).toBe('')
  })
  it('retains Grok descriptions and native failure without inventing a batch', () => {
    const [call] = grokRecordToItems({
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call',
          title: 'run_terminal_command',
          rawInput: { command: 'false', description: 'Check the exit status' },
        },
      },
    })
    const [result] = grokRecordToItems({
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call',
          status: 'failed',
          rawOutput: { output_for_prompt: '' },
        },
      },
    })
    expect(call?.toolExecution?.inputs?.[0]?.description).toBe('Check the exit status')
    expect(call?.toolBatch).toBeUndefined()
    expect(result?.toolExecution).toMatchObject({
      status: 'failed',
      output: { capture: 'complete' },
    })
  })
  it('uses recorded OpenCode steps and keeps late output attached to its original step', () => {
    const start = { type: 'step-start' }
    const tool = {
      type: 'tool',
      tool: 'bash',
      callID: 'a',
      state: {
        status: 'completed',
        input: { command: 'true', description: 'Check a command' },
        output: '',
      },
    }
    const items = opencodeRowsToItems([
      row('step-a', start),
      row('tool-a', tool),
      row('step-b', start),
      row('tool-b', { ...tool, callID: 'b' }),
    ])
    expect(
      items
        .filter((item) => item.toolName && item.toolResult === undefined)
        .map((item) => item.toolBatch?.id),
    ).toEqual(['step-a', 'step-b'])
    expect(items[1]?.toolResult).toBe('')
    const context = { steps: new Map<string, string>(), parts: new Map() }
    const info = { id: 'message', sessionID: 'session', role: 'assistant' as const }
    partToItems(
      'session',
      info,
      { id: 'step-a', messageID: 'message', sessionID: 'session', type: 'step-start' },
      context,
    )
    const live = partToItems(
      'session',
      info,
      { ...tool, id: 'tool-a', messageID: 'message', sessionID: 'session' },
      context,
    )
    partToItems(
      'session',
      info,
      { id: 'step-b', messageID: 'message', sessionID: 'session', type: 'step-start' },
      context,
    )
    const late = partToItems(
      'session',
      info,
      { ...tool, id: 'tool-a', messageID: 'message', sessionID: 'session' },
      context,
    )
    expect(live[0]?.toolBatch).toEqual({ kind: 'step', id: 'step-a' })
    expect(late[0]?.toolBatch).toEqual(live[0]?.toolBatch)
    expect(opencodeRowsToItems([row('tool-a', tool)])[0]?.toolBatch).toBeUndefined()
  })
})

it('keeps an OpenCode partial output in progress until the native tool completes', () => {
  const items = opencodeRowsToItems([
    row('partial', {
      type: 'tool',
      tool: 'bash',
      callID: 'call',
      state: { status: 'running', input: { command: 'long-command' }, output: 'progress' },
    }),
  ])
  expect(items[1]?.toolExecution?.status).toBe('running')
  expect(items[1]?.toolResult).toBe('progress')
})
