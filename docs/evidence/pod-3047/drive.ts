/**
 * POD-3047 — Claude SDK vs PTY acceptance at the current 1761 tip.
 *
 *   bun docs/evidence/pod-3047/drive.ts A1a claude-sdk
 *   bun docs/evidence/pod-3047/drive.ts A1a claude-pty
 *
 * One JSON reading per cell. Pin server, web, daemon before each run.
 * TOS acknowledgement is PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 on the daemon plus
 * an explicit per-spawn runtimeContract=claude-sdk. No token values are logged.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { Chat, login, mutate, primeTerminalTui, query, wait } from '../pod-2777/rig'

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNDRIVEN' | 'REFUSED'
type Driver = 'claude-sdk' | 'claude-pty'
type Mode = 'native' | 'chat'

interface Status {
  sessionId?: string
  driverId?: string | null
  requestedDriverId?: string | null
  driverFamily?: string | null
  status?: string
  phase?: string
  error?: { class?: string; detail?: string } | null
  [key: string]: unknown
}

interface Item {
  id?: string
  role?: string
  text?: string
  event?: string
  toolName?: string
  [key: string]: unknown
}

interface Control {
  fired: boolean
  what: string
  detail: string
}

interface Pin {
  cell: string
  at: string
  sourceRoot: string
  checkoutSha: string
  pinSha?: string
  serverSha: string
  daemonSha: string
  web: Record<string, unknown> | { error: string }
  webReuseProof?: Record<string, unknown>
  serverPid: string
  daemonPid: string
  serverAlive: boolean
  daemonAlive: boolean
  serverCwd: string
  daemonCwd: string
  tosOnDaemon: boolean
  freeMemory: Record<string, string>
  rootFreeKiB: number
  load1m: number
  credential: Record<string, unknown>
  forbiddenOverrides: Record<string, string | null>
}

const cell = (process.argv[2] ?? '').toUpperCase()
const driver = (process.argv[3] ?? '') as Driver
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3047'
const PORT = process.env.PODIUM_PORT ?? '19956'
const ROOT = process.cwd()
const READING_DIR = join(ROOT, 'docs/evidence/pod-3047/readings')
const PIN_DIR = join(ROOT, 'docs/evidence/pod-3047/pins')
const AGENT_HOME =
  process.env.P3047_STATE_ROOT
    ? join(process.env.P3047_STATE_ROOT, 'agent-home')
    : join(process.env.HOME ?? '', '.local/state/podium/p3047/agent-home')
const REPLY_MS = Number(process.env.P3047_REPLY_MS ?? 180_000)
const BUSY_MS = Number(process.env.P3047_BUSY_MS ?? 90_000)
const STEP_MS = 500
const QUOTA = /(?:weekly|usage|rate) limit|monthly spend limit|spend limit|quota|hit your limit|used\s+\d+%|resets?\s+[A-Z][a-z]{2}|resets?\s+\d/i
const LOGGED_OUT = /not logged in|run\s+\/login|sign in|oauth|token expired|refresh required/i

const CELLS = new Set([
  'A1A', 'A1B', 'A1C', 'A2A', 'A2B', 'A3', 'A4A', 'A4B', 'A5',
  'A6A', 'A6B', 'A7A', 'A7B', 'A8', 'A9', 'A10', 'BQUOTA', 'BAUTH', 'A3NEG',
])

if (!CELLS.has(cell)) throw new Error('unsupported cell ' + cell)
if (driver !== 'claude-sdk' && driver !== 'claude-pty') throw new Error('driver must be claude-sdk or claude-pty')
if (PORT === '19797') throw new Error('refusing to drive the operator instance')

const cwd = join(BASE, 'probes', driver + '-' + cell.toLowerCase())
const stamp = () => new Date().toISOString()
const short = (x: unknown, n = 260) => JSON.stringify(x).slice(0, n)
const textOf = (x: unknown) => (typeof x === 'string' ? x : String(x ?? ''))

function outputOf(command: string, args: string[]): string {
  return (spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '').trim()
}

function pidInfo(path: string): { pid: string; alive: boolean; cwd: string } {
  const pid = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  let alive = false
  let processCwd = ''
  if (pid) {
    try {
      process.kill(Number(pid), 0)
      alive = true
    } catch {
      /* dead */
    }
    try {
      processCwd = outputOf('readlink', [join('/proc', pid, 'cwd')])
    } catch {
      /* dead */
    }
  }
  return { pid, alive, cwd: processCwd }
}

function memInfo(): Record<string, string> {
  const rows: Record<string, string> = {}
  for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(MemTotal|MemAvailable|SwapFree):\s+(\d+)\s+(\w+)/)
    if (m) rows[m[1]] = m[2] + ' ' + m[3]
  }
  return rows
}

function rootFreeKiB(): number {
  const st = statSync('/')
  const df = outputOf('df', ['-kP', '/'])
  const line = df.split('\n')[1] ?? ''
  const parts = line.trim().split(/\s+/)
  return Number(parts[3] ?? 0)
}

function credentialMeta(): Record<string, unknown> {
  const live = join(process.env.HOME ?? '', '.claude/.credentials.json')
  const isolated = join(AGENT_HOME, '.claude/.credentials.json')
  const statOnly = (path: string) => {
    if (!existsSync(path)) return { present: false, path }
    const st = statSync(path)
    return { present: true, path, mtime: st.mtime.toISOString(), size: st.size }
  }
  return { live: statOnly(live), isolated: statOnly(isolated) }
}

function daemonTos(): boolean {
  const pid = pidInfo(join(BASE, 'daemon.pid')).pid
  if (!pid) return false
  try {
    const env = readFileSync(join('/proc', pid, 'environ'), 'utf8')
    return env.split('\0').includes('PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1')
  } catch {
    return false
  }
}

async function pinFor(label: string): Promise<Pin> {
  const checkoutSha = outputOf('git', ['-C', ROOT, 'rev-parse', 'HEAD'])
  const pinSha = process.env.P3047_PIN_SHA ?? '86d707d89ce37a5e8945a4c50bec31e8fe6a5005'
  const server = pidInfo(join(BASE, 'server.pid'))
  const daemon = pidInfo(join(BASE, 'daemon.pid'))
  const serverSha = existsSync(join(BASE, 'server.sha')) ? readFileSync(join(BASE, 'server.sha'), 'utf8').trim() : ''
  const daemonSha = existsSync(join(BASE, 'daemon.sha')) ? readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim() : ''
  let web: Record<string, unknown> | { error: string }
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/podium-build.json')
    web = (await r.json()) as Record<string, unknown>
  } catch (error) {
    web = { error: String(error) }
  }
  const forbiddenOverrides: Record<string, string | null> = {}
  for (const key of ['PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR', 'TMUX_TMPDIR']) {
    forbiddenOverrides[key] = process.env[key] ?? null
  }
  const webSha = typeof web === 'object' && 'sourceSha' in web ? textOf(web.sourceSha) : ''
  const webMatchesHead = webSha === checkoutSha.slice(0, 7)
  const reuse = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', webSha, 'HEAD', '--', 'apps/web'])
  const webReuseProof = {
    servedSourceSha: webSha,
    headShort: checkoutSha.slice(0, 7),
    appsWebIdentical: reuse.status === 0,
  }
  const isolatedCred = join(AGENT_HOME, '.claude/.credentials.json')
  const pin: Pin = {
    cell: label,
    at: stamp(),
    sourceRoot: ROOT,
    checkoutSha,
    pinSha,
    serverSha,
    daemonSha,
    web,
    webReuseProof,
    serverPid: server.pid,
    daemonPid: daemon.pid,
    serverAlive: server.alive,
    daemonAlive: daemon.alive,
    serverCwd: server.cwd,
    daemonCwd: daemon.cwd,
    tosOnDaemon: daemonTos(),
    freeMemory: memInfo(),
    rootFreeKiB: rootFreeKiB(),
    load1m: loadavg()[0],
    credential: credentialMeta(),
    forbiddenOverrides,
  }
  mkdirSync(PIN_DIR, { recursive: true })
  writeFileSync(join(PIN_DIR, driver + '-' + label.toLowerCase() + '.json'), JSON.stringify(pin, null, 2) + '\n')
  const overrides = Object.entries(forbiddenOverrides).filter(([, value]) => value !== null)
  const webOk = webMatchesHead || reuse.status === 0
  if (existsSync(isolatedCred)) {
    throw new Error('isolated credential present; no-copy fence ' + isolatedCred)
  }
  if (
    pinSha.length !== 40 ||
    serverSha !== pinSha ||
    daemonSha !== pinSha ||
    !server.alive ||
    !daemon.alive ||
    !webOk ||
    overrides.length > 0 ||
    pin.rootFreeKiB < 5 * 1024 * 1024 ||
    (driver === 'claude-sdk' && !pin.tosOnDaemon)
  ) {
    throw new Error('pin mismatch ' + short({ pinSha, checkoutSha, serverSha, daemonSha, webSha, webReuseProof, server, daemon, overrides, tosOnDaemon: pin.tosOnDaemon, rootFreeKiB: pin.rootFreeKiB }))
  }
  return pin
}

