/**
 * THE LANDED PREDICATE REACHES THE PRODUCT — over a real socket (PDM-392).
 *
 * `branch-landed.test.ts` proves the predicate; it proves nothing about whether
 * anything RUNS it. Drop either call site in `control/exec.ts` and that file
 * stays entirely green while `cleanup` goes back to refusing every branch this
 * project ever lands — which is the defect, and it is a WIRING defect. So this
 * drives a real daemon over a real ws connection against a real repository
 * whose branch was landed by cherry-pick, the same shape PDM-373's wiring test
 * uses one door down.
 *
 * BOTH FRAMES MATTER AND THEY FAIL INDEPENDENTLY. `isBranchLanded` is the guard
 * cleanup asks before it removes anything; `branchDelete` is the delete that
 * git's own `-d` refuses for exactly the same wrong reason. Wiring one without
 * the other gets you a removed worktree and a branch that never goes away.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
]

const git = async (cwd: string, ...argv: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...IDENTITY, ...argv])
  return stdout.trim()
}

describe('repoOp isBranchLanded / branchDelete answer by CONTENT (PDM-392)', () => {
  let dir: string
  let httpServer: Server
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-landed-wire-'))
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

  it('reports a cherry-picked branch as landed, and deletes it', async () => {
    const repo = join(dir, 'r')
    const branch = 'issue/1-example'
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo])
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
    await git(repo, 'checkout', '-q', '-b', branch)
    writeFileSync(join(repo, 'leaf.txt'), 'the work\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'leaf: work')
    await git(repo, 'checkout', '-q', 'main')
    // A divergent commit first: without it the cherry-pick below would land on
    // the same parent with the same content and reproduce the branch's sha
    // exactly, fast-forwarding main and making the branch a true ancestor.
    writeFileSync(join(repo, 'other.txt'), 'elsewhere\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'somebody else landed first')
    await git(repo, 'cherry-pick', await git(repo, 'rev-parse', branch))
    // The shipped guard's answer, and git -d's, for contrast: both still "no".
    await expect(
      execFileAsync('git', ['-C', repo, 'merge-base', '--is-ancestor', '--', branch, 'main']),
    ).rejects.toThrow()

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
    const ask = async (
      requestId: string,
      op: string,
      args: Record<string, string>,
    ): Promise<Record<string, unknown> | undefined> => {
      socket?.send(JSON.stringify({ type: 'repoOpRequest', requestId, op, cwd: repo, args }))
      return await new Promise((resolve) => {
        const deadline = Date.now() + 15_000
        const tick = setInterval(() => {
          const hit = replies.find((m) => m.requestId === requestId)
          if (hit || Date.now() > deadline) {
            clearInterval(tick)
            resolve(hit)
          }
        }, 50)
      })
    }
    try {
      const guard = await ask('ro-landed-1', 'isBranchLanded', { branch, parentBranch: 'main' })
      expect(guard, 'daemon sent NO repoOpResult for isBranchLanded').toBeDefined()
      expect(guard, String(guard?.output ?? '')).toMatchObject({ ok: true })

      const del = await ask('ro-landed-2', 'branchDelete', { branch, parentBranch: 'main' })
      expect(del, 'daemon sent NO repoOpResult for branchDelete').toBeDefined()
      expect(del, String(del?.output ?? '')).toMatchObject({ ok: true })
      await expect(
        execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', branch]),
      ).rejects.toThrow()
    } finally {
      await daemon.close()
    }
  }, 40_000)
})
