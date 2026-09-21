/**
 * THE OPENCODE ENGINE HOST (moved from apps/daemon/src/runtime/opencode-server.test.ts
 * in 1.5 with the code it pins).
 *
 * The family is handed its engine through injected supervision ports and never
 * spawns, journals or kills: the fakes below stand in for the supervisor's
 * durable process, and every harness-shaped value (serve argv, scope tokens,
 * strip lists, preview flavor) is read off the adapter's sections through the
 * flavor facts. The same host drives the preview speaker with different
 * flavor facts, no edits.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineBindUnrecoverable } from '../engine-supervision.js'
import { asSessionId } from '@podium/model'
import {
  type OpencodeEngineHostDeps,
  createOpencodeEngineHost,
  evaluateOpencode2VersionProbe,
  evaluateOpencodeVersionProbe,
  OpencodeEngineLeaseRefused,
  opencodeScopeLabel,
  probeHealth,
} from './engine-host.js'
import { opencode2Flavor, opencodeFlavor } from './engine-facts.js'
import { manifestFor } from '../../../registry.js'
import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSupervisor,
} from '../engine-supervision.js'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
const FLAVOR = opencodeFlavor(manifestFor('opencode')!)
const FLAVOR2 = opencode2Flavor(manifestFor('opencode')!)

function engineHost(extra: Partial<OpencodeEngineHostDeps> = {}) {
  return createOpencodeEngineHost({
    flavor: FLAVOR,
    journal: { read: () => undefined, write: () => {}, clear: () => {} },
    stageAttachment: async () => { throw new Error('attachments are not under test') },
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => null,
    freePort: async () => 41234,
    ...extra,
  })
}

/** A held engine attachment the test drives by hand. */
function fakeEngineSession(input: { childPid?: number; lease?: boolean } = {}): {
  session: EngineAttachment
  exits: Array<(code: number, signal: number) => void>
} {
  const exits: Array<(code: number, signal: number) => void> = []
  const session: EngineAttachment = {
    ready: Promise.resolve({
      lease: input.lease ?? true,
      childPid: input.childPid ?? 4242,
    }),
    connection: {
      onData: () => () => {},
      onExit: (cb: (code: number, signal: number) => void) => {
        exits.push(cb)
        return () => {}
      },
      signal: () => {},
    },
    dispose: () => {},
  }
  return { session, exits }
}

/**
 * Both ports the family consumes, built from one set of hooks: the
 * session-owned process verbs (`engines`) carry the behavior under test,
 * while the scope port (`supervision`) answers nothing on this platform.
 * Spread at the call site: `...fakePorts({ startEngine: ... })`.
 */
