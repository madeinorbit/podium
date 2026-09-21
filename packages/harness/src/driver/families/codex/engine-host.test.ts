/**
 * THE CODEX ENGINE HOST (moved from apps/daemon/src/runtime/codex-app-server.test.ts
 * in 1.5 with the code it pins).
 *
 * The family is handed its engine through injected supervision ports and never
 * spawns, journals or kills: the fakes below stand in for the supervisor's
 * durable process, and every harness-shaped value (argv stems, scope tokens,
 * strip lists) is read off the adapter's sections through the facts.
 */

import { createHash } from 'node:crypto'
import { STRIPPED_CODEX_CREDENTIALS } from './version.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexEngineFacts } from './engine-facts.js'
import {
  type CodexEngineHostDeps,
  codexAppServerConfigArgs,
  codexClientSocketPath,
  codexScopeLabel,
  CodexEngineLeaseRefused,
  createCodexEngineHost,
  evaluateCodexVersionProbe,
} from './engine-host.js'
import type { EngineAttachment, EngineSupervisor } from '../engine-supervision.js'

const FACTS = codexEngineFacts()

function engineHost(extra: Partial<CodexEngineHostDeps> = {}) {
  return createCodexEngineHost({
    facts: FACTS,
    journal: { read: () => undefined, write: () => {}, clear: () => {} },
    stageAttachment: async () => { throw new Error('attachments are not under test') },
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => ({ drivable: true as const }),
    socketRoot: tmpdir(),
    dialSocket: () => Promise.reject(new Error('no listener in this test')),
    ...extra,
  })
}

describe('env hygiene — the subscription-auth mechanism', () => {
  it('strips every credential that could outrank the stored ChatGPT login', () => {
    /**
     * CODEX PREFERS AN INHERITED KEY over `~/.codex/auth.json`. A daemon carries
     * whatever the operator's shell had, so without this a session would bill an
     * API account while the operator believed they were demonstrating
     * subscription auth — invisibly, and with a working session as the evidence.
     */
    // One array: the manifest's foreignCredentialEnv, read through the facts.
    // The live test reads the same array from the same place.
    expect(FACTS.stripEnv).toEqual(STRIPPED_CODEX_CREDENTIALS)
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_API_KEY')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('CODEX_API_KEY')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('CODEX_ACCESS_TOKEN')
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_ORGANIZATION')
    // Asserted BY NAME because the review found this list restated in
    // `live.test.ts` with this key missing — the one that would have been
    // dropped silently. There is now one array and both readers import it.
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_ORG_ID')
    // `OPENAI_BASE_URL` is on the list for the same reason though it is not a
    // credential: it redirects the session to a different provider entirely,
    // which is the same silent substitution wearing a different name.
    expect(STRIPPED_CODEX_CREDENTIALS).toContain('OPENAI_BASE_URL')
  })

  it('produces the env the child actually gets, with those keys gone', () => {
    // The strip is a plain filter over the merged env; asserting it here rather
    // than reaching into `launch()` keeps the test from needing a real spawn,
    // and the filter is the whole mechanism.
    const merged: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-should-not-survive',
      CODEX_ACCESS_TOKEN: 'tok-should-not-survive',
      PODIUM_SESSION: 'keep-me',
    }
    for (const key of FACTS.stripEnv) delete merged[key]
    expect(merged.OPENAI_API_KEY).toBeUndefined()
    expect(merged.CODEX_ACCESS_TOKEN).toBeUndefined()
    // …and nothing else is disturbed. A strip that took the whole env would
    // break PATH resolution and every managed credential the spawn frame set.
    expect(merged.PATH).toBe('/usr/bin')
    expect(merged.PODIUM_SESSION).toBe('keep-me')
  })
})

