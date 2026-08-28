import { describe, expect, it } from 'vitest'
import {
  availableDriverIds,
  CLAUDE_SDK_TOS_ENV,
  claudeSdkTosAcceptedByEnv,
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

  it('requires both the per-spawn driver id and the operator ToS acknowledgement', () => {
    const refused = resolveRuntimeDriver({
      ...base,
      requested: 'claude-sdk',
      machineDefault: undefined,
      available: ['claude-pty', 'generic-pty'],
    })
    expect(refused).toMatchObject({ ok: false })
    if (!refused.ok) expect(refused.reason).toContain(CLAUDE_SDK_TOS_ENV)

    expect(
      resolveRuntimeDriver({
        ...base,
        requested: 'claude-sdk',
        machineDefault: undefined,
        available: ['claude-pty', 'generic-pty', 'claude-sdk'],
      }),
    ).toEqual({ ok: true, driverId: 'claude-sdk' })
  })

  it('never offers the SDK unless the acknowledgement value is exact', () => {
    expect(claudeSdkTosAcceptedByEnv({ [CLAUDE_SDK_TOS_ENV]: '1' })).toBe(true)
    expect(claudeSdkTosAcceptedByEnv({ [CLAUDE_SDK_TOS_ENV]: 'true' })).toBe(false)
    expect(availableDriverIds({ opencodeDrivable: false })).not.toContain('claude-sdk')
    expect(availableDriverIds({ opencodeDrivable: false, claudeSdkTosAccepted: true })).toContain(
      'claude-sdk',
    )
  })

  it('routes subscription auth to the SDK only when the ToS gate admits it', () => {
    const admitted = ['claude-pty', 'generic-pty', 'claude-sdk'] as const
    expect(
      resolveRuntimeDriver({
        ...base,
        auth: 'subscription',
        requested: undefined,
        machineDefault: undefined,
        available: admitted,
      }),
    ).toEqual({ ok: true, driverId: 'claude-sdk' })
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
