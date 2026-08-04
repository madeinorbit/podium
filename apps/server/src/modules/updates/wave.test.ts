import { describe, expect, it } from 'vitest'
import { planWave, type WaveMachine } from './wave'

const m = (over: Partial<WaveMachine> & { id: string }): WaveMachine => ({
  version: '0.4.1',
  state: 'current',
  online: true,
  busy: false,
  ...over,
})

const base = { targetVersion: '0.4.2', concurrency: 3 }

describe('planWave', () => {
  it('grants exactly one canary first', () => {
    expect(
      planWave({
        ...base,
        canaryHealthy: false,
        machines: [m({ id: 'a' }), m({ id: 'b' }), m({ id: 'c' })],
      }),
    ).toHaveLength(1)
  })

  it('prefers an idle machine as the canary', () => {
    expect(
      planWave({
        ...base,
        canaryHealthy: false,
        machines: [m({ id: 'busy', busy: true }), m({ id: 'idle' })],
      }),
    ).toEqual(['idle'])
  })

  it('grants nothing more until the canary is healthy', () => {
    expect(
      planWave({
        ...base,
        canaryHealthy: false,
        machines: [m({ id: 'a', state: 'restarting' }), m({ id: 'b' }), m({ id: 'c' })],
      }),
    ).toEqual([])
  })

  it('widens up to the concurrency cap once the canary is healthy', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [
        m({ id: 'a', version: '0.4.2' }),
        m({ id: 'b' }),
        m({ id: 'c' }),
        m({ id: 'd' }),
        m({ id: 'e' }),
      ],
    })
    expect(out).toHaveLength(3)
    expect(out).not.toContain('a')
  })

  it('counts in-flight machines against the cap', () => {
    const out = planWave({
      ...base,
      canaryHealthy: true,
      machines: [
        m({ id: 'a', state: 'downloading' }),
        m({ id: 'b', state: 'restarting' }),
        m({ id: 'c' }),
        m({ id: 'd' }),
      ],
    })
    expect(out).toHaveLength(1)
  })

  it('never grants to an offline machine', () => {
    expect(
      planWave({ ...base, canaryHealthy: true, machines: [m({ id: 'off', online: false }), m({ id: 'on' })] }),
    ).toEqual(['on'])
  })

  it('never re-grants a machine that rejected this target', () => {
    expect(
      planWave({ ...base, canaryHealthy: true, machines: [m({ id: 'bad', state: 'rejected' }), m({ id: 'ok' })] }),
    ).toEqual(['ok'])
  })

  it('never re-grants a stuck machine', () => {
    expect(planWave({ ...base, canaryHealthy: true, machines: [m({ id: 'stuck', state: 'stuck' })] })).toEqual([])
  })

  it('grants nothing when every machine is already on the target', () => {
    expect(
      planWave({
        ...base,
        canaryHealthy: true,
        machines: [m({ id: 'a', version: '0.4.2' }), m({ id: 'b', version: '0.4.2' })],
      }),
    ).toEqual([])
  })

  it('is deterministic for the same input', () => {
    const machines = [m({ id: 'a' }), m({ id: 'b' }), m({ id: 'c' })]
    const one = planWave({ ...base, canaryHealthy: true, machines })
    const two = planWave({ ...base, canaryHealthy: true, machines })
    expect(one).toEqual(two)
  })
})
