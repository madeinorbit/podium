/**
 * THE TERMINAL FAMILY'S HANDED-SECTIONS GUARD (this issue).
 *
 * ARMED: the family must install from sections it is HANDED, never by looking
 * its harness up in the registry by name (spec §4.1). This test drives the
 * install with a `fixture` harness that has NO registry entry and must still
 * succeed — on the current tip it throws "no instrumentation installer for
 * fixture" because the family calls `manifestFor(spec.harness)`.
 */
import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../host.js'
import { asSessionId } from '@podium/model'
import { installTerminalInstrumentation } from './instrumentation.js'

function spec(harness: string): SessionSpec {
  return {
    harness,
    selection: { auth: 'unknown', platform: 'linux', available: [] },
    workdir: '/project',
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
    instrumentation: { endpointUrl: 'http://127.0.0.1:1234/hooks/fixture' },
  }
}

describe('handed terminal instrumentation sections', () => {
  it('installs for a harness with no registry entry', async () => {
    // No registerTestManifest call: `fixture` is unknown to the registry here.
    const wiring = await installTerminalInstrumentation({
      sessionId: asSessionId('fixture-session'),
      spec: spec('fixture'),
      settingsDir: '/unused',
    })
    expect(wiring.args).toEqual([])
  })
})
