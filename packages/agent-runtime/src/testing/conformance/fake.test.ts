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
  assertAttachHonoursOneControlLease,
  assertNoNativeSteerEntitled,
  assertSteerJoinedOpenTurn,
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

/**
 * A THIRD TARGET, AND IT EXISTS FOR THE ARM THE OTHER TWO CANNOT REACH
 * (POD-2703).
 *
 * Both fakes above mint a resume ref at spawn and declare an archive, so between
 * them they exercise only the POSITIVE side of `resume()` and `export()`. The
 * corpus's other side — "a family that cannot support a verb must REFUSE rather
 * than silently degrade" — was asserted in branches no target entered, which is
 * the same nothing as not asserting it.
 *
 * This is a CLI with no resume at all: `resumeRefTiming: 'never'`, and therefore
 * no archive either, because `SessionArchive.resume` is not optional and there
 * would be nothing honest to put in it. Under the corpus it must refuse
 * `hibernate()`, reject `resume()` and reject `export()` — and it must go on
 * passing every other property, because "no resume" is a missing verb, not a
 * licence to be a worse driver.
 */
describeDriverConformance({
  name: 'fake-terminal-no-resume',
  family: 'terminal',
  createDriver: () => {
    const driver = createFakeTerminalDriver({ resumeRefTiming: 'never' })
    return { driver, control: driver.control as ConformanceControl }
  },
  reset: resetFakeRuntime,
  spec,
})

/**
 * A FOURTH TARGET, FOR THE ARM THAT USED TO BE AN EXEMPTION (POD-2703, review 2).
 *
 * A harness that streams its turns and keeps no readable history — real enough,
 * and the declaration the second review found could switch the corpus's central
 * resume property OFF. Every target above declares `transcript.history`, so the
 * "no history" branch was reasoned about and never run, and what ran instead was
 * `expect(false).toBe(false)`.
 *
 * It RESUMES and it ARCHIVES. That combination is the point: the property can no
 * longer take the absent history as an answer, so it has to reach for the
 * archive and find this conversation's own turn in it. Break resume here and it
 * goes red through the second channel rather than being excused by the first.
 */