async function status(sid: string): Promise<Status | undefined> {
  const r = await query('sessions.status', { ref: sid })
  return r.result?.data as Status | undefined
}

async function listRow(sid: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('sessions.list', {})
  return (r.result?.data ?? []).find((x: Record<string, unknown>) => x.sessionId === sid) as Record<string, unknown> | undefined
}

async function transcript(sid: string): Promise<Item[]> {
  const r = await query('sessions.read', { sessionId: sid, turns: 500 })
  return ((r.result?.data as { items?: Item[] } | undefined)?.items ?? []) as Item[]
}

function joined(items: Item[], role?: string): string {
  return items
    .filter((x) => !role || x.role === role)
    .map((x) => textOf(x.text))
    .join('\n')
}

function hasNeedle(items: Item[], needle: string, role?: string): boolean {
  return joined(items, role).includes(needle)
}

async function waitForNeedle(sid: string, chat: Chat, needle: string, role: 'user' | 'assistant' | 'any', timeout = REPLY_MS) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const items = await transcript(sid)
    const inServer =
      role === 'user'
        ? hasNeedle(items, needle, 'user')
        : role === 'assistant'
          ? hasNeedle(items, needle, 'assistant')
          : hasNeedle(items, needle)
    const inChat =
      role === 'user'
        ? chat.userText().includes(needle)
        : role === 'assistant'
          ? chat.assistantText().includes(needle)
          : chat.userText().includes(needle) || chat.assistantText().includes(needle)
    if (inServer || inChat) return { ok: true, ms: Date.now() - started, items }
    await wait(STEP_MS)
  }
  return { ok: false, ms: Date.now() - started, items: await transcript(sid) }
}

async function waitPhase(sid: string, wanted: (phase: string | undefined, row: Status | undefined) => boolean, timeout: number, every = 250) {
  const started = Date.now()
  const samples: { ms: number; phase?: string; status?: string; driverId?: string | null }[] = []
  while (Date.now() - started < timeout) {
    const row = await status(sid)
    samples.push({ ms: Date.now() - started, phase: row?.phase, status: row?.status, driverId: row?.driverId })
    if (wanted(row?.phase, row)) return { ok: true, ms: Date.now() - started, row, samples }
    await wait(every)
  }
  return { ok: false, ms: Date.now() - started, row: await status(sid), samples }
}

async function waitIdle(sid: string, timeout = REPLY_MS) {
  return waitPhase(sid, (phase) => phase !== 'working', timeout, 500)
}

function result(verdict: Verdict, summary: string, control: Control, evidence: string[] = [], data: Record<string, unknown> = {}) {
  return { verdict, summary, control, evidence, data }
}

function classifyText(text: string): { errorClass: string; retryable: boolean | null } {
  const t = text.toLowerCase()
  if (/monthly spend|spend limit|usage limit|you'?ve hit your(?:\s+\w+)?\s+limit|quota (?:exceeded|exhausted)/.test(t)) {
    return { errorClass: 'usage_limit', retryable: false }
  }
  if (/\b429\b|rate.?limit|too many requests/.test(t)) return { errorClass: 'rate_limit', retryable: true }
  if (/\b401\b|not logged in|unauthorized|access token (is )?expired|authentication (failed|required)|invalid.*(token|auth|credential)|please (log|sign)[ -]?in/.test(t)) {
    return { errorClass: 'authentication', retryable: false }
  }
  return { errorClass: 'none', retryable: null }
}

async function create(): Promise<{ sid: string; chat: Chat; created: unknown; row?: Status }> {
  mkdirSync(cwd, { recursive: true })
  if (!existsSync(join(cwd, '.git'))) {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd })
    writeFileSync(join(cwd, 'README.md'), `POD-3047 ${driver} ${cell}\n`)
    spawnSync('git', ['add', 'README.md'], { cwd })
    spawnSync('git', ['-c', 'user.email=drive@localhost', '-c', 'user.name=drive', 'commit', '-qm', 'probe seed'], { cwd })
  }
  const body: Record<string, unknown> = { cwd, agentKind: 'claude-code' }
  if (driver === 'claude-sdk') body.runtimeContract = 'claude-sdk'
  else body.runtimeContract = 'claude-pty'
  const made = await mutate('sessions.create', body)
  const sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId
  if (!sid) throw new Error('sessions.create failed ' + short(made))
  const chat = new Chat(sid)
  await chat.open(driver === 'claude-pty' ? 'native' : 'chat')
  const bound = await waitPhase(sid, (_phase, row) => Boolean(row?.driverId) || Boolean(row?.driverFamily), 30_000, 250)
  if (driver === 'claude-pty') await primeTerminalTui(chat, sid)
  else await wait(2_000)
  const row = await status(sid)
  return { sid, chat, created: made.result?.data, row: bound.row ?? row }
}

async function cleanup(sid: string, chat?: Chat): Promise<void> {
  await chat?.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}

function input(chat: Chat, sid: string, text: string): void {
  chat.send({ type: 'input', sessionId: sid, data: Buffer.from(text).toString('base64'), inputOrigin: 'human' })
}

function view(chat: Chat, sid: string, mode: Mode): void {
  chat.send({ type: 'viewState', visible: [sid], focused: sid, modes: { [sid]: mode } })
}

async function screenNeedle(chat: Chat, needle: string, timeout = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (chat.screen.includes(needle)) return { ok: true, ms: Date.now() - started }
    await wait(STEP_MS)
  }
  return { ok: false, ms: Date.now() - started }
}

function identityOk(row?: Status): boolean {
  if (!row) return false
  if (driver === 'claude-sdk') return row.driverId === 'claude-sdk'
  return row.driverId === 'claude-pty' || row.driverFamily === 'terminal'
}

async function baselineReply(sid: string, chat: Chat, tag: string) {
  const needle = 'P3047-' + tag + '-' + Date.now().toString(36).toUpperCase()
  const sent = await mutate('sessions.sendText', {
    sessionId: sid,
    text: 'Reply with exactly this word and nothing else: ' + needle + '. Do not use tools.',
  })
  const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
  const assistant = await waitForNeedle(sid, chat, needle, 'assistant', REPLY_MS)
  await waitIdle(sid).catch(() => {})
  return { needle, sent, user, assistant }
}

interface ProcessRow {
  pid: number
  ppid: number
  cwd: string
  cmd: string
}

function sessionProcesses(target: string): ProcessRow[] {
  const ps = outputOf('ps', ['-eo', 'pid=,ppid=,args='])
  const rows: ProcessRow[] = []
  for (const line of ps.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    const processCwd = outputOf('readlink', [join('/proc', String(pid), 'cwd')])
    if (processCwd !== target) continue
    const stat = outputOf('cat', [join('/proc', String(pid), 'stat')])
    if (stat.split(') ')[1]?.startsWith('Z ')) continue
    rows.push({ pid, ppid: Number(match[2]), cwd: processCwd, cmd: match[3].trim() })
  }
  return rows.sort((a, b) => a.pid - b.pid)
}

