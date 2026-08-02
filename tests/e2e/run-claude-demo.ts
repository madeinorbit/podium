/**
 * Live validation: server + passive daemon (real `claude`) + a raw multiplexed client.
 * Creates a session, attaches, and prints claude's actual screen (ANSI-stripped) — proving
 * the real `claude` TUI renders through the MULTI-SESSION relay. A prompt is typed only if
 * the PROMPT env var is set (that one uses your claude quota); the default run is render-only.
 *
 * Run: bunx tsx tests/e2e/run-claude-demo.ts            (render-only)
 *      PROMPT='what is 2+2? one word' bunx tsx tests/e2e/run-claude-demo.ts
 */
import { encode } from '@podium/protocol'
import WebSocket from 'ws'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { startServer } from '../../apps/server/src/server'

/** THIS HOST's machine id (POD-318) — read from `<stateDir>/machine.id`, the same
 *  file the server and the split-mode daemon read. There is no `'local'` constant
 *  any more; a machine id is minted material.
 *
 *  A FUNCTION, not a module-level constant: these harnesses point PODIUM_STATE_DIR
 *  at an isolated directory AFTER the imports run, and a constant would have read
 *  (and minted into) the real state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

const SERVER_PORT = Number(process.env.PORT ?? 8787)
const PROMPT = process.env.PROMPT

const ANSI = /\[[0-9;?]*[ -/]*[@-~]|[()][0-9A-B]|[=>]|[ --]/g
const strip = (s: string): string => s.replace(ANSI, '')
const tail = (s: string, n: number): string =>
  strip(s)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n')
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const server = await startServer({ port: SERVER_PORT })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: hostMachineId(),
  hooks: { port: 0 },
  agentRelay: { port: 0 },
})
const { sessionId } = server.registry.createSession({
  agentKind: 'claude-code',
  cwd: process.cwd(),
})

let text = ''
const ws = new WebSocket(`ws://localhost:${server.port}/client`)
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve())
  ws.once('error', reject)
})
ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(raw.toString()) as { type: string; sessionId?: string; data?: string }
  if (msg.type === 'outputFrame' && msg.sessionId === sessionId && msg.data) {
    text += Buffer.from(msg.data, 'base64').toString('utf8')
  }
})
ws.send(encode({ type: 'hello', clientId: 'demo', viewport: { cols: 100, rows: 30, dpr: 1 } }))
ws.send(encode({ type: 'attach', sessionId }))
ws.send(encode({ type: 'redrawRequest', sessionId }))

await wait(6000)
console.log('=== CLAUDE INITIAL SCREEN (ansi-stripped, last 30 non-empty lines) ===')
console.log(tail(text, 30))
console.log(`[raw bytes received: ${text.length}]`)

if (PROMPT) {
  text = ''
  ws.send(
    encode({
      type: 'input',
      sessionId,
      data: Buffer.from(`${PROMPT}\r`, 'utf8').toString('base64'),
    }),
  )
  await wait(8000)
  console.log('\n=== AFTER TYPING A PROMPT (ansi-stripped, last 30 non-empty lines) ===')
  console.log(tail(text, 30))
  console.log(`[raw bytes received after input: ${text.length}]`)
}

ws.close()
await daemon.close()
await server.close()
process.exit(0)