function fakePorts(hooks: {
  startEngine?: (opts: {
    label: string
    cmd: string
    args: string[]
    cwd: string
    env: Record<string, string>
    stripEnv: readonly string[]
  }) => Promise<EngineAttachment>
  reattachEngine?: (opts: { label: string; fromSeq: 'tail' }) => Promise<EngineAttachment>
  destroyed?: (label: string) => void
}): {
  supervision: Pick<EngineSupervisor, 'scopeUnitFor'>
  engines: EngineProcessOwner
} {
  return {
    supervision: { scopeUnitFor: () => undefined },
    engines: {
      startEngine:
        hooks.startEngine ?? (() => Promise.reject(new Error('unexpected startEngine'))),
      reattachEngine:
        hooks.reattachEngine ?? (() => Promise.reject(new Error('no engine host answers'))),
      engineAlive: async () => false,
      destroyEngine: async (label: string) => {
        hooks.destroyed?.(label)
      },
    },
  }
}

  it('admits only the OpenCode 2 betas whose API boundary is exercised', async () => {
    expect(evaluateOpencode2VersionProbe('0.0.0-beta-18743', true)).toEqual({ drivable: true })
    expect(evaluateOpencode2VersionProbe('0.0.0-beta-18866', true)).toEqual({ drivable: true })
    const future = evaluateOpencode2VersionProbe('0.0.0-beta-18867', true)
    expect(future.drivable).toBe(false)
    if (!future.drivable) expect(future.reason).toBe('unsupported')
  })

  it('probes the OpenCode 2 health route with its configured username', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      await expect(
        probeHealth('http://127.0.0.1:41427', 'secret', 'opencode', '/api/health'),
      ).resolves.toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:41427/api/health',
        expect.objectContaining({
          headers: { authorization: 'Basic b3BlbmNvZGU6c2VjcmV0' },
        }),
      )
    } finally {
      fetch.mockRestore()
    }
  })

  it('spawns the resolved executable headless under the session label', async () => {
    const executable = '/home/rig/.opencode/bin/opencode'
    const launched: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
    const stopped = new Error('stop after argv capture')
    const host = engineHost({
      executablePath: executable,
      checkVersion: async () => null,
      ...fakePorts({
        startEngine: async (opts) => {
          launched.push(opts)
          throw stopped
        },
      }),
    })

    await expect(
      host.launch({
        sessionId: SESSION,
        workdir: '/tmp',
        secret: 'secret',
        username: 'podium',
      }),
    ).rejects.toBe(stopped)

    // ONE engine per session, headless under podium-host: the label names the
    // session (so a restart re-adopts it), the argv is bare `serve`, and the
    // systemd scope the old spawn wrapped here is the host's own discipline now.
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: opencodeScopeLabel(FLAVOR, SESSION),
      cmd: executable,
      args: ['serve', '--port', '41234', '--hostname', '127.0.0.1'],
      cwd: '/tmp',
    })
    // RULE 2, pinned: the secret rides the env, never argv — and provider keys
    // are stripped by the host after the merge, exactly as the old delete loop.
    expect(launched[0]?.env).toMatchObject({
      OPENCODE_SERVER_USERNAME: 'podium',
      OPENCODE_SERVER_PASSWORD: 'secret',
    })
    expect(JSON.stringify(launched[0]?.args)).not.toContain('secret')
    expect(launched[0]?.stripEnv).toContain('ANTHROPIC_API_KEY')
  })

  it('passes the isolated database path to the OpenCode 2 server process', async () => {
    const stopped = new Error('stop after env capture')
    const launched: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
    const host = engineHost({
      flavor: FLAVOR2,
      flavorEnv: { OPENCODE_DB: '/instance/state/opencode2.db' },
      checkVersion: async () => null,
      ...fakePorts({
        startEngine: async (opts) => {
          launched.push(opts)
          throw stopped
        },
      }),
    })

    await expect(
      host.launch({
        sessionId: SESSION,
        workdir: '/tmp',
        secret: 'secret',
        username: 'opencode',
      }),
    ).rejects.toBe(stopped)
    expect(host.driverId).toBe('opencode2-server')
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: 'podium-oc2-11111111-1111-4111-8111-111111111111',
      cmd: 'opencode2',
      args: ['serve', '--port', '41234', '--hostname', '127.0.0.1'],
    })
    expect(launched[0]?.env).toMatchObject({
      OPENCODE_DB: '/instance/state/opencode2.db',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    })
  })

  it('builds serve argv from the resolved executable without changing PATH installs', () => {
    // The stem is the adapter's `runtime.server.spawn` section, with the
    // resolved executable and the supervisor-picked port substituted.
    expect(FLAVOR.serveArgs('/opt/resolved/opencode', 41234)).toEqual([
      '/opt/resolved/opencode',
      'serve',
      '--port',
      '41234',
      '--hostname',
      '127.0.0.1',
    ])
    expect(FLAVOR.serveArgs('/usr/bin/opencode', 41234)[0]).toBe('/usr/bin/opencode')
    expect(FLAVOR.serveArgs('opencode', 41234)[0]).toBe('opencode')
  })

  describe('headless adopt (POD-4433)', () => {
    const journalled = {
      sessionId: SESSION,
      opencodeSessionId: 'ses_adoptme',
      baseUrl: 'http://127.0.0.1:41234',
      username: 'podium',
      secret: 'journalled-secret',
      workdir: '/tmp',
      process: { key: opencodeScopeLabel(FLAVOR, SESSION), pid: 4242 },
      seq: 7,
      turnEpoch: 2,
      bindingVersion: 1,
    }
    const binding = {
      sessionId: SESSION,
      driver: 'opencode-server',
      family: 'server',
      harness: 'opencode',
      workdir: '/tmp',
      resume: null,
      process: { key: opencodeScopeLabel(FLAVOR, SESSION) },
      bindingVersion: 1,
    } as never

    function adoptHost(hooks: {
      reattachEngine?: (opts: { label: string; fromSeq: 'tail' }) => Promise<EngineAttachment>
    }) {
      return engineHost({
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        ...fakePorts(hooks),
      })
    }

    it('adopts a surviving server in place: same port and secret, no second spawn', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 49999,
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        ...fakePorts({
          startEngine: async (opts) => {
            spawned.push(opts)
            throw new Error('a live server must be adopted, never re-spawned')
          },
          reattachEngine: async () => session,
        }),
      })
      try {
        const endpoint = await host.launch({
          sessionId: SESSION,
          workdir: '/tmp',
          secret: 'fresh-secret',
          username: 'podium',
        })
        expect(endpoint.baseUrl).toBe(journalled.baseUrl)
        expect(endpoint.password).toBe(journalled.secret)
        expect(spawned).toHaveLength(0)
      } finally {
        fetch.mockRestore()
      }
    })

    it('host.adopt rebinds the survivor for the driver', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = adoptHost({ reattachEngine: async () => session })
      try {
        const endpoint = await host.adopt(binding)
        expect(endpoint?.baseUrl).toBe(journalled.baseUrl)
        expect(endpoint?.password).toBe(journalled.secret)
        expect(endpoint?.process.key).toBe(opencodeScopeLabel(FLAVOR, SESSION))
      } finally {
        fetch.mockRestore()
      }
    })

    it('a writer lease held elsewhere refuses loudly instead of spawning beside it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
      const { session } = fakeEngineSession({ childPid: 4242, lease: false })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 49999,
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        ...fakePorts({
          startEngine: async (opts) => {
            spawned.push(opts)
            throw new Error('must not spawn beside a leased engine')
          },
          reattachEngine: async () => session,
        }),
      })
      try {
        await expect(
          host.launch({
            sessionId: SESSION,
            workdir: '/tmp',
            secret: 'fresh-secret',
            username: 'podium',
          }),
        ).rejects.toBeInstanceOf(OpencodeEngineLeaseRefused)
        expect(spawned).toHaveLength(0)
      } finally {
        fetch.mockRestore()
      }
    })

    it('the host EXITED frame records the real status for the daemon', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session, exits } = fakeEngineSession({ childPid: 4242 })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 41234,
        journal: { read: () => undefined, write: () => {}, clear: () => {} },
        ...fakePorts({ startEngine: async () => session }),
      })
      try {
        const endpoint = await host.launch({
          sessionId: SESSION,
          workdir: '/tmp',
          secret: 'secret',
          username: 'podium',
        })
        expect(endpoint.engineExit?.()).toBeUndefined()
        for (const fire of exits) fire(3, 0)
        expect(endpoint.engineExit?.()).toEqual({ code: 3, signal: 0 })
      } finally {
        fetch.mockRestore()
      }
    })
  })

  it('admits recorded and newer versions', async () => {
    expect(evaluateOpencodeVersionProbe('1.18.16', true)).toEqual({ drivable: true })
    const verdict = evaluateOpencodeVersionProbe('2.0.0', true)
    expect(verdict.drivable).toBe(true)
    expect(verdict.diagnostic?.body).toContain('session runs normally')
  })

  it('refuses too old but admits an unknown version', async () => {
    const unsupported = evaluateOpencodeVersionProbe('1.17.99', true)
    expect(unsupported.drivable).toBe(false)
    expect(unsupported.diagnostic?.body).toContain('Install opencode 1.18 or newer')
    const unprobeable = evaluateOpencodeVersionProbe('opencode ETIMEDOUT', false)
    expect(unprobeable).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(unprobeable.diagnostic?.body).toContain('session runs normally')
  })