function instanceProcesses(): ProcessRow[] {
  const inst = process.env.PODIUM_INSTANCE ?? 'p3047'
  const rows: ProcessRow[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const env = readFileSync(join('/proc', name, 'environ'), 'utf8')
      if (!env.split('\0').includes('PODIUM_INSTANCE=' + inst)) continue
      const pid = Number(name)
      rows.push({
        pid,
        ppid: 0,
        cwd: outputOf('readlink', [join('/proc', name, 'cwd')]),
        cmd: readFileSync(join('/proc', name, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim(),
      })
    } catch {
      /* gone */
    }
  }
  return rows
}

async function runA1a() {
  const { sid, chat } = await create()
  const turns: Record<string, unknown>[] = []
  let controlFired = false
  try {
    for (let i = 1; i <= 3; i++) {
      const needle = 'P3047-A1A-' + driver + '-' + i + '-' + Date.now().toString(36).toUpperCase()
      const sent = await mutate('sessions.sendText', {
        sessionId: sid,
        text: 'Reply with exactly this word and nothing else: ' + needle + '. Do not use tools.',
      })
      const delivered = Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok)
      const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
      const assistant = await waitForNeedle(sid, chat, needle, 'assistant', REPLY_MS)
      controlFired ||= delivered || user.ok || assistant.ok
      const row = await status(sid)
      turns.push({
        i,
        needle,
        sent: sent.result?.data ?? sent.error ?? null,
        delivered,
        user: user.ok,
        assistant: assistant.ok,
        userMs: user.ms,
        assistantMs: assistant.ms,
        chatAssistant: chat.assistantText().includes(needle),
        status: row,
      })
      if (!assistant.ok) break
      await waitIdle(sid)
    }
    const last = turns.at(-1) as Record<string, unknown> | undefined
    const control: Control = {
      fired: controlFired,
      what: 'send delivered or a needle appearing on the chat/transcript plane',
      detail:
        turns.filter((x) => x.delivered).length +
        '/' +
        turns.length +
        ' delivered; user=' +
        turns.filter((x) => x.user).length +
        ' assistant=' +
        turns.filter((x) => x.assistant).length +
        ' lastAssistant=' +
        String(last?.assistant ?? false),
    }
    const allThree = turns.length === 3 && turns.every((x) => x.assistant === true)
    return result(
      !controlFired ? 'BLOCKED' : allThree ? 'PASS' : 'FAIL',
      !controlFired
        ? 'no delivered send or needle; cell is not attributable'
        : allThree
          ? 'three idle sends replied, including the required last send'
          : 'one of the three idle sends did not land or reply',
      control,
      ['SENDS             ' + JSON.stringify(turns), 'IDENTITY          ' + short(await status(sid)), 'FRAME TYPES        ' + chat.frameSummary()],
      { sid, turns, driverRow: await status(sid) },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA1b() {
  const { sid, chat } = await create()
  try {
    const first = 'P3047-A1B-FIRST-' + Date.now().toString(36).toUpperCase()
    const queued = 'P3047-A1B-QUEUED-' + Date.now().toString(36).toUpperCase()
    const firstSent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Count from 1 to 160, putting each number on its own line with a full sentence. Do not use tools. Include ' + first + ' in the final line.',
    })
    const firstUser = await waitForNeedle(sid, chat, first, 'user', 5_000)
    const firstAssistantPreview = chat.assistantText().length > 0 || chat.deltaFrames > 0
    const working = await waitPhase(sid, (phase) => phase === 'working', 15_000, 250)
    const control: Control = {
      fired: firstUser.ok || firstAssistantPreview || working.ok || Boolean((firstSent.result?.data as { ok?: boolean } | undefined)?.ok),
      what: 'the first busy-turn send delivering and the session producing an in-flight signal',
      detail: 'first user turn=' + firstUser.ok + '; preview=' + firstAssistantPreview + '; working=' + working.ok + ' at ' + working.ms + 'ms',
    }
    if (!control.fired) return result('BLOCKED', 'busy-turn control did not land', control, ['FIRST SEND        ' + short(firstSent)], { sid, working: working.samples })
    if (!working.ok) {
      return result('BLOCKED', 'the first turn was not observed in flight, so queue behavior was not exercised', control, ['FIRST SEND        ' + short(firstSent), 'PHASE SAMPLES     ' + JSON.stringify(working.samples.slice(-12))], {
        sid,
        working: working.samples,
      })
    }
    const secondSent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Reply with exactly this word and nothing else: ' + queued + '. Do not use tools.',
    })
    await chat.close()
    const reloaded = new Chat(sid)
    await reloaded.open()
    const secondUser = await waitForNeedle(sid, reloaded, queued, 'user', 5_000)
    const secondAssistant = await waitForNeedle(sid, reloaded, queued, 'assistant', REPLY_MS)
    const payload = secondSent.result?.data ?? secondSent.error ?? null
    const payloadObject = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    const positionFrames = [...chat.positionFrames, ...reloaded.positionFrames]
    const framePosition = positionFrames.find((frame) => typeof frame.position === 'number' || typeof frame.queuePosition === 'number')
    const text = JSON.stringify(payload)
    const queuedFlag = /queued/i.test(text) && !/queued[^a-z]+false/i.test(text)
    const position =
      payloadObject?.position ?? payloadObject?.queuePosition ?? framePosition?.position ?? framePosition?.queuePosition ?? null
    const hasPositionField = typeof position === 'number' || positionFrames.length > 0
    const pass = queuedFlag && hasPositionField && secondAssistant.ok
    const out = result(
      pass ? 'PASS' : 'FAIL',
      pass
        ? 'busy send queued with a durable position, survived reload, and answered idle'
        : 'busy send did not show a durable queue position or did not answer after reload',
      control,
      [
        'FIRST SEND        ' + short(firstSent),
        'SECOND SEND       ' + short(payload),
        'QUEUE POSITION    ' + String(position),
        'POSITION FIELD    ' + hasPositionField,
        'RELOADED USER     ' + secondUser.ok + ' in ' + secondUser.ms + 'ms',
        'RELOADED REPLY    ' + secondAssistant.ok + ' in ' + secondAssistant.ms + 'ms',
      ],
      { sid, first, queued, firstUser: firstUser.ok, working: working.samples, second: payload, secondUser: secondUser.ok, secondAssistant: secondAssistant.ok, position, hasPositionField },
    )
    await reloaded.close()
    return out
  } finally {
    await cleanup(sid)
  }
}

