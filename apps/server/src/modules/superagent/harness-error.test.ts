import { describe, expect, it } from 'vitest'
import { classifyHarnessError } from './harness-error'

describe('classifyHarnessError', () => {
  it("classifies the user's rmcp transport crash as mcp-transport, NOT auth", () => {
    // The exact shape reported in POD-1021.
    const raw =
      'harness exited 1: 2026-07-19T06:35:29.979605Z ERROR rmcp::transport::worker: ' +
      'worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)'
    const r = classifyHarnessError(raw, 'codex')
    expect(r.kind).toBe('mcp-transport')
    expect(r.message).toMatch(/Podium's tool endpoint/)
    expect(r.message).toMatch(/not your Codex account/)
    // Must NOT be mistaken for a login problem despite "AuthorizationRequired".
    expect(r.message).not.toMatch(/codex login/)
  })

  it('classifies a provider 429 as usage-limit with a wait/switch hint', () => {
    const r = classifyHarnessError('harness exited 1: stream error: 429 Too Many Requests', 'codex')
    expect(r.kind).toBe('usage-limit')
    expect(r.message).toMatch(/usage limit/i)
    expect(r.message).toMatch(/reset|switch/i)
  })

  it('classifies an explicit "usage limit reached" message as usage-limit', () => {
    const r = classifyHarnessError("You've hit your usage limit for this plan.", 'codex')
    expect(r.kind).toBe('usage-limit')
  })

  it('classifies a model-side login expiry as provider-auth with a re-auth hint', () => {
    const r = classifyHarnessError(
      'harness exited 1: error: 401 Unauthorized — access token is expired',
      'codex',
    )
    // rmcp is absent, so this is the provider login case, not mcp-transport.
    expect(r.kind).toBe('provider-auth')
    expect(r.message).toMatch(/codex login/)
  })

  it('classifies a timeout', () => {
    expect(classifyHarnessError('turn timed out', 'codex').kind).toBe('timeout')
  })

  it('classifies a missing CLI', () => {
    expect(classifyHarnessError('codex: command not found', 'codex').kind).toBe('not-installed')
  })

  it('falls back to a trimmed unknown message and strips timestamps/noise', () => {
    const r = classifyHarnessError(
      'harness exited 2: 2026-07-19T06:35:29.979605Z something weird happened',
      'grok',
    )
    expect(r.kind).toBe('unknown')
    expect(r.message).toMatch(/^The Grok turn failed:/)
    // Timestamp stripped by shorten().
    expect(r.message).not.toMatch(/2026-07-19T06:35/)
  })

  it('names the provider per harness', () => {
    expect(classifyHarnessError('429', 'claude-code').message).toMatch(/Claude/)
    expect(classifyHarnessError('429', 'grok').message).toMatch(/Grok/)
  })
})
