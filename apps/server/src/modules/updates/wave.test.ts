import { describe, expect, it } from 'vitest'
import {
  decideWave,
  machineCanTakeDelivery,
  machineCanTakeTargetPlatform,
  machineCanUseTargetTrust,
  offeredDeliveries,
  planWave,
  type WaveMachine,
} from './wave'

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
    // A source daemon offers no delivery at all: no install directory, nowhere
    // to put a verified bundle. It keeps unrelated capabilities.
    deliveryCaps: ['podium.shipping-train'],
    ...over,
  })
  const installed = (over: Partial<WaveMachine> = {}): WaveMachine => ({
    id: 'b-installed',
    version: 'dev+old',
    state: 'current',
    online: true,
    busy: false,
    deliveryCaps: ['update.delivery.feed', 'podium.shipping-train'],
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
    // The live shape has INVERTED with the retirement of git delivery, and the
    // guard is the same one. It used to be that a bare identity offered git
    // alone and the INSTALLED machine could not take it; now every target
    // offers a feed and the SOURCE machine cannot take that. Either way the
    // machine that cannot take delivery is not selected — it used to be granted
    // anyway and answer "unsupported-delivery", which the operator read as "The
    // machines do not support this update's delivery method" partway through a
    // wave (POD-2004).
    expect(plan([source(), installed()], ['feed'])).toEqual(['b-installed'])
  })

  it('selects nobody for a target that offers nothing at all', () => {
    // The identity a source host publishes before a release has been built.
    // Nobody can take it, so nobody is waved towards it — and the moment a real
    // release is published the installed machine converges with nothing to
    // retry by hand.
    expect(plan([source(), installed()], [])).toEqual([])
    expect(plan([source(), installed()], ['feed'])).toEqual(['b-installed'])
  })

  it('grants a machine that has never reported its capabilities', () => {
    // Refusing an unknown would strand a daemon that predates the build report,
    // which is worse than the failure this prevents.
    const unknown = installed({ id: 'c-unknown' })
    delete (unknown as { deliveryCaps?: unknown }).deliveryCaps
    expect(plan([unknown], ['feed'])).toEqual(['c-unknown'])
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
    // The shape that makes this dangerous: it reports `installed` with a real
    // feed cap, so nothing in the caps answer would refuse it.
    deliveryCaps: ['update.delivery.feed'],
    supervised: true,
    ...over,
  })
  const plan = (machines: WaveMachine[], over: Partial<Parameters<typeof planWave>[0]> = {}) =>
    planWave({
      machines,
      targetVersion: '0.4.2',
      concurrency: 3,
      canaryHealthy: true,
      deliveries: ['feed'],
      ...over,
    })

  it('is granted a target exactly like another capable machine', () => {
    expect(plan([macAllInOne()])).toEqual(['macbook'])
    expect(plan([macAllInOne({ supervised: false })])).toEqual(['macbook'])
  })

  it('can be chosen as the canary', () => {
    const machines = [macAllInOne(), macAllInOne({ id: 'vmi', supervised: false })]
    expect(plan(machines, { canaryHealthy: false })).toEqual(['macbook'])
    expect(plan([macAllInOne()], { canaryHealthy: false })).toEqual(['macbook'])
  })

  it('is eligible even when the caller offers no delivery list at all', () => {
    expect(plan([macAllInOne()], { deliveries: undefined })).toEqual(['macbook'])
  })

  it('never blocks the rest of the fleet from converging', () => {
    const fleet = [macAllInOne(), macAllInOne({ id: 'ludovico', supervised: false })]
    expect(plan(fleet)).toEqual(['ludovico', 'macbook'])
  })

  it('answers the delivery question directly, whatever it reported it can take', () => {
    // `supervised` is deliberately no longer part of this question (POD-2508):
    // the delivery answer now depends only on what a machine says it can take,
    // not on who owns its files. Both cases keep their previous verdicts —
    // empty caps still means "no caps question to ask", and a matching cap
    // still matches.
    expect(machineCanTakeDelivery({ deliveryCaps: [] }, [])).toBe(true)
    expect(machineCanTakeDelivery({ deliveryCaps: ['update.delivery.feed'] }, ['feed'])).toBe(true)
    // Absent is an ordinary fleet machine — the frozen-contract reading.
    expect(machineCanTakeDelivery({ deliveryCaps: ['update.delivery.feed'] }, ['feed'])).toBe(true)
    // A RETIRED cap matches nothing any target offers, which is exactly how an
    // old daemon stays honestly behind instead of being handed bytes it cannot
    // install. Caps are open at the wire; they are not accepted by being old.
    expect(machineCanTakeDelivery({ deliveryCaps: ['update.delivery.git'] }, ['feed'])).toBe(false)
    // An empty offer is not "do not filter": it is a target with nothing to
    // hand anyone.
    expect(machineCanTakeDelivery({ deliveryCaps: ['update.delivery.feed'] }, [])).toBe(false)
  })
})

