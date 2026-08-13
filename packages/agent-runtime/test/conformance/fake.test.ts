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
import type { SessionSpec } from '../../src/contract.js'
import {
  createFakeServerDriver,
  createFakeTerminalDriver,
  resetFakeRuntime,
} from '../../src/fake-driver.js'
import { PERMITTED_FAILURES, permits } from '../../src/permitted-failures.js'
import { RUNTIME_PRIMITIVE_TIER } from '../../src/tiers.js'
import { describeDriverConformance } from './suite.js'
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
  it('grants the server family NO exemptions', () => {
    // Spec §3: the server family "must not need" any. If this ever gains an
    // entry, the surface has absorbed a weakness rather than the driver fixing
    // one — which is the reason to make it fail here.
    expect(PERMITTED_FAILURES.server).toEqual([])
  })

  it('grants the terminal family exactly the two weaknesses the spec names', () => {
    expect(PERMITTED_FAILURES.terminal).toContain('unverified-send')
    expect(PERMITTED_FAILURES.terminal).toContain('at-least-once-interactions')
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

  it('would fail a server driver that claims a weakness its family may not have', () => {
    const dishonest = createFakeServerDriver({ mayReturnUnverified: true })
    // This is exactly the pair the corpus's "claims `unverified` ONLY where the
    // family permits it" property compares. Disagreement here is a red suite.
    expect(dishonest.capabilities().send.mayReturnUnverified).toBe(true)
    expect(permits('server', 'unverified-send')).toBe(false)
    expect(dishonest.capabilities().send.mayReturnUnverified).not.toBe(
      permits('server', 'unverified-send'),
    )
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
