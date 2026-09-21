import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '@podium/harness'
import { addSink, type LogRecord } from '@podium/logger'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  type CodexVersionProbe,
  checkPodiumHookTrust,
  codexInstrumentation,
  detectCodexVersion,
  ensurePodiumCodexHooks,
  parseCodexHookTrustState,
  PODIUM_CODEX_HOOK_COMMAND,
  parseCodexVersion,
  podiumHookPositions,
  supportsCodexHooks,
} from './instrumentation.js'

// POD-518 [spec:SP-0be7]: every mkdtemp in this file is tracked and removed when the file's
// tests finish, so a suite run leaves nothing behind in tmp.
const tmpDirs: string[] = []
function trackTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const LEGACY_PODIUM_CODEX_HOOK_COMMAND = `bash -c 'u="$PODIUM_CODEX_HOOK_URL"; [ -n "$u" ] || exit 0; curl --data-binary @- "$u"'`

const execFileAsync = promisify(execFile)
const knownVersion: CodexVersionProbe = async () => 'codex-cli 0.146.0'
const ensureHooks = (opts: Parameters<typeof ensurePodiumCodexHooks>[0] = {}) =>
  ensurePodiumCodexHooks({ ...opts, versionProbe: opts.versionProbe ?? knownVersion })

const home = async (): Promise<string> => {
  const dir = trackTmp('podium-codex-hooks-')
  await mkdir(join(dir, '.codex'), { recursive: true })
  return dir
}

