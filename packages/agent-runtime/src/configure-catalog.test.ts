/**
 * THE CATALOG MUST AGREE WITH THE DRIVERS IT SUMMARIZES (POD-3087).
 *
 * `configureFieldsForDriver` exists so a client can decide whether to OFFER a
 * model control, from a driver id alone. That makes it a second statement about
 * something the drivers already declare — and this axis has been burned by
 * exactly that shape once already, when the capability catalogue described
 * `configure` as announced on every driver while `capabilities.ts` said the
 * opposite on all four.
 *
 * So every case here reads the DRIVER's own `capabilities()` and compares. None
 * of them hard-codes an expected field list, because a test that restated the
 * answer would drift in lockstep with the thing it is supposed to catch.
 */

import { describe, expect, it } from 'vitest'
import type { DriverCapabilities } from './capabilities.js'
import { attachKindsForDriver, configureFieldsForDriver } from './configure-catalog.js'
import { claudeSdkCapabilities } from './drivers/claude-sdk/capabilities.js'
import { codexAppServerCapabilities } from './drivers/codex/capabilities.js'
import { grokAcpCapabilities } from './drivers/grok-acp/capabilities.js'
import { opencodeServerCapabilities } from './drivers/opencode/capabilities.js'
import { terminalCapabilities } from './drivers/terminal/capabilities.js'

const declaredFields = (caps: DriverCapabilities): readonly string[] =>
  caps.configure.supported ? caps.configure.value.fields : []

const declaredAttach = (caps: DriverCapabilities): readonly string[] =>
  caps.attach.supported ? caps.attach.value.kinds : []

describe('attachKindsForDriver', () => {
  it.each([
    ['codex-app-server', codexAppServerCapabilities],
    ['opencode-server', opencodeServerCapabilities],
    ['grok-acp', grokAcpCapabilities],
    ['claude-sdk', claudeSdkCapabilities],
  ] as const)('reports exactly what %s declares', (driverId, capabilities) => {
    expect(attachKindsForDriver(driverId)).toEqual(declaredAttach(capabilities()))
  })

  it('matches the terminal factory and handles unknown ids', () => {
    const live = terminalCapabilities({
      driverId: 'claude-pty',
      sendProof: ['transcript-echo'],
      interactionsFromHooks: true,
      draftReadable: true,
      usesRawFirstTurn: false,
      reportsContextPercent: true,
      archivable: true,
    })
    expect(attachKindsForDriver('claude-pty')).toEqual(declaredAttach(live))
    expect(attachKindsForDriver('generic-pty')).toEqual(declaredAttach(live))
    expect(attachKindsForDriver('some-future-driver')).toEqual([])
  })
})

describe('configureFieldsForDriver', () => {
  it.each([
    ['codex-app-server', codexAppServerCapabilities],
    ['opencode-server', opencodeServerCapabilities],
    ['grok-acp', grokAcpCapabilities],
    ['claude-sdk', claudeSdkCapabilities],
  ] as const)('reports exactly what %s declares', (driverId, capabilities) => {
    expect(configureFieldsForDriver(driverId)).toEqual(declaredFields(capabilities()))
  })

  it('separates grok from its own FAMILY, which is the whole reason this exists', () => {
    /**
     * `grok-acp` and `opencode-server` are both `driverFamily: 'server'`, and a
     * picker gated on the family would be offered on both. Grok sends no model
     * on `session/new` OR `session/prompt`, so a model change there has nothing
     * to change — and this is the assertion that says the two are distinguishable
     * at the granularity a client actually needs.
     */
    expect(configureFieldsForDriver('grok-acp')).not.toContain('model')
    expect(configureFieldsForDriver('opencode-server')).toContain('model')
  })

  it('reports NOTHING for either terminal driver, and the real factory agrees', () => {
    // The catalog answers these two from a constant rather than by calling the
    // factory, because that factory's `configure` axis reads none of its input.
    // This is the pairing that keeps the shortcut honest: if a terminal driver
    // ever gains a configure route, the second half fails here.
    for (const driverId of ['claude-pty', 'generic-pty'] as const) {
      expect(configureFieldsForDriver(driverId)).toEqual([])
    }
    const live = terminalCapabilities({
      driverId: 'claude-pty',
      sendProof: ['transcript-echo'],
      interactionsFromHooks: true,
      draftReadable: true,
      usesRawFirstTurn: false,
      reportsContextPercent: true,
      archivable: true,
    })
    expect(live.configure.supported).toBe(false)
  })

  it('answers EMPTY for a driver id it has never heard of, rather than throwing', () => {
    /**
     * The rolling-upgrade case: a client asking about a driver a newer daemon
     * bound and this build does not know. Hiding a control that would have
     * worked costs one relaunch; throwing inside a render costs the screen.
     */
    expect(configureFieldsForDriver('some-future-driver')).toEqual([])
  })
})
