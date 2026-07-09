import { describe, expect, it } from 'vitest'
import { claudeRecordColor, claudeRecordToItems, toolInputPreview } from './claude'

describe('claudeRecordColor', () => {
  it('reads agentColor from an agent-color record', () => {
    expect(claudeRecordColor({ type: 'agent-color', agentColor: 'green', sessionId: 's' })).toBe(
      'green',
    )
  })
  it('returns undefined for non-color records', () => {
    expect(claudeRecordColor({ type: 'assistant', message: {} })).toBeUndefined()
    expect(claudeRecordColor({ type: 'agent-color' })).toBeUndefined()
    expect(claudeRecordColor(null)).toBeUndefined()
  })
})

describe('claudeRecordToItems', () => {
  it('maps a plain string user prompt', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-06-12T10:00:00.000Z',
      message: { role: 'user', content: 'fix the bug' },
    })
    expect(items).toEqual([
      { id: 'u1', role: 'user', ts: '2026-06-12T10:00:00.000Z', text: 'fix the bug' },
    ])
  })

  it('maps an assistant turn with text + tool calls into separate items', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'a1', role: 'assistant', text: 'Let me look.' })
    expect(items[1]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'ls -la',
      toolUseId: 'toolu_1',
    })
  })

  it('surfaces the Bash description as toolTitle (used for the lone-command batch summary)', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a2',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Bash',
            input: {
              command: 'node render.mjs',
              description: 'Render the three chat-view mockups to PNG',
            },
          },
        ],
      },
    })
    expect(items[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: 'node render.mjs',
      toolTitle: 'Render the three chat-view mockups to PNG',
    })
  })

  it('omits toolTitle when the call has no description', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a3',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    })
    expect(items[0]).not.toHaveProperty('toolTitle')
  })

  it('maps tool results (user-typed records) to tool items linked by toolUseId', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    })
    expect(items).toEqual([
      {
        id: 'u2-result-toolu_1',
        role: 'tool',
        ts: undefined,
        text: '',
        toolResult: 'ok',
        toolUseId: 'toolu_1',
      },
    ])
  })

  it('tags image and document blocks on user messages', () => {
    const items = claudeRecordToItems({
      type: 'user',
      uuid: 'u3',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'see screenshot' },
          { type: 'image', source: { type: 'base64' } },
          { type: 'document', source: { title: 'spec.pdf' } },
        ],
      },
    })
    expect(items[0]).toMatchObject({
      role: 'user',
      text: 'see screenshot',
      tags: [{ kind: 'image' }, { kind: 'file', label: 'spec.pdf' }],
    })
  })

  it('skips sidechain records and bookkeeping types', () => {
    expect(
      claudeRecordToItems({ type: 'assistant', isSidechain: true, message: { content: [] } }),
    ).toEqual([])
    expect(claudeRecordToItems({ type: 'summary', summary: 'x' })).toEqual([])
    expect(claudeRecordToItems('garbage')).toEqual([])
  })

  it('skips isMeta records (skill-body / slash-command / continuation injections)', () => {
    // Claude Code marks injected, non-user-authored content with isMeta:true — a
    // skill body, a slash-command expansion, an auto "Continue…" prompt — and its
    // own UI hides them. They must not render as user messages in the chat view.
    expect(
      claudeRecordToItems({
        type: 'user',
        uuid: 'm1',
        isMeta: true,
        message: {
          role: 'user',
          content: 'Base directory for this skill: /…/brainstorming\n\n# Brainstorming…',
        },
      }),
    ).toEqual([])
    expect(
      claudeRecordToItems({
        type: 'user',
        uuid: 'm2',
        isMeta: true,
        message: { role: 'user', content: 'Continue from where you left off.' },
      }),
    ).toEqual([])
  })

  it('truncates huge tool results', () => {
    const items = claudeRecordToItems({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000) }],
      },
    })
    expect(items[0]?.toolResult?.length).toBeLessThanOrEqual(2001)
  })
})

