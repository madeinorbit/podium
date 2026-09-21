import { describe, expect, it } from 'vitest'
import { claudeCodeInstrumentation } from './instrumentation.js'

const base = { session_id: 'cc1', transcript_path: '/nonexistent.jsonl', cwd: '/tmp' }

/** Hook payload fixtures decode through the section, not past it (POD-4472). */
describe('claudeCodeInstrumentation.payloadCodec', () => {
  const codec = claudeCodeInstrumentation.payloadCodec

  it('reads the snake_case routing fields', () => {
    const payload = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' }
    expect(codec.eventName(payload)).toBe('UserPromptSubmit')
    expect(codec.sessionId(payload)).toBe('cc1')
    expect(codec.transcriptPath(payload)).toBe('/nonexistent.jsonl')
    expect(codec.eventName(null)).toBeUndefined()
  })

  it('decodes lifecycle events with the hook channel', async () => {
    await expect(codec.decode({ ...base, hook_event_name: 'SessionStart' })).resolves.toEqual([
      { kind: 'session_started', source: 'hook', confidence: 1 },
    ])
    await expect(
      codec.decode({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    ).resolves.toEqual([{ kind: 'prompt_submitted', source: 'hook', confidence: 1 }])
    await expect(codec.decode({ ...base, hook_event_name: 'SessionEnd' })).resolves.toEqual([
      { kind: 'session_ended', source: 'hook', confidence: 1 },
    ])
    await expect(codec.decode(null)).resolves.toEqual([])
  })

  it('declares the loopback transport', () => {
    expect(claudeCodeInstrumentation.hookTransport).toBe('loopback-http')
  })

  it('installs per-session settings wiring that carries the endpoint', async () => {
    const installed = await claudeCodeInstrumentation.install({
      sessionId: 's1' as never,
      endpointUrl: 'http://127.0.0.1:1/hooks/s1',
      settingsDir: '/settings',
    })
    expect(installed.args).toEqual(['--settings', '/settings/s1.json'])
    expect(installed.file?.path).toBe('/settings/s1.json')
    expect(installed.file?.contents).toContain('http://127.0.0.1:1/hooks/s1')
    expect(installed.degradedReason).toBeUndefined()
  })
})