describe('channel-keyed trust compatibility', () => {
  const legacy = {
    deliveryCaps: ['update.delivery.feed', 'update.delivery.bundle'],
  }

  it('recognizes the retired bundle capability as a pre-channel-trust build', () => {
    expect(machineCanUseTargetTrust(legacy, 'instance')).toBe(false)
  })

  it('keeps current, unknown, and release-trusted machines eligible', () => {
    expect(machineCanUseTargetTrust({ deliveryCaps: ['update.delivery.feed'] }, 'instance')).toBe(
      true,
    )
    expect(machineCanUseTargetTrust({}, 'instance')).toBe(true)
    expect(machineCanUseTargetTrust(legacy, 'release')).toBe(true)
    expect(machineCanUseTargetTrust(legacy)).toBe(true)
  })

  it('holds a legacy verifier before it can download an instance-trusted feed', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: true,
      deliveries: ['feed'],
      trust: 'instance',
      machines: [
        m({ id: 'flatblock', deliveryCaps: legacy.deliveryCaps }),
        m({ id: 'current', deliveryCaps: ['update.delivery.feed'] }),
      ],
    })
    expect(decision.selected).toEqual(['current'])
    expect(decision.held).toContainEqual({
      id: 'flatblock',
      reason: 'legacy-instance-trust',
    })
  })
})

describe('what a target offers', () => {
  it('counts the headless artifact and every alternative', () => {
    expect(
      offeredDeliveries({
        artifacts: {
          headless: { delivery: 'feed' },
          headlessAlternatives: [{ delivery: 'feed' }],
        },
      }),
    ).toEqual(['feed', 'feed'])
    // The identity target the server publishes before a release exists offers
    // nothing at all now that git delivery is retired.
    expect(offeredDeliveries({ artifacts: {} })).toEqual([])
  })
})

/**
 * THE DECISION, NOT JUST THE SELECTION (POD-2754).
 *
 * `planWave`'s answer cannot be held to afterwards: "one machine was granted"
 * and "one machine was granted while another was deliberately held back for want
 * of a proved canary" are the same list. These cases are about the difference,
 * because the difference is the whole of what the rollout gate checks.
 */
