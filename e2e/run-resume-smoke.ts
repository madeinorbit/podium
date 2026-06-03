/**
 * Loose resume validation: scan the local agent conversations, resume the most recent
 * claude conversation THROUGH THE RELAY, attach, and confirm it renders without a spawn
 * error. This validates that `claude --resume <id>` (built by agentLaunchCommand) actually
 * attaches. No prompt is typed, so it spends no quota.
 *
 * Run: bunx tsx e2e/run-resume-smoke.ts
 */
import { scanAgentConversations } from '@podium/agent-bridge'
import { encode } from '@podium/protocol'
import WebSocket from 'ws'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'

const SERVER_PORT = Number(process.env.PORT ?? 8788)
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for a readable preview
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

const scan = await scanAgentConversations()
const conv = scan.conversations.find((c) => c.agentKind === 'claude-code' && c.resume)
if (!conv) {
  console.log('No resumable claude conversation found in ~/.claude — nothing to validate.')
  process.exit(0)
}
console.log(`Resuming: "${conv.title ?? conv.id}" (${conv.resume?.value}) in ${conv.projectPath}`)

const server = await startServer({ port: SERVER_PORT })
const daemon = await startDaemon({ serverUrl: `ws://localhost:${server.port}` })
const { sessionId } = server.registry.resumeSession({
  agentKind: 'claude-code',
  cwd: conv.projectPath ?? process.cwd(),
  // biome-ignore lint/style/noNonNullAssertion: guarded by the find() predicate above
  resume: conv.resume!,
  conversationId: conv.id,
  ...(conv.title ? { title: conv.title } : {}),
})

let text = ''
let spawnError = ''
const ws = new WebSocket(`ws://localhost:${server.port}/client`)
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve())
  ws.once('error', reject)
})
ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(raw.toString()) as {
    type: string
    sessionId?: string
    data?: string
    code?: number
  }
  if (msg.sessionId !== sessionId) return
  if (msg.type === 'outputFrame' && msg.data)
    text += Buffer.from(msg.data, 'base64').toString('utf8')
  if (msg.type === 'agentExit') spawnError = `agent exited early (code ${msg.code})`
})
ws.send(encode({ type: 'hello', clientId: 'resume', viewport: { cols: 100, rows: 30, dpr: 1 } }))
ws.send(encode({ type: 'attach', sessionId }))
ws.send(encode({ type: 'redrawRequest', sessionId }))

await wait(8000)
console.log('=== RESUMED CLAUDE SCREEN (ansi-stripped, last 30 non-empty lines) ===')
console.log(tail(text, 30))
console.log(
  spawnError
    ? `RESUME FAILED — ${spawnError}`
    : text.length > 0
      ? `RESUME OK — claude --resume rendered ${text.length} bytes`
      : 'RESUME INCONCLUSIVE — no output (claude may need auth or longer warmup)',
)

ws.close()
await daemon.close()
await server.close()
process.exit(0)
