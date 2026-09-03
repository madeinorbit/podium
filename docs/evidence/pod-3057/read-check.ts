/**
 * POD-3057 — can anything READ a Claude SDK session's transcript?
 *
 *   bun docs/evidence/pod-3057/read-check.ts <arm>
 *
 * One question, asked on a named instance: after a real turn with a real reply,
 * does `sessions.read` return that conversation? The session stream is read
 * beside it as the control — a stream with the conversation and a read without
 * it is the defect; both empty means the turn never happened and the cell is
 * BLOCKED rather than red.
 *
 * The mechanism is measured too, on disk: which home holds the JSONL the CLI
 * wrote for this session. That is the fact the fix moves, and reporting the
 * count without it would leave "the reader was fixed" and "the writer moved"
 * indistinguishable.
 *
 * `<arm>` names the reading file only. WHICH CODE RAN is read out of the server
 * and daemon that are actually serving, and the cell refuses if either is not
 * the checked-out HEAD.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// The PRODUCT's own slug, imported rather than re-derived: a rig that spells
// the project directory itself can disagree with the reader and report a home
// as empty when it is only misspelled.
import { claudeProjectSlug } from '../../../packages/harness/src/agent-state/claude-locate.js'
import { Chat, login, mutate, query, wait } from '../pod-2777/rig'

const arm = (process.argv[2] ?? 'fix').toLowerCase()
if (!/^[a-z0-9-]{1,32}$/.test(arm)) throw new Error('arm must be a short slug')

const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3057n'
const PORT = process.env.PODIUM_PORT ?? '19958'
const ROOT = process.cwd()
const READING_DIR = join(ROOT, 'docs/evidence/pod-3057/readings')
const AGENT_HOME = join(
  process.env.P3057_STATE_ROOT ?? join(homedir(), '.local/state/podium/p3057n'),
  'agent-home',
)
const REPLY_MS = Number(process.env.P3057_REPLY_MS ?? 180_000)

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

const cwd = join(BASE, 'probes', 'read-check-' + arm)
const stamp = () => new Date().toISOString()
const short = (x: unknown, n = 300) => JSON.stringify(x).slice(0, n)
const out = (command: string, args: string[]) =>
  (spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '').trim()

interface Item {
  id?: string
  role?: string
  text?: string
  [key: string]: unknown
}

function pidInfo(path: string): { pid: string; alive: boolean } {
  const pid = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  let alive = false
  if (pid) {
    try {
      process.kill(Number(pid), 0)
      alive = true
    } catch {
      /* dead */
    }
  }
  return { pid, alive }
}

function daemonTos(): boolean {
  const pid = pidInfo(join(BASE, 'daemon.pid')).pid
  if (!pid) return false
  try {
    return readFileSync(join('/proc', pid, 'environ'), 'utf8')
      .split('\0')
      .includes('PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1')
  } catch {
    return false
  }
}

/** Every JSONL the CLI wrote for this workdir, under both candidate homes, with
 *  whether it holds the needle. The reader resolves ONLY the agent home. */
function transcriptsOnDisk(needle: string): Record<string, unknown> {
  const look = (home: string) => {
    const dir = join(home, '.claude', 'projects', claudeProjectSlug(cwd))
    if (!existsSync(dir)) return { dir, present: false, files: [] as string[], withNeedle: [] }
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    const withNeedle = files.filter((f) => {
      try {
        return readFileSync(join(dir, f), 'utf8').includes(needle)
      } catch {
        return false
      }
    })
    return { dir, present: true, files, withNeedle }
  }
  return { readerHome: look(AGENT_HOME), operatorHome: look(homedir()) }
}

function pinFor(): Record<string, unknown> {
  const checkoutSha = out('git', ['-C', ROOT, 'rev-parse', 'HEAD'])
  const dirty = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', 'HEAD', '--', '.', ':!docs']).status
  const server = pidInfo(join(BASE, 'server.pid'))
  const daemon = pidInfo(join(BASE, 'daemon.pid'))
  const read = (name: string) =>
    existsSync(join(BASE, name)) ? readFileSync(join(BASE, name), 'utf8').trim() : ''
  const pin = {
    arm,
    at: stamp(),
    checkoutSha,
    productTreeClean: dirty === 0,
    serverSha: read('server.sha'),
    daemonSha: read('daemon.sha'),
    serverPid: server.pid,
    daemonPid: daemon.pid,
    tosOnDaemon: daemonTos(),
    agentHome: AGENT_HOME,
    port: PORT,
  }
  if (
    !pin.productTreeClean ||
    pin.serverSha !== checkoutSha ||
    pin.daemonSha !== checkoutSha ||
    !server.alive ||
    !daemon.alive ||
    !pin.tosOnDaemon
  ) {
    throw new Error('pin mismatch ' + short(pin, 900))
  }
  return pin
}

async function transcript(sid: string): Promise<Item[]> {
  const r = await query('sessions.read', { sessionId: sid, turns: 500 })
  return ((r.result?.data as { items?: Item[] } | undefined)?.items ?? []) as Item[]
}

