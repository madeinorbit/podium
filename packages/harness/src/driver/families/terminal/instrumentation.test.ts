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
import {
  installTerminalInstrumentation,
  type TerminalInstrumentationSections,
} from './instrumentation.js'

/** A hand-built section double: adapter knowledge without an adapter. */
const FIXTURE_SECTIONS: TerminalInstrumentationSections = {
  instrumentation: {
    install: async () => ({ args: [] }),
    payloadCodec: {
      eventName: () => undefined,
      sessionId: () => undefined,
      transcriptPath: () => undefined,
      decode: async () => [],
    },
    hookTransport: 'none',
  },
  environment: {},
  hookInstall: 'settings-args',
}

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