describe('ensurePodiumCodexHooks', () => {
  it('skips silently when ~/.codex does not exist', async () => {
    const dir = trackTmp('podium-codex-hooks-')
    const res = await ensureHooks({ homeDir: dir })
    expect(res.installed).toBe(false)
    expect(existsSync(join(dir, '.codex', 'hooks.json'))).toBe(false)
  })

  it('creates hook definitions without writing private trust state', async () => {
    const dir = await home()
    const onDegraded = vi.fn()
    const res = await ensureHooks({ homeDir: dir, onDegraded })
    expect(res).toMatchObject({ installed: true, changed: true })

    const doc = JSON.parse(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8'))
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
    ]) {
      expect(doc.hooks[event]?.[0]?.hooks?.[0]?.command).toBe(PODIUM_CODEX_HOOK_COMMAND)
      expect(doc.hooks[event]?.[0]?.hooks?.[0]?.timeout).toBe(5)
    }
    expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(false)
    // POD-4076 first-run shape: a fresh home has the file but no trust, so
    // Codex will silently run none of it. The installer must say so rather
    // than report success, and must still not write trust on our behalf.
    expect(res).toMatchObject({ trusted: false, degraded: true })
    expect(res.untrustedEvents).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'PostToolUse',
        'Stop',
      ]),
    )
    expect(onDegraded).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'codex-hooks-untrusted',
        title: 'Codex hooks need review',
      }),
    )
    expect(String(onDegraded.mock.calls[0]?.[0]?.body)).toContain('/hooks')
  })

  // PARITY RECORD (this issue): Codex subscribes SessionStart and
  // UserPromptSubmit but never PreCompact, so driver prime is delivered once
  // per session incarnation and is never re-armed by a hook. The codec still
  // answers a synthetic PreCompact (pinned per harness elsewhere), but a real
  // Codex run never sends one — compaction re-prime for Codex needs its own
  // path, and the removal must not assume the hook will do it.
  it('never subscribes PreCompact, so hooks cannot re-arm Codex prime', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const doc = JSON.parse(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8'))
    expect(Object.keys(doc.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ])
    expect(doc.hooks.PreCompact).toBeUndefined()
  })

  it('is idempotent — second run writes nothing', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const res = await ensureHooks({ homeDir: dir })
    expect(res).toMatchObject({ installed: true, changed: false })
  })

  it('refreshes an installed handler that predates stdin draining', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: LEGACY_PODIUM_CODEX_HOOK_COMMAND, timeout: 5 }],
            },
          ],
        },
      }),
    )

    await ensureHooks({ homeDir: dir })
    const doc = JSON.parse(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8'))
    expect(doc.hooks.Stop[0].hooks[0].command).toBe(PODIUM_CODEX_HOOK_COMMAND)
  })

  it('preserves foreign hooks and leaves all trust state untouched', async () => {
    const dir = await home()
    const foreignCommand = '/usr/bin/python3 /home/u/.codex/hooks/other-tool.py'
    await writeFile(
      join(dir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: foreignCommand }] }],
        },
      }),
    )
    const config = [
      'model = "gpt-5.5"',
      '',
      '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:aaaa"',
      '',
    ].join('\n')
    await writeFile(join(dir, '.codex', 'config.toml'), config)
    // The foreign entry trusts stop:0:0, but Podium lands at stop:1:0 here —
    // so the install must still report untrusted while leaving the file alone.
    const res = await ensureHooks({ homeDir: dir })

    const doc = JSON.parse(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8'))
    expect(doc.hooks.Stop[0].hooks[0].command).toBe(foreignCommand)
    expect(doc.hooks.Stop[1].hooks[0].command).toBe(PODIUM_CODEX_HOOK_COMMAND)

    expect(await readFile(join(dir, '.codex', 'config.toml'), 'utf8')).toBe(config)
    expect(res).toMatchObject({ installed: true, trusted: false })
    expect(res.untrustedEvents).toContain('Stop')
  })

  it('accepts a Codex newer than the last exercised version (ceilings never block)', async () => {
    for (const raw of ['codex-cli 0.147.0', 'codex-cli 0.154.0', 'codex-cli 1.0.0']) {
      const version = parseCodexVersion(raw)
      if (!version) throw new Error(`unparseable ${raw}`)
      expect(supportsCodexHooks(version)).toBe(true)
    }
    const old = parseCodexVersion('codex-cli 0.141.9')
    if (!old) throw new Error('unparseable')
    expect(supportsCodexHooks(old)).toBe(false)
  })

  it('degrades loudly and leaves both Codex files untouched on an unknown version', async () => {
    const dir = await home()
    const hooks = '{"hooks":{"Stop":[]}}\n'
    const config = 'model = "gpt-5.6"\n'
    await writeFile(join(dir, '.codex', 'hooks.json'), hooks)
    await writeFile(join(dir, '.codex', 'config.toml'), config)
    const onDegraded = vi.fn()
    // Observed through a SINK: the operator-facing banner goes through the
    // logger now, so a console spy would see nothing.
    const records: LogRecord[] = []
    const dispose = addSink({ name: 'test', write: (r) => records.push(r) })

    const res = await ensureHooks({
      homeDir: dir,
      versionProbe: async () => 'codex-cli 0.141.0',
      onDegraded,
    })

    expect(res).toMatchObject({ installed: false, changed: false, degraded: true })
    expect(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8')).toBe(hooks)
    expect(await readFile(join(dir, '.codex', 'config.toml'), 'utf8')).toBe(config)
    expect(onDegraded).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'codex-version-unsupported',
        observedVersion: 'codex-cli 0.141.0',
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'Codex hooks need review',
        code: 'codex-version-unsupported',
        observedVersion: 'codex-cli 0.141.0',
      }),
    )
    dispose()
  })
})