async function create(): Promise<{ sid: string; chat: Chat; row: Record<string, unknown> }> {
  mkdirSync(cwd, { recursive: true })
  if (!existsSync(join(cwd, '.git'))) {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd })
    writeFileSync(join(cwd, 'README.md'), 'POD-3057 read check ' + arm + '\n')
    spawnSync('git', ['add', 'README.md'], { cwd })
    spawnSync(
      'git',
      ['-c', 'user.email=drive@localhost', '-c', 'user.name=drive', 'commit', '-qm', 'probe seed'],
      { cwd },
    )
  }
  const made = await mutate('sessions.create', {
    cwd,
    agentKind: 'claude-code',
    runtimeContract: 'claude-sdk',
  })
  const sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId
  if (!sid) throw new Error('sessions.create failed ' + short(made))
  const chat = new Chat(sid)
  await chat.open('chat')
  const started = Date.now()
  let row: Record<string, unknown> | undefined
  while (Date.now() - started < 30_000) {
    const r = await query('sessions.status', { ref: sid })
    row = r.result?.data as Record<string, unknown> | undefined
    if (row?.driverId || row?.driverFamily) break
    await wait(250)
  }
  if (row?.driverId !== 'claude-sdk') {
    throw new Error('session did not bind the claude-sdk driver: ' + short(row))
  }
  await wait(2_000)
  return { sid, chat, row }
}

async function run(): Promise<Record<string, unknown>> {
  const { sid, chat, row } = await create()
  try {
    const needle = 'P3057-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Reply with exactly this token and nothing else: ' + needle,
    })
    const started = Date.now()
    let assistant = false
    while (Date.now() - started < REPLY_MS) {
      if (chat.assistantText().includes(needle)) {
        assistant = true
        break
      }
      await wait(500)
    }
    // The turn has to be OVER before the read is scored: a JSONL still being
    // written is not an empty one, and reading mid-turn would confuse the two.
    await wait(5_000)
    const streamItems = chat.items.map((x) => ({ ...x }) as Item)
    const readItems = await transcript(sid)
    const recap = await query('sessions.recap', { sessionId: sid, turns: 50 })
    const disk = transcriptsOnDisk(needle)

    const readHasNeedle = readItems.some((x) => String(x.text ?? '').includes(needle))
    const streamHasNeedle = streamItems.some((x) => String(x.text ?? '').includes(needle))
    const recapText = short(recap.result?.data ?? recap.error ?? null, 400)
    const controlFired = assistant || streamHasNeedle

    const verdict = !controlFired
      ? 'BLOCKED'
      : readItems.length === 0
        ? 'FAIL'
        : readHasNeedle
          ? 'PASS'
          : 'FAIL'
    return {
      verdict,
      summary:
        verdict === 'PASS'
          ? 'sessions.read returns the conversation the session stream showed'
          : verdict === 'BLOCKED'
            ? 'no reply ever reached the stream, so the read was not exercised'
            : readItems.length === 0
              ? 'the session stream holds the conversation and sessions.read answers with an empty page'
              : 'sessions.read answered items but not the conversation that happened',
      control: {
        fired: controlFired,
        what: 'a real assistant reply carrying the needle on the session stream',
        detail: 'assistant=' + assistant + '; streamItems=' + streamItems.length,
      },
      evidence: [
        'DRIVER            ' + short(row, 200),
        'SEND              ' + short(sent.result?.data ?? sent.error ?? null),
        'NEEDLE            ' + needle,
        'STREAM ITEMS      ' + streamItems.length + ' (needle=' + streamHasNeedle + ')',
        'SESSIONS.READ     ' + readItems.length + ' items (needle=' + readHasNeedle + ')',
        'SESSIONS.RECAP    ' + recapText,
        'DISK reader home  ' + short(disk.readerHome, 400),
        'DISK operator home' + short(disk.operatorHome, 400),
      ],
      data: { sid, needle, cwd, streamItems, readItems, disk, recap: recap.result?.data ?? null },
    }
  } finally {
    await chat.close().catch(() => {})
    await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  }
}

await login()
const at = stamp()
const pin = pinFor()
let reading: Record<string, unknown>
try {
  reading = await run()
} catch (error) {
  reading = {
    verdict: 'REFUSED',
    summary: 'cell could not be driven: ' + String(error).slice(0, 240),
    control: { fired: false, what: 'the complete pinned cell running to a result', detail: String(error) },
    evidence: ['ERROR             ' + String(error)],
    data: {},
  }
}
mkdirSync(READING_DIR, { recursive: true })
const full = { cell: 'READ', driver: 'claude-sdk', arm, cwd, at, pin, ...reading }
writeFileSync(join(READING_DIR, 'read-check.' + arm + '.json'), JSON.stringify(full, null, 2) + '\n')
console.log('claude-sdk/READ[' + arm + '] ' + full.verdict + ' — ' + full.summary)
for (const line of (full.evidence as string[]) ?? []) console.log(line)