describe('toolInputPreview', () => {
  it('prefers the human-meaningful field', () => {
    expect(toolInputPreview({ command: 'bun test', description: 'Run tests' })).toBe('bun test')
    expect(toolInputPreview({ file_path: '/a/b.ts' })).toBe('/a/b.ts')
  })
  it('falls back to compact JSON', () => {
    expect(toolInputPreview({ x: 1 })).toBe('{"x":1}')
  })
})

describe('claudeRecordToItems — injected vs real user turns', () => {
  it('drops isMeta synthetic turns (skill/command expansions, SessionStart context)', () => {
    const rec = {
      type: 'user',
      isMeta: true,
      uuid: 'm1',
      message: { role: 'user', content: 'Base directory for this skill: …\n<full skill body>' },
    }
    expect(claudeRecordToItems(rec)).toEqual([])
  })

  it('keeps a genuine user prompt that has an appended <system-reminder> as role "user"', () => {
    const rec = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: 'fix the chat view\n<system-reminder>As you answer…</system-reminder>',
      },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user' })
    expect(items[0]?.text).toContain('fix the chat view')
  })

  it('drops harness-injected pseudo-user turns (promptSource "system", e.g. task-notification)', () => {
    const rec = {
      type: 'user',
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      uuid: 'tn1',
      message: {
        role: 'user',
        content:
          '<task-notification>\n<task-id>abc</task-id>\nSubagent result…\n</task-notification>',
      },
    }
    expect(claudeRecordToItems(rec)).toEqual([])
  })

  it('keeps a real typed prompt (promptSource "typed")', () => {
    const rec = {
      type: 'user',
      promptSource: 'typed',
      uuid: 'u9',
      message: { role: 'user', content: 'do the thing' },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]?.role).toBe('user')
  })

  it('still renders tool_result records even though they are type:"user"', () => {
    const rec = {
      type: 'user',
      promptSource: 'system',
      uuid: 'tr1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'tool', toolResult: 'ok' })
  })

  it('strips a prepended <system-reminder> and keeps the real prompt (e.g. "Yes")', () => {
    const rec = {
      type: 'user',
      promptSource: 'queued',
      uuid: 'q1',
      message: {
        role: 'user',
        content:
          '<system-reminder>Message sent at Sun 2026-06-14 20:37:24 UTC.</system-reminder>\nYes',
      },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', text: 'Yes' })
    expect(items[0]?.text).not.toContain('system-reminder')
  })

  it('drops a user turn that is wholly a <system-reminder> (no real prompt left)', () => {
    const rec = {
      type: 'user',
      uuid: 'sr1',
      message: {
        role: 'user',
        content: '<system-reminder>Background context…</system-reminder>\n',
      },
    }
    expect(claudeRecordToItems(rec)).toEqual([])
  })

  it('flags a user interrupt as an event but keeps role "user" (recognized, not reclassified)', () => {
    const rec = {
      type: 'user',
      uuid: 'int1',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', event: 'interrupt' })
  })
})

describe('claudeRecordToItems — final answer vs intermediate narration', () => {
  const asst = (stop_reason: string, text: string) => ({
    type: 'assistant',
    uuid: `a-${stop_reason}`,
    message: { role: 'assistant', stop_reason, content: [{ type: 'text', text }] },
  })

  it('marks turn-ending assistant text (stop_reason end_turn) as answer:true', () => {
    const [item] = claudeRecordToItems(asst('end_turn', 'Here is the final answer.'))
    expect(item).toMatchObject({ role: 'assistant', answer: true })
  })

  it('treats stop_sequence the same as end_turn', () => {
    const [item] = claudeRecordToItems(asst('stop_sequence', 'Done.'))
    expect(item?.answer).toBe(true)
  })

  it('does NOT mark intermediate narration (stop_reason tool_use) as answer', () => {
    const [item] = claudeRecordToItems(asst('tool_use', 'Let me check that now…'))
    expect(item).toMatchObject({ role: 'assistant' })
    expect(item?.answer).toBeUndefined()
  })

  it('ignores thinking blocks (no text item from a thinking-only record)', () => {
    const rec = {
      type: 'assistant',
      uuid: 'a-think',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }],
      },
    }
    expect(claudeRecordToItems(rec)).toEqual([])
  })
})

