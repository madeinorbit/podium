/**
 * THE CORPUS, RUN GREEN AGAINST THE BUNDLED FAKES.
 *
 * Two targets, because one would not exercise the permitted-failures table:
 * the server fake must meet every guarantee with NO exemptions (the spec's
 * requirement for the family), and the terminal fake must exhibit exactly the
 * weaknesses the table permits and no others.
 *
 * When W3's terminal driver and W5's opencode driver land, they add their own
 * `describeDriverConformance({...})` call and this file does not change.
 */

import { unsupported } from '@podium/harness'
import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../index.js'
import {
  NO_NATIVE_STEER_DRIVERS,
  PERMITTED_FAILURES,
  permits,
  RUNTIME_PRIMITIVE_TIER,
} from '../../index.js'
import {
  createFakeServerDriver,
  createFakeTerminalDriver,
  resetFakeRuntime,
} from '../fake-driver.js'
import {
  assertNoNativeSteerEntitled,
  assertUnverifiedClaimHonest,
  describeDriverConformance,
} from './suite.js'
import type { ConformanceControl } from './target.js'

const spec = (): SessionSpec => ({
  harness: 'fake-harness',
  selection: { auth: 'api-key', platform: 'linux', available: ['fake'] },
  workdir: '/tmp/fake-workdir',
  model: {},
  instructions: unsupported('the fake has no hidden instruction channel'),
  mcpServers: unsupported('the fake mounts no MCP servers'),
})

describeDriverConformance({
  name: 'fake-server',
  family: 'server',
  createDriver: () => {
    const driver = createFakeServerDriver()
    return { driver, control: driver.control as ConformanceControl }
  },
  reset: resetFakeRuntime,
  spec,
})

describeDriverConformance({
  name: 'fake-terminal',
  family: 'terminal',
  createDriver: () => {
    const driver = createFakeTerminalDriver()
    return { driver, control: driver.control as ConformanceControl }
  },
  reset: resetFakeRuntime,
  spec,
})

// ---------------------------------------------------------------------------
// The tables themselves — a permission nobody can read is a permission that
// grows quietly.
// ---------------------------------------------------------------------------

describe('the permitted-failures table', () => {
  it('grants the server family NO FIDELITY exemption, ever', () => {
    /**
     * THE TRIPWIRE, NARROWED ONCE AND ONLY ONCE (POD-2023).
     *
     * This assertion was `toEqual([])`, on spec §3's "the server family must not
     * need any" — and it did its job: W5 could not add a row without coming
     * here and arguing for it. The argument, in full, is in
     * `../../permitted-failures.ts`. In short: `no-native-steer` turned out to
     * be a per-HARNESS protocol verb rather than a family property. Codex's
     * app-server has `turn/steer`; opencode, measured at 1.18.16, has nothing
     * like it — a prompt POSTed into an open turn becomes a separate turn that
     * runs afterwards. No single value in a per-family table is true of both
     * drivers.
     *
     * WHAT THE TRIPWIRE STILL GUARDS is the part spec §3 was actually about:
     * FIDELITY. `unverified-send` and `at-least-once-interactions` are the two
     * weaknesses that make a consumer distrust what a session reports, they are
     * the terminal family's alone, and a server driver claiming either is
     * refused by the corpus in both directions. Those two must never appear
     * here, and an exact-equality check on the whole row is what stops a third
     * name arriving without the same argument this one had to make.
     */
    expect(PERMITTED_FAILURES.server).toEqual(['no-native-steer'])
    expect(PERMITTED_FAILURES.server).not.toContain('unverified-send')
    expect(PERMITTED_FAILURES.server).not.toContain('at-least-once-interactions')
  })

  it('grants the terminal family exactly the two weaknesses the spec names', () => {
    expect(PERMITTED_FAILURES.terminal).toContain('unverified-send')
    expect(PERMITTED_FAILURES.terminal).toContain('at-least-once-interactions')
  })

  it('pins WHICH DRIVERS may decline native steer, because the family row cannot', () => {
    /**
     * THE VACUITY, WRITTEN DOWN (POD-2085).
     *
     * `no-native-steer` is on all three rows, so the family predicate answers
     * yes for everyone — this loop is not a check, it is the EVIDENCE that the
     * family gate stopped gating. What replaced it is the driver-id pin, and the
     * equality below is what makes widening it show up in a diff next to the
     * measurement it has to bring. `manifest-axis.test.ts` pins a version range
     * per driver on the same argument.
     */
    for (const family of ['server', 'embedded', 'terminal'] as const) {
      expect(permits(family, 'no-native-steer')).toBe(true)
    }
    expect([...NO_NATIVE_STEER_DRIVERS]).toEqual(['generic-pty', 'opencode-server'])
    // The absence with a date on it: W6's driver has `turn/steer` in its own
    // protocol, so a codex-server declining steer is a bug in the driver, not a
    // weakness of its harness.
    expect(NO_NATIVE_STEER_DRIVERS).not.toContain('codex-app-server')
  })

  it('lets only the embedded family decline attach', () => {
    // Terminal has a real terminal by definition; server gets a TUI client. An
    // embedded session has neither, and chat is the honest answer.
    expect(PERMITTED_FAILURES.embedded).toContain('no-attach')
    expect(PERMITTED_FAILURES.server).not.toContain('no-attach')
    expect(PERMITTED_FAILURES.terminal).not.toContain('no-attach')
  })
})

