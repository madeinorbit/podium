import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { batchDigests, distillTranscript } from './pspec-import-distill'

const HEADER = { conversationId: 'conv-1', agentKind: 'claude-code', date: '2026-07-01' }

function item(partial: Partial<TranscriptItem> & { role: TranscriptItem['role'] }): TranscriptItem {
  return { id: Math.random().toString(36).slice(2), text: '', ...partial }
}

describe('distillTranscript', () => {
  it('keeps user messages with surrounding assistant context, drops tools', () => {
    const items = [
      item({ role: 'assistant', text: 'Should exports be CSV or JSON? I lean CSV.' }),
      item({ role: 'user', text: 'CSV, and always include headers.' }),
      item({ role: 'assistant', text: 'Got it — CSV with headers. Implementing now.' }),
      item({ role: 'assistant', toolName: 'Bash', toolInput: 'ls', text: '' }),
      item({ role: 'tool', toolResult: 'HUGE OUTPUT'.repeat(1000), text: '' }),
    ]
    const digest = distillTranscript(items, HEADER)
    expect(digest).toContain('USER: CSV, and always include headers.')
    expect(digest).toContain('> agent: Should exports be CSV or JSON?')
    expect(digest).toContain('> agent then: Got it — CSV with headers')
    expect(digest).not.toContain('HUGE OUTPUT')
  })

  it('extracts AskUserQuestion Q&A pairs', () => {
    const items = [
      item({
        role: 'assistant',
        toolName: 'AskUserQuestion',
        toolUseId: 'tu1',
        toolInputJson: JSON.stringify({
          questions: [
            { question: 'Which auth method?', options: [{ label: 'OIDC' }, { label: 'SAML' }] },
          ],
        }),
      }),
      item({ role: 'tool', toolUseId: 'tu1', toolResult: '"Which auth method?"="OIDC"', text: '' }),
      item({ role: 'user', text: 'also make sessions last 30 days' }),
    ]
    const digest = distillTranscript(items, HEADER)
    expect(digest).toContain('Q: Which auth method?')
    expect(digest).toContain('options: OIDC | SAML')
    expect(digest).toContain('A: "Which auth method?"="OIDC"')
  })

  it('truncates pasted blobs in user messages', () => {
    const blob = Array.from({ length: 100 }, (_, i) => `log line ${i}`).join('\n')
    const digest = distillTranscript([item({ role: 'user', text: blob })], HEADER)
    expect(digest).toContain('log line 29')
    expect(digest).not.toContain('log line 30\n')
    expect(digest).toContain('[70 more lines truncated]')
  })

  it('returns null for sessions with no user input', () => {
    const items = [
      item({ role: 'assistant', text: 'working…' }),
      item({ role: 'user', text: '[Request interrupted by user]', event: 'interrupt' }),
    ]
    expect(distillTranscript(items, HEADER)).toBeNull()
  })
})

describe('batchDigests', () => {
  it('packs greedily and never drops oversized digests', () => {
    const batches = batchDigests(['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(200)], 100)
    expect(batches).toHaveLength(3)
    expect(batches.flat()).toHaveLength(3)
  })
})
