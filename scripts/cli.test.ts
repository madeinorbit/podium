import { describe, expect, it } from 'vitest'
import { resolvePlan } from './cli'

describe('resolvePlan', () => {
  it('defaults to all-in-one + setup hint when nothing is configured', () => {
    expect(resolvePlan([], {})).toEqual({ mode: 'all-in-one', showSetupHint: true })
  })
  it('uses the configured mode when present', () => {
    expect(resolvePlan([], { mode: 'server' })).toEqual({ mode: 'server', showSetupHint: false })
  })
  it('an explicit subcommand overrides config', () => {
    expect(resolvePlan(['daemon'], { mode: 'all-in-one' })).toMatchObject({ mode: 'daemon' })
  })
  it('--server flag is carried into the plan', () => {
    expect(resolvePlan(['daemon', '--server', 'ws://h:1'], {})).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://h:1',
    })
  })
  it('config.serverUrl is used when no flag', () => {
    expect(resolvePlan(['daemon'], { serverUrl: 'ws://cfg:1' })).toMatchObject({ serverUrl: 'ws://cfg:1' })
  })
})
