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
import type { DurableProcess, PipeSecret } from '@podium/process/durable'
import type { AccessField } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../control/access'
import { createSessionEngineScope } from './engines.js'
import { SessionRegistry } from './registry.js'

const SESSION = asSessionId('00000000-0000-4000-8000-0000000000e5')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-engine-secret-0005'

/** A key Claude Code reads from a pipe on Linux (POD-7378). */
const access: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000e5',
  delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: PLANTED },
}
/** A key Codex reads from its variable. */
const codexAccess: AccessField = {
  credentialId: 'cred_00000000-0000-4000-8000-0000000000e6',
  delivery: { kind: 'env', variable: 'OPENAI_API_KEY', secret: PLANTED },
}

function heldEngine(): EngineAttachment {
  return {
    ready: Promise.resolve({ lease: true, childPid: 4242 }),
    connection: { onData: () => () => {}, onExit: () => () => {}, signal: () => {} },
    dispose: () => {},
  }
}

type Spawned = {
  env: Record<string, string>
  stripEnv: readonly string[]
  args: string[]
  pipe?: PipeSecret
}

function scopeWith(store: SessionAccessStore) {
  const spawned: Spawned[] = []
  const adapter = {
    kind: 'host',
    spawnHeadless: async (opts: Spawned) => {
      spawned.push({
        env: opts.env,
        stripEnv: opts.stripEnv,
        args: opts.args,
        ...(opts.pipe ? { pipe: opts.pipe } : {}),
      })
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

const start = (
  scope: ReturnType<typeof scopeWith>['scope'],
  sessionId = SESSION,
  // What every family passes: the harness's whole inherited-credential list.
  stripEnv: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
) =>
  scope.startEngine({
    sessionId,
    label: `podium-cl-${sessionId}`,
    command: testBoundCommand('claude', ['--input-format', 'stream-json']),
    cwd: '/tmp',
    env: { FAMILY: 'wiring' },
    stripEnv,
  })

describe('SessionEngineScope.startEngine with a session credential', () => {
  it('passes the delivered variable and keeps it off the strip list', async () => {
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    store.remember(SESSION, codexAccess, 'codex')
    const { scope, spawned } = scopeWith(store)
    await start(scope, SESSION, ['OPENAI_API_KEY', 'CODEX_API_KEY'])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.env).toMatchObject({ FAMILY: 'wiring', OPENAI_API_KEY: PLANTED })
    expect(spawned[0]?.stripEnv).toEqual(['CODEX_API_KEY'])
    expect(spawned[0]?.pipe).toBeUndefined()
  })

  it.runIf(process.platform === 'linux')(
    'a Claude engine on Linux gets its key on a pipe: no variable, no scrub switch, no bwrap (POD-7378)',
    async () => {
      const store = new SessionAccessStore({ markers: memoryMarkers() })
      store.remember(SESSION, access, 'claude-code')
      const { scope, spawned } = scopeWith(store)
      await start(scope)
      expect(spawned).toHaveLength(1)
      expect(spawned[0]?.pipe).toEqual({
        variable: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
        contents: PLANTED,
      })
      expect(spawned[0]?.env).toEqual({ FAMILY: 'wiring' })
      // The line's variable stays on the strip list: no inherited copy competes.
      expect(spawned[0]?.stripEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
      // Canary first (the pipe holds it), then the env and argv that must not.
      expect(JSON.stringify(spawned[0]?.pipe)).toContain(PLANTED)
      expect(JSON.stringify([spawned[0]?.env, spawned[0]?.args])).not.toContain(PLANTED)
    },
  )

  it.runIf(process.platform === 'linux')(
    'every Claude engine start gets a pipe of its own: a respawn (resume) carries the new key',
    async () => {
      const store = new SessionAccessStore({ markers: memoryMarkers() })
      store.remember(SESSION, access, 'claude-code')
      const { scope, spawned } = scopeWith(store)
      await start(scope)
      const rotated = 'sk-FAKE-planted-engine-secret-0006'
      store.remember(SESSION, {
        ...access,
        delivery: { kind: 'env', variable: 'ANTHROPIC_API_KEY', secret: rotated },
      })
      await start(scope)
      expect(spawned.map((s) => s.pipe?.contents)).toEqual([PLANTED, rotated])
      expect(spawned[0]?.pipe).not.toBe(spawned[1]?.pipe)
    },
  )

  it.runIf(process.platform === 'linux')(
    "a one-shot Claude turn's process gets the session's pipe too, and no leading arguments",
    async () => {
      const store = new SessionAccessStore({ markers: memoryMarkers() })
      store.remember(SESSION, access, 'claude-code')
      const { scope, spawned } = scopeWith(store)
      await scope.startEngine({
        turnFor: SESSION,
        label: `podium-turn-${SESSION}`,
        command: testBoundCommand('/bin/sh', ['-c', 'wrapper']),
        cwd: '/tmp',
        env: { FAMILY: 'turn' },
        stripEnv: ['ANTHROPIC_API_KEY'],
      })
      expect(spawned[0]?.pipe?.variable).toBe('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR')
      expect(spawned[0]?.args).toEqual(['-c', 'wrapper'])
      expect(spawned[0]?.env).toEqual({ FAMILY: 'turn' })
    },
  )

  it("a one-shot turn of a variable-delivered credential is left to the turn's own env", async () => {
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    store.remember(SESSION, codexAccess, 'codex')
    const { scope, spawned } = scopeWith(store)
    await scope.startEngine({
      turnFor: SESSION,
      label: `podium-turn-${SESSION}`,
      command: testBoundCommand('/bin/sh', ['-c', 'wrapper']),
      cwd: '/tmp',
      env: { OPENAI_API_KEY: PLANTED },
      stripEnv: ['CODEX_API_KEY'],
    })
    expect(spawned[0]).toEqual({
      env: { OPENAI_API_KEY: PLANTED },
      stripEnv: ['CODEX_API_KEY'],
      args: ['-c', 'wrapper'],
    })
  })

  it.runIf(process.platform === 'linux')(
    'an empty Claude key starts no engine (POD-7378)',
    async () => {
      const store = new SessionAccessStore({ markers: memoryMarkers() })
      store.remember(
        SESSION,
        { ...access, delivery: { kind: 'env', variable: 'CLAUDE_CODE_OAUTH_TOKEN', secret: '' } },
        'claude-code',
      )
      const { scope, spawned } = scopeWith(store)
      await expect(start(scope)).rejects.toThrow(/credential .* is empty/)
      expect(spawned).toEqual([])
    },
  )

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
    const delivered =
      process.platform === 'linux' ? spawned[0]?.pipe?.contents : spawned[0]?.env.ANTHROPIC_API_KEY
    expect(delivered).toBe(PLANTED)
  })

  it('a codex engine on a ChatGPT plan starts with the provider flags, the token in env only (Task 15, acceptance 1)', async () => {
    const token = 'tok-FAKE-planted-plan-engine-0015'
    const store = new SessionAccessStore({ markers: memoryMarkers() })
    store.remember(
      SESSION,
      {
        credentialId: 'cred_00000000-0000-4000-8000-0000000000f5',
        delivery: { kind: 'env', variable: 'ACCESS_TOKEN', secret: token },
      },
      'codex',
    )
    const { scope, spawned } = scopeWith(store)
    await scope.startEngine({
      sessionId: SESSION,
      label: `podium-cx-${SESSION}`,
      command: testBoundCommand('codex', ['app-server', '--listen', 'stdio://']),
      cwd: '/tmp',
      env: {},
      stripEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'],
    })
    const args = spawned[0]?.args ?? []
    // The provider comes before the subcommand: `codex -c … app-server`.
    const subcommand = args.indexOf('app-server')
    const provider = args.indexOf('model_provider="podium_chatgpt_plan"')
    expect(provider).toBeGreaterThan(0)
    expect(provider).toBeLessThan(subcommand)
    expect(args).toContain('model_providers.podium_chatgpt_plan.env_key="ACCESS_TOKEN"')
    expect(spawned[0]?.env.ACCESS_TOKEN).toBe(token)
    expect(spawned[0]?.stripEnv).not.toContain('ACCESS_TOKEN')
    // Canary first, then the search that must come back empty.
    expect(JSON.stringify(spawned[0]?.env)).toContain(token)
    expect(JSON.stringify(args)).not.toContain(token)
  })
})