async function runA1c() {
  const { sid, chat } = await create()
  try {
    const base = await baselineReply(sid, chat, 'A1C-CONTROL')
    const before = [...sessionProcesses(cwd), ...instanceProcesses().filter((row) => /claude|claude-sdk-host/i.test(row.cmd))]
    const agent = before.find((row) => /claude(?:-code)?(?:\s|$|\/)|claude-sdk-host/i.test(row.cmd))
    const control: Control = {
      fired: (base.user.ok || base.assistant.ok) && Boolean(agent),
      what: 'a baseline prompt/reply and the exact Claude child PID appearing before death',
      detail: 'baseline user=' + base.user.ok + '; baseline reply=' + base.assistant.ok + '; agentPid=' + String(agent?.pid ?? '(none)'),
    }
    if (!control.fired) return result('BLOCKED', 'baseline control did not fire', control, ['BASELINE          ' + short(base), 'PROCS             ' + short(before, 1800)], { sid, before })
    let killed = false
    let killError = ''
    try {
      process.kill(agent!.pid, 'SIGKILL')
      killed = true
    } catch (error) {
      killError = String(error)
    }
    await wait(1_500)
    const gone = !instanceProcesses().some((row) => row.pid === agent!.pid)
    const dead = 'P3047-A1C-DEAD-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + dead + '.' })
    const payload = sent.result?.data ?? sent.error ?? null
    const text = JSON.stringify(payload)
    const typed = Boolean(sent.error) || /refus|not found|dead|retir|exited|unknown session|cannot/i.test(text)
    const delivered = /disposition[^}]*delivered|queued[^}]*true|"ok"\s*:\s*true/i.test(text) && !typed
    const afterSend = await status(sid)
    const revivedReply = delivered ? await waitForNeedle(sid, chat, dead, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
    const pass = killed && gone && (typed ? !delivered : delivered && revivedReply.ok)
    const summary = !killed || !gone
      ? 'the exact Claude child was not confirmed dead, so the dead-session condition was not exercised'
      : pass && typed
        ? 'exact Claude child was killed after a live baseline; dead-session send returned a typed refusal'
        : pass
          ? 'dead-session send was queued and its assistant needle arrived after queue-triggered resurrection'
          : delivered
            ? 'dead-session send was accepted as queued, but its assistant needle did not arrive'
            : 'dead-session send was accepted without a typed refusal'
    return result(!killed || !gone ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', summary, control, [
      'BASELINE          ' + short(base),
      'CHILD PID         ' + agent!.pid,
      'CHILD CMD         ' + agent!.cmd,
      'KILL              SIGKILL sent=' + killed + (killError ? ' error=' + killError : ''),
      'CHILD GONE        ' + gone,
      'DEAD SEND         ' + short(payload),
      'AFTER SEND STATUS ' + short(afterSend),
      'TYPED REFUSAL     ' + typed,
      'RESURRECTED REPLY ' + revivedReply.ok + ' in ' + revivedReply.ms + 'ms',
    ], { sid, dead, payload, typed, delivered, revivedReply: revivedReply.ok, childPid: agent!.pid, killed, gone })
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA2a() {
  const { sid, chat } = await create()
  try {
    const needle = 'P3047-A2A-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Count from 1 to 180 with one sentence per number. Do not use tools. Include ' + needle + ' in your final line.',
    })
    const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
    const samples: { at: number; phase?: string; status?: string; driverId?: string | null }[] = []
    const started = Date.now()
    while (Date.now() - started < 15_000) {
      const row = await status(sid)
      samples.push({ at: Date.now() - started, phase: row?.phase, status: row?.status, driverId: row?.driverId })
      await wait(250)
    }
    const workingAt = samples.find((x) => x.phase === 'working')
    const idleDuring = samples.filter((x) => x.phase === 'idle').length
    const assistant = await waitForNeedle(sid, chat, needle, 'assistant', BUSY_MS)
    const after = await status(sid)
    const control: Control = {
      fired: user.ok || assistant.ok || Boolean(workingAt) || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok),
      what: 'the working-turn send delivering or producing a measurable in-flight signal',
      detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; workingAt=' + short(workingAt ?? null),
    }
    const pass = Boolean(workingAt && workingAt.at <= 2_000 && idleDuring === 0 && after?.phase !== 'working')
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL',
      !control.fired
        ? 'working-turn control did not land'
        : pass
          ? 'working appeared within 2s, stayed working through the sample, and returned idle'
          : 'working badge timing or continuity did not meet the release criterion',
      control,
      ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'WORKING AT        ' + short(workingAt ?? null), 'IDLE SAMPLES      ' + idleDuring, 'AFTER             ' + short(after)],
      { sid, user: user.ok, assistant: assistant.ok, workingAt, idleDuring, samples, after },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA2b() {
  const { sid, chat, created, row } = await create()
  try {
    const control: Control = {
      fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || Boolean(row?.driverId) || Boolean(created),
      what: 'new session attach/output/bind evidence independent of the status value',
      detail: 'created=' + short(created) + '; attached=' + (chat.frameTypes.get('attached') ?? 0) + '; driver=' + (row?.driverId ?? '(none)'),
    }
    const pass = row?.phase === 'idle'
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL',
      pass ? 'fresh session reported idle at boot' : 'fresh session reported ' + (row?.phase ?? 'blank') + ' at boot',
      control,
      ['STATUS            ' + short(row), 'SESSION ROW       ' + short(await listRow(sid)), 'FRAME TYPES       ' + chat.frameSummary()],
      { sid, status: row },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

/**
 * A3 — the interrupt cell, rewritten for POD-3047 after the POD-3043 repair.
 *
 * The POD-3036 scorer was `after.ok && (hasMarker || typedRefusal)`, where
 * `hasMarker` was a regex over EVERY transcript item's text. That could not
 * answer the question this issue asks: it cannot count records, it cannot tell
 * a record the runtime wrote from the model saying the word "cancel" in its own
 * prose, and it says nothing about whether the wording matches what the
 * provider actually did.
 *
 * The repair (dd839fc54) publishes exactly three system notes, with fixed text:
 *
 *   stop, confirmed    "Turn interrupted by the operator."
 *   stop, unconfirmed  "Turn interrupted by the operator; the model host did
 *                       not confirm the interrupt before the turn ended."
 *   refusal            "Interrupt refused by the model provider: <detail> The
 *                       turn is still running."
 *   idle receipt       "Interrupt refused: no turn was in flight."
 *
 * So this classifies on the RECORD, by exact wording and by item id prefix,
 * and counts. Three clauses, each scored separately and reported by name:
 *
 *   stopped     the turn left `working` after the interrupt
 *   exactlyOne  exactly one stop record for this turn, and it survives a
 *               transcript reload (durable, not a live-stream artefact)
 *   truthful    the wording matches the provider outcome that was actually
 *               available. See A3NEG for the control that makes this clause
 *               capable of failing.
 */
/**
 * WHICH PLANE THE RECORD LIVES ON, measured rather than assumed.
 *
 * The first version of this read `sessions.read` and found ZERO records — and
 * zero of everything else too, including the user turn the probe had just
 * watched land. `sessions.read` for a claude-sdk session resolves through
 * `rpc.readTranscript` into the Claude CLI's OWN store keyed by workdir; the
 * runtime's published items never enter it. A count of zero taken there is a
 * fact about the plane, not about the repair, and it would have been recorded
 * as a product red.
 *
 * The plane the daemon forwards published items onto is the session stream, so
 * that is what is scored: `chat.items`, upserted by id. `sessions.read` is still
 * dumped alongside as a second plane, because its emptiness is a finding of its
 * own and the reader should be able to see both numbers next to each other.
 */
async function interruptRecords(sid: string, chat: Chat): Promise<{
  items: Item[]
  serverItems: Item[]
  stop: Item[]
  confirmed: Item[]
  unconfirmed: Item[]
  refused: Item[]
  idle: Item[]
}> {
  const items = chat.items as unknown as Item[]
  const serverItems = await transcript(sid)
  const idIs = (x: Item, prefix: string) => typeof x.id === 'string' && x.id.startsWith(prefix)
  const CONFIRMED = 'Turn interrupted by the operator.'
  const UNCONFIRMED = 'Turn interrupted by the operator; the model host did not confirm'
  const REFUSED = 'Interrupt refused by the model provider:'
  const IDLE = 'Interrupt refused: no turn was in flight.'
  // Matched on BOTH the id the runtime mints and the exact text it writes, so a
  // transport that rewrites ids cannot make a present record read as absent and
  // a model quoting the sentence cannot make an absent one read as present.
  const confirmed = items.filter(
    (x) => textOf(x.text).trim() === CONFIRMED || (idIs(x, `claude-sdk-interrupt-${sid}-`) && textOf(x.text).trim() === CONFIRMED),
  )
  const unconfirmed = items.filter((x) => textOf(x.text).trim().startsWith(UNCONFIRMED))
  const refused = items.filter((x) => textOf(x.text).trim().startsWith(REFUSED) || idIs(x, `claude-sdk-interrupt-refused-${sid}-`))
  const idle = items.filter((x) => textOf(x.text).trim() === IDLE || idIs(x, `claude-sdk-interrupt-idle-${sid}-`))
  return { items, serverItems, stop: [...confirmed, ...unconfirmed], confirmed, unconfirmed, refused, idle }
}

function hostChildren(probeCwd: string): ProcessRow[] {
  return sessionProcesses(probeCwd).filter((row) => /claude-sdk-host/.test(row.cmd))
}

async function interruptTurn(freezeHost: boolean) {
  const load1m = loadavg()[0]
  if (load1m >= 12) {
    return result('UNDRIVEN', 'host load was ' + load1m.toFixed(2) + ' at the A3 gate; interrupt was not attempted', {
      fired: false,
      what: 'load gate below 12 before starting an interrupt turn',
      detail: '1m load=' + load1m.toFixed(2) + '; threshold=12',
    }, ['LOAD 1M           ' + load1m.toFixed(2)], { load1m, threshold: 12 })
  }
  const { sid, chat } = await create()
  const frozen: number[] = []
  try {
    const needle = 'P3047-A3-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Count from 1 to 220, one sentence per line, without tools. Include ' + needle + ' in the final line.',
    })
    const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
    const working = await waitPhase(sid, (phase) => phase === 'working', 15_000, 250)
    const before = await interruptRecords(sid, chat)
    const hosts = hostChildren(cwd)
    const control: Control = {
      fired: (user.ok || working.ok || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok)) && before.stop.length === 0,
      what: freezeHost
        ? 'a turn observed in flight, a claude-sdk-host child to freeze, and no pre-existing stop record'
        : 'a turn observed in flight and no pre-existing stop record',
      detail:
        'user=' + user.ok + '; working=' + working.ok + '; hostChildren=' + hosts.length +
        '; preExistingStopRecords=' + before.stop.length,
    }
    if (!working.ok) {
      return result('BLOCKED', 'no in-flight turn was observed, so interrupt was not exercised', control, ['SEND              ' + short(sent.result?.data ?? sent.error ?? null)], { sid, user: user.ok, working: working.samples })
    }
    if (freezeHost && hosts.length !== 1) {
      return result('BLOCKED', 'the negative control needs exactly one claude-sdk-host child to freeze; found ' + hosts.length, control, ['HOSTS             ' + short(hosts, 1200)], { sid, hosts })
    }
    if (freezeHost) {
      // SIGSTOP, not SIGKILL. A killed host closes the pipe, which settles the
      // ack through the CLOSE handler; a frozen one settles it through the
      // 5s ACK DEADLINE — a different line of code, and the one POD-3043's
      // second commit was written to pin. The daemon's own 15s grace SIGKILL
      // then ends the turn, so nothing is left stopped behind us.
      for (const row of hosts) {
        try {
          process.kill(row.pid, 'SIGSTOP')
          frozen.push(row.pid)
        } catch {
          /* already gone */
        }
      }
    }
    const at = Date.now()
    const interrupted = await mutate('sessions.interrupt', { sessionId: sid })
    const after = await waitPhase(sid, (phase) => phase !== 'working', 40_000, 500)
    const stopMs = after.ms
    await wait(4_000)
    const live = await interruptRecords(sid, chat)
    // DURABILITY. The record has to be in the persisted transcript, not only on
    // the socket that watched it happen — so drop the viewer, take a new one,
    // and read it back.
    await chat.close()
    const reloaded = new Chat(sid)
    await reloaded.open()
    await wait(2_000)
    const persisted = await interruptRecords(sid, reloaded)

    // The IDLE arm: an interrupt with nothing to interrupt, pressed twice. One
    // receipt per epoch is the claim, so two presses must leave one receipt.
    const idleBefore = persisted.idle.length
    await mutate('sessions.interrupt', { sessionId: sid }).catch(() => null)
    await wait(1_000)
    await mutate('sessions.interrupt', { sessionId: sid }).catch(() => null)
    await wait(3_000)
    const afterIdle = await interruptRecords(sid, reloaded)
    await reloaded.close()

    const payload = interrupted.result?.data ?? interrupted.error ?? null
    const typedRefusal = Boolean(interrupted.error) || /refus|unsupported|cannot|not available/i.test(JSON.stringify(payload))
    const outcome =
      persisted.confirmed.length > 0 && persisted.unconfirmed.length === 0
        ? 'confirmed'
        : persisted.unconfirmed.length > 0 && persisted.confirmed.length === 0
          ? 'unconfirmed'
          : persisted.stop.length === 0
            ? 'none'
            : 'mixed'
    const expected = freezeHost ? 'unconfirmed' : 'confirmed'
    const stopped = after.ok
    const exactlyOne = persisted.stop.length === 1 && live.stop.length === 1
    const durable = persisted.stop.length === live.stop.length && persisted.stop.length === 1
    const truthful = outcome === expected
    const idleOnce = afterIdle.idle.length === idleBefore + 1
    const stopUnchangedByIdle = afterIdle.stop.length === persisted.stop.length
    const pass = control.fired && stopped && exactlyOne && durable && truthful
    const clauses =
      'stopped=' + stopped + ' exactlyOneStopRecord=' + exactlyOne + ' durableAfterReload=' + durable +
      ' outcome=' + outcome + ' expected=' + expected + ' truthful=' + truthful +
      ' idleReceiptOnePerEpoch=' + idleOnce + ' stopRecordUnchangedByIdlePresses=' + stopUnchangedByIdle
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL',
      !control.fired
        ? 'interrupt control did not fire'
        : pass
          ? (freezeHost
              ? 'frozen host: the turn stopped and left exactly one durable record that says the interrupt was NOT confirmed'
              : 'live host: the turn stopped and left exactly one durable record that says the provider confirmed the interrupt') +
            '; ' + clauses
          : 'interrupt clauses unmet: ' + clauses,
      control,
      [
        'FROZEN HOSTS      ' + JSON.stringify(frozen),
        'INTERRUPT         ' + short(payload),
        'STOPPED           ' + stopped + ' in ' + stopMs + 'ms',
        'STOP RECORDS      live=' + live.stop.length + ' persisted=' + persisted.stop.length,
        'RECORD TEXTS      ' + short(persisted.stop.map((x) => ({ id: x.id, role: x.role, text: x.text })), 1200),
        'OUTCOME           ' + outcome + ' (expected ' + expected + ')',
        'REFUSAL RECORDS   ' + persisted.refused.length,
        'IDLE RECEIPTS     before=' + idleBefore + ' afterTwoPresses=' + afterIdle.idle.length + ' onePerEpoch=' + idleOnce,
        'TYPED REFUSAL     ' + typedRefusal,
        'CLAUSES           ' + clauses,
        // AN ABSENCE CLAIM IS A CLAIM ABOUT THE WHOLE SURFACE. A count of zero
        // records is only worth reading next to everything the transcript did
        // hold, so the full item list goes in the reading rather than a filter
        // over it.
        'SERVER READ ITEMS ' + afterIdle.serverItems.length + ' (sessions.read; empty on this path — see the note on interruptRecords)',
        'ALL ITEMS         ' + short(afterIdle.items.map((x) => ({ id: x.id, role: x.role, event: x.event, text: textOf(x.text).slice(0, 120) })), 4000),
      ],
      {
        sid,
        freezeHost,
        frozen,
        payload,
        after,
        stopMs,
        hosts,
        outcome,
        expected,
        stopped,
        exactlyOne,
        durable,
        truthful,
        idleBefore,
        idleAfter: afterIdle.idle.length,
        idleOnce,
        stopUnchangedByIdle,
        typedRefusal,
        liveStop: live.stop,
        persistedStop: persisted.stop,
        persistedRefused: persisted.refused,
        persistedIdle: afterIdle.idle,
        allItems: afterIdle.items,
        serverReadItems: afterIdle.serverItems,
        statusAfter: await status(sid),
      },
    )
  } finally {
    // A frozen process that the daemon's grace kill did not reach would be left
    // stopped forever. Continue every one of them on EVERY exit path.
    for (const pid of frozen) {
      try {
        process.kill(pid, 'SIGCONT')
      } catch {
        /* already reaped */
      }
    }
    await cleanup(sid, chat)
  }
}