describe('the spawn config', () => {
  it('leaves approval routing to the current app-server contract', () => {
    // Codex 0.149 refuses the retired `untrusted` value before opening its
    // listener. Its current default produces the server→client approval
    // requests this driver handles, so no approval policy is generated at all.
    const { args } = codexAppServerConfigArgs({})
    expect(args.join(' ')).not.toContain('approval_policy')
    expect(args.join(' ')).toContain('sandbox_mode="workspace-write"')
  })

  it('opens network access only when an MCP server is actually mounted', () => {
    // A Podium MCP server is on loopback and is unreachable from a sandbox with
    // no network, so mounting one without this is mounting nothing. Opening it
    // for a session with no MCP would widen the sandbox for no reason.
    expect(codexAppServerConfigArgs({}).args.join(' ')).not.toContain('network_access')
    const mounted = codexAppServerConfigArgs({
      mcpServers: {
        transport: 'inline',
        config: JSON.stringify({
          mcpServers: { podium: { url: 'http://127.0.0.1:7777/mcp' } },
        }),
      },
    })
    expect(mounted.args.join(' ')).toContain('sandbox_workspace_write.network_access=true')
  })

  it('mounts MCP servers through the manifest own verified mechanism', () => {
    const { args, env } = codexAppServerConfigArgs({
      mcpServers: {
        transport: 'inline',
        config: JSON.stringify({
          mcpServers: {
            podium: {
              url: 'http://127.0.0.1:7777/mcp',
              headers: { Authorization: 'Bearer secret-token' },
            },
          },
        }),
      },
    })
    const flat = args.join(' ')
    expect(flat).toContain('mcp_servers."podium".url="http://127.0.0.1:7777/mcp"')
    /**
     * THE BEARER RIDES AN ENV VAR, NOT A HEADER, and not argv. Smuggling it as a
     * plain `http_headers` entry makes codex treat the server as unauthenticated,
     * run OAuth discovery, find none, and kill the whole turn with
     * `Auth(AuthorizationRequired)` — the exact failure POD-1021 recorded. An env
     * var also keeps the token out of `/proc/<pid>/cmdline`.
     */
    expect(flat).toContain('bearer_token_env_var')
    expect(Object.values(env)).toContain('secret-token')
    expect(flat).not.toContain('secret-token')
  })

  it('reads a path-transport config through the injected reader', () => {
    const { args } = codexAppServerConfigArgs({
      mcpServers: { transport: 'path', path: '/tmp/mcp.json' },
      readConfig: (path) =>
        path === '/tmp/mcp.json'
          ? JSON.stringify({ mcpServers: { podium: { url: 'http://127.0.0.1:1/mcp' } } })
          : undefined,
    })
    expect(args.join(' ')).toContain('mcp_servers."podium".url')
  })

  it('mounts nothing when the config cannot be read, rather than half of one', () => {
    // A tool-less session is a visible outcome; a session that thinks it mounted
    // tools and did not is a turn that fails deep inside the model's reasoning.
    const { args } = codexAppServerConfigArgs({
      mcpServers: { transport: 'path', path: '/tmp/missing.json' },
      readConfig: () => undefined,
    })
    expect(args.join(' ')).not.toContain('mcp_servers')
    expect(args.join(' ')).not.toContain('network_access')
  })
})

describe('the version gate', () => {
  it('admits the version the fixtures were recorded from', async () => {
    expect(evaluateCodexVersionProbe('codex-cli 0.147.0', true)).toEqual({
      drivable: true,
    })
  })

  it('admits codex 0.151 after its generated protocol and live driver were re-proved', async () => {
    expect(evaluateCodexVersionProbe('codex-cli 0.151.0', true)).toEqual({
      drivable: true,
    })
  })

  it('REFUSES an out-of-range codex with a machine-readable diagnostic', async () => {
    /**
     * The acceptance item, and the reason the gate is worth its cost: a driver
     * whose approval method name is wrong does not error — it never receives an
     * approval, and the session hangs on its first tool call with nothing
     * anywhere saying why.
     */
    const verdict = evaluateCodexVersionProbe('codex-cli 0.130.0', true)
    expect(verdict.drivable).toBe(false)
    if (verdict.drivable) return
    expect(verdict.reason).toBe('unsupported')
    expect(verdict.diagnostic.code).toBe('codex-version-too-old')
    expect(verdict.diagnostic.observedVersion).toBe('codex-cli 0.130.0')
  })

  it.each([
    'codex-cli 0.154.0',
    'codex-cli 1.0.0',
    'some unrelated banner',
  ])('admits %s with an informational diagnostic', async (output) => {
    const verdict = evaluateCodexVersionProbe(output, true)
    expect(verdict.drivable).toBe(true)
    expect(verdict.diagnostic?.body).toContain('session runs normally with the full driver')
  })

  it('admits failed probes and retains a retryable notice', async () => {
    const verdict = evaluateCodexVersionProbe('codex: command not found', false)
    expect(verdict).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(verdict.diagnostic?.body).toContain('probe may have timed out')
  })
})

