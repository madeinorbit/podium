import { describe, expect, it } from 'vitest'
import {
  availableDriverIds,
  resolveRuntimeDriver,
  selectionAuthForLogin,
} from './registry'

const base = {
  agentKind: 'claude-code' as const,
  platform: 'linux' as const,
  auth: 'unknown' as const,
}

describe('Claude SDK runtime selection', () => {
  it('keeps the interactive PTY default even when the SDK is admitted', () => {
    expect(
      resolveRuntimeDriver({
        ...base,
        requested: undefined,
        machineDefault: undefined,
        available: ['claude-pty', 'generic-pty', 'claude-sdk'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-pty' })
  })

  it('does not let a machine default opt every Claude session into the SDK', () => {
    expect(
      resolveRuntimeDriver({
        ...base,
        requested: undefined,
        machineDefault: 'claude-sdk',
        available: ['claude-pty', 'generic-pty', 'claude-sdk'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-pty' })
  })

  it('only an explicit per-spawn SDK request overrides a machine default', () => {
    const selectedByMachineDefault = resolveRuntimeDriver({
      ...base,
      requested: undefined,
      machineDefault: 'claude-sdk',
      available: ['claude-pty', 'generic-pty', 'claude-sdk'],
    })
    expect(selectedByMachineDefault).toEqual({ ok: true, driverId: 'claude-pty' })

    const selectedExplicitly = resolveRuntimeDriver({
      ...base,
      requested: 'claude-sdk',
      machineDefault: 'claude-sdk',
      available: ['claude-pty', 'generic-pty', 'claude-sdk'],
    })
    expect(selectedExplicitly).toEqual({ ok: true, driverId: 'claude-sdk' })
  })

  it('accepts an explicit per-spawn SDK request without a separate admission flag', () => {
    expect(
      resolveRuntimeDriver({
        ...base,
        requested: 'claude-sdk',
        machineDefault: undefined,
        available: ['claude-pty', 'generic-pty'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-sdk' })
  })

  it('always advertises the embedded SDK shipped by this build', () => {
    expect(availableDriverIds({ opencodeDrivable: false })).toContain('claude-sdk')
  })

  it('keeps subscription auth headed until the SDK is explicitly requested', () => {
    const admitted = ['claude-pty', 'generic-pty', 'claude-sdk'] as const
    expect(
      resolveRuntimeDriver({
        ...base,
        auth: 'subscription',
        requested: undefined,
        machineDefault: undefined,
        available: admitted,
      }),
    ).toEqual({ ok: true, driverId: 'claude-pty' })
    expect(
      resolveRuntimeDriver({
        ...base,
        auth: 'subscription',
        requested: undefined,
        machineDefault: undefined,
        available: ['claude-pty', 'generic-pty'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-pty' })
  })

  it('keeps unknown Claude auth on the PTY even when the SDK is admitted', () => {
    expect(
      resolveRuntimeDriver({
        ...base,
        auth: 'unknown',
        requested: undefined,
        machineDefault: undefined,
        available: ['claude-pty', 'generic-pty', 'claude-sdk'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-pty' })
  })
})

describe('Claude selection auth', () => {
  it('treats a stored Claude login as subscription, not unknown', () => {
    expect(selectionAuthForLogin('claude-code', 'in')).toBe('subscription')
    expect(selectionAuthForLogin('claude-code', 'out')).toBe('logged-out')
    expect(selectionAuthForLogin('claude-code', 'unknown')).toBe('unknown')
  })

  it('lets a spawn-frame subscription token or API key override disk login', () => {
    expect(
      selectionAuthForLogin('claude-code', 'out', { CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-1' }),
    ).toBe('subscription')
    expect(selectionAuthForLogin('claude-code', 'in', { ANTHROPIC_API_KEY: 'sk-ant-test' })).toBe(
      'api-key',
    )
    expect(selectionAuthForLogin('claude-code', 'in', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(
      'bedrock',
    )
  })
})