async function runA3() {
  return interruptTurn(false)
}

/**
 * A3NEG — the control that lets A3's truthfulness clause FAIL.
 *
 * A3 alone cannot distinguish "the wording tracks the provider's answer" from
 * "the runtime always writes the confirmed sentence". Freezing the host makes
 * the ack impossible to deliver, so the SAME code path must produce the OTHER
 * sentence. If A3 says confirmed and A3NEG also says confirmed, the wording is
 * a constant and A3's PASS means nothing.
 */
async function runA3neg() {
  return interruptTurn(true)
}

async function permissionAsk(sid: string, chat: Chat, timeout = 45_000) {
  const started = Date.now()
  let asks: Record<string, unknown>[] = []
  while (Date.now() - started < timeout) {
    const r = await query('interactions.list', { sessionId: sid })
    asks = (r.result?.data ?? []) as Record<string, unknown>[]
    if (asks.length) break
    await wait(1_000)
  }
  const terminal = /permission|allow|approve|outside|run|yes/i.test(chat.screenTail(5000))
  const chatFrame = [...chat.frameTypes.keys()].some((x) => /interaction|ask|approval/i.test(x))
  return { asks, terminal, chatFrame, ms: Date.now() - started }
}

async function answerAsk(a: Record<string, unknown>) {
  return mutate('interactions.answer', { id: a.id, answer: { kind: 'permission', decision: 'allow-once' } })
}

