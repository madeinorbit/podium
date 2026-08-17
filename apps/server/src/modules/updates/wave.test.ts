import { describe, expect, it } from 'vitest'
import { machineCanTakeDelivery, offeredDeliveries, planWave, type WaveMachine } from './wave'

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
      planWave({
        ...base,
        canaryHealthy: true,
        machines: [m({ id: 'off', online: false }), m({ id: 'on' })],
      }),
    ).toEqual(['on'])
  })

  it('never re-grants a machine that rejected this target', () => {
    expect(
      planWave({
        ...base,
        canaryHealthy: true,
        machines: [m({ id: 'bad', state: 'rejected' }), m({ id: 'ok' })],
      }),
    ).toEqual(['ok'])
  })

  it('never re-grants a stuck machine', () => {
    expect(
      planWave({ ...base, canaryHealthy: true, machines: [m({ id: 'stuck', state: 'stuck' })] }),
    ).toEqual([])
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

describe('a machine that cannot take the delivery', () => {
  const source = (over: Partial<WaveMachine> = {}): WaveMachine => ({
    id: 'a-source',
    version: 'dev+old',
    // "Behind" is a version that differs from the target, not a state of its
    // own — the fleet projection keeps such a row `current` at its own version.
    state: 'current',
    online: true,
    busy: false,
    deliveryCaps: ['update.delivery.git'],
    ...over,
  })
  const installed = (over: Partial<WaveMachine> = {}): WaveMachine => ({
    id: 'b-installed',
    version: 'dev+old',
    state: 'current',
    online: true,
    busy: false,
    deliveryCaps: ['update.delivery.feed', 'update.delivery.bundle'],
    ...over,
  })
  const plan = (machines: WaveMachine[], deliveries: string[]) =>
    planWave({
      machines,
      targetVersion: 'dev+new',
      concurrency: 3,
      canaryHealthy: true,
      deliveries,
    })

  it('is never selected for a target it has no capability for', () => {
    // The live shape: a dev+<sha> with no packed tarball offers git ALONE, and
    // the installed machine reported it can only take a feed or a bundle. It
    // used to be granted anyway and answered "unsupported-delivery", which the
    // operator read as "The machines do not support this update's delivery
    // method" partway through a wave (POD-2004).
    expect(plan([source(), installed()], ['git'])).toEqual(['a-source'])
  })

  it('selects it again as soon as a target it CAN take is published', () => {
    // The tarball, packed a minute later. Nothing to retry by hand.
    expect(plan([source(), installed()], ['bundle', 'git'])).toEqual(['a-source', 'b-installed'])
  })

  it('grants a machine that has never reported its capabilities', () => {
    // Refusing an unknown would strand a daemon that predates the build report,
    // which is worse than the failure this prevents.
    const unknown = installed({ id: 'c-unknown' })
    delete (unknown as { deliveryCaps?: unknown }).deliveryCaps
    expect(plan([unknown], ['git'])).toEqual(['c-unknown'])
  })

  it('does not filter when the caller offers no delivery list', () => {
    expect(
      planWave({
        machines: [installed()],
        targetVersion: 'dev+new',
        concurrency: 3,
        canaryHealthy: true,
      }),
    ).toEqual(['b-installed'])
  })
})

/**
 * A DAEMON INSIDE PODIUM DESKTOP IS THE SHELL'S TO UPDATE (POD-2099, spec §4).
 *
 * The flag is the whole decision: each test plans the SAME machine twice, once
 * supervised and once not, so a filter that stopped firing would be visible as
 * the two runs agreeing rather than as a bare red.
 */
describe('a desktop-supervised daemon', () => {
  const macAllInOne = (over: Partial<WaveMachine> = {}): WaveMachine => ({
    id: 'macbook',
    version: '0.4.1',
    state: 'current',
    online: true,
    busy: false,
    // The shape that makes this dangerous: it reports `installed` with real
    // bundle caps, so nothing in the caps answer would refuse it.
    deliveryCaps: ['update.delivery.feed', 'update.delivery.bundle'],
    supervised: true,
    ...over,
  })
  const plan = (machines: WaveMachine[], over: Partial<Parameters<typeof planWave>[0]> = {}) =>
    planWave({
      machines,
      targetVersion: '0.4.2',
      concurrency: 3,
      canaryHealthy: true,
      deliveries: ['feed', 'bundle'],
      ...over,
    })

  it('is never granted a target it has the capabilities for', () => {
    expect(plan([macAllInOne()])).toEqual([])
    expect(plan([macAllInOne({ supervised: false })])).toEqual(['macbook'])
  })

  it('is never chosen as the canary, the one selection a widening filter misses', () => {
    const machines = [macAllInOne(), macAllInOne({ id: 'vmi', supervised: false })]
    expect(plan(machines, { canaryHealthy: false })).toEqual(['vmi'])
    // Alone and unhealthy there is no canary left to pick, rather than picking it.
    expect(plan([macAllInOne()], { canaryHealthy: false })).toEqual([])
  })

  it('is refused even when the caller offers no delivery list at all', () => {
    // The per-machine Apply path (`authorizeMachine`) plans without deliveries;
    // "no list" disables the CAPS question, and this must not ride on it.
    expect(plan([macAllInOne()], { deliveries: undefined })).toEqual([])
  })

  it('never blocks the rest of the fleet from converging', () => {
    const fleet = [macAllInOne(), macAllInOne({ id: 'ludovico', supervised: false })]
    expect(plan(fleet)).toEqual(['ludovico'])
  })

  it('answers the delivery question directly, whatever it reported it can take', () => {
    expect(machineCanTakeDelivery({ supervised: true, deliveryCaps: [] }, [])).toBe(false)
    expect(
      machineCanTakeDelivery({ supervised: true, deliveryCaps: ['update.delivery.git'] }, ['git']),
    ).toBe(false)
    // Absent is an ordinary fleet machine — the frozen-contract reading.
    expect(machineCanTakeDelivery({ deliveryCaps: ['update.delivery.git'] }, ['git'])).toBe(true)
  })
})

describe('what a target offers', () => {
  it('counts the headless artifact and every alternative', () => {
    expect(
      offeredDeliveries({
        artifacts: {
          headless: { delivery: 'bundle' },
          headlessAlternatives: [{ delivery: 'git' }],
        },
      }),
    ).toEqual(['bundle', 'git'])
    // The identity target the server publishes before a tarball exists.
    expect(
      offeredDeliveries({ artifacts: { headlessAlternatives: [{ delivery: 'git' }] } }),
    ).toEqual(['git'])
    expect(offeredDeliveries({ artifacts: {} })).toEqual([])
  })
})