describe('claudeRecordToItems — AskUserQuestion tool', () => {
  it('carries the structured question input and previews the question text', () => {
    const rec = {
      type: 'assistant',
      uuid: 'a-ask',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Pick a mode?',
                  header: 'Mode',
                  multiSelect: false,
                  options: [
                    { label: 'A', description: 'first' },
                    { label: 'B', description: 'second' },
                  ],
                },
              ],
            },
          },
        ],
      },
    }
    const [item] = claudeRecordToItems(rec)
    expect(item).toMatchObject({
      role: 'tool',
      toolName: 'AskUserQuestion',
      toolInput: 'Pick a mode?',
    })
    expect(JSON.parse(item?.toolInputJson ?? '{}').questions[0].options).toHaveLength(2)
  })

  it('leaves ordinary tools without toolInputJson', () => {
    const rec = {
      type: 'assistant',
      uuid: 'a-bash',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }],
      },
    }
    const [item] = claudeRecordToItems(rec)
    expect(item?.toolInputJson).toBeUndefined()
    expect(item).toMatchObject({ toolName: 'Bash', toolInput: 'ls' })
  })
})

describe('claudeRecordToItems toolPaths', () => {
  it('extracts file_path from a tool_use block', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }],
      },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/a.ts'))).toBe(true)
  })

  it('extracts an @-mention file attachment path', () => {
    const items = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'file', filename: '/repo/spec.md', displayPath: 'spec.md' },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/spec.md'))).toBe(true)
  })

  it('extracts an edited_text_file attachment path', () => {
    const items = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'edited_text_file', filename: '/repo/b.ts', snippet: '...' },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/b.ts'))).toBe(true)
  })

  // Duplicate-key guard: two attachment records for the SAME file (e.g. first an
  // @-mention 'file', then a 'compact_file_reference') must produce DIFFERENT ids
  // so React does not warn about duplicate keys in the chat view.
  it('produces distinct ids for two attachment records with the same filename', () => {
    const filename = '/repo/spec.md'
    const [item1] = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'file', filename },
    })
    const [item2] = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'compact_file_reference', filename },
    })
    expect(item1).toBeDefined()
    expect(item2).toBeDefined()
    expect(item1!.id).not.toBe(item2!.id)
    // Both must still carry the filename in toolPaths
    expect(item1!.toolPaths).toContain(filename)
    expect(item2!.toolPaths).toContain(filename)
  })

  it('maps a turn_duration system record to a duration item (Churned for…)', () => {
    const items = claudeRecordToItems({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'd1',
      timestamp: '2026-06-18T14:29:53.029Z',
      durationMs: 479963,
    })
    expect(items).toEqual([
      {
        id: 'd1',
        role: 'system',
        ts: '2026-06-18T14:29:53.029Z',
        text: '',
        systemKind: 'duration',
        durationMs: 479963,
      },
    ])
  })

  it('maps an away_summary system record to a recap item', () => {
    const items = claudeRecordToItems({
      type: 'system',
      subtype: 'away_summary',
      uuid: 's1',
      content: 'Fixed the title bug. (disable recaps in /config)',
    })
    expect(items[0]).toMatchObject({
      role: 'system',
      systemKind: 'recap',
      text: 'Fixed the title bug. (disable recaps in /config)',
    })
  })

  it('keeps other content-bearing system records as plain system items', () => {
    const items = claudeRecordToItems({
      type: 'system',
      subtype: 'informational',
      uuid: 's2',
      content: 'Remote Control disconnected',
    })
    expect(items[0]).toMatchObject({ role: 'system', text: 'Remote Control disconnected' })
    expect(items[0]!.systemKind).toBeUndefined()
  })

  it('carries SendUserFile paths (the files array) into toolPaths', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      uuid: 'a9',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_suf',
            name: 'SendUserFile',
            input: { files: ['/tmp/a.png', '/tmp/b.png'], caption: 'shots', status: 'normal' },
          },
        ],
      },
    })
    expect(items[0]).toMatchObject({ role: 'tool', toolName: 'SendUserFile' })
    expect(items[0]!.toolPaths).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })
})
