import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonMessage, encode, parseDaemonMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { type DaemonHandle, startDaemon } from './daemon'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)
const G = { cols: 80, rows: 24 }
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
type AgentFrame = Extract<DaemonMessage, { type: 'agentFrame' }>

describe('daemon multi-bridge', () => {
  let wss: WebSocketServer
  let serverSocket: WS
  let received: DaemonMessage[]
  let daemon: DaemonHandle

  beforeEach(async () => {
    received = []
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      // inject the deterministic fixture instead of real claude/codex
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
  })

  afterEach(async () => {
    await daemon.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })

  const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
  const frames = (): AgentFrame[] =>
    received.filter((m): m is AgentFrame => m.type === 'agentFrame')
  const fixtureFrame = (sid: string): AgentFrame | undefined =>
    frames().find((f) => f.sessionId === sid && decode(f.data).includes('PODIUM-FIXTURE'))
  async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('spawns independent bridges and tags bind + frames by sessionId', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's1'))
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 's2'))
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)
    const sids = new Set(frames().map((f) => f.sessionId))
    expect([...sids].sort()).toEqual(['s1', 's2'])
  })

  it('routes resize to the right bridge; kill stops only the targeted one', async () => {
    send({ type: 'spawn', sessionId: 's1', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    send({ type: 'spawn', sessionId: 's2', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => fixtureFrame('s1') !== undefined)
    await waitFor(() => fixtureFrame('s2') !== undefined)

    send({ type: 'kill', sessionId: 's1' })
    send({ type: 'resize', sessionId: 's2', cols: 90, rows: 30 })
    // s2 repaints at the new width...
    await waitFor(() =>
      frames().some((f) => f.sessionId === 's2' && decode(f.data).includes('cols=90')),
    )
    await new Promise((r) => setTimeout(r, 100))
    // ...and the killed s1 never reports the new size (resize was routed only to s2).
    expect(frames().some((f) => f.sessionId === 's1' && decode(f.data).includes('cols=90'))).toBe(
      false,
    )
  })

  it('scanRequest maps a discovered conversation to a wire-valid scanResult', async () => {
    // Isolate HOME to a temp dir seeded with one minimal claude conversation: fast +
    // deterministic (vs the dev's real ~/.claude, which can be thousands of files), and it
    // actually exercises summaryToWire. parseDaemonMessage (beforeEach) schema-validates
    // every received message, so a Date leak or a dropped providerId would fail at parse.
    const home = await mkdtemp(join(tmpdir(), 'podium-scan-'))
    const projDir = join(home, '.claude', 'projects', 'proj')
    await mkdir(projDir, { recursive: true })
    await writeFile(
      join(projDir, 'sess.jsonl'),
      `${[
        JSON.stringify({
          sessionId: 'sess-9',
          cwd: '/home/proj',
          timestamp: '2026-06-01T00:00:00.000Z',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T00:01:00.000Z',
          message: { role: 'assistant', content: 'yo' },
        }),
      ].join('\n')}\n`,
    )
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      send({ type: 'scanRequest', requestId: 'req-1' })
      await waitFor(() => received.some((m) => m.type === 'scanResult'))
    } finally {
      process.env.HOME = prevHome
    }
    const result = received.find(
      (m): m is Extract<DaemonMessage, { type: 'scanResult' }> => m.type === 'scanResult',
    )
    expect(result?.requestId).toBe('req-1')
    const conv = result?.conversations.find((c) => c.id === 'sess-9')
    expect(conv).toMatchObject({
      agentKind: 'claude-code',
      providerId: 'claude-code-jsonl',
      resume: { kind: 'claude-session', value: 'sess-9' },
    })
    expect(typeof conv?.createdAt).toBe('string') // Date → ISO string (mapper exercised)
  })
})
