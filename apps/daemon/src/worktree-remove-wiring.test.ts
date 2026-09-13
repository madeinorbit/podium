/**
 * THE `worktreeRemove` OP REACHES THE ESCALATION — over a real socket (PDM-373).
 *
 * `worktree-remove.test.ts` proves the removal; it proves nothing about whether
 * the product runs it. Delete the call site in `control/exec.ts` and that file
 * stays entirely green while `issue stop` and `issue cleanup` go back to
 * refusing every worktree on a superproject with a submodule — which is the
 * defect, and it is a WIRING defect. So this drives a real daemon over a real ws
 * connection and asks it to free a real worktree, the same way POD-1464's
 * unknown-op test does one door down.
 *
 * The two callers are bound by this one op: `freeWorktreeKeepBranch` (stop) and
 * `cleanup` in apps/server/src/modules/issues/service/workflow.ts each send
 * exactly this frame, and this is the only place the daemon runs it.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { startDaemon } from './daemon'

const execFileAsync = promisify(execFile)
const priorStateDir = process.env.PODIUM_STATE_DIR!

const IDENTITY = [
  '-c',
  'user.name=podium test',
  '-c',
  'user.email=test@podium.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'protocol.file.allow=always',
]

const git = async (cwd: string, ...argv: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...IDENTITY, ...argv])
  return stdout.trim()
}

describe('repoOp worktreeRemove frees a worktree containing a submodule (PDM-373)', () => {
  let dir: string
  let httpServer: Server
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-wtremove-wire-'))
    process.env.PODIUM_STATE_DIR = dir
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    await new Promise<void>((r) => httpServer.listen(0, () => r()))
    port = (httpServer.address() as { port: number }).port
  })
  afterEach(async () => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    for (const c of wss.clients) c.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    httpServer.closeAllConnections?.()
    await new Promise<void>((r) => httpServer.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers ok and leaves the branch at the same sha', async () => {
    const repo = join(dir, 'super')
    const sub = join(dir, 'sub')
    const worktree = join(dir, 'wt')
    const branch = 'issue/1-example'
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo])
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
    await execFileAsync('git', ['init', '-q', '-b', 'main', sub])
    await git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub root')
    await git(repo, 'submodule', 'add', '-q', '--', sub, 'oss/dep')
    await git(repo, 'commit', '-q', '-m', 'add submodule')
    await git(repo, 'worktree', 'add', '-q', '-b', branch, '--', worktree)
    await git(worktree, 'submodule', 'update', '--init', '-q')
    const sha = await git(repo, 'rev-parse', branch)

    let socket: WebSocket | undefined
    const replies: Record<string, unknown>[] = []
    wss.on('connection', (ws) => {
      socket = ws
      ws.once('message', () => {
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: WIRE_VERSION,
          caps: [],
          issuedToken: 'tok-1',
          assignedId: 'm-1',
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
      })
      ws.on('message', (raw) => {
        try {
          replies.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        } catch {}
      })
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      identityDir: dir,
      backend: 'none' as const,
      hooks: { port: 0, settingsDir: join(dir, 'hooks') },
      agentRelay: { port: 0 },
      discovery: { background: false as const, cachePath: ':memory:' },
      metrics: { background: false as const },
      pairCode: 'CODE-1',
    })
    try {
      socket?.send(
        JSON.stringify({
          type: 'repoOpRequest',
          requestId: 'ro-wtremove-1',
          op: 'worktreeRemove',
          cwd: repo,
          args: { path: worktree },
        }),
      )
      const result = await new Promise<Record<string, unknown> | undefined>((resolve) => {
        const deadline = Date.now() + 15_000
        const tick = setInterval(() => {
          const hit = replies.find((m) => m.requestId === 'ro-wtremove-1')
          if (hit || Date.now() > deadline) {
            clearInterval(tick)
            resolve(hit)
          }
        }, 50)
      })
      expect(result, 'daemon sent NO repoOpResult').toBeDefined()
      expect(result, String(result?.output ?? '')).toMatchObject({
        type: 'repoOpResult',
        requestId: 'ro-wtremove-1',
        ok: true,
      })
      expect(existsSync(worktree)).toBe(false)
      expect(await git(repo, 'rev-parse', branch)).toBe(sha)
    } finally {
      await daemon.close()
    }
  }, 40_000)
})