describe('the corpus has teeth', () => {
  // A green suite proves nothing until you have watched it go red. These pin the
  // two assertions most likely to rot into decoration.

  it('REFUSES a server driver that claims a weakness its family may not have', () => {
    const dishonest = createFakeServerDriver({ mayReturnUnverified: true })
    // Calls the corpus's OWN checker, not a recomputation of it. An earlier
    // version compared the same two values inline, so deleting the property from
    // the suite would have left this green — a teeth test with no teeth.
    expect(() => assertUnverifiedClaimHonest('server', dishonest.capabilities())).toThrow()
  })

  it('REFUSES a terminal driver that hides a weakness its family has', () => {
    const dishonest = createFakeTerminalDriver({ mayReturnUnverified: false })
    // The direction that actually protects callers: a terminal driver claiming
    // it can always prove delivery is claiming protocol-grade fidelity over a
    // screen scrape.
    expect(() => assertUnverifiedClaimHonest('terminal', dishonest.capabilities())).toThrow()
  })

  it('REFUSES a driver that declines native steer without being entitled to', () => {
    // The future this exists for: a codex-server that simply leaves `steer` out
    // of `send.native` and inherits the family's permission in silence. Its
    // app-server has `turn/steer`, so the corpus must not let it.
    expect(() => assertNoNativeSteerEntitled('server', 'codex-app-server')).toThrow()
    // And the embedded family, whose row carries the permission with no measured
    // driver behind it at all.
    expect(() => assertNoNativeSteerEntitled('embedded', 'claude-sdk')).toThrow()
  })

  it('ACCEPTS the two drivers somebody actually measured', () => {
    // opencode 1.18.16 has no steer verb and a TUI has no way to append into an
    // open turn. Both arguments are in `../../permitted-failures.ts`.
    expect(() => assertNoNativeSteerEntitled('server', 'opencode-server')).not.toThrow()
    expect(() => assertNoNativeSteerEntitled('terminal', 'generic-pty')).not.toThrow()
  })

  it('ACCEPTS drivers that declare their family honestly', () => {
    expect(() =>
      assertUnverifiedClaimHonest('server', createFakeServerDriver().capabilities()),
    ).not.toThrow()
    expect(() =>
      assertUnverifiedClaimHonest('terminal', createFakeTerminalDriver().capabilities()),
    ).not.toThrow()
  })

  it('refuses to produce an unverified receipt from a driver that declared it cannot', async () => {
    resetFakeRuntime()
    const driver = createFakeServerDriver()
    const session = await driver.create(spec())
    driver.control.failNextVerification(session.binding.sessionId)
    // Not a silent downgrade to some other outcome: the fake THROWS, because a
    // driver emitting an outcome it declared impossible is a contract violation
    // and the reference implementation must not model it as merely unusual.
    await expect(
      session.send({ text: 'hi' }, { origin: 'human', delivery: 'when-ready' }),
    ).rejects.toThrow(/declared it cannot happen/)
  })

  it('refuses to mint a duplicate ask from an exactly-once driver', async () => {
    resetFakeRuntime()
    const driver = createFakeServerDriver()
    const session = await driver.create(spec())
    const id = driver.control.askInteraction(session.binding.sessionId, 'permission')
    expect(() => driver.control.reaskInteraction(session.binding.sessionId, id)).toThrow(
      /exactly-once identity/,
    )
  })
})

describe('the tier boundary', () => {
  it('keeps the feature seams out of core', () => {
    // A driver shipping only the core is COMPLETE. If one of these drifts to
    // core, a driver that cannot sync drafts stops being shippable — which is
    // exactly the growth the two tiers exist to resist.
    for (const primitive of ['draft', 'configure', 'usage', 'quota', 'title'] as const) {
      expect(RUNTIME_PRIMITIVE_TIER[primitive]).toBe('extended')
    }
  })

  it('keeps the swap-critical primitives in core', () => {
    for (const primitive of ['send', 'events', 'adopt', 'snapshot', 'export'] as const) {
      expect(RUNTIME_PRIMITIVE_TIER[primitive]).toBe('core')
    }
  })
})