describe('the scope label', () => {
  it('is per-session and stable, which is what `adopt()` matches on', () => {
    const label = opencodeScopeLabel(FLAVOR, SESSION)
    expect(label).toContain(SESSION)
    // A PURE FUNCTION OF THE SESSION ID, and that is the property `adopt()`
    // depends on: the process identity must survive a restart that gives the
    // server a DIFFERENT port. A key derived from the port would let `adopt()`
    // bind to whatever process inherited it — the kernel recycles one within
    // seconds — which the contract calls worse than not adopting.
    expect(opencodeScopeLabel(FLAVOR, SESSION)).toBe(label)
    const other = asSessionId('33333333-3333-4333-8333-333333333333')
    expect(opencodeScopeLabel(FLAVOR, other)).not.toBe(label)
  })
})

describe('spec §6 — the secret rides the env', () => {
  it('keeps a secret out of the serve argv this daemon constructs', () => {
    const secret = 'a-very-secret-value'
    // The argv shape the launch path builds, read off the same section it
    // reads: port and hostname, and nothing else that could carry a
    // credential.
    const serveArgv = FLAVOR.serveArgs('opencode', 41234)
    expect(serveArgv.join(' ')).not.toContain(secret)
    // …and loopback is not a setting. A `--hostname 0.0.0.0` here would put spec
    // §6's whole argument in a config file.
    expect(serveArgv).toContain('127.0.0.1')
    expect(serveArgv).not.toContain('0.0.0.0')
  })
})

describe('§4.8 failure ownership — bind failure keeps the engine', () => {
  it('engine up but server silent: launch rejects typed, kills nothing, journals nothing', async () => {
    // §4.8 step 4, same shape as the codex family's: the health wait expires
    // with the engine running. Our hold is released but the engine is KEPT —
    // killing it would destroy what the lifecycle owner could still adopt
    // from this error's address and secret. The secret rides a field, never
    // the message.
    const killed: string[] = []
    const written: string[] = []
    const { session } = fakeEngineSession()
    const host = engineHost({
      checkVersion: async () => null,
      freePort: async () => 41234,
      journal: {
        read: () => undefined,
        write: (entry) => void written.push(entry.sessionId),
        clear: () => {},
      },
      ...fakePorts({
        startEngine: async () => session,
        destroyed: (label) => void killed.push(label),
      }),
    })
    const error = await host
      .launch({ sessionId: SESSION, workdir: '/tmp', secret: 's3cret', username: 'podium' })
      .then(
        () => null,
        (err: unknown) => err,
      )
    expect(error).toBeInstanceOf(EngineBindUnrecoverable)
    expect((error as EngineBindUnrecoverable).during).toBe('launch')
    expect((error as EngineBindUnrecoverable).address).toBe('http://127.0.0.1:41234')
    expect((error as EngineBindUnrecoverable).secret).toBe('s3cret')
    expect(String((error as Error).message)).not.toContain('s3cret')
    expect(killed).toEqual([])
    expect(written).toEqual([])
  }, 90_000)
})