async function runA4a() {
  const { sid, chat } = await create()
  try {
    const marker = 'P3047-A4A-' + Date.now().toString(36).toUpperCase()
    const outside = join('/tmp', 'pod-3047-external')
    mkdirSync(outside, { recursive: true })
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Use your Bash tool to run exactly: printf ' + marker + ' > ' + outside + '/' + marker + '.txt ; then tell me whether it succeeded.',
    })
    const probe = await permissionAsk(sid, chat)
    const items = await transcript(sid)
    const control: Control = {
      fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0 || Boolean((await status(sid))?.driverId),
      what: 'the session becoming live independent of whether an ask is raised',
      detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; items=' + items.length,
    }
    if (!control.fired) return result('BLOCKED', 'permission probe had no live-session control', control, ['SEND              ' + short(sent)], { sid })
    if (!probe.asks.length) {
      // WHY THE ASK WAS ABSENT IS PART OF THE BLOCK. "No ask appeared" is one
      // sentence about two different worlds: the agent never attempted the tool
      // (nothing to approve), or it attempted it and the write landed with no
      // approval asked for. The marker file separates them, and only the second
      // is worth anyone's time.
      const wrote = existsSync(join(outside, marker + '.txt'))
      return result('BLOCKED', 'no permission ask was raised; the guarded write ' + (wrote ? 'HAPPENED ANYWAY (marker file present outside the session cwd)' : 'did not happen, so the agent never attempted the tool'), control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms', 'TERMINAL          ' + probe.terminal, 'MARKER WRITTEN    ' + wrote + ' at ' + join(outside, marker + '.txt'), 'ITEMS             ' + short(items, 1200), 'CHAT ITEMS        ' + short((chat.items as unknown as Item[]).map((x) => ({ id: x.id, role: x.role, text: textOf(x.text).slice(0, 160) })), 2000)], { sid, probe, items, markerWritten: wrote, chatItems: chat.items })
    }
    const answers = []
    for (const ask of probe.asks) answers.push(await answerAsk(ask))
    const cleared = await waitPhase(sid, (phase) => phase !== 'needs_user', 30_000, 500)
    const bothViews = driver === 'claude-pty' ? probe.terminal : true
    const pass = probe.asks.length > 0 && bothViews && cleared.ok
    return result(
      pass ? 'PASS' : 'FAIL',
      pass ? 'permission ask appeared and answering resolved it' : 'permission ask did not appear and resolve',
      control,
      ['ASKS              ' + short(probe.asks, 1400), 'TERMINAL          ' + probe.terminal, 'ANSWERS           ' + short(answers), 'RESOLVED          ' + cleared.ok],
      { sid, probe, answers, cleared },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA4b() {
  const { sid, chat } = await create()
  try {
    const marker = 'P3047-A4B-' + Date.now().toString(36).toUpperCase()
    const outside = join('/tmp', 'pod-3047-external')
    mkdirSync(outside, { recursive: true })
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Use your Bash tool to run exactly: printf ' + marker + ' > ' + outside + '/' + marker + '.txt ; then tell me whether it succeeded.',
    })
    const probe = await permissionAsk(sid, chat)
    const items = await transcript(sid)
    const control: Control = {
      fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0 || Boolean((await status(sid))?.driverId),
      what: 'the session attach/transcript becoming live before the ask answer test',
      detail: 'items=' + items.length,
    }
    if (!control.fired) return result('BLOCKED', 'answer-twice probe had no live-session control', control, ['SEND              ' + short(sent)], { sid })
    if (!probe.asks.length) {
      const wrote = existsSync(join(outside, marker + '.txt'))
      return result('BLOCKED', 'no permission ask was raised; the guarded write ' + (wrote ? 'HAPPENED ANYWAY (marker file present outside the session cwd)' : 'did not happen, so the agent never attempted the tool'), control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms', 'MARKER WRITTEN    ' + wrote, 'CHAT ITEMS        ' + short((chat.items as unknown as Item[]).map((x) => ({ id: x.id, role: x.role, text: textOf(x.text).slice(0, 160) })), 2000)], { sid, probe, items, markerWritten: wrote, chatItems: chat.items })
    }
    const first = await answerAsk(probe.asks[0])
    const second = await answerAsk(probe.asks[0])
    const secondText = JSON.stringify(second.result?.data ?? second.error ?? null)
    const typed = Boolean(second.error) || /already|closed|unknown|not found|answered|invalid|refus/i.test(secondText)
    return result(
      typed ? 'PASS' : 'FAIL',
      typed ? 'second answer returned a typed error without a double action' : 'second answer was accepted without a typed error',
      control,
      ['ASK               ' + short(probe.asks[0]), 'FIRST             ' + short(first), 'SECOND            ' + short(second), 'TYPED ERROR       ' + typed],
      { sid, probe, first, second, typed },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA5() {
  const { sid, chat } = await create()
  try {
    const marker = 'P3047-A5-MARKER-' + Date.now().toString(36).toUpperCase()
    writeFileSync(join(cwd, 'transcript-fixture.txt'), 'transcript fixture test marker ' + marker + '\n')
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Use your Bash tool to run cat ' + join(cwd, 'transcript-fixture.txt') + ' and then reply with only the test marker it contains.',
    })
    const user = await waitForNeedle(sid, chat, 'transcript-fixture.txt', 'user', 5_000)
    const assistant = await waitForNeedle(sid, chat, marker, 'assistant', REPLY_MS)
    // SAME PLANE CORRECTION AS A3. `transcript()` is sessions.read, which is
    // empty for every claude-sdk session on this path, so scoring pairing there
    // asks "did the agent call a tool" of a surface that never carries one and
    // answers no whatever happened. The session stream is where published items
    // land, so that is what is scored; sessions.read is reported beside it.
    const before = [...(chat.items as unknown as Item[])]
    const serverBefore = await transcript(sid)
    await chat.close()
    const reload = new Chat(sid)
    await reload.open()
    await wait(2_000)
    const after = [...(reload.items as unknown as Item[])]
    const serverAfter = await transcript(sid)
    const toolItems = before.filter((x) => x.role === 'tool' || x.toolName || /tool/i.test(textOf(x.event)))
    const resultItems = before.filter((x) => (x.role === 'tool' && !x.toolName) || x.role === 'tool_result' || /result/i.test(textOf(x.event)))
    const paired = toolItems.length > 0 && (resultItems.length > 0 || before.some((x) => Boolean(x.toolName)))
    const sameHistory =
      JSON.stringify(before.map((x) => ({ id: x.id, role: x.role, text: x.text, event: x.event, toolName: x.toolName }))) ===
      JSON.stringify(after.map((x) => ({ id: x.id, role: x.role, text: x.text, event: x.event, toolName: x.toolName })))
    const control: Control = {
      fired: user.ok || assistant.ok || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok),
      what: 'the transcript fixture send delivering or a needle appearing',
      detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; items=' + before.length,
    }
    // DID THE AGENT USE A TOOL, OR DID THE TRANSCRIPT JUST NOT SAY SO?
    //
    // "No tool items, therefore pairing was not exercised" is the comfortable
    // reading and it is unfalsifiable: a transcript that publishes no tool items
    // at all produces it whatever the agent did. The marker is the control that
    // separates them. It is random per run, it is written ONLY into the fixture
    // file, and it is never in the prompt — so an assistant reply carrying it is
    // proof that a tool read that file. Tool ran and no tool item was published
    // is an unmet clause, not an unexercised one.
    const toolRan = assistant.ok
    const out = result(
      !control.fired ? 'BLOCKED' : !toolRan ? 'BLOCKED' : !toolItems.length ? 'FAIL' : paired && sameHistory ? 'PASS' : 'FAIL',
      !control.fired
        ? 'transcript control did not fire'
        : !toolRan
          ? 'the agent never returned the fixture marker, so no tool call is proven and pairing was not exercised'
          : !toolItems.length
            ? 'the agent DID read the fixture file — its reply carries a marker that exists only inside it — and the transcript published no tool call and no tool result at all'
            : paired && sameHistory
              ? 'tool call/result pair and reload history are intact'
              : 'tool transcript pairing or reload history failed',
      control,
      [
        'SEND              ' + short(sent.result?.data ?? sent.error ?? null),
        'USER              ' + user.ok,
        'ASSISTANT         ' + assistant.ok,
        'TOOL ITEMS        ' + short(toolItems, 1200),
        'RELOAD SAME       ' + sameHistory,
        'STREAM ITEMS      ' + short(before.map((x) => ({ id: x.id, role: x.role, event: x.event, toolName: x.toolName, text: textOf(x.text).slice(0, 120) })), 3000),
        'SERVER READ ITEMS before=' + serverBefore.length + ' after=' + serverAfter.length + ' (sessions.read, empty on this path)',
      ],
      { sid, marker, before, after, serverBefore, serverAfter, toolItems, resultItems, paired, sameHistory, toolRan },
    )
    await reload.close()
    return out
  } finally {
    await cleanup(sid)
  }
}

async function runA6a() {
  const { sid, chat: one, row } = await create()
  const two = new Chat(sid)
  try {
    // ASSERT ON THE MECHANISM. The old guard required a truthy `driverFamily`,
    // and an SDK session reports it as null — so the guard never fired, the cell
    // drove a terminal that does not exist, and reported a missing control
    // instead of an inapplicable cell. `driverId` is the field that is actually
    // populated and is what decides whether there is a client terminal at all.
    if (driver === 'claude-sdk' && row?.driverId === 'claude-sdk' && row.driverFamily !== 'terminal' && one.screenBytes === 0) {
      const control: Control = { fired: Boolean(row.driverId), what: 'SDK session bound so terminal-applicability can be judged', detail: 'driverId=' + (row.driverId ?? '(none)') + '; family=' + (row.driverFamily ?? '(none)') }
      return result('BLOCKED', 'claude-sdk arm has no client terminal; A6a is not applicable', control, ['IDENTITY          ' + short(row), 'SCREEN BYTES      ' + one.screenBytes], { sid, applicable: false, row })
    }
    view(one, sid, 'native')
    await wait(2_000)
    await two.open()
    view(two, sid, 'native')
    await wait(2_000)
    const control: Control = {
      fired: one.frameTypes.has('attached') && one.screenBytes > 0,
      what: 'the first native viewer receiving an attached terminal stream',
      detail: 'attached=' + (one.frameTypes.get('attached') ?? 0) + '; screenBytes=' + one.screenBytes,
    }
    const marker = 'P3047-A6A-' + Date.now().toString(36).toUpperCase()
    const beforeGeometry = (await listRow(sid))?.geometry
    input(one, sid, marker + '\r')
    const firstScreen = await screenNeedle(one, marker, 20_000)
    const secondScreen = await screenNeedle(two, marker, 20_000)
    one.send({ type: 'resize', sessionId: sid, cols: 100, rows: 30 })
    await wait(2_000)
    const afterGeometry = (await listRow(sid))?.geometry
    const geometryOk = JSON.stringify(afterGeometry) === JSON.stringify({ cols: 100, rows: 30 })
    const pass = firstScreen.ok && secondScreen.ok && geometryOk && one.screenBytes > 0
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL',
      !control.fired ? 'native attach control did not fire' : pass ? 'keystrokes echoed, resize refit, and second viewer saw the same screen' : 'terminal attach, echo, resize, or second-viewer parity failed',
      control,
      ['MARKER            ' + marker, 'FIRST SCREEN      ' + firstScreen.ok, 'SECOND SCREEN     ' + secondScreen.ok, 'GEOMETRY AFTER    ' + short(afterGeometry)],
      { sid, marker, firstScreen, secondScreen, beforeGeometry, afterGeometry, geometryOk },
    )
  } finally {
    await two.close().catch(() => {})
    await cleanup(sid, one)
  }
}