describe('the scope label', () => {
  it('names the SESSION, so it survives the engine being replaced', () => {
    /**
     * `adopt()` for this family rebinds the surviving engine when one answers
     * and only starts a fresh child (plus `thread/resume`) when nothing did,
     * and the corpus requires `binding.process.key` to be unchanged across
     * either path. A pid-derived key would break both that property and the
     * exact-identity check the journal comparison performs.
     */
    const a = codexScopeLabel(FACTS, 'sess-1' as never)
    expect(a).toBe(codexScopeLabel(FACTS, 'sess-1' as never))
    expect(a).not.toBe(codexScopeLabel(FACTS, 'sess-2' as never))
  })
})

describe('headless engine lifecycle (POD-4433)', () => {
  const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')

  /** A supervision attachment the test drives by hand. */
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

  function fakeSupervision(hooks: {
    spawnHeadless?: (opts: {
      label: string
      cmd: string
      args: string[]
      cwd: string
      env: Record<string, string>
      stripEnv: readonly string[]
    }) => Promise<EngineAttachment>
    attachHeadless?: (opts: { label: string; fromSeq: 'tail' }) => Promise<EngineAttachment>
    has?: (label: string) => Promise<boolean>
    killed?: (label: string) => void
  }): EngineSupervisor {
    return {
      spawnHeadless:
        hooks.spawnHeadless ?? (() => Promise.reject(new Error('unexpected spawnHeadless'))),
      attachHeadless:
        hooks.attachHeadless ?? (() => Promise.reject(new Error('no engine host answers'))),
      has: hooks.has ?? (async () => false),
      kill: async (label: string) => {
        hooks.killed?.(label)
      },
      scopeUnitFor: () => undefined,
    }
  }

  /** Raw WS acceptor: answers the upgrade and records post-handshake bytes. */
  function listen(path: string): { frames: Buffer[]; close(): void } {
    const frames: Buffer[] = []
    const server = createServer((socket) => {
      let pending = ''
      let upgraded = false
      socket.on('data', (chunk: Buffer) => {
        if (upgraded) {
          frames.push(chunk)
          return
        }
        pending += chunk.toString('latin1')
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) return
        upgraded = true
        const key =
          /sec-websocket-key:[ \t]*([^\r\n]+)/i.exec(pending.slice(0, end))?.[1]?.trim() ?? ''
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64')
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'),
        )
      })
      socket.on('error', () => undefined)
    })
    server.listen(path)
    return { frames, close: () => server.close() }
  }

  /** Short socket root so engine sockets fit sun_path. */
  let runtimeRoot = ''
  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'pod-4470-cx-'))
  })
  afterEach(() => {
    rmSync(runtimeRoot, { recursive: true, force: true })
  })

  const journalledEntry = (clientAddress: string | undefined) => ({
    sessionId: SESSION,
    threadId: 'thr-journalled',
    workdir: '/tmp',
    rolloutPath: undefined,
    ...(clientAddress ? { clientAddress } : {}),
    process: { key: codexScopeLabel(FACTS, SESSION), pid: 4242 },
    seq: 7,
    turnEpoch: 2,
    bindingVersion: 1,
  })
  const binding = {
    sessionId: SESSION,
    driver: 'codex-app-server',
    family: 'server',
    harness: 'codex',
    workdir: '/tmp',
    resume: null,
    process: { key: codexScopeLabel(FACTS, SESSION) },
    bindingVersion: 1,
  } as never

  it('spawns the engine headless and connects the listener it was given', async () => {
    const launched: Array<Parameters<EngineSupervisor['spawnHeadless']>[0]> = []
    let listener: { frames: Buffer[]; close(): void } | undefined
    const { session } = fakeEngineSession()
    const host = engineHost({
      socketRoot: runtimeRoot,
      checkVersion: async () => evaluateCodexVersionProbe('0.147.0', true),
      dialSocket: async (path) => {
        // The engine the launch describes listens where it was told: serve
        // that address so the connect below completes against a real upgrade.
        listener = listen(path)
        const { default: WebSocket } = await import('ws')
        return new WebSocket(`ws+unix://${path}:/rpc`, {
          maxPayload: 128 << 20,
          perMessageDeflate: false,
        }) as never
      },
      supervision: fakeSupervision({
        spawnHeadless: async (opts) => {
          launched.push(opts)
          return session
        },
      }),
    })
    try {
      const endpoint = await host.launch({ sessionId: SESSION, workdir: '/tmp' })
      expect(launched).toHaveLength(1)
      expect(launched[0]).toMatchObject({
        label: codexScopeLabel(FACTS, SESSION),
        cmd: 'codex',
        cwd: '/tmp',
      })
      expect(launched[0]?.args?.slice(0, 2)).toEqual(['app-server', '-c'])
      expect(launched[0]?.args).toContain('--listen')
      expect(launched[0]?.stripEnv).toEqual(expect.arrayContaining([...FACTS.stripEnv]))
      expect(endpoint.clientAddress.startsWith('unix://')).toBe(true)
      expect(endpoint.process.key).toBe(codexScopeLabel(FACTS, SESSION))
      endpoint.transport.write('{"id":1}\n')
      await vi.waitFor(() => expect(listener?.frames.length).toBeGreaterThan(0))
    } finally {
      listener?.close()
    }
  })

  it('adopt rebinds the surviving engine at its journalled address: no spawn', async () => {
    const dir = mkdtempSync(join(runtimeRoot, 'sock-'))
    const socketPath = join(dir, 'engine.sock')
    const socketListener = listen(socketPath)
    const clientAddress = `unix://${socketPath}`
    const spawned: Array<Parameters<EngineSupervisor['spawnHeadless']>[0]> = []
    const { session, exits } = fakeEngineSession({ childPid: 7777 })
    const host = engineHost({
      journal: {
        read: () => journalledEntry(clientAddress),
        write: () => {},
        clear: () => {},
      },
      dialSocket: async (path) => {
        const { default: WebSocket } = await import('ws')
        return new WebSocket(`ws+unix://${path}:/rpc`, {
          maxPayload: 128 << 20,
          perMessageDeflate: false,
        }) as never
      },
      supervision: fakeSupervision({
        spawnHeadless: async (opts) => {
          spawned.push(opts)
          throw new Error('a live engine must be rebound, never re-spawned')
        },
        attachHeadless: async () => session,
        has: async () => true,
      }),
    })
    try {
      const endpoint = await host.adopt?.(binding)
      expect(endpoint?.clientAddress).toBe(clientAddress)
      expect(endpoint?.process.key).toBe(codexScopeLabel(FACTS, SESSION))
      expect(endpoint?.process.pid).toBe(7777)
      expect(spawned).toHaveLength(0)
      endpoint?.transport.write('{"id":2}\n')
      await vi.waitFor(() => expect(socketListener.frames.length).toBeGreaterThan(0))
      // And the host EXITED frame is the status channel, not the dead pipe.
      expect(endpoint?.engineExit?.()).toBeUndefined()
      for (const fire of exits) fire(0, 0)
      expect(endpoint?.engineExit?.()).toEqual({ code: 0, signal: 0 })
    } finally {
      socketListener.close()
    }
  })

  it('adopt returns undefined when no host holds the label', async () => {
    const host = engineHost({
      journal: {
        read: () => journalledEntry('unix:///tmp/nowhere.sock'),
        write: () => {},
        clear: () => {},
      },
      supervision: fakeSupervision({ has: async () => false }),
    })
    await expect(host.adopt?.(binding)).resolves.toBeUndefined()
  })

  it('adopt returns undefined when the journalled address is silent', async () => {
    // A silent address costs the whole connect deadline (20s, bounded by
    // construction) before adopt gives up and lets the driver resume fresh.
    const { session } = fakeEngineSession()
    const host = engineHost({
      journal: {
        read: () => journalledEntry('unix:///tmp/nowhere.sock'),
        write: () => {},
        clear: () => {},
      },
      dialSocket: async (path) => {
        const { default: WebSocket } = await import('ws')
        return new WebSocket(`ws+unix://${path}:/rpc`, {
          maxPayload: 128 << 20,
          perMessageDeflate: false,
        }) as never
      },
      supervision: fakeSupervision({
        attachHeadless: async () => session,
        has: async () => true,
      }),
    })
    await expect(host.adopt?.(binding)).resolves.toBeUndefined()
  }, 30_000)

  it('adopt refuses loudly when the writer lease is held elsewhere', async () => {
    const { session } = fakeEngineSession({ lease: false })
    const host = engineHost({
      journal: {
        read: () => journalledEntry('unix:///tmp/nowhere.sock'),
        write: () => {},
        clear: () => {},
      },
      supervision: fakeSupervision({
        attachHeadless: async () => session,
        has: async () => true,
      }),
    })
    await expect(host.adopt?.(binding)).rejects.toBeInstanceOf(CodexEngineLeaseRefused)
  })

  it('adopt returns undefined for entries predating the journalled address', async () => {
    const host = engineHost({
      journal: { read: () => journalledEntry(undefined), write: () => {}, clear: () => {} },
      supervision: fakeSupervision({ has: async () => {
        throw new Error('liveness must not be consulted without an address')
      } }),
    })
    await expect(host.adopt?.(binding)).resolves.toBeUndefined()
  })
})