describeDriverConformance({
  name: 'fake-server-no-transcript',
  family: 'server',
  createDriver: () => {
    const driver = createFakeServerDriver({ transcriptHistory: false })
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
    expect([...NO_NATIVE_STEER_DRIVERS]).toEqual([
      'generic-pty',
      'claude-sdk',
      'opencode-server',
      'grok-acp',
    ])
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
    // The embedded family still has to name the exact measured driver; the
    // family-level exemption is not permission for future adapters.
    expect(() => assertNoNativeSteerEntitled('embedded', 'fake-embedded')).toThrow()
  })

  it('ACCEPTS the drivers somebody actually measured', () => {
    // opencode 1.18.16 has no steer verb and a TUI has no way to append into an
    // open turn. Both arguments are in `../../permitted-failures.ts`.
    expect(() => assertNoNativeSteerEntitled('server', 'opencode-server')).not.toThrow()
    expect(() => assertNoNativeSteerEntitled('terminal', 'generic-pty')).not.toThrow()
    expect(() => assertNoNativeSteerEntitled('embedded', 'claude-sdk')).not.toThrow()
  })

  /**
   * THE IMPOSTOR, KEPT RATHER THAN REBUILT (POD-2085 review, finding 3).
   *
   * The anti-substitution property was watched failing once against a
   * hand-patched fake, and the patch was then thrown away — so the property's
   * own teeth lived in a commit message. These three cases are the same
   * experiment, committed: a driver that reports `deliveredAs: 'steer'` while
   * queueing the words, run through the corpus's OWN assertion, plus the honest
   * driver alongside it so a check that stopped discriminating shows up as a
   * green impostor rather than as nothing at all.
   */
  const steerScenario = async (
    driver: ReturnType<typeof createFakeServerDriver>,
  ): Promise<Parameters<typeof assertSteerJoinedOpenTurn>[0]> => {
    resetFakeRuntime()
    const session = await driver.create(spec())
    const sessionId = session.binding.sessionId
    const opened = await session.send(
      { text: 'open a turn' },
      { origin: 'human', delivery: 'when-ready' },
    )
    if (opened.outcome !== 'accepted') throw new Error('fixture: the first send must open a turn')
    const before = driver.control.textDeliveries(sessionId)
    // EVERY READING IS MEASURED, never handed in. A teeth test that fed the
    // assertion the numbers it wanted to see would be testing arithmetic.
    const receipt = await session.send({ text: 'steer me' }, { origin: 'mail', delivery: 'steer' })
    const epochAfterReceipt = (await session.snapshot()).turnEpoch
    const afterReceipt = driver.control.textDeliveries(sessionId)
    // Fenced in the same order the property fences it: the reading AFTER the
    // turn ends is what separates a count that moved by the wrong amount from
    // one that moved at the wrong moment.
    driver.control.completeTurn(sessionId)
    return {
      receipt,
      openEpoch: opened.turnEpoch,
      epochAfterReceipt,
      textDeliveries: {
        before,
        afterReceipt,
        afterFence: driver.control.textDeliveries(sessionId),
      },
    }
  }

  it('REFUSES a driver that reports a steer and queues the words', async () => {
    const observed = await steerScenario(
      createFakeServerDriver({ steerImpostor: 'queues-silently' }),
    )
    // THE LIE IS WELL-FORMED, which is the point: the outcome, the delivery and
    // the epoch all say the words joined the open turn, and each of those is
    // separately asserted elsewhere in the corpus. Only the DELIVERY betrays it.
    const { receipt } = observed
    expect(receipt.outcome).toBe('accepted')
    if (receipt.outcome !== 'accepted') return
    expect(receipt.deliveredAs).toBe('steer')
    expect(observed.epochAfterReceipt).toBe(observed.openEpoch)
    expect(observed.textDeliveries.afterReceipt).toBe(observed.textDeliveries.before)
    expect(() => assertSteerJoinedOpenTurn(observed)).toThrow(/sitting in a queue/)
  })

  it('REFUSES a driver whose steer counts at the wrong MOMENT', async () => {
    /**
     * THE ADVERSARY THE RECEIPT-TIME READINGS CANNOT SEE (review round 2,
     * finding 1). This one queues the words AND increments, so all three
     * receipt-time readings are satisfied — the count is up by exactly one and
     * no epoch moved. The words are still in a queue, and the proof is what the
     * FENCE does: it drains them, and a second delivery of a turn that claimed
     * to be already delivered is the contradiction.
     */
    const observed = await steerScenario(
      createFakeServerDriver({ steerImpostor: 'queues-and-counts' }),
    )
    // Every receipt-time reading looks honest…
    expect(observed.epochAfterReceipt).toBe(observed.openEpoch)
    expect(observed.textDeliveries.afterReceipt).toBe(observed.textDeliveries.before + 1)
    // …and the fence is where the queue gives it away.
    expect(observed.textDeliveries.afterFence).toBe(observed.textDeliveries.before + 2)
    expect(() => assertSteerJoinedOpenTurn(observed)).toThrow(/delivered a SECOND time/)
  })

  it('ACCEPTS a driver whose steer really reaches the agent', async () => {
    const observed = await steerScenario(createFakeServerDriver())
    const { receipt } = observed
    expect(receipt.outcome).toBe('accepted')
    if (receipt.outcome !== 'accepted') return
    expect(receipt.deliveredAs).toBe('steer')
    expect(() => assertSteerJoinedOpenTurn(observed)).not.toThrow()
  })

  /**
   * THE ATTACH INVARIANT, DRIVEN FROM BOTH SIDES (POD-2085 review round 2,
   * finding 2).
   *
   * The attach property landed one commit after the steer teeth, without teeth
   * of its own — and its two refusal assertions are dormant on every landed
   * target, so they were the two nobody could show had ever bitten. Both
   * constructions below are the SAME bug POD-2059 found in a real driver, one
   * per half: taking the lease unconditionally, and taking it before deciding
   * the machine cannot host a terminal at all.
   */
  const attachScenario = async (driver: ReturnType<typeof createFakeServerDriver>) => {
    resetFakeRuntime()
    const session = await driver.create(spec())
    return assertAttachHonoursOneControlLease(session, driver.capabilities(), 'server')
  }

  it('REFUSES an attach that takes the control lease unconditionally', async () => {
    // A second take-over silently displacing the first — the defect exactly as
    // it shipped in opencode before POD-2059.
    await expect(
      attachScenario(createFakeServerDriver({ attachLease: 'displaces' })),
    ).rejects.toThrow()
  })

  it('REFUSES an attach that keeps the lease it took', async () => {
    // The ordering half: refusing for want of a terminal host is correct, doing
    // it while still holding the lease leaves an orphaned controller on a
    // session the caller was just refused control of. Real drivers reach that
    // state by reserving the lease and failing to roll it back; the fake reaches
    // it by taking the lease and refusing anyway. The assertion cannot tell the
    // two apart, which is the point — it reads the LEASE, not the route.
    await expect(
      attachScenario(createFakeServerDriver({ attachLease: 'refuses-after-taking' })),
    ).rejects.toThrow(/reservation was never rolled back/)
  })

  it('ACCEPTS an attach that holds one lease and admits every spectator', async () => {
    await expect(attachScenario(createFakeServerDriver())).resolves.toBeUndefined()
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