async function runA6b() {
  const { sid, chat, row } = await create()
  try {
    if (driver === 'claude-sdk' && row?.driverId === 'claude-sdk' && row.driverFamily !== 'terminal' && chat.screenBytes === 0) {
      const control: Control = { fired: Boolean(row.driverId), what: 'SDK session bound so chat/CLI-applicability can be judged', detail: short(row) }
      return result('BLOCKED', 'claude-sdk arm has no CLI terminal; A6b is not applicable', control, ['IDENTITY          ' + short(row)], { sid, applicable: false, row })
    }
    view(chat, sid, 'chat')
    const c1 = await baselineReply(sid, chat, 'A6B-CHAT1')
    const control: Control = { fired: c1.user.ok || c1.assistant.ok, what: 'the first chat send landing before view switches', detail: 'chat control user=' + c1.user.ok + '; reply=' + c1.assistant.ok }
    if (!c1.assistant.ok) return result('BLOCKED', 'first chat control did not fire', control, ['CHAT 1            ' + short(c1)], { sid })
    const cli1 = 'P3047-A6B-CLI1-' + Date.now().toString(36).toUpperCase()
    view(chat, sid, 'native')
    await wait(1_500)
    input(chat, sid, cli1 + '\r')
    const cli1Seen = await screenNeedle(chat, cli1, 20_000)
    view(chat, sid, 'chat')
    await wait(1_500)
    const c2 = await baselineReply(sid, chat, 'A6B-CHAT2')
    view(chat, sid, 'native')
    await wait(1_500)
    const cli2 = 'P3047-A6B-CLI2-' + Date.now().toString(36).toUpperCase()
    input(chat, sid, cli2 + '\r')
    const cli2Seen = await screenNeedle(chat, cli2, 20_000)
    const geom = (await listRow(sid))?.geometry
    const pass = c1.assistant.ok && cli1Seen.ok && c2.assistant.ok && cli2Seen.ok && Boolean(geom)
    return result(
      pass ? 'PASS' : 'FAIL',
      pass ? 'chat→CLI→chat→CLI retained one live session and both views remained functional' : 'a chat/CLI switch lost a reply or terminal echo',
      control,
      ['CHAT 1            ' + short(c1), 'CLI 1             ' + cli1Seen.ok, 'CHAT 2            ' + short(c2), 'CLI 2             ' + cli2Seen.ok, 'GEOMETRY          ' + short(geom)],
      { sid, c1, cli1, cli1Seen, c2, cli2, cli2Seen, geometry: geom },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function restartDaemon(): Promise<{ oldPid: string; newPid: string; out: string }> {
  const oldPid = pidInfo(join(BASE, 'daemon.pid')).pid
  const r = spawnSync('bash', [join(ROOT, 'docs/evidence/pod-3047/restart-daemon.sh')], { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw new Error('daemon restart failed: ' + (r.stdout ?? '') + (r.stderr ?? ''))
  const newPid = pidInfo(join(BASE, 'daemon.pid')).pid
  if (!newPid || newPid === oldPid) throw new Error('daemon pid did not change: old=' + oldPid + ' new=' + newPid)
  return { oldPid, newPid, out: r.stdout }
}

async function runA7a() {
  const { sid, chat } = await create()
  try {
    const secret = 'P3047-A7A-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Remember this codeword: ' + secret + '. Reply with exactly ' + secret + '. Do not use tools.',
    })
    const user = await waitForNeedle(sid, chat, secret, 'user', 5_000)
    const reply = await waitForNeedle(sid, chat, secret, 'assistant', REPLY_MS)
    const control: Control = { fired: user.ok || reply.ok, what: 'pre-restart Claude codeword send/reply', detail: 'user=' + user.ok + '; reply=' + reply.ok }
    if (!reply.ok) return result('BLOCKED', 'pre-restart codeword control did not land', control, ['SEND              ' + short(sent)], { sid, secret })
    await chat.close()
    const restart = await restartDaemon()
    const postPin = await pinFor('A7A-post-restart')
    const resumed = new Chat(sid)
    await resumed.open()
    await wait(4_000)
    const recallSent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'What codeword did I ask you to remember? Reply with exactly ' + secret + '. Do not use tools.',
    })
    const got = await waitForNeedle(sid, resumed, secret, 'assistant', REPLY_MS)
    const pass = got.ok === true
    const out = result(
      pass ? 'PASS' : 'FAIL',
      pass ? 'daemon restart retained the same live conversation and codeword' : 'daemon restart lost the session or codeword',
      control,
      ['BASELINE          user=' + user.ok + ' reply=' + reply.ok, 'RESTART           ' + short(restart), 'POST PIN          ' + postPin.daemonPid + ' ' + postPin.daemonSha, 'RECALL            ' + short(recallSent.result?.data ?? recallSent.error ?? null) + ' assistant=' + got.ok, 'STATUS            ' + short(await status(sid))],
      { sid, secret, restart, got },
    )
    await resumed.close()
    return out
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA7b() {
  const { sid, chat } = await create()
  try {
    const secret = 'P3047-A7B-' + Date.now().toString(36).toUpperCase()
    const seeded = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Remember ' + secret + '. Reply exactly ' + secret + '. Do not use tools.',
    })
    const user = await waitForNeedle(sid, chat, secret, 'user', 5_000)
    const reply = await waitForNeedle(sid, chat, secret, 'assistant', REPLY_MS)
    const control: Control = { fired: user.ok || reply.ok, what: 'pre-hibernate conversation replying with a unique codeword', detail: 'user=' + user.ok + '; reply=' + reply.ok }
    if (!control.fired) return result('BLOCKED', 'pre-hibernate control did not fire', control, ['SEEDED            ' + short(seeded)], { sid })
    const hibernated = await mutate('sessions.hibernate', { sessionId: sid })
    const parked = await waitPhase(sid, (phase, row) => phase === 'idle' && row?.status === 'hibernated', 30_000, 500)
    const resurrected = await mutate('sessions.resurrect', { sessionId: sid })
    const live = await waitPhase(sid, (phase, row) => phase !== 'working' && row?.status === 'live', 45_000, 500)
    const fresh = new Chat(sid)
    await fresh.open()
    await wait(3_000)
    const recall = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Recall the codeword ' + secret + '; reply exactly ' + secret + '. Do not use tools.',
    })
    const recalled = await waitForNeedle(sid, fresh, secret, 'assistant', REPLY_MS)
    const pass = parked.ok && live.ok && recalled.ok
    const out = result(
      pass ? 'PASS' : 'FAIL',
      pass ? 'hibernate/wake preserved the conversation and answered after wake' : 'hibernate/wake lost context or failed to become live',
      control,
      ['HIBERNATE         ' + short(hibernated), 'PARKED            ' + parked.ok, 'RESURRECT         ' + short(resurrected), 'LIVE              ' + live.ok, 'RECALLED          ' + recalled.ok, 'STATUS            ' + short(await status(sid))],
      { sid, secret, hibernated, parked, resurrected, live, recalled: recalled.ok, recall },
    )
    await fresh.close()
    return out
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA8() {
  const credentials = join(AGENT_HOME, '.claude/.credentials.json')
  if (existsSync(credentials)) {
    throw new Error('isolated credential present; A8 must not copy or move it')
  }
  let sid = ''
  let chat: Chat | undefined
  try {
    const made = await mutate('sessions.create', {
      cwd,
      agentKind: 'claude-code',
      runtimeContract: driver === 'claude-sdk' ? 'claude-sdk' : 'claude-pty',
    })
    sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId ?? ''
    if (!sid) throw new Error('sessions.create failed ' + short(made))
    chat = new Chat(sid)
    await chat.open()
    if (driver === 'claude-pty') await primeTerminalTui(chat, sid)
    await wait(8_000)
    const items = await transcript(sid)
    const screen = chat.screenTail(7000)
    const text = joined(items) + '\n' + screen
    const control: Control = {
      fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0 || Boolean((await status(sid))?.driverId),
      what: 'logged-out Claude spawn producing a live surface',
      detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes + '; items=' + items.length,
    }
    const loginPath = LOGGED_OUT.test(text) || /log in|login|sign in|oauth|claude\.ai|authenticate|API key/i.test(text)
    const cls = classifyText(text)

    // A SETUP STEP IS NOT A CONDITION UNTIL THE PRODUCT SAYS SO.
    //
    // This cell's premise is a LOGGED-OUT spawn, and its setup is the absence of
    // a credential in the isolated agent home. On the SDK path that absence
    // reaches nothing: the daemon runs under the operator's own HOME and the SDK
    // authenticates from there, so the session is fully logged in. Scoring "no
    // login path was offered" against a session that was never logged out is a
    // vacuous red — the mirror of the vacuous pass this same cell produced on the
    // terminal arm, and it is not attributable to the product.
    //
    // So the condition gets a control of its own, read from the product: send a
    // turn. A reply means authenticated, and the cell REFUSES to score.
    const probe = 'P3047-A8-AUTHED-' + Date.now().toString(36).toUpperCase()
    await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + probe + '. Do not use tools.' }).catch(() => null)
    const replied = await waitForNeedle(sid, chat, probe, 'assistant', 60_000)
    if (replied.ok) {
      return result(
        'BLOCKED',
        'the logged-out condition was never established: the session answered a live turn, so it is authenticated. The isolated agent home has no credential, but the SDK authenticates from the daemon\'s own HOME, and creating a logged-out condition there would mean touching the operator credential, which this rig may not do.',
        {
          fired: true,
          what: 'the product itself reporting whether the session is logged out — a live reply means it is not',
          detail: 'probe reply=' + replied.ok + ' in ' + replied.ms + 'ms; isolatedCredential=absent; loginPathText=' + loginPath,
        },
        ['AUTH PROBE        replied=' + replied.ok + ' in ' + replied.ms + 'ms', 'SCREEN            ' + JSON.stringify(screen), 'LOGIN PATH        ' + loginPath, 'CLASS             ' + short(cls), 'STATUS            ' + short(await status(sid))],
        { sid, loginPath, class: cls, isolatedCredential: false, authenticated: true, probeMs: replied.ms },
      )
    }
    return result(
      !control.fired ? 'BLOCKED' : loginPath ? 'BLOCKED' : 'FAIL',
      !control.fired
        ? 'logged-out spawn had no live control'
        : loginPath
          ? 'login path is visible; completing external OAuth is outside this rig'
          : 'logged-out spawn showed no working login path',
      control,
      ['SCREEN            ' + JSON.stringify(screen), 'LOGIN PATH        ' + loginPath, 'CLASS             ' + short(cls), 'STATUS            ' + short(await status(sid))],
      { sid, loginPath, class: cls, isolatedCredential: false },
    )
  } finally {
    if (chat && sid) await chat.close().catch(() => {})
    if (sid) await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  }
}

