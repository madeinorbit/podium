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
  it('--pair and --name are carried into the plan for a fresh remote daemon', () => {
    expect(resolvePlan(['daemon', '--server', 'ws://h:1', '--pair', 'ABC123', '--name', 'laptop'], {})).toEqual({
      mode: 'daemon',
      serverUrl: 'ws://h:1',
      pairCode: 'ABC123',
      name: 'laptop',
      showSetupHint: false,
    })
  })
  it('--pair and --name are absent when not passed', () => {
    const plan = resolvePlan(['daemon', '--server', 'ws://h:1'], {})
    expect(plan).not.toHaveProperty('pairCode')
    expect(plan).not.toHaveProperty('name')
  })
  it('daemon pairCode falls back to config.pairCode when no --pair flag', () => {
    expect(resolvePlan(['daemon'], { serverUrl: 'ws://cfg:1', pairCode: 'CFG999' })).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://cfg:1',
      pairCode: 'CFG999',
    })
  })
  it('--pair flag wins over config.pairCode', () => {
    expect(
      resolvePlan(['daemon', '--pair', 'FLAG1'], { serverUrl: 'ws://cfg:1', pairCode: 'CFG999' }),
    ).toMatchObject({ pairCode: 'FLAG1' })
  })
})
