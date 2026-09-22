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

  it('classifies Claude monthly spend exhaustion as usage-limit, not expired auth', () => {
    const spend = classifyHarnessError("You've hit your monthly spend limit", 'claude-code')
    expect(spend.kind).toBe('usage-limit')
    expect(spend.message).not.toMatch(/login|expired/i)
    const expired = classifyHarnessError(
      '401 Unauthorized — access token is expired',
      'claude-code',
    )
    expect(expired.kind).toBe('provider-auth')
    expect(expired.message).not.toMatch(/usage limit/i)
  })

  it('classifies a model-side login expiry as provider-auth with a generic sign-in hint when the descriptor carries no command', () => {
    const r = classifyHarnessError(
      'harness exited 1: error: 401 Unauthorized — access token is expired',
      'codex',
    )
    // rmcp is absent, so this is the provider login case, not mcp-transport.
    // codex carries no login.command in its descriptor (absence is a value),
    // so the hint is generic — never another harness's command.
    expect(r.kind).toBe('provider-auth')
    expect(r.message).toMatch(/re-authenticate Codex/i)
    expect(r.message).not.toMatch(/codex login/)
  })

  it('reads the re-auth command off the served descriptor when present', () => {
    const opencode = classifyHarnessError(
      'harness exited 1: error: 401 Unauthorized — access token is expired',
      'opencode',
    )
    expect(opencode.kind).toBe('provider-auth')
    expect(opencode.message).toMatch(/opencode auth login/)
    const pi = classifyHarnessError(
      'harness exited 1: error: 401 Unauthorized — access token is expired',
      'pi',
    )
    expect(pi.kind).toBe('provider-auth')
    expect(pi.message).toMatch(/run `pi`/)
  })

  it('never borrows another harness command when the descriptor carries none', () => {
    const r = classifyHarnessError(
      'harness exited 1: error: 401 Unauthorized — access token is expired',
      'claude-code',
    )
    expect(r.kind).toBe('provider-auth')
    expect(r.message).toMatch(/re-authenticate Claude/i)
    expect(r.message).not.toMatch(/opencode auth login/)
    expect(r.message).not.toMatch(/cursor-agent login/)
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
