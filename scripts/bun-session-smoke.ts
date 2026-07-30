/**
 * Real session lifecycle through the Bun-running daemon, end to end:
 *   client WS -> server -> daemon -> Bun.Terminal -> abduco master -> agent -> frames.
 *
 * In-process server + daemon (so the daemon spawns via Bun.Terminal and persists via
 * bun:sqlite under Bun), driving a client over the wire exactly like the browser does:
 * attach, redraw, stream output, round-trip input, resize + take control. Uses the e2e
 * harness isolation so it can't touch the developer's real ~/.podium or live abduco
 * sessions, and reaps its durable master at the end.
 *
 * Run: bun --conditions=@podium/source scripts/bun-session-smoke.ts
 */
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'
import { encode, parseServerMessage } from '../packages/protocol/src/index.js'
import { applyHarnessEnv, reapHarnessSessions } from '../tests/e2e/harness-env'

const PORT = 9931
const FIXTURE = fileURLToPath(
  new URL('../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

reapHarnessSessions(PORT)
applyHarnessEnv(PORT)

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', (e) => reject(e), { once: true })
  })
}
function collect(ws: WebSocket): { readonly text: string } {
  let text = ''
  ws.addEventListener('message', (ev: MessageEvent) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw)
    } catch {
      return
    }
    if (msg.type === 'outputFrame') text += Buffer.from(msg.data, 'base64').toString('utf8')
  })
  return {
    get text() {
      return text
    },
  }
}
async function waitFor(pred: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`
console.log(`[smoke] runtime: ${runtime}`)

const srv = await startServer()
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${srv.port}`,
  launch: () => ({ cmd: 'node', args: [FIXTURE], cwd: '/tmp' }),
})
const { sessionId } = srv.registry.createSession({
  agentKind: 'claude-code',
  cwd: '/tmp',
  title: 'bun-smoke',
})
const client = await openWs(`ws://localhost:${srv.port}/client`)
const c = collect(client)

let ok = false
try {
  client.send(encode({ type: 'attach', sessionId }))
  client.send(encode({ type: 'redrawRequest', sessionId }))

  // 1) live agent output reaches the client through the full chain
  await waitFor(() => c.text.includes('cols=80 rows=24'), 'initial frame')
  console.log('[smoke] ✓ output streamed: cols=80 rows=24')

  // 2) input typed at the client round-trips to the agent and back
  client.send(encode({ type: 'input', sessionId, data: Buffer.from('a', 'utf8').toString('base64') }))
  await waitFor(() => c.text.includes('last-input=61'), 'input echo')
  console.log('[smoke] ✓ input round-trip: last-input=61')

  // 3) take control + resize repaints the agent at the new geometry
  client.send(encode({ type: 'resize', sessionId, cols: 100, rows: 30 }))
  client.send(encode({ type: 'requestControl', sessionId }))
  const sess = () => srv.registry.listSessions().find((s) => s.sessionId === sessionId)
  await waitFor(() => (sess()?.epoch ?? 0) >= 1, 'epoch bump')
  await waitFor(() => c.text.includes('cols=100 rows=30'), 'resize repaint')
  console.log('[smoke] ✓ resize + takeover: epoch bumped, repainted at cols=100 rows=30')

  ok = true
} finally {
  const bound = async (p: Promise<unknown>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 3000) })
    const result = await Promise.race([p.then(() => 'closed' as const), timeout])
    if (timer) clearTimeout(timer)
    console.log(`[smoke] ${label} ${result === 'timeout' ? 'close did not drain in 3s (known: Bun node:http close waits on sockets)' : 'closed'}`)
  }
  try { client.close() } catch {}
  await bound(daemon.close(), 'daemon')
  await bound(srv.close(), 'server')
  reapHarnessSessions(PORT)
}

console.log(ok ? '[smoke] PASS — session lifecycle works through the Bun daemon' : '[smoke] FAIL')
process.exit(ok ? 0 : 1)
