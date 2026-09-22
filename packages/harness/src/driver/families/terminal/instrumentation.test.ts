/**
 * THE TERMINAL FAMILY'S HANDED-SECTIONS GUARD (this issue, spec §4.1).
 *
 * A Driver is not handed the whole Adapter: it receives a typed subset, the
 * sections it owns, so the read restriction is a type rather than a rule. This
 * test drives the family install with a `fixture` harness that has NO registry
 * entry — no `registerTestManifest` call anywhere in this file — and it must
 * still succeed. On the previous tip it threw "no instrumentation installer
 * for fixture" because the family looked the harness up by name itself;
 * the red run is recorded in VERIFY-4521.
 */
import { describe, expect, it } from 'vitest'
import { asSessionId } from '@podium/model'
import type {
  InstalledInstrumentation,
  InstrumentationDestination,
  InstrumentationInstallScope,
} from '../../../manifest.js'
import {
  installTerminalInstrumentation,
  type TerminalInstrumentationSections,
} from './instrumentation.js'

/** A hand-built section double: adapter knowledge without an adapter. */
const FIXTURE_SECTIONS: TerminalInstrumentationSections = {
  instrumentation: {
    scope: { kind: 'session' },
    install: async () => ({ args: [] }),
    payloadCodec: {
      eventName: () => undefined,
      sessionId: () => undefined,
      transcriptPath: () => undefined,
      decode: async () => [],
    },
    hookTransport: 'none',
  },
}

/** A hand-built section double with a caller-chosen scope and install. */
function fixtureSections(
  scope: InstrumentationInstallScope,
  install: (destination: InstrumentationDestination) => Promise<InstalledInstrumentation>,
): TerminalInstrumentationSections {
  return {
    instrumentation: {
      scope,
      install,
      payloadCodec: {
        eventName: () => undefined,
        sessionId: () => undefined,
        transcriptPath: () => undefined,
        decode: async () => [],
      },
      hookTransport: 'none',
    },
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('handed terminal instrumentation sections', () => {
  it('installs for a harness with no registry entry', async () => {
    const wiring = await installTerminalInstrumentation({
      sessionId: asSessionId('fixture-session'),
      harness: 'fixture',
      spec: {
        instrumentation: { endpointUrl: 'http://127.0.0.1:1234/hooks/fixture' },
      },
      sections: FIXTURE_SECTIONS,
      settingsDir: '/unused',
    })
    expect(wiring.args).toEqual([])
  })

  it('refuses the whole manifest at the type boundary', async () => {
    await installTerminalInstrumentation({
      sessionId: asSessionId('fixture-type'),
      harness: 'fixture',
      spec: {
        instrumentation: { endpointUrl: 'http://127.0.0.1:1/hooks/t' },
      },
      sections: FIXTURE_SECTIONS,
      settingsDir: '/unused',
      // @ts-expect-error — handed sections only: no parameter accepts a manifest
      manifest: {},
    })
  })
})

/**
 * THE INSTALL-SCOPE GUARD (this issue, spec §3).
 *
 * The adapter declares the install scope and the mechanism looks one strategy
 * up by it — no `if` on a harness-shaped flag. A `home`-scoped section shares
 * one harness home across every session in it, so two concurrent installs
 * into one home must SERIALIZE (the second waits for the first); a
 * `session`-scoped section touches no shared home, so two concurrent installs
 * must NOT serialize. Both tests race with a deliberate delay the way
 * POD-4436 did — calling twice in sequence would pass against the broken
 * version and prove nothing.
 */
describe('declared install scope', () => {
  it('serializes two concurrent installs into one home', async () => {
    const home = '/test/scope-home'
    const seenHomes: (string | undefined)[] = []
    let active = 0
    let maxActive = 0
    const sections = fixtureSections({ kind: 'home', homeOf: () => home }, async (destination) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      seenHomes.push(destination.harnessHome)
      await delay(30)
      active -= 1
      return { args: [] }
    })
    const channel = { endpointUrl: 'http://127.0.0.1:1234/hooks/scope' }
    await Promise.all(
      ['scope-one', 'scope-two'].map((name) =>
        installTerminalInstrumentation({
          sessionId: asSessionId(name),
          harness: 'fixture',
          spec: { instrumentation: channel },
          sections,
          settingsDir: '/unused',
        }),
      ),
    )
    expect(seenHomes).toEqual([home, home])
    expect(maxActive).toBe(1)
  })

  it('does not serialize session-scoped installs', async () => {
    const seenHomes: (string | undefined)[] = []
    let active = 0
    let maxActive = 0
    const sections = fixtureSections({ kind: 'session' }, async (destination) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      seenHomes.push(destination.harnessHome)
      await delay(30)
      active -= 1
      return { args: [] }
    })
    const channel = { endpointUrl: 'http://127.0.0.1:1234/hooks/scope' }
    await Promise.all(
      ['scope-three', 'scope-four'].map((name) =>
        installTerminalInstrumentation({
          sessionId: asSessionId(name),
          harness: 'fixture',
          spec: { instrumentation: channel },
          sections,
          settingsDir: '/unused',
        }),
      ),
    )
    expect(seenHomes).toEqual([undefined, undefined])
    expect(maxActive).toBe(2)
  })
})
