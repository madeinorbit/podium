import { describe, expect, it } from 'vitest'
import { claudeRecordToItems, toolInputPreview } from './claude.js'

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
        content: '<task-notification>\n<task-id>abc</task-id>\nSubagent result…\n</task-notification>',
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
        content: '<system-reminder>Message sent at Sun 2026-06-14 20:37:24 UTC.</system-reminder>\nYes',
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
      message: { role: 'user', content: '<system-reminder>Background context…</system-reminder>\n' },
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
