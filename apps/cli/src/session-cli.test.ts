import { describe, expect, it, vi } from 'vitest'
import { parseSessionArgs, runSessionCli, type SessionControlClient } from './session-cli'

function client(result: { ok: boolean; queued?: boolean; reason?: string } = { ok: true }) {
  return {
    sessions: {
      sendText: { mutate: vi.fn(async () => result) },
      resumeAndSend: { mutate: vi.fn(async () => result) },
      continue: { mutate: vi.fn(async () => result) },
    },
  } satisfies SessionControlClient
}

describe('podium session CLI', () => {
  it('parses boolean flags without consuming positionals', () => {
    expect(parseSessionArgs(['send', '--wake', 's1', '--text', 'hello'])).toEqual({
      command: 'send',
      args: { wake: true, text: 'hello' },
      positionals: ['s1'],
    })
  })

  it('sends a real turn to a running session', async () => {
    const c = client()
    await expect(runSessionCli(['send', 's1', '--text', 'hello'], c)).resolves.toBe('sent')
    expect(c.sessions.sendText.mutate).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello' })
    expect(c.sessions.resumeAndSend.mutate).not.toHaveBeenCalled()
  })

  it('wake-send uses the durable resumeAndSend path', async () => {
    const c = client({ ok: true, queued: true })
    await expect(runSessionCli(['send', 's1', '--text', 'continue', '--wake'], c)).resolves.toBe(
      'queued for delivery',
    )
    expect(c.sessions.resumeAndSend.mutate).toHaveBeenCalledWith({
      sessionId: 's1',
      text: 'continue',
    })
  })

  it('continue uses the phase-gated session operation', async () => {
    const c = client()
    await expect(runSessionCli(['continue', 's1'], c)).resolves.toBe('continued')
    expect(c.sessions.continue.mutate).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('surfaces a rejected session operation', async () => {
    await expect(
      runSessionCli(
        ['send', 's1', '--text', 'hello'],
        client({ ok: false, reason: 'not running' }),
      ),
    ).rejects.toThrow('not running')
  })

  it('help documents direct, wake, and continue semantics', async () => {
    const out = await runSessionCli(['help'], client())
    expect(out).toContain('send <session-id>')
    expect(out).toContain('resume-and-send')
    expect(out).toContain('continue <session-id>')
  })
})