describe('decideWave', () => {
  it('names every machine the canary round held, and why', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: false,
      machines: [m({ id: 'a', name: 'fleet-a' }), m({ id: 'b', name: 'fleet-b' })],
    })
    expect(decision.gate).toBe('canary')
    expect(decision.selected).toEqual(['a'])
    expect(decision.held).toEqual([{ id: 'b', name: 'fleet-b', reason: 'canary-gated' }])
  })

  it('holds an eligible machine `canary-gated` while the canary is in flight', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: false,
      machines: [m({ id: 'a', state: 'downloading' }), m({ id: 'b' })],
    })
    expect(decision.selected).toEqual([])
    expect(decision.held).toEqual([
      { id: 'a', reason: 'in-flight' },
      { id: 'b', reason: 'canary-gated' },
    ])
  })

  it('says `canary-gated` about nobody once the canary is proved', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'a' }), m({ id: 'b' })],
    })
    expect(decision.gate).toBe('widen')
    expect(decision.selected).toEqual(['a', 'b'])
    expect(decision.held).toEqual([])
  })

  it('separates a machine that cannot be granted from one the round has no room for', () => {
    const decision = decideWave({
      ...base,
      concurrency: 1,
      canaryHealthy: true,
      machines: [
        m({ id: 'behind' }),
        m({ id: 'waiting' }),
        m({ id: 'checkout', installKind: 'source' }),
        m({ id: 'gone', online: false }),
        m({ id: 'arrived', version: '0.4.2' }),
        m({ id: 'refused', state: 'rejected' }),
      ],
    })
    expect(decision.selected).toEqual(['behind'])
    expect(Object.fromEntries(decision.held.map((held) => [held.id, held.reason]))).toEqual({
      waiting: 'wave-full',
      checkout: 'source-checkout',
      gone: 'offline',
      arrived: 'already-current',
      refused: 'terminal-verdict',
    })
  })

  it('holds a machine that cannot take what the target offers', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: true,
      deliveries: [],
      machines: [m({ id: 'a', deliveryCaps: ['update.delivery.feed'] })],
    })
    expect(decision.selected).toEqual([])
    expect(decision.held).toEqual([{ id: 'a', reason: 'unsupported-delivery' }])
  })

  it('agrees with planWave about the selection, always', () => {
    const machines = [m({ id: 'a' }), m({ id: 'b', busy: true }), m({ id: 'c', online: false })]
    for (const canaryHealthy of [false, true]) {
      const ctx = { ...base, canaryHealthy, machines }
      expect(planWave(ctx)).toEqual(decideWave(ctx).selected)
    }
  })
})

/**
 * NEVER OFFER A MACHINE A RELEASE THAT CONTAINS NOTHING FOR IT (POD-2783).
 *
 * A release's platform list is fixed when it is minted, from the fleet as it
 * stood at that moment. A machine that enrolls afterwards is not in it and can
 * never be — the release is immutable — so granting it that release buys one
 * download attempt, one refusal, and a dialog telling the operator to check a
 * release nobody can change. The wave has to ask before it grants, which is the
 * same rule `machineCanTakeDelivery` already carries for delivery kinds.
 */
describe('machineCanTakeTargetPlatform', () => {
  it('refuses a platform the release carries no bytes for', () => {
    expect(machineCanTakeTargetPlatform({ platform: 'darwin-aarch64' }, ['linux-x86_64'])).toBe(
      false,
    )
  })

  it('accepts a platform the release carries', () => {
    expect(
      machineCanTakeTargetPlatform({ platform: 'darwin-aarch64' }, [
        'linux-x86_64',
        'darwin-aarch64',
      ]),
    ).toBe(true)
  })

  /** Unknown means yes, for the reason unknown delivery caps mean yes: a machine
   *  that has not said what it is must stay visible rather than be stranded. */
  it('accepts a machine that has not reported a platform', () => {
    expect(machineCanTakeTargetPlatform({}, ['linux-x86_64'])).toBe(true)
  })

  it('does not filter when the caller asks no platform question', () => {
    expect(machineCanTakeTargetPlatform({ platform: 'darwin-aarch64' })).toBe(true)
  })

  /** A target carrying no platform at all is takeable by nobody who named itself. */
  it('refuses a named platform against a release that carries none', () => {
    expect(machineCanTakeTargetPlatform({ platform: 'darwin-aarch64' }, [])).toBe(false)
  })
})

describe('decideWave platform eligibility', () => {
  it('holds the machine a release predates instead of granting it', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: true,
      machines: [m({ id: 'mac', platform: 'darwin-aarch64' })],
      platforms: ['linux-x86_64'],
    })
    expect(decision.selected).toEqual([])
    expect(decision.held).toEqual([{ id: 'mac', reason: 'unsupported-platform' }])
  })

  it('still waves the machines the release was built for', () => {
    const decision = decideWave({
      ...base,
      canaryHealthy: true,
      machines: [
        m({ id: 'mac', platform: 'darwin-aarch64' }),
        m({ id: 'vps', platform: 'linux-x86_64' }),
      ],
      platforms: ['linux-x86_64'],
    })
    expect(decision.selected).toEqual(['vps'])
  })
})
