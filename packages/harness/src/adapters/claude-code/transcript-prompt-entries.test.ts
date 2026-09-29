import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { claudeRecordToItems } from './transcript.js'

/**
 * USER RECORDS NOBODY TYPED (POD-4877). Claude 2.1.284 writes several `user`
 * records that are not a person's prompt (POD-4862 lane,
 * docs/measurements/pod-4834-receipt-proof/claude-2.1.284/results.md point 4).
 * None of them may come out of the reader as a `user` item: the chat would show
 * it as the person's words, and the send proof would count it as a prompt entry
 * (it passes a waiting send, or it becomes the "last prompt entry" order credit
 * is measured from). The records below are the lane's own, trimmed.
 */
const LANE = fileURLToPath(
  new URL(
    '../../../../../docs/measurements/pod-4834-receipt-proof/claude-2.1.284/',
    import.meta.url,
  ),
)

const promptEntries = (record: unknown) =>
  claudeRecordToItems(record).filter((item) => transcriptEchoAcceptCorrelation.accepts(item))

describe('Claude user records that are not a prompt entry', () => {
  it('shows the compaction summary as a system note, not as the person', () => {
    const items = claudeRecordToItems({
      type: 'user',
      promptId: '9bbde1c5-3843-4859-83d3-faa74f48355e',
      uuid: '179d28f0-8e9a-4b95-9d4d-90618f457f84',
      timestamp: '2026-09-29T16:19:21.604Z',
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      message: {
        role: 'user',
        content:
          'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nr62w1 r62w2 r62w3\n\nContinue the conversation from where it left off without asking the user any further questions.',
      },
    })
    expect(items).toEqual([
      {
        id: '179d28f0-8e9a-4b95-9d4d-90618f457f84',
        role: 'system',
        ts: '2026-09-29T16:19:21.604Z',
        text: expect.stringContaining('r62w1 r62w2 r62w3'),
      },
    ])
  })

  it('shows a slash command as a system note carrying the command as typed', () => {
    const custom = {
      type: 'user',
      promptId: 'd862c26c-096c-4adf-88ab-8cd47d8675c9',
      uuid: '916b94c9-a2bf-446b-a404-342c53aade85',
      timestamp: '2026-09-29T16:17:46.473Z',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content:
          '<command-message>cmdx</command-message>\n<command-name>/cmdx</command-name>\n<command-args>CMDARG-A15</command-args>',
      },
    }
    expect(claudeRecordToItems(custom)).toEqual([
      {
        id: '916b94c9-a2bf-446b-a404-342c53aade85',
        role: 'system',
        ts: '2026-09-29T16:17:46.473Z',
        text: '/cmdx CMDARG-A15',
      },
    ])
    const builtIn = {
      type: 'user',
      uuid: '3a80aa28-f6e4-44ca-afdf-72d3e3d8545b',
      timestamp: '2026-09-29T16:19:21.406Z',
      message: {
        role: 'user',
        content:
          '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
      },
    }
    expect(claudeRecordToItems(builtIn)).toEqual([
      expect.objectContaining({ role: 'system', text: '/compact' }),
    ])
  })

  it("shows a local command's output as a system note without terminal colour codes", () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: '9b81d6ff-4f55-49d2-8373-dac374afcf26',
      timestamp: '2026-09-29T16:19:21.771Z',
      message: {
        role: 'user',
        content:
          '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n\u001b[2mPreCompact [hook.sh PreCompact] completed successfully\u001b[22m</local-command-stdout>',
      },
    })
    expect(items).toEqual([
      {
        id: '9b81d6ff-4f55-49d2-8373-dac374afcf26',
        role: 'system',
        ts: '2026-09-29T16:19:21.771Z',
        text: 'Compacted (ctrl+o to see full summary)\nPreCompact [hook.sh PreCompact] completed successfully',
      },
    ])
    // A command that printed nothing leaves nothing to show.
    expect(
      claudeRecordToItems({
        type: 'user',
        uuid: 'empty-out',
        message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' },
      }),
    ).toEqual([])
  })

  it('keeps the other records nobody typed out of the prompt entries', () => {
    const records = [
      // Stop-hook feedback
      {
        type: 'user',
        uuid: 'a',
        isMeta: true,
        message: { role: 'user', content: 'Stop hook feedback:\nSTOPFEEDBACK please say done' },
      },
      // The caveat Claude writes ahead of a local command's records
      {
        type: 'user',
        uuid: 'b',
        isMeta: true,
        message: {
          role: 'user',
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
        },
      },
      // A custom command's expansion
      {
        type: 'user',
        uuid: 'c',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Reply to CMDX: CMDARG-A15\n' }] },
      },
      // A background task's completion
      {
        type: 'user',
        uuid: 'd',
        promptSource: 'system',
        origin: { kind: 'task-notification', producer: 'session-task' },
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>bfyg02xy4</task-id>\n</task-notification>',
        },
      },
      // The synthetic tool result written at the first submit after a resume
      {
        type: 'user',
        uuid: 'e',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content:
                "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]",
              is_error: true,
              tool_use_id: 'toolu_x',
            },
          ],
        },
      },
      // Interrupt markers, both wordings
      {
        type: 'user',
        uuid: 'f',
        message: { role: 'user', content: '[Request interrupted by user]' },
      },
      {
        type: 'user',
        uuid: 'g',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      },
    ]
    for (const record of records) expect(promptEntries(record), record.uuid).toEqual([])
  })

  it("reads exactly the person's submits as prompt entries from the lane's transcripts", () => {
    for (const lane of ['tui', 'sdk']) {
      const directory = join(LANE, lane, 'transcripts')
      for (const file of readdirSync(directory).filter(
        (name) => name.endsWith('.jsonl') && name !== 'history.jsonl',
      )) {
        const expected: string[] = []
        const actual: string[] = []
        for (const line of readFileSync(join(directory, file), 'utf8')
          .split('\n')
          .filter(Boolean)) {
          const record = JSON.parse(line) as Record<string, unknown>
          const attachment = record.attachment as Record<string, unknown> | undefined
          const content = (record.message as Record<string, unknown> | undefined)?.content
          // A submit: a typed, queued or SDK prompt; a prompt taken in at a tool
          // boundary; and the plain record a built-in slash command writes with
          // the words as typed (`/compact`, no promptSource).
          const submit =
            (record.type === 'user' &&
              (['typed', 'queued', 'sdk'].includes(record.promptSource as string) ||
                (record.promptSource === undefined &&
                  typeof content === 'string' &&
                  /^\/\S+$/.test(content)))) ||
            (record.type === 'attachment' &&
              attachment?.type === 'queued_command' &&
              attachment.commandMode === 'prompt' &&
              (attachment.origin as Record<string, unknown> | undefined)?.kind === 'human')
          if (submit) expected.push(record.uuid as string)
          for (const item of promptEntries(record)) actual.push(item.id)
        }
        expect(actual, `${lane}/${file}`).toEqual(expected)
        expect(expected.length, `${lane}/${file}`).toBeGreaterThan(0)
      }
    }
  })
})
