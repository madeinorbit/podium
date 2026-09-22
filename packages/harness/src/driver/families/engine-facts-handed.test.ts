/**
 * ARMED (POD-4494): engine hosts run on HANDED facts, never on a registry
 * lookup by harness name.
 *
 * Each case builds fixture adapter sections — the real manifest with a
 * different spawn stem and a different label token — hands them to the
 * family's facts reader, drives the engine host, and asserts the host used
 * the fixture's facts. Red before the fix (the family ignores what it is
 * handed and fetches 'codex'/'grok'/'opencode' itself); green after.
 *
 * The journal namespaces and attach kinds stay family literals (they name the
 * family/flavor, not the harness), so they are asserted unchanged.
 */

import { asSessionId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { declaredValue, supported } from '../../manifest.js'
import { manifestFor } from '../../registry.js'
import { codexEngineFacts } from './codex/engine-facts.js'
import { createCodexEngineHost } from './codex/engine-host.js'
import { grokEngineFacts } from './grok-acp/engine-facts.js'
import { createGrokEngineHost, grokAcpProcessKey } from './grok-acp/engine-host.js'
import { opencode2Flavor, opencodeFlavor } from './opencode/engine-facts.js'
import { createOpencodeEngineHost, opencodeScopeLabel } from './opencode/engine-host.js'
import type { EngineAttachment, SessionEngineOwner } from './engine-supervision.js'
import { createTestEngineOwner } from '../testing/binding-records.js'

function requireManifest(kind: 'codex' | 'grok' | 'opencode') {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no harness adapter for '${kind}'`)
  return manifest
}

function serverValue(kind: 'codex' | 'grok' | 'opencode') {
  const manifest = requireManifest(kind)
  const server = declaredValue(manifest.runtime.server)
  if (!server) throw new Error(`${kind} manifest declares no server`)
  const clientTerminal = declaredValue(server.clientTerminal)
  if (!clientTerminal) throw new Error(`${kind} manifest declares no client terminal`)
  return { manifest, server, clientTerminal }
}

/** Real codex sections with a fixture spawn stem, label token and strip marker. */
function codexFixture() {
  const { manifest, server, clientTerminal } = serverValue('codex')
  return {
    kind: manifest.kind,
    inventory: {
      ...manifest.inventory,
      executable: { ...manifest.inventory.executable, names: ['fixture-codex'] },
      foreignCredentialEnv: [...manifest.inventory.foreignCredentialEnv, 'FIXTURE_CODEX_SECRET'],
    },
    runtime: {
      ...manifest.runtime,
      server: supported({
        ...server,
        spawn: ['fixture-codex', 'app-server', '--fixture'],
        clientTerminal: supported({ ...clientTerminal, labelToken: 'fx' }),
      }),
    },
  }
}

/** Real grok sections with a fixture spawn stem, label token and strip marker. */
function grokFixture() {
  const { manifest, server, clientTerminal } = serverValue('grok')
  return {
    kind: manifest.kind,
    inventory: {
      ...manifest.inventory,
      executable: { ...manifest.inventory.executable, names: ['fixture-grok'] },
      foreignCredentialEnv: [...manifest.inventory.foreignCredentialEnv, 'FIXTURE_GROK_SECRET'],
    },
    runtime: {
      ...manifest.runtime,
      server: supported({
        ...server,
        spawn: ['fixture-grok', 'agent', 'stdio', '--fixture'],
        clientTerminal: supported({ ...clientTerminal, labelToken: 'fg' }),
      }),
    },
  }
}

/** Real opencode sections with a fixture spawn stem, label token and binary. */
function opencodeFixture() {
  const { manifest, server, clientTerminal } = serverValue('opencode')
  return {
    kind: manifest.kind,
    inventory: {
      ...manifest.inventory,
      executable: { ...manifest.inventory.executable, names: ['fixture-opencode'] },
    },
    runtime: {
      ...manifest.runtime,
      server: supported({
        ...server,
        spawn: ['fixture-opencode', 'serve', '--port', '<daemon-picked>', '--hostname', '127.0.0.1'],
        clientTerminal: supported({ ...clientTerminal, labelToken: 'fo' }),
      }),
    },
  }
}

/** Real opencode sections with a fixture preview alternative. */
function opencode2Fixture() {
  const manifest = requireManifest('opencode')
  const alternative = manifest.runtime.serverAlternatives?.find(
    (server) => server.driverId === 'opencode2-server',
  )
  if (!alternative) throw new Error("opencode adapter declares no 'opencode2-server' alternative")
  const clientTerminal = declaredValue(alternative.clientTerminal)
  if (!clientTerminal) throw new Error('opencode2 alternative declares no client terminal')
  return {
    kind: manifest.kind,
    inventory: manifest.inventory,
    runtime: {
      ...manifest.runtime,
      serverAlternatives: [
        {
          ...alternative,
          spawn: [
            'fixture-opencode2',
            'serve',
            '--port',
            '<daemon-picked>',
            '--hostname',
            '127.0.0.1',
          ],
          clientTerminal: supported({ ...clientTerminal, labelToken: 'fo2' }),
        },
      ],
    },
  }
}

function fakeEngineSession(): EngineAttachment {
  return {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
    },
    dispose: () => {},
  }
}

type SpawnOpts = Parameters<SessionEngineOwner<{ sessionId: SessionId }>['startEngine']>[0]

/**
 * The session-owned process verbs, capturing the composed spec and refusing
 * the start — plus the scope port the families read beside it. Spread at the
 * call site alongside `supervision: { scopeUnitFor: ... }` where given.
 */
function capturingOwner<TFacts extends { sessionId: SessionId }>(
  captured: SpawnOpts[],
  marker: Error,
): SessionEngineOwner<TFacts> {
  return createTestEngineOwner<TFacts>({
    startEngine: async (opts) => {
      captured.push(opts)
      throw marker
    },
  })
}

describe('engine facts come from handed sections', () => {
  it('codex host launches the handed stem under the handed label token', async () => {
    const facts = codexEngineFacts(codexFixture())
    expect(facts.command).toBe('fixture-codex')
    expect(facts.serverArgs).toEqual(['app-server', '--fixture'])
    expect(facts.executableName).toBe('fixture-codex')
    expect(facts.stripEnv).toContain('FIXTURE_CODEX_SECRET')
    expect(facts.scopeToken).toBe('fx')
    expect(facts.journalNamespace).toBe('codex-app-servers')
    expect(facts.attachKind).toBe('codex')

    const sessionId = asSessionId('f4494000-0000-4000-8000-000000000001')
    const captured: SpawnOpts[] = []
    const marker = new Error('stop after argv capture')
    const host = createCodexEngineHost({
      facts,
      stageAttachment: async () => {
        throw new Error('attachments are not under test')
      },
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => ({ drivable: true as const }),
      dialSocket: () => Promise.reject(new Error('no listener in this test')),
      supervision: { scopeUnitFor: () => undefined },
      engines: capturingOwner(captured, marker),
    })
    await expect(host.launch({ sessionId, workdir: '/tmp' })).rejects.toBe(marker)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.cmd).toBe('fixture-codex')
    expect(captured[0]?.label).toBe(`podium-fx-${sessionId}`)
    expect(captured[0]?.stripEnv).toContain('FIXTURE_CODEX_SECRET')
  })

  it('grok host launches the handed stem under the handed label token', async () => {
    const facts = grokEngineFacts(grokFixture())
    expect(facts.command).toBe('fixture-grok')
    expect(facts.serverArgs).toEqual(['agent', 'stdio', '--fixture'])
    expect(facts.executableName).toBe('fixture-grok')
    expect(facts.stripEnv).toContain('FIXTURE_GROK_SECRET')
    expect(facts.scopeToken).toBe('fg')
    expect(facts.journalNamespace).toBe('grok-acp-servers')
    expect(facts.attachKind).toBe('grok')

    const sessionId = asSessionId('f4494000-0000-4000-8000-000000000002')
    const captured: SpawnOpts[] = []
    const host = createGrokEngineHost({
      facts,
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => ({ drivable: true as const }),
      supervision: { scopeUnitFor: () => undefined },
      engines: createTestEngineOwner({
        startEngine: async (opts) => {
          captured.push(opts)
          return fakeEngineSession()
        },
      }),
    })
    const endpoint = await host.launch({ sessionId, workdir: '/tmp' })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.cmd).toBe('fixture-grok')
    expect(captured[0]?.label).toBe(grokAcpProcessKey(facts, sessionId))
    expect(endpoint.process.key).toContain('fg')
    expect(captured[0]?.stripEnv).toContain('FIXTURE_GROK_SECRET')
  })

  it('opencode host launches the handed stable stem under the handed label token', async () => {
    const flavor = opencodeFlavor(opencodeFixture())
    expect(flavor.driverId).toBe('opencode-server')
    expect(flavor.executableName).toBe('fixture-opencode')
    expect(flavor.scopeToken).toBe('fo')
    expect(flavor.journalNamespace).toBe('opencode-servers')
    expect(flavor.attachKind).toBe('opencode')

    const sessionId = asSessionId('f4494000-0000-4000-8000-000000000003')
    const captured: SpawnOpts[] = []
    const marker = new Error('stop after argv capture')
    const host = createOpencodeEngineHost({
      flavor,
      stageAttachment: async () => {
        throw new Error('attachments are not under test')
      },
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => null,
      freePort: async () => 41234,
      supervision: { scopeUnitFor: () => undefined },
      engines: capturingOwner(captured, marker),
    })
    await expect(
      host.launch({ sessionId, workdir: '/tmp', secret: 'secret', username: 'podium' }),
    ).rejects.toBe(marker)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.cmd).toBe('fixture-opencode')
    expect(captured[0]?.args).toEqual(['serve', '--port', '41234', '--hostname', '127.0.0.1'])
    expect(captured[0]?.label).toBe(opencodeScopeLabel(flavor, sessionId))
    expect(captured[0]?.label).toBe(`podium-fo-${sessionId}`)
  })

  it('opencode host launches the handed preview alternative under its label token', async () => {
    const flavor = opencode2Flavor(opencode2Fixture())
    expect(flavor.driverId).toBe('opencode2-server')
    expect(flavor.executableName).toBe('fixture-opencode2')
    expect(flavor.scopeToken).toBe('fo2')
    expect(flavor.journalNamespace).toBe('opencode2-servers')
    expect(flavor.attachKind).toBe('opencode')

    const sessionId = asSessionId('f4494000-0000-4000-8000-000000000004')
    const captured: SpawnOpts[] = []
    const marker = new Error('stop after argv capture')
    const host = createOpencodeEngineHost({
      flavor,
      stageAttachment: async () => {
        throw new Error('attachments are not under test')
      },
      resources: () => undefined,
      buildEnv: () => ({}),
      gracefulExitMs: 1,
      checkVersion: async () => null,
      freePort: async () => 49999,
      supervision: { scopeUnitFor: () => undefined },
      engines: capturingOwner(captured, marker),
    })
    await expect(
      host.launch({ sessionId, workdir: '/tmp', secret: 'secret', username: 'opencode' }),
    ).rejects.toBe(marker)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.cmd).toBe('fixture-opencode2')
    expect(captured[0]?.args).toEqual(['serve', '--port', '49999', '--hostname', '127.0.0.1'])
    expect(captured[0]?.label).toBe(`podium-fo2-${sessionId}`)
  })
})
