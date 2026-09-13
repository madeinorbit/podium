/**
 * THE GUARD, AND THE PROOF THAT IT IS NOT SIMPLY "throw".
 *
 * Every refusal case here is paired with the counterfactual that would pass equally
 * well against a guard that threw unconditionally — a guard that did that would leave
 * production unable to open its own database, and no `toThrow` assertion can tell the
 * two apart on its own.
 *
 * NOTHING IN THIS FILE OPENS A DATABASE. Every assertion is on a resolved path string
 * or on a thrown error, so a regression in this file cannot itself cause the incident
 * it exists to prevent.
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_INSTANCE_ID, instanceStateDir } from './instance'
import {
  guardedLiveStateDir,
  isWithinLiveStateDir,
  LIVE_STATE_DIR_ENV,
  refuseLiveStateDir,
  TEST_RUNTIME_ENV,
} from './live-state-guard'

const live = '/home/someone/.podium'
const marked = { [TEST_RUNTIME_ENV]: '1', [LIVE_STATE_DIR_ENV]: live }

describe('refuseLiveStateDir', () => {
  it('refuses the live root and everything beneath it', () => {
    expect(() => refuseLiveStateDir(live, 'probe', marked)).toThrow(/live state tree/)
    expect(() => refuseLiveStateDir(join(live, 'podium.db'), 'probe', marked)).toThrow(
      /live state tree/,
    )
    expect(() => refuseLiveStateDir(join(live, 'run', 'a', 'b'), 'probe', marked)).toThrow(
      /live state tree/,
    )
  })

  it('refuses a live path that only NORMALISES to one', () => {
    // The shape a join with a computed segment produces. A guard that compared the
    // unresolved strings would pass this straight through.
    expect(() => refuseLiveStateDir(`${live}/../.podium/podium.db`, 'probe', marked)).toThrow(
      /live state tree/,
    )
  })

  it('ALLOWS a sibling whose path merely starts with the same characters', () => {
    // `~/.podium-test` is not under `~/.podium`. A prefix or substring match would
    // refuse it, and the next person whose scratch root got refused would relax the
    // containment test until it meant nothing.
    expect(refuseLiveStateDir('/home/someone/.podium-test', 'probe', marked)).toBe(
      '/home/someone/.podium-test',
    )
    expect(isWithinLiveStateDir('/home/someone/.podium-test', live)).toBe(false)
    expect(isWithinLiveStateDir('/home/someone/.podiumx/podium.db', live)).toBe(false)
    expect(isWithinLiveStateDir('/home/someone', live)).toBe(false)
  })

  it('names the site, because WHICH default fired is the actionable half', () => {
    expect(() => refuseLiveStateDir(live, 'openStoreDatabase', marked)).toThrow(/openStoreDatabase/)
    expect(() => refuseLiveStateDir(live, 'instanceStateDir (fallback)', marked)).toThrow(
      /instanceStateDir \(fallback\)/,
    )
  })

  it('is INERT outside a marked test runtime — THE COUNTERFACTUAL', () => {
    // Without these four, every assertion above is satisfied by `throw new Error(...)`
    // with no condition at all, and the shipped binary could not open ~/.podium.
    expect(refuseLiveStateDir(live, 'probe', {})).toBe(live)
    expect(refuseLiveStateDir(join(live, 'podium.db'), 'probe', {})).toBe(join(live, 'podium.db'))
    // Half-published pairs disarm rather than guess: a guessed live root is a
    // guessed refusal.
    expect(refuseLiveStateDir(live, 'probe', { [LIVE_STATE_DIR_ENV]: live })).toBe(live)
    expect(refuseLiveStateDir(live, 'probe', { [TEST_RUNTIME_ENV]: '1' })).toBe(live)
  })

  it('treats a blank or non-"1" marker as unarmed', () => {
    expect(guardedLiveStateDir({ [TEST_RUNTIME_ENV]: 'true', [LIVE_STATE_DIR_ENV]: live })).toBe(
      undefined,
    )
    expect(guardedLiveStateDir({ [TEST_RUNTIME_ENV]: '1', [LIVE_STATE_DIR_ENV]: '   ' })).toBe(
      undefined,
    )
    expect(guardedLiveStateDir(marked)).toBe(live)
  })
})

describe('instanceStateDir under the guard', () => {
  const home = '/home/someone'

  it('refuses the default-instance fallback — the exact step the incident took', () => {
    expect(() => instanceStateDir(DEFAULT_INSTANCE_ID, marked, home)).toThrow(
      /default-instance fallback/,
    )
  })

  it('refuses an EXPLICIT PODIUM_STATE_DIR pointing at the live root', () => {
    // The branch a harness assertion sees only at a hook boundary, and never inside a
    // test body that set it and has not yet restored.
    expect(() =>
      instanceStateDir(DEFAULT_INSTANCE_ID, { ...marked, PODIUM_STATE_DIR: live }, home),
    ).toThrow(/PODIUM_STATE_DIR/)
    expect(() =>
      instanceStateDir(
        DEFAULT_INSTANCE_ID,
        { ...marked, PODIUM_STATE_DIR: `${live}/nested` },
        home,
      ),
    ).toThrow(/PODIUM_STATE_DIR/)
  })

  it('still returns every path that is NOT the live tree', () => {
    // The counterfactual for the two above, at the resolver rather than the guard: a
    // named instance, and a hermetic PODIUM_STATE_DIR, both under the SAME marked env.
    expect(instanceStateDir('worker', marked, home)).toBe(
      join(home, '.local', 'state', 'podium', 'worker'),
    )
    expect(
      instanceStateDir(DEFAULT_INSTANCE_ID, { ...marked, PODIUM_STATE_DIR: '/tmp/hermetic' }, home),
    ).toBe('/tmp/hermetic')
    expect(instanceStateDir(DEFAULT_INSTANCE_ID, marked, '/tmp/fake-home')).toBe(
      join('/tmp/fake-home', '.podium'),
    )
  })

  it('is inert for a SYNTHETIC env, which describes a machine rather than opening one', () => {
    // Arming reads the env this call was GIVEN. A caller passing a literal is computing
    // a string for an imaginary home; the incident chain passes process.env, which the
    // case below proves is armed. openStoreDatabase guards the open itself regardless.
    expect(instanceStateDir(DEFAULT_INSTANCE_ID, { HOME: home }, home)).toBe(join(home, '.podium'))
  })
})

describe('the live wiring on this machine', () => {
  it('is ARMED in this very process', () => {
    // Not a restatement of the unit cases: this asserts that test-hermetic-env.ts
    // actually published both markers for the lane running right now, which is the
    // only thing that makes the guard reach a child process at all.
    expect(process.env[TEST_RUNTIME_ENV]).toBe('1')
    expect(process.env[LIVE_STATE_DIR_ENV]).toBeTruthy()
    expect(guardedLiveStateDir()).toBe(resolve(process.env[LIVE_STATE_DIR_ENV] as string))
  })

  it('refuses THIS operator live database path, and allows the hermetic root in use', () => {
    expect(() =>
      refuseLiveStateDir(join(process.env[LIVE_STATE_DIR_ENV] as string, 'podium.db'), 'probe'),
    ).toThrow(/live state tree/)
    const hermetic = process.env.PODIUM_STATE_DIR as string
    expect(hermetic).toBeTruthy()
    expect(refuseLiveStateDir(hermetic, 'probe')).toBe(hermetic)
    expect(instanceStateDir(DEFAULT_INSTANCE_ID)).toBe(hermetic)
  })

  it('captured the live root BEFORE $HOME could move — not recomputed from it', () => {
    // Under Bun os.homedir() and os.userInfo().homedir both read $HOME, so a
    // recomputing guard would follow a test's fake home and silently disarm.
    const priorHome = process.env.HOME
    try {
      process.env.HOME = '/tmp/definitely-not-the-operator-home'
      expect(guardedLiveStateDir()).toBe(resolve(process.env[LIVE_STATE_DIR_ENV] as string))
      expect(guardedLiveStateDir()).not.toBe('/tmp/definitely-not-the-operator-home/.podium')
    } finally {
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
    }
  })
})
