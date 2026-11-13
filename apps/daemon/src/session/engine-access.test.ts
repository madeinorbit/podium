/**
 * AN ENGINE STARTS WITH ITS SESSION'S CREDENTIAL (credential management §8;
 * epic plan Task 5).
 *
 * Every engine (codex app-server, the Claude stream engine, opencode, grok)
 * starts through `SessionEngineScope.startEngine`, and every family hands it a
 * strip list naming all of the harness's inherited credential variables. The
 * delivered one must survive that strip, and a restarted daemon must not start
 * an engine before the server's refresh brings the credential back.
 */

import type { EngineAttachment } from '@podium/harness/driver/host'
import { testBoundCommand } from '@podium/harness/driver/testing'
import { asSessionId } from '@podium/model'
import type { DurableProcess } from '@podium/process/durable'
import type { AccessField } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../control/access'
import { createSessionEngineScope } from './engines.js'
import { SessionRegistry } from './registry.js'

const SESSION = asSessionId('00000000-0000-4000-8000-0000000000e5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-engine-secret-0005'

const access: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000e5',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
}

function heldEngine(): EngineAttachment {
  return {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: { onData: () => () => {}, onExit: () => () => {}, signal: () => {} },
    dispose: () => {},
  }
}

type Spawned = { env: Record<string, string>; stripEnv: readonly string[]; args: string[] }

function scopeWith(store: SessionAccessStore) {
  const spawned: Spawned[] = []
  const adapter = {
    kind: 'host',
    spawnHeadless: async (opts: Spawned) => {
      spawned.push({ env: opts.env, stripEnv: opts.stripEnv, args: opts.args })
      return heldEngine()
    },
    attachHeadless: async () => heldEngine(),
    has: async () => true,
    kill: async () => {},
  }
  const durable = { backend: 'host', primary: adapter, all: [adapter] } as unknown as DurableProcess
  const scope = createSessionEngineScope(durable, {
    sessions: new SessionRegistry(),
    access: store,
  })
  return { scope, spawned }
}

const start = (scope: ReturnType<typeof scopeWith>['scope'], sessionId = SESSION) =>
  scope.startEngine({
    sessionId,
    label: `podium-cl-${sessionId}`,
    command: testBoundCommand('claude', ['--input-format', 'stream-json']),
    cwd: '/tmp',
    env: { FAMILY: 'wiring' },
    // What every family passes: the harness's whole inherited-credential list.
    stripEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  })

describe('SessionEngineScope.startEngine with a session credential', () => {
  it('passes the delivered variable and keeps it off the strip list', async () => {
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    store.remember(SESSION, access, 'claude-code')
    const { scope, spawned } = scopeWith(store)
    await start(scope)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.env).toMatchObject({
      FAMILY: 'wiring',
      ANTHROPIC_API_KEY: PLANTED,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    })
    expect(spawned[0]?.stripEnv).toEqual(['ANTHROPIC_AUTH_TOKEN'])
  })

  it('a session with no credential starts unchanged: everything inherited is stripped', async () => {
    const { scope, spawned } = scopeWith(new SessionAccessStore({ markers: memoryMarkers() }))
    await start(scope)
    expect(spawned[0]?.env).toEqual({ FAMILY: 'wiring' })
    expect(spawned[0]?.stripEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  })

  it('after a restart with no refresh, the engine is not started (acceptance 6)', async () => {
    const markers = memoryMarkers()
    new SessionAccessStore({ markers }).remember(SESSION, access, 'claude-code')
    const restarted = new SessionAccessStore({ markers, waitMs: 20 })
    const { scope, spawned } = scopeWith(restarted)
    await expect(start(scope)).rejects.toThrow(/credential/i)
    expect(spawned).toEqual([])
  })

  it('after a restart, the engine starts with the credential once the refresh lands', async () => {
    const markers = memoryMarkers()
    new SessionAccessStore({ markers }).remember(SESSION, access, 'claude-code')
    const restarted = new SessionAccessStore({ markers, waitMs: 5_000 })
    const { scope, spawned } = scopeWith(restarted)
    const starting = start(scope)
    restarted.remember(SESSION, access)
    await starting
    expect(spawned[0]?.env.ANTHROPIC_API_KEY).toBe(PLANTED)
  })
})
