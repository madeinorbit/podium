import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ensurePodiumGrokHooks, PODIUM_GROK_HOOK_COMMAND } from './grok-hooks'

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


const execFileAsync = promisify(execFile)

async function home(): Promise<string> {
  const dir = trackTmp('podium-grok-hooks-')
  await mkdir(join(dir, '.grok'), { recursive: true })
  return dir
}

const events = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
]

describe('ensurePodiumGrokHooks', () => {
  it('skips silently when the Grok home does not exist', async () => {
    const dir = trackTmp('podium-grok-hooks-')
    const result = await ensurePodiumGrokHooks({ homeDir: dir })
    expect(result.installed).toBe(false)
    expect(existsSync(join(dir, '.grok', 'hooks', 'podium.json'))).toBe(false)
  })

  it('creates an env-gated personal hook for every native lifecycle event', async () => {
    const dir = await home()
    const result = await ensurePodiumGrokHooks({ homeDir: dir })
    expect(result).toMatchObject({ installed: true, changed: true })

    const doc = JSON.parse(await readFile(join(dir, '.grok', 'hooks', 'podium.json'), 'utf8'))
    for (const event of events) {
      expect(doc.hooks[event]?.[0]?.hooks?.[0]).toEqual({
        type: 'command',
        command: PODIUM_GROK_HOOK_COMMAND,
        timeout: 5,
      })
    }
  })

  it('is idempotent and preserves foreign hook groups', async () => {
    const dir = await home()
    const path = join(dir, '.grok', 'hooks', 'podium.json')
    await mkdir(join(dir, '.grok', 'hooks'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] }],
        },
      }),
    )

    await ensurePodiumGrokHooks({ homeDir: dir })
    const second = await ensurePodiumGrokHooks({ homeDir: dir })
    expect(second).toMatchObject({ installed: true, changed: false })
    const doc = JSON.parse(await readFile(path, 'utf8'))
    expect(doc.hooks.Stop[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'other-tool' }],
    })
    expect(doc.hooks.Stop[1].hooks[0].command).toBe(PODIUM_GROK_HOOK_COMMAND)
  })

  it('never overwrites a corrupt dedicated hook file', async () => {
    const dir = await home()
    const hooksDir = join(dir, '.grok', 'hooks')
    const path = join(hooksDir, 'podium.json')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(path, '{broken')
    const result = await ensurePodiumGrokHooks({ homeDir: dir })
    expect(result).toMatchObject({ installed: false, changed: false })
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })

  it('is discovered by the installed Grok CLI in an isolated home', async () => {
    try {
      await execFileAsync('grok', ['--version'], { timeout: 10_000 })
    } catch {
      return
    }
    const dir = await home()
    const grokHome = join(dir, '.grok')
    await ensurePodiumGrokHooks({ homeDir: dir })
    const { stdout } = await execFileAsync('grok', ['inspect', '--json'], {
      cwd: dir,
      env: { ...process.env, GROK_HOME: grokHome },
      timeout: 10_000,
    })
    const inspected = JSON.parse(stdout) as {
      hooks?: Array<{
        event?: string
        target?: string
        source?: { path?: string }
      }>
    }
    expect(inspected.hooks).toContainEqual(
      expect.objectContaining({
        event: 'PreToolUse',
        target: PODIUM_GROK_HOOK_COMMAND,
        source: expect.objectContaining({ path: join(grokHome, 'hooks') }),
      }),
    )
  })
})

describe('Podium Grok hook command', () => {
  it('contains no variables for Grok to pre-expand as required environment', () => {
    expect(PODIUM_GROK_HOOK_COMMAND).not.toMatch(/\$[A-Za-z_{]/)
  })

  it('exits successfully and performs no callback when PODIUM_GROK_HOOK_URL is absent', async () => {
    const dir = trackTmp('podium-grok-hook-cmd-')
    const marker = join(dir, 'curl-called')
    const curlPath = join(dir, 'curl')
    await writeFile(curlPath, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`)
    await chmod(curlPath, 0o755)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    }
    delete env.PODIUM_GROK_HOOK_URL

    const child = spawn('sh', ['-c', PODIUM_GROK_HOOK_COMMAND], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(stdout).toBe('')
  })

  it('posts the native stdin payload and relays a blocking response to stdout', async () => {
    let received: unknown
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason: 'read your Podium inbox' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const child = spawn('sh', ['-c', PODIUM_GROK_HOOK_COMMAND], {
        env: {
          ...process.env,
          PODIUM_GROK_HOOK_URL: `http://127.0.0.1:${port}/hooks/grok-test`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stdin.end(JSON.stringify({ hookEventName: 'PreToolUse', toolName: 'Bash' }))
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })

      expect(code).toBe(0)
      expect(received).toEqual({ hookEventName: 'PreToolUse', toolName: 'Bash' })
      expect(JSON.parse(stdout)).toEqual({
        decision: 'deny',
        reason: 'read your Podium inbox',
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
