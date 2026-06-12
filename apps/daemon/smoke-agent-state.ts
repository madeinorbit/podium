/**
 * One-shot live verification (not committed CI): spawn the REAL `claude` CLI
 * through the daemon and verify the hook → ingest → translate → reduce →
 * agentState pipeline with real payloads. Run: node_modules/.bin/tsx scripts/smoke-agent-state.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DaemonMessage, encode, parseDaemonMessage } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import { startDaemon } from './src/daemon'

const CWD = '/home/user/src/other/podium' // trusted project dir — no trust dialog
const settingsDir = mkdtempSync(join(tmpdir(), 'podium-smoke-hooks-'))
const received: DaemonMessage[] = []
const states = () => received.filter((m) => m.type === 'agentState')

const wss = new WebSocketServer({ port: 0 })
await new Promise<void>((r) => wss.once('listening', () => r()))
const port = (wss.address() as { port: number }).port
let sendToDaemon: (msg: unknown) => void = () => {}
wss.on('connection', (ws) => {
  sendToDaemon = (msg) => ws.send(encode(msg as never))
  ws.on('message', (raw) => {
    const msg = parseDaemonMessage(raw.toString())
    received.push(msg)
    if (msg.type === 'agentState')
      console.log(`[state] ${msg.state.phase}`, JSON.stringify(msg.state))
    if (msg.type === 'agentFrame') {
      const text = Buffer.from(msg.data, 'base64').toString('utf8')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for logs
      const clean = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '').trim()
      if (clean) console.log(`[pty] ${clean.slice(0, 200)}`)
    }
    if (msg.type === 'agentExit') console.log(`[exit] code=${msg.code}`)
    if (msg.type === 'spawnError') console.log(`[spawnError] ${msg.message}`)
  })
})

const daemon = await startDaemon({
  serverUrl: `ws://localhost:${port}`,
  tmux: false,
  discovery: { background: false, cachePath: ':memory:' },
  metrics: { background: false },
  hooks: { port: 0, settingsDir },
})
console.log(`daemon up, hook ingest on :${daemon.hookPort}`)

const waitFor = async (label: string, fn: () => boolean, ms = 60_000): Promise<boolean> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) {
      console.log(`TIMEOUT waiting for: ${label}`)
      return false
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`OK: ${label}`)
  return true
}

await new Promise((r) => setTimeout(r, 300)) // let the daemon ws connect
sendToDaemon({
  type: 'spawn',
  sessionId: 'smoke1',
  agentKind: 'claude-code',
  cwd: CWD,
  geometry: { cols: 120, rows: 40 },
})

await waitFor('bind', () => received.some((m) => m.type === 'bind'))
console.log('settings file:', readFileSync(join(settingsDir, 'smoke1.json'), 'utf8').slice(0, 120))

// NOTE (verified live, CLI 2.1.173): interactive mode fires NO SessionStart hook
// at UI boot — the first observable events are UserPromptSubmit/Stop. Phase stays
// 'unknown' until the first prompt, which the UI hides by design.
await new Promise((r) => setTimeout(r, 10_000)) // let the real CLI finish booting

// Type a trivial prompt into the PTY: UserPromptSubmit → working, Stop → idle
sendToDaemon({
  type: 'input',
  sessionId: 'smoke1',
  data: Buffer.from('reply with one word: ok\r').toString('base64'),
})
const gotWorking = await waitFor(
  'UserPromptSubmit → working',
  () => states().some((m) => m.type === 'agentState' && m.state.phase === 'working'),
  30_000,
)
const gotStopIdle = await waitFor(
  'Stop → idle (turn finished)',
  () => states().some((m) => m.type === 'agentState' && m.state.phase === 'idle'),
  120_000,
)

// Simulated error path through the real ingest (no quota burned)
await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/smoke1`, {
  method: 'POST',
  body: JSON.stringify({ hook_event_name: 'StopFailure', error_type: 'rate_limit' }),
})
const gotErrored = await waitFor(
  'simulated StopFailure → errored(rate_limit, retryable)',
  () =>
    states().some(
      (m) =>
        m.type === 'agentState' &&
        m.state.phase === 'errored' &&
        m.state.error?.class === 'rate_limit' &&
        m.state.error?.retryable === true,
    ),
  10_000,
)

sendToDaemon({ type: 'kill', sessionId: 'smoke1' })
await new Promise((r) => setTimeout(r, 500))
await daemon.close()
await new Promise<void>((r) => wss.close(() => r()))

console.log('--- SUMMARY ---')
console.log({ gotWorking, gotStopIdle, gotErrored })
process.exit(gotWorking && gotStopIdle && gotErrored ? 0 : 1)