describe('codex hook trust detection (POD-4076)', () => {
  const events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'Stop',
  ] as const
  const snake: Record<string, string> = {
    SessionStart: 'session_start',
    UserPromptSubmit: 'user_prompt_submit',
    PreToolUse: 'pre_tool_use',
    PermissionRequest: 'permission_request',
    PostToolUse: 'post_tool_use',
    Stop: 'stop',
  }

  function trustConfig(hooksJsonPath: string, opts?: { enabled?: boolean; omitHash?: boolean }): string {
    const lines = ['model = "gpt-5.5"', '']
    for (const event of events) {
      lines.push(`[hooks.state."${hooksJsonPath}:${snake[event]}:0:0"]`)
      if (!opts?.omitHash) lines.push('trusted_hash = "sha256:aaaa"')
      if (opts?.enabled !== undefined) lines.push(`enabled = ${opts.enabled ? 'true' : 'false'}`)
      lines.push('')
    }
    return lines.join('\n')
  }

  it('reports trusted only when every Podium handler has a trust entry', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const hooksJsonPath = join(dir, '.codex', 'hooks.json')
    await writeFile(join(dir, '.codex', 'config.toml'), trustConfig(hooksJsonPath))

    const res = await ensureHooks({ homeDir: dir })
    expect(res).toMatchObject({ installed: true, trusted: true, untrustedEvents: [] })
    expect(res.degraded).toBeUndefined()
  })

  it('treats a missing enabled line as trusted (pre-field entries carry only the hash)', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const hooksJsonPath = join(dir, '.codex', 'hooks.json')
    // No `enabled` lines at all — the shape observed on live hosts.
    await writeFile(join(dir, '.codex', 'config.toml'), trustConfig(hooksJsonPath))

    const doc = JSON.parse(await readFile(hooksJsonPath, 'utf8'))
    const { trusted } = checkPodiumHookTrust({
      hooksJsonPath,
      doc,
      configText: trustConfig(hooksJsonPath),
    })
    expect(trusted).toBe(true)
  })

  it('reports untrusted when config.toml is absent and names the /hooks remedy', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const onDegraded = vi.fn()
    const res = await ensureHooks({ homeDir: dir, onDegraded })

    expect(res.trusted).toBe(false)
    expect(res.untrustedEvents).toEqual(expect.arrayContaining([...events]))
    expect(onDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'codex-hooks-untrusted' }),
    )
    expect(String(onDegraded.mock.calls[0]?.[0]?.body)).toContain('/hooks')
    // Reading to diagnose never writes trust on the user's behalf.
    expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(false)
  })

  it('reports untrusted when an entry is explicitly disabled', async () => {
    const dir = await home()
    await ensureHooks({ homeDir: dir })
    const hooksJsonPath = join(dir, '.codex', 'hooks.json')
    const config = trustConfig(hooksJsonPath).replace(
      `[hooks.state."${hooksJsonPath}:stop:0:0"]\ntrusted_hash = "sha256:aaaa"`,
      `[hooks.state."${hooksJsonPath}:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\nenabled = false`,
    )
    await writeFile(join(dir, '.codex', 'config.toml'), config)

    const res = await ensureHooks({ homeDir: dir })
    expect(res.trusted).toBe(false)
    expect(res.untrustedEvents).toEqual(['Stop'])
  })

  it('parses trust entries without a TOML dependency and ignores unparseable bodies', () => {
    const entries = parseCodexHookTrustState(
      [
        '[hooks.state."/h/hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:aaaa"',
        '',
        '[hooks.state."/h/hooks.json:pre_tool_use:0:0"]',
        'trusted_hash = "sha256:bbbb"',
        'enabled = false',
        '',
        '[hooks.state."/h/hooks.json:broken:0:0"]',
        'not toml at all :::',
        '',
      ].join('\n'),
    )
    expect(entries.get('/h/hooks.json:stop:0:0')).toMatchObject({
      trustedHash: 'sha256:aaaa',
    })
    expect(entries.get('/h/hooks.json:pre_tool_use:0:0')).toMatchObject({
      trustedHash: 'sha256:bbbb',
      enabled: false,
    })
    expect(entries.get('/h/hooks.json:broken:0:0')).toEqual({})
  })

  it('locates Podium handlers at their shifted indices beside foreign hooks', () => {
    const doc = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'foreign' }] },
          { hooks: [{ type: 'command', command: PODIUM_CODEX_HOOK_COMMAND, timeout: 5 }] },
        ],
      },
    }
    expect(podiumHookPositions(doc)).toEqual([
      { event: 'Stop', snake: 'stop', group: 1, handler: 0 },
    ])
  })
})

