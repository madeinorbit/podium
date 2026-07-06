import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  computeCodexTrustedHash,
  ensurePodiumCodexHooks,
  PODIUM_CODEX_HOOK_COMMAND,
} from './codex-hooks.js'

const execFileAsync = promisify(execFile)

const home = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'podium-codex-hooks-'))
  await mkdir(join(dir, '.codex'), { recursive: true })
  return dir
}

describe('ensurePodiumCodexHooks', () => {
  it('skips silently when ~/.codex does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-codex-hooks-'))
    const res = await ensurePodiumCodexHooks({ homeDir: dir })
    expect(res.installed).toBe(false)
    expect(existsSync(join(dir, '.codex', 'hooks.json'))).toBe(false)
  })

  it('creates hooks.json + trust entries from scratch', async () => {
    const dir = await home()
    const res = await ensurePodiumCodexHooks({ homeDir: dir })
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
    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain(':session_start:0:0"]')
    expect(toml).toContain(':stop:0:0"]')
    expect(toml.match(/trusted_hash = "sha256:/g)?.length).toBe(6)
  })

  it('is idempotent — second run writes nothing', async () => {
    const dir = await home()
    await ensurePodiumCodexHooks({ homeDir: dir })
    const res = await ensurePodiumCodexHooks({ homeDir: dir })
    expect(res).toMatchObject({ installed: true, changed: false })
  })

  it('preserves foreign hooks and trust entries, appending podium after them', async () => {
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
    await writeFile(
      join(dir, '.codex', 'config.toml'),
      [
        'model = "gpt-5.5"',
        '',
        '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:aaaa"',
        '',
      ].join('\n'),
    )
    await ensurePodiumCodexHooks({ homeDir: dir })

    const doc = JSON.parse(await readFile(join(dir, '.codex', 'hooks.json'), 'utf8'))
    expect(doc.hooks.Stop[0].hooks[0].command).toBe(foreignCommand)
    expect(doc.hooks.Stop[1].hooks[0].command).toBe(PODIUM_CODEX_HOOK_COMMAND)

    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('model = "gpt-5.5"')
    expect(toml).toContain('sha256:aaaa') // foreign trust entry untouched
    expect(toml).toContain(':stop:1:0"]') // podium keyed at its appended index
  })

  it('re-keys trust entries when foreign hooks shift podium to a new group index', async () => {
    const dir = await home()
    await ensurePodiumCodexHooks({ homeDir: dir }) // podium at Stop group 0
    // Another tool prepends its own Stop group — podium shifts to group 1.
    const hooksPath = join(dir, '.codex', 'hooks.json')
    const doc = JSON.parse(await readFile(hooksPath, 'utf8'))
    doc.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'other' }] })
    await writeFile(hooksPath, JSON.stringify(doc))

    await ensurePodiumCodexHooks({ homeDir: dir })
    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain(':stop:1:0"]')
    // The stale podium entry for :stop:0:0 must be gone (its identity no longer
    // matches; codex would prompt/drop on it).
    expect(toml).not.toContain(':stop:0:0"]\nenabled = true')
  })
})

describe('computeCodexTrustedHash', () => {
  it('is stable and shaped like codex-rs command_hook_hash', () => {
    const h = computeCodexTrustedHash({ eventLabel: 'stop', command: 'echo hi', timeoutSec: 5 })
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(h).toBe(computeCodexTrustedHash({ eventLabel: 'stop', command: 'echo hi', timeoutSec: 5 }))
    expect(h).not.toBe(computeCodexTrustedHash({ eventLabel: 'stop', command: 'echo hi' }))
  })
})

// Real-binary smoke (cli-invocations-need-real-binary-smoke): installs into an
// isolated CODEX_HOME and runs a real `codex exec` turn WITHOUT
// --dangerously-bypass-hook-trust. Hooks only fire if the trust hash recipe is
// bit-exact for the installed codex — this is the test that catches codex-rs
// changing its hash serialization. Skips when codex or auth is unavailable.
describe('codex hooks real-binary smoke', () => {
  const auth = join(homedir(), '.codex', 'auth.json')
  const enabled = process.env.PODIUM_SKIP_REAL_CLI !== '1' && existsSync(auth)

  it.skipIf(!enabled)(
    'trusted install fires UserPromptSubmit + Stop into the ingest URL',
    async () => {
      try {
        await execFileAsync('codex', ['--version'], { timeout: 10_000 })
      } catch {
        return // codex binary not runnable here
      }
      const dir = await home()
      await copyFile(auth, join(dir, '.codex', 'auth.json'))
      await writeFile(join(dir, '.codex', 'config.toml'), '[features]\nhooks = true\n')
      await ensurePodiumCodexHooks({ homeDir: dir })

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
          const child = spawn('codex', ['exec', '--skip-git-repo-check', 'Reply with exactly: done'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            cwd: dir,
            env: {
              ...process.env,
              CODEX_HOME: join(dir, '.codex'),
              PODIUM_CODEX_HOOK_URL: `http://127.0.0.1:${port}/hooks/test`,
            },
          })
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
      expect(received).toContain('UserPromptSubmit')
      expect(received).toContain('Stop')
    },
    180_000,
  )
})
