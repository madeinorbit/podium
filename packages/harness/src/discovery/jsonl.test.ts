import { describe, expect, test } from 'vitest'
import { contentToText, dateField, mapConversationRole, parseJsonLines } from './jsonl.js'

const providerId = 'test-provider'
const path = '/fixtures/session.jsonl'

describe('parseJsonLines', () => {
  test('parses valid JSONL records and reports malformed lines as diagnostics', () => {
    const result = parseJsonLines('{"ok":true}\nnot-json\n{"ok":false}\n', {
      providerId,
      path,
      root: '/fixtures',
    })

    expect(result.records).toEqual([{ ok: true }, { ok: false }])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId,
        path,
        root: '/fixtures',
        message: 'Could not parse JSONL line 2 in /fixtures/session.jsonl',
      }),
    ])
  })
})

describe('mapConversationRole', () => {
  test('normalizes known agent roles into Podium roles', () => {
    expect(mapConversationRole('user')).toBe('user')
    expect(mapConversationRole('assistant')).toBe('assistant')
    expect(mapConversationRole('developer')).toBe('system')
    expect(mapConversationRole('system')).toBe('system')
    expect(mapConversationRole('tool')).toBe('tool')
    expect(mapConversationRole('unknown-role')).toBe('unknown')
    expect(mapConversationRole(undefined)).toBe('unknown')
  })
})

describe('contentToText', () => {
  test('normalizes string, text parts, tool results, and tool uses without serializing inputs', () => {
    expect(contentToText('hello')).toBe('hello')
    expect(
      contentToText([
        { type: 'text', text: 'first' },
        { type: 'tool_result', content: 'tool output' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/secret' } },
        { type: 'thinking', thinking: 'private reasoning' },
      ]),
    ).toBe('first\ntool output\n[tool_use:Read]')
  })
})

describe('dateField', () => {
  test('returns valid Date objects and ignores invalid dates', () => {
    expect(dateField({ timestamp: '2026-06-01T10:00:00.000Z' }, 'timestamp')?.toISOString()).toBe(
      '2026-06-01T10:00:00.000Z',
    )
    expect(dateField({ timestamp: 'not-a-date' }, 'timestamp')).toBeUndefined()
    expect(dateField({ timestamp: 123 }, 'timestamp')).toBeUndefined()
  })
})