describe('PODIUM_CODEX_HOOK_COMMAND', () => {
  it('drains stdin before exiting when the routing env is absent', async () => {
    const child = spawn('bash', ['-c', PODIUM_CODEX_HOOK_COMMAND], {
      env: {
        ...process.env,
        PODIUM_SESSION_ID: '',
        PODIUM_CODEX_HOOK_URL: '',
        PODIUM_CODEX_HOOK_SOCKET: '',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    const stdinFinished = finished(child.stdin)
    child.stdin.end(Buffer.alloc(1024 * 1024, 'x'))

    const [exitCode, signal] = await once(child, 'close')
    await stdinFinished

    expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null })
  })

  it.skipIf(process.platform === 'win32')(
    'fails open without recreating the retired receipt spool when the daemon is unavailable',
    async () => {
      const dir = trackTmp('podium-codex-hook-command-')
      const receiptDir = join(dir, 'receipts')
      const payload = JSON.stringify({ session_id: 'thread-a', hook_event_name: 'SessionStart' })
      const child = spawn('bash', ['-c', PODIUM_CODEX_HOOK_COMMAND], {
        env: {
          ...process.env,
          PODIUM_SESSION_ID: 'pane-a',
          PODIUM_CODEX_HOOK_URL: '',
          PODIUM_CODEX_HOOK_SOCKET: join(dir, 'daemon-down.sock'),
          // A stale inherited value must not reactivate the removed writer.
          PODIUM_CODEX_HOOK_RECEIPT_DIR: receiptDir,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      child.stdin.end(payload)
      const [exitCode, signal] = await once(child, 'close')

      expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null })
      expect(existsSync(receiptDir)).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'prefers the stable socket even when the launch-time URL is stale',
    async () => {
      const dir = trackTmp('podium-codex-hook-command-')
      const socketPath = join(dir, 'hook.sock')
      let resolvePayload!: (payload: unknown) => void
      const received = new Promise<unknown>((resolve) => {
        resolvePayload = resolve
      })
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          resolvePayload(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          res.writeHead(200)
          res.end('{}')
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      try {
        const payload = { session_id: 'thread-a', hook_event_name: 'SessionStart' }
        const child = spawn('bash', ['-c', PODIUM_CODEX_HOOK_COMMAND], {
          env: {
            ...process.env,
            PODIUM_SESSION_ID: 'pane-a',
            PODIUM_CODEX_HOOK_URL: 'http://127.0.0.1:1/hooks/wrong-pane',
            PODIUM_CODEX_HOOK_SOCKET: socketPath,
          },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        child.stdin.end(JSON.stringify(payload))
        const [exitCode, signal] = await once(child, 'close')
        expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null })
        expect(await received).toEqual(payload)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )

  // PARITY RECORD (this issue): the wrapper discards the daemon's bounded
  // hook response on BOTH transports (socket and URL fallback), so Codex
  // hooks are observe-only — neither driver prime nor a mail veto can steer
  // Codex through this channel. Proven by execution, not by string-matching
  // the command: the stub daemon answers with prime and nothing reaches the
  // hook command's stdout. Surfacing responses to Codex needs a wrapper
  // change AND proof the harness consumes the new output.
  //
  // REAL-HARNESS PROOF (POD-4395, codex-cli 0.155.0): the harness WOULD consume
  // it. A real `codex exec` run with SessionStart/UserPromptSubmit hooks echoing
  // hookSpecificOutput.additionalContext markers recorded both markers in the
  // rollout as role-developer messages tagged
  // content_item_kinds:["hooks.additional_context"] before any model request —
  // so prime non-delivery on Codex is purely this wrapper's choice, and lifting
  // it is a wrapper change away. (The probe turn itself errored on quota before
  // reaching the model, which cost nothing and changed nothing: the injection
  // is recorded by the framework, not the model.)
  it.skipIf(process.platform === 'win32').each([
    { transport: 'socket', useUrl: false },
    { transport: 'url-fallback', useUrl: true },
  ])(
    'never surfaces the daemon hook response on stdout over $transport (observe-only transport)',
    async ({ useUrl }) => {
      const dir = trackTmp('podium-codex-hook-command-')
      const socketPath = join(dir, 'hook.sock')
      const primeBody = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIME' },
      })
      const answerPrime = (req: { on: (event: string, fn: (chunk: Buffer) => void) => void }, res: {
        writeHead: (code: number, headers: Record<string, string>) => void
        end: (body: string) => void
      }): void => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(primeBody)
        })
      }
      const socketServer = createServer(answerPrime)
      await new Promise<void>((resolve, reject) => {
        socketServer.once('error', reject)
        socketServer.listen(socketPath, resolve)
      })
      const httpServer = useUrl ? createServer(answerPrime) : undefined
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
      }
      const httpPort = httpServer
        ? ((): number => {
            const address = httpServer.address()
            return typeof address === 'object' && address ? address.port : 0
          })()
        : 0
      try {
        const child = spawn('bash', ['-c', PODIUM_CODEX_HOOK_COMMAND], {
          env: {
            ...process.env,
            PODIUM_SESSION_ID: 'pane-a',
            // The wrapper prefers the socket whenever it is set, so the
            // URL-fallback arm must leave it unset to reach the elif branch.
            PODIUM_CODEX_HOOK_URL: useUrl ? `http://127.0.0.1:${httpPort}/hooks/pane-a` : '',
            PODIUM_CODEX_HOOK_SOCKET: useUrl ? '' : socketPath,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const out: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
        child.stdin.end(JSON.stringify({ session_id: 'thread-a', hook_event_name: 'SessionStart' }))
        const [exitCode, signal] = await once(child, 'close')
        expect({ exitCode, signal }).toEqual({ exitCode: 0, signal: null })
        expect(Buffer.concat(out).toString('utf8')).toBe('')
      } finally {
        await new Promise<void>((resolve) => socketServer.close(() => resolve()))
        if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      }
    },
  )
})

// Real-binary smoke (cli-invocations-need-real-binary-smoke): the isolated
// CODEX_HOME contains only Podium's hook, so the documented automation-only
// trust bypass cannot run any user/project hooks. Production never sets it.
describe('codex hooks real-binary smoke', () => {
  const auth = join(homedir(), '.codex', 'auth.json')
  const enabled =
    process.env.PODIUM_REAL_CLI === '1' &&
    existsSync(auth) &&
    (() => {
      try {
        execFileSync('codex', ['--version'], {
          timeout: AGENT_VERSION_PROBE_TIMEOUT_MS,
          stdio: 'ignore',
        })
        return true
      } catch {
        return false
      }
    })()

  it.skipIf(!enabled)(
    'recognizes the installed real Codex binary before editing hook files',
    async () => {
      const version = parseCodexVersion(await detectCodexVersion())
      if (!version) throw new Error('installed Codex binary did not report a parseable version')
      expect(supportsCodexHooks(version)).toBe(true)
    },
  )

  it.skipIf(!enabled)(
    '[real-agent:codex] official hook payload reaches the ingest URL',
    async () => {
      try {
        await execFileAsync('codex', ['--version'], {
          timeout: AGENT_VERSION_PROBE_TIMEOUT_MS,
        })
      } catch {
        return // codex binary not runnable here
      }
      const dir = await home()
      await copyFile(auth, join(dir, '.codex', 'auth.json'))
      await writeFile(join(dir, '.codex', 'config.toml'), '[features]\nhooks = true\n')
      await ensurePodiumCodexHooks({ homeDir: dir })

      // SALVAGED FROM POD-4070 (commit 71dd868f6): the two-arm proof. The
      // isolated CODEX_HOME holds only Podium's hook and no persisted trust,
      // so the bypass arm cannot run any user/project hook. Production never
      // sets the flag — it is the UNTRUSTED arm's shape.
      async function runCodex(trust: 'bypassed' | 'unpersisted'): Promise<string[]> {
        const received: string[] = []
        const server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            try {
              const p = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                hook_event_name?: string
              }
              if (p.hook_event_name) received.push(p.hook_event_name)
            } catch {
              // ignore
            }
            res.writeHead(200)
            res.end('{}')
          })
        })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        try {
          // stdio.stdin MUST be closed ('ignore') — `codex exec` appends stdin to
          // the prompt and blocks until EOF on an open pipe.
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              'codex',
              [
                ...(trust === 'bypassed' ? ['--dangerously-bypass-hook-trust'] : []),
                'exec',
                '--skip-git-repo-check',
                'Reply with exactly: done',
              ],
              {
                stdio: ['ignore', 'ignore', 'ignore'],
                cwd: dir,
                env: {
                  ...process.env,
                  CODEX_HOME: join(dir, '.codex'),
                  PODIUM_CODEX_HOOK_URL: `http://127.0.0.1:${port}/hooks/test`,
                },
              },
            )
            const timer = setTimeout(() => {
              child.kill('SIGKILL')
              reject(new Error('codex exec timed out'))
            }, 120_000)
            child.on('exit', () => {
              clearTimeout(timer)
              resolve()
            })
            child.on('error', (err) => {
              clearTimeout(timer)
              reject(err)
            })
          })
        } finally {
          server.close()
        }
        return received
      }

      const received = await runCodex('bypassed')
      expect(received).toContain('UserPromptSubmit')
      expect(received).toContain('Stop')

      // The trust precondition: this CODEX_HOME has no persisted trust for
      // Podium's handlers, and Podium never writes Codex's trust state or
      // passes the bypass flag at launch. Without trust Codex runs none of
      // the hooks and says nothing about it — the hermetic trust-detection
      // tests above are what production relies on to say so instead.
      // Labelled as the UNTRUSTED world, not production's: on a host where
      // the operator approved via /hooks, production's hooks do fire.
      expect(await runCodex('unpersisted')).toEqual([])
    },
    180_000,
  )
})