async function runA9() {
  const { sid, chat } = await create()
  try {
    await wait(3_000)
    const before = [...sessionProcesses(cwd), ...instanceProcesses().filter((row) => row.cmd.includes(sid) || /claude|claude-sdk-host/i.test(row.cmd))]
    const control: Control = {
      fired: before.length > 0 || Boolean((await status(sid))?.driverId),
      what: 'target session process tree existing before kill',
      detail: 'processes=' + before.length + '; screenBytes=' + chat.screenBytes,
    }
    const killed = await mutate('sessions.kill', { sessionId: sid })
    const immediate: ProcessRow[][] = []
    for (let i = 0; i < 10; i++) {
      await wait(500)
      immediate.push(sessionProcesses(cwd))
    }
    await wait(300_000)
    const after = sessionProcesses(cwd)
    const pass = control.fired && after.length === 0
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL',
      !control.fired
        ? 'kill control did not show a target process tree'
        : pass
          ? 'session process tree was gone immediately and after five minutes'
          : 'orphaned session processes remained after five minutes',
      control,
      ['KILL              ' + short(killed), 'BEFORE            ' + short(before, 1800), 'AFTER 5 MIN       ' + short(after, 1800)],
      { sid, before, killed, immediate, after, waitedMs: 300_000 },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runA10() {
  const { sid, chat, row } = await create()
  try {
    const control: Control = {
      fired: Boolean(row?.driverId) || Boolean(row?.driverFamily),
      what: 'session reporting a driver identity after spawn',
      detail: 'driverId=' + (row?.driverId ?? '(none)') + '; family=' + (row?.driverFamily ?? '(none)'),
    }
    const pass = identityOk(row)
    return result(
      !control.fired ? 'REFUSED' : pass ? 'PASS' : 'FAIL',
      pass
        ? 'session reported ' + (row?.driverId ?? '(none)') + '/' + (row?.driverFamily ?? '(none)')
        : 'session did not report expected ' + driver,
      control,
      ['STATUS            ' + short(row), 'SESSION ROW       ' + short(await listRow(sid)), 'FRAME TYPES       ' + chat.frameSummary()],
      { sid, row, expected: driver },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runBquota() {
  const { sid, chat } = await create()
  try {
    const needle = 'P3047-BQUOTA-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Reply with exactly this word and nothing else: ' + needle + '. Do not use tools.',
    })
    const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
    const assistant = await waitForNeedle(sid, chat, needle, 'assistant', REPLY_MS)
    const items = await transcript(sid)
    const screen = chat.screenTail(4000)
    const row = await status(sid)
    const combined = joined(items) + '\n' + screen + '\n' + JSON.stringify(row?.error ?? {})
    const cls = classifyText(combined)
    const control: Control = {
      fired: user.ok || assistant.ok || LOGGED_OUT.test(combined) || QUOTA.test(combined) || Boolean(row?.error) || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok),
      what: 'a delivered send, reply needle, quota text, auth text, or structured error from a live session',
      detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; class=' + cls.errorClass,
    }
    const pass = assistant.ok && cls.errorClass === 'none'
    const blockedQuota = cls.errorClass === 'usage_limit' || cls.errorClass === 'rate_limit'
    const blockedAuth = cls.errorClass === 'authentication'
    return result(
      !control.fired ? 'BLOCKED' : pass ? 'PASS' : blockedQuota || blockedAuth ? 'BLOCKED' : 'FAIL',
      !control.fired
        ? 'quota classification control did not fire'
        : pass
          ? 'turn succeeded after reset; no quota/auth class'
          : blockedQuota
            ? 'provider classed as ' + cls.errorClass + '; reset not observed as recovered'
            : blockedAuth
              ? 'provider classed as authentication'
              : 'turn failed without a typed quota/auth class',
      control,
      ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'CLASS             ' + short(cls), 'ERROR             ' + short(row?.error ?? null), 'ASSISTANT         ' + assistant.ok, 'SCREEN            ' + JSON.stringify(screen)],
      { sid, needle, class: cls, user: user.ok, assistant: assistant.ok, row },
    )
  } finally {
    await cleanup(sid, chat)
  }
}

async function runBauth() {
  return runA8()
}

async function main(): Promise<void> {
  mkdirSync(READING_DIR, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const at = stamp()
  let pin: Pin | undefined
  let out: ReturnType<typeof result>
  try {
    pin = await pinFor(cell)
    switch (cell) {
      case 'A1A':
        out = await runA1a()
        break
      case 'A1B':
        out = await runA1b()
        break
      case 'A1C':
        out = await runA1c()
        break
      case 'A2A':
        out = await runA2a()
        break
      case 'A2B':
        out = await runA2b()
        break
      case 'A3':
        out = await runA3()
        break
      case 'A3NEG':
        out = await runA3neg()
        break
      case 'A4A':
        out = await runA4a()
        break
      case 'A4B':
        out = await runA4b()
        break
      case 'A5':
        out = await runA5()
        break
      case 'A6A':
        out = await runA6a()
        break
      case 'A6B':
        out = await runA6b()
        break
      case 'A7A':
        out = await runA7a()
        break
      case 'A7B':
        out = await runA7b()
        break
      case 'A8':
        out = await runA8()
        break
      case 'A9':
        out = await runA9()
        break
      case 'A10':
        out = await runA10()
        break
      case 'BQUOTA':
        out = await runBquota()
        break
      case 'BAUTH':
        out = await runBauth()
        break
      default:
        throw new Error('unhandled ' + cell)
    }
  } catch (error) {
    out = result(
      'REFUSED',
      'cell could not be driven: ' + String(error).slice(0, 240),
      { fired: false, what: 'the complete pinned cell running to a result', detail: String(error) },
      ['ERROR             ' + String(error)],
    )
  }
  const reading = { cell, driver, cwd, at, pin, ...out }
  writeFileSync(join(READING_DIR, driver + '.' + cell.toLowerCase() + '.json'), JSON.stringify(reading, null, 2) + '\n')
  console.log(driver + '/' + cell + ' ' + reading.verdict + ' — ' + reading.summary)
  console.log('control=' + (reading.control.fired ? 'FIRED' : 'MISSING') + ' ' + reading.control.detail)
  for (const line of reading.evidence) console.log(line)
}

await login()
await main()
