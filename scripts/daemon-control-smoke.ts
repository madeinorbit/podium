// Compile-harness fixture for apps/daemon/test/control-compiled.bun.test.ts.
// It exercises the standalone Bun-compiled daemon websocket path: after the daemon
// receives helloOk, a control frame sent immediately after must be processed.
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { startDaemon } from '../apps/daemon/src/daemon.js'
import type { DaemonHandshakeReply, DaemonMessage } from '../packages/protocol/src/index.ts'
import { encode, parseDaemonMessage } from '../packages/protocol/src/index.ts'

const FIXTURE = fileURLToPath(
  new URL('../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

const work = mkdtempSync(join(tmpdir(), 'podium-control-smoke-'))
const root = join(work, 'repo')
const settingsDir = join(work, 'hooks')
const received: DaemonMessage[] = []
const malformedControlWarnings: unknown[][] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  if (String(args[0]).includes('dropped malformed inbound control frame')) {
    malformedControlWarnings.push(args)
  }
  originalWarn(...args)
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
const wss = new WebSocketServer({ port: 0 })
try {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'file.txt'), 'ok\n')
  if (wss.address() === null) {
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  }
  const port = (wss.address() as { port: number }).port
  const connected = new Promise<void>((resolve) => {
    wss.once('connection', (ws: WS) => {
      let authed = false
      ws.on('message', (raw) => {
        if (!authed) {
          authed = true
          const ok: DaemonHandshakeReply = { type: 'helloOk', name: 'compiled-smoke' }
          ws.send(encode(ok))
          ws.send(
            encode({
              type: 'dirListRequest',
              requestId: 'dl-smoke',
              root,
              path: root,
            }),
          )
          resolve()
          return
        }
        const parsed = parseDaemonMessage(raw.toString())
        received.push(parsed)
      })
    })
  })
  daemon = await startDaemon({
    serverUrl: `ws://localhost:${port}`,
    bootstrapToken: 'test',
    hooks: { port: 0, settingsDir },
    issueRelay: { port: 0 },
    backend: 'none',
    discovery: { background: false, cachePath: ':memory:' },
    metrics: { background: false },
    launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
  })
  await connected
  const started = Date.now()
  while (!received.some((m) => m.type === 'dirListResult')) {
    if (Date.now() - started > 3000) throw new Error('dirListResult timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (malformedControlWarnings.length > 0) throw new Error('helloOk was parsed as control')
  const result = received.find(
    (m): m is Extract<DaemonMessage, { type: 'dirListResult' }> => m.type === 'dirListResult',
  )
  if (!result?.ok) throw new Error(`dirListResult not ok: ${result?.error ?? 'missing'}`)
  if (!result.entries.some((entry) => entry.name === 'file.txt')) {
    throw new Error('dirListResult missing file.txt')
  }
  console.log('SMOKE_OK')
} catch (err) {
  console.log(`SMOKE_FAILED ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  await daemon?.close().catch(() => {})
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  console.warn = originalWarn
  rmSync(work, { recursive: true, force: true })
}