/** Hook payload fixtures decode through the section, not past it (POD-4472). */
describe('codexInstrumentation.payloadCodec', () => {
  it('reads the snake_case routing fields', () => {
    const codec = codexInstrumentation.payloadCodec
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'cx1',
      transcript_path: '/tmp/rollout.jsonl',
    }
    expect(codec.eventName(payload)).toBe('UserPromptSubmit')
    expect(codec.sessionId(payload)).toBe('cx1')
    expect(codec.transcriptPath(payload)).toBe('/tmp/rollout.jsonl')
    expect(codec.eventName(null)).toBeUndefined()
  })

  it('decodes native hooks with the hook channel', async () => {
    const codec = codexInstrumentation.payloadCodec
    await expect(
      codec.decode({ hook_event_name: 'SessionStart', session_id: 'cx1' }),
    ).resolves.toEqual([{ kind: 'session_started', source: 'hook', confidence: 1 }])
    await expect(
      codec.decode({ hook_event_name: 'UserPromptSubmit', session_id: 'cx1' }),
    ).resolves.toEqual([{ kind: 'prompt_submitted', source: 'hook', confidence: 1 }])
    await expect(
      codec.decode({
        hook_event_name: 'Stop',
        session_id: 'cx1',
        last_assistant_message: 'All done.',
      }),
    ).resolves.toEqual([
      {
        kind: 'turn_completed',
        verdict: { kind: 'done', summary: 'All done.' },
        source: 'hook',
        confidence: 1,
      },
    ])
    await expect(codec.decode(null)).resolves.toEqual([])
  })

  it('declares the loopback transport', () => {
    expect(codexInstrumentation.hookTransport).toBe('loopback-http')
  })
})
