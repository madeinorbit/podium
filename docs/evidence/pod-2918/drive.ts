/**
 * POD-2918 — current-pin Tier-A release acceptance for Claude.
 *
 * Run one cell at a time:
 *
 *   bun docs/evidence/pod-2874/drive.ts A1a claude
 *   bun docs/evidence/pod-2874/drive.ts A1a shell
 *
 * One JSON reading is written per cell. Every cell pins server, web bundle and
 * daemon before it starts, and every scored result carries a positive control.
 * Claude is not waited on for driverId before its first turn: claude-pty
 * publishes its binding lazily at that turn.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { Chat, login, mutate, primeTerminalTui, query, wait } from '../pod-2777/rig'

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNDRIVEN'
type Harness = 'claude' | 'shell'
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
  serverSha: string
  daemonSha: string
  web: Record<string, unknown> | { error: string }
  serverPid: string
  daemonPid: string
  serverAlive: boolean
  daemonAlive: boolean
  serverCwd: string
  daemonCwd: string
  freeMemory: Record<string, string>
  forbiddenOverrides: Record<string, string | null>
}

interface Reading {
  cell: string
  harness: Harness
  cwd: string
  verdict: Verdict
  summary: string
  control: Control
  evidence: string[]
  data: Record<string, unknown>
  pin?: Pin
  postRestartPin?: Pin
  at: string
}

const cell = (process.argv[2] ?? '').toUpperCase()
const harness = (process.argv[3] ?? 'claude') as Harness
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2918'
const PORT = process.env.PODIUM_PORT ?? '29181'
const ROOT = process.cwd()
const SOURCE_ROOT = process.env.POD2874_SOURCE_ROOT ?? ROOT
const READING_DIR = join(ROOT, 'docs/evidence/pod-2918/readings')
const PIN_DIR = join(ROOT, 'docs/evidence/pod-2918/pins')
const AGENT_HOME = process.env.POD2918_AGENT_HOME ?? join(process.env.HOME ?? '', '.local/state/podium/p2918/agent-home')
const READING_PREFIX = process.env.POD2874_READING_PREFIX ?? harness
const PIN_PREFIX = process.env.POD2874_PIN_PREFIX ?? ''
const REPLY_MS = Number(process.env.POD2918_REPLY_MS ?? process.env.POD2874_REPLY_MS ?? 120_000)
const BUSY_MS = Number(process.env.POD2918_BUSY_MS ?? process.env.POD2874_BUSY_MS ?? 90_000)
const STEP_MS = 500

const CLAUDE_CELLS = new Set([
  'A1A', 'A1B', 'A1C', 'A2A', 'A2B', 'A3', 'A4A', 'A4B', 'A5',
  'A6A', 'A6B', 'A7A', 'A7B', 'A8', 'A9',
])
const SHELL_CELLS = new Set(['A1A', 'A1C', 'A2B', 'A6A', 'A7A', 'A9'])

if (!CLAUDE_CELLS.has(cell) && !SHELL_CELLS.has(cell)) throw new Error('unsupported cell ' + cell)
if (harness !== 'claude' && harness !== 'shell') throw new Error('unsupported harness ' + harness)
if (harness === 'claude' && !CLAUDE_CELLS.has(cell)) throw new Error(cell + ' is not a Claude cell')
if (harness === 'shell' && !SHELL_CELLS.has(cell)) throw new Error(cell + ' is not a shell cell')

const cwd = join(BASE, 'probes', harness.toLowerCase() + '-' + cell.toLowerCase())
const stamp = () => new Date().toISOString()
const short = (x: unknown, n = 260) => JSON.stringify(x).slice(0, n)
const textOf = (x: unknown) => typeof x === 'string' ? x : String(x ?? '')

function outputOf(command: string, args: string[]): string {
  return (spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '').trim()
}

function pidInfo(path: string): { pid: string; alive: boolean; cwd: string } {
  const pid = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  let alive = false
  let processCwd = ''
  if (pid) {
    try { process.kill(Number(pid), 0); alive = true } catch { /* dead */ }
    try { processCwd = outputOf('readlink', [join('/proc', pid, 'cwd')]) } catch { /* dead */ }
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

async function pinFor(label: string): Promise<Pin> {
  const checkoutSha = outputOf('git', ['-C', SOURCE_ROOT, 'rev-parse', 'HEAD'])
  const server = pidInfo(join(BASE, 'server.pid'))
  const daemon = pidInfo(join(BASE, 'daemon.pid'))
  const serverSha = existsSync(join(BASE, 'server.sha')) ? readFileSync(join(BASE, 'server.sha'), 'utf8').trim() : ''
  const daemonSha = existsSync(join(BASE, 'daemon.sha')) ? readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim() : ''
  let web: Record<string, unknown> | { error: string }
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/podium-build.json')
    web = await r.json() as Record<string, unknown>
  } catch (error) {
    web = { error: String(error) }
  }
  const forbiddenOverrides: Record<string, string | null> = {}
  for (const key of ['PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR', 'TMUX_TMPDIR', 'PODIUM_WEB_DIR']) {
    forbiddenOverrides[key] = process.env[key] ?? null
  }
  const pin: Pin = {
    cell: label,
    at: stamp(),
    sourceRoot: SOURCE_ROOT,
    checkoutSha,
    serverSha,
    daemonSha,
    web,
    serverPid: server.pid,
    daemonPid: daemon.pid,
    serverAlive: server.alive,
    daemonAlive: daemon.alive,
    serverCwd: server.cwd,
    daemonCwd: daemon.cwd,
    freeMemory: memInfo(),
    forbiddenOverrides,
  }
  mkdirSync(PIN_DIR, { recursive: true })
  const pinName = PIN_PREFIX ? PIN_PREFIX + '-' + label.toLowerCase() : label.toLowerCase()
  writeFileSync(join(PIN_DIR, pinName + '.json'), JSON.stringify(pin, null, 2) + '\n')
  const webSha = typeof web === 'object' && 'sourceSha' in web ? textOf(web.sourceSha) : ''
  const webMatches = webSha === checkoutSha.slice(0, 7)
  const overrides = Object.entries(forbiddenOverrides).filter(([, value]) => value !== null)
  if (checkoutSha.length !== 40 || serverSha !== checkoutSha || daemonSha !== checkoutSha ||
      !server.alive || !daemon.alive || !webMatches || overrides.length > 0) {
    throw new Error('pin mismatch ' + short({ checkoutSha, serverSha, daemonSha, webSha, server, daemon, overrides }))
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
  return items.filter((x) => !role || x.role === role).map((x) => textOf(x.text)).join('\n')
}

function hasNeedle(items: Item[], needle: string, role?: string): boolean {
  return joined(items, role).includes(needle)
}

async function waitForNeedle(sid: string, chat: Chat, needle: string, role: 'user' | 'assistant' | 'any', timeout = REPLY_MS) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const items = await transcript(sid)
    const inServer = role === 'user' ? hasNeedle(items, needle, 'user') : role === 'assistant' ? hasNeedle(items, needle, 'assistant') : hasNeedle(items, needle)
    const inChat = role === 'user' ? chat.userText().includes(needle) : role === 'assistant' ? chat.assistantText().includes(needle) : chat.userText().includes(needle) || chat.assistantText().includes(needle)
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

async function create(h: Harness): Promise<{ sid: string; chat: Chat; created: unknown }> {
  const made = await mutate('sessions.create', { cwd, agentKind: h === 'claude' ? 'claude-code' : 'shell' })
  const sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId
  if (!sid) throw new Error('sessions.create failed ' + short(made))
  const chat = new Chat(sid)
  await chat.open()
  await wait(30_000)
  await primeTerminalTui(chat, sid)
  return { sid, chat, created: made.result?.data }
}

async function cleanup(sid: string, chat?: Chat): Promise<void> {
  await chat?.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}

function input(chat: Chat, sid: string, text: string): void {
  chat.send({ type: 'input', sessionId: sid, data: Buffer.from(text).toString('base64'), inputOrigin: 'human' })
}


function shellPrint(text: string): string {
  const encoded = Buffer.from(text).toString('base64')
  return 'printf "%s\\n" "$(printf "%s" "' + encoded + '" | base64 -d)"\r'
}

function shellSetCode(text: string): string {
  const encoded = Buffer.from(text).toString('base64')
  return 'export POD2874_CODE=$(printf %s ' + encoded + ' | base64 -d); printf "%s\\n" "$POD2874_CODE"\r'
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

function diskHasUserTurn(needle: string): boolean {
  const root = join(AGENT_HOME, '.claude', 'projects')
  if (!existsSync(root)) return false
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (stat.isDirectory() && walk(path)) return true
      if (!name.endsWith('.jsonl')) continue
      let text = ''
      try { text = readFileSync(path, 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.includes(needle)) continue
        try {
          if ((JSON.parse(line) as { type?: string }).type === 'user') return true
        } catch { /* partial tail line */ }
      }
    }
    return false
  }
  return walk(root)
}

function result(verdict: Verdict, summary: string, control: Control, evidence: string[] = [], data: Record<string, unknown> = {}) {
  return { verdict, summary, control, evidence, data }
}

async function baselineReply(sid: string, chat: Chat, tag: string) {
  const needle = 'P2874-' + tag + '-' + Date.now().toString(36).toUpperCase()
  if (harness === 'shell') {
    view(chat, sid, 'native')
    await wait(1_000)
    const sent = { method: 'native-input', command: 'shellPrint(' + needle + ')' }
    input(chat, sid, shellPrint(needle))
    const echo = await screenNeedle(chat, needle, 15_000)
    return { needle, sent, user: echo, assistant: echo }
  }
  const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + needle + '. Do not use tools.' })
  const user = await waitForNeedle(sid, chat, needle, 'user', REPLY_MS)
  const assistant = user.ok ? await waitForNeedle(sid, chat, needle, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
  await waitIdle(sid).catch(() => {})
  if (harness === 'claude') await primeTerminalTui(chat, sid)
  return { needle, sent, user, assistant }
}

async function runA1a() {
  const { sid, chat } = await create(harness)
  const turns: Record<string, unknown>[] = []
  let controlFired = false
  try {
    for (let i = 1; i <= 3; i++) {
      const needle = 'P2874-A1A-' + harness + '-' + i + '-' + Date.now().toString(36).toUpperCase()
      let sent: unknown
      let user: { ok: boolean; ms: number; items?: Item[] }
      let assistant: { ok: boolean; ms: number; items?: Item[] }
      if (harness === 'shell') {
        view(chat, sid, 'native')
        await wait(500)
        sent = { method: 'native-input', command: 'shellPrint(' + needle + ')' }
        input(chat, sid, shellPrint(needle))
        const echo = await screenNeedle(chat, needle, 15_000)
        user = echo
        assistant = echo
      } else {
        sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + needle + '. Do not use tools.' })
        user = await waitForNeedle(sid, chat, needle, 'user', REPLY_MS)
        assistant = user.ok ? await waitForNeedle(sid, chat, needle, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
      }
      controlFired ||= user.ok
      const row = await status(sid)
      const sentData = sent && typeof sent === 'object' && 'result' in sent
        ? (sent as { result?: unknown; error?: unknown }).result ?? (sent as { error?: unknown }).error
        : sent
      turns.push({ i, needle, sent: sentData, user: user.ok, assistant: assistant.ok, userMs: user.ms, assistantMs: assistant.ms, diskUser: harness === 'claude' ? diskHasUserTurn(needle) : null, status: row })
      if (!user.ok || !assistant.ok) break
      await waitIdle(sid)
      if (harness === 'claude') await primeTerminalTui(chat, sid)
    }
    const last = turns.at(-1) as Record<string, unknown> | undefined
    const control: Control = { fired: controlFired, what: 'a prompt appearing as a durable user turn', detail: turns.filter((x) => x.user).length + '/' + turns.length + ' user turns landed; last=' + String(last?.user ?? false) }
    const allThree = turns.length === 3 && turns.every((x) => x.user === true && x.assistant === true)
    return result(!controlFired ? 'BLOCKED' : allThree ? 'PASS' : 'FAIL', !controlFired ? 'no durable send landed; cell is not attributable' : allThree ? 'three idle sends replied, including the required last send' : 'one of the three idle sends did not land or reply', control, ['SENDS             ' + JSON.stringify(turns), 'LAST DISK USER     ' + String(last?.diskUser ?? 'n/a'), 'SCREEN TAIL        ' + JSON.stringify(chat.screenTail(700)), 'FRAME TYPES        ' + chat.frameSummary()], { sid, turns, driver: await status(sid) })
  } finally { await cleanup(sid, chat) }
}

async function runA1b() {
  const { sid, chat } = await create('claude')
  try {
    const first = 'P2874-A1B-FIRST-' + Date.now().toString(36).toUpperCase()
    const queued = 'P2874-A1B-QUEUED-' + Date.now().toString(36).toUpperCase()
    const firstSent = await mutate('sessions.sendText', { sessionId: sid, text: 'Count from 1 to 160, putting each number on its own line with a full sentence. Do not use tools. Include ' + first + ' in the final line.' })
    const firstUser = await waitForNeedle(sid, chat, first, 'user', 30_000)
    const working = await waitPhase(sid, (phase) => phase === 'working', 15_000, 250)
    const control: Control = { fired: firstUser.ok, what: 'the first busy-turn prompt appearing as a durable user turn', detail: 'first user turn=' + firstUser.ok + '; working=' + working.ok + ' at ' + working.ms + 'ms' }
    if (!firstUser.ok) return result('BLOCKED', 'busy-turn control did not land', control, ['FIRST SEND        ' + short(firstSent), 'SCREEN TAIL       ' + JSON.stringify(chat.screenTail(900))], { sid, working: working.samples })
    if (!working.ok) return result('BLOCKED', 'the first turn was not observed in flight, so queue behavior was not exercised', control, ['FIRST SEND        ' + short(firstSent), 'PHASE SAMPLES     ' + JSON.stringify(working.samples.slice(-12))], { sid, working: working.samples })
    const secondSent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + queued + '. Do not use tools.' })
    await chat.close()
    const reloaded = new Chat(sid)
    await reloaded.open()
    await primeTerminalTui(reloaded, sid)
    const secondUser = await waitForNeedle(sid, reloaded, queued, 'user', REPLY_MS)
    const secondAssistant = secondUser.ok ? await waitForNeedle(sid, reloaded, queued, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
    const payload = secondSent.result?.data ?? secondSent.error ?? null
    const payloadObject = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    const responseObject = secondSent.result && typeof secondSent.result === 'object' ? secondSent.result as Record<string, unknown> : null
    const positionFrames = [...chat.positionFrames, ...reloaded.positionFrames]
    const framePosition = positionFrames.find((frame) => typeof frame.position === 'number' || typeof frame.queuePosition === 'number')
    const text = JSON.stringify(payload)
    const queuedFlag = /queued/i.test(text) && !/queued[^a-z]+false/i.test(text)
    const position = payloadObject?.position ?? payloadObject?.queuePosition ?? responseObject?.position ?? responseObject?.queuePosition ?? framePosition?.position ?? framePosition?.queuePosition ?? null
    const hasPositionField = typeof position === 'number' || positionFrames.length > 0 || /\b(?:queuePosition|position)\b["']?\s*:/i.test(JSON.stringify(secondSent))
    const pass = queuedFlag && hasPositionField && secondUser.ok && secondAssistant.ok
    const out = result(pass ? 'PASS' : 'FAIL', pass ? 'busy send queued with a durable position, survived reload, and answered idle' : 'busy send did not show a durable queue position or did not answer after reload', control, ['FIRST SEND        ' + short(firstSent), 'SECOND SEND       ' + short(payload), 'QUEUE POSITION    ' + String(position), 'POSITION FIELD    ' + hasPositionField, 'RELOADED USER     ' + secondUser.ok + ' in ' + secondUser.ms + 'ms', 'RELOADED REPLY    ' + secondAssistant.ok + ' in ' + secondAssistant.ms + 'ms', 'PHASE AFTER       ' + short(await status(sid))], { sid, first, queued, firstUser: firstUser.ok, working: working.samples, second: payload, secondUser: secondUser.ok, secondAssistant: secondAssistant.ok, position, hasPositionField })
    out.evidence.splice(1, 0, 'SECOND RAW       ' + short(secondSent))
    out.evidence.splice(5, 0, 'POSITION FRAMES   ' + short(positionFrames))
    out.data.secondRaw = secondSent
    await reloaded.close()
    return out
  } finally { await cleanup(sid) }
}

async function runA1c() {
  const { sid, chat } = await create(harness)
  try {
    const base = await baselineReply(sid, chat, 'A1C-CONTROL')
    const before = sessionProcesses(cwd)
    const agent = before.find((row) => /claude(?:-code)?(?:\s|$|\/)/i.test(row.cmd))
    const control: Control = { fired: base.user.ok && Boolean(agent), what: 'a baseline prompt and the exact Claude child PID appearing before death', detail: 'baseline user=' + base.user.ok + '; baseline reply=' + base.assistant.ok + '; agentPid=' + String(agent?.pid ?? '(none)') }
    if (!control.fired) return result('BLOCKED', 'baseline control did not fire', control, ['BASELINE          ' + short(base)], { sid })
    let killed = false
    let killError = ''
    try { process.kill(agent!.pid, 'SIGKILL'); killed = true } catch (error) { killError = String(error) }
    await wait(1_500)
    const gone = !sessionProcesses(cwd).some((row) => row.pid === agent!.pid)
    const dead = 'P2918-A1C-DEAD-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + dead + '.' })
    const payload = sent.result?.data ?? sent.error ?? null
    const text = JSON.stringify(payload)
    const typed = Boolean(sent.error) || /refus|not found|dead|retir|exited|unknown session|cannot/i.test(text)
    const delivered = /disposition[^}]*delivered|queued[^}]*true|"ok"\s*:\s*true/i.test(text) && !typed
    const afterSend = await status(sid)
    // A queued user item alone is not proof of survival: sendText can record it
    // before a dead PTY ever comes back. Require the assistant needle after the
    // queue-triggered resurrection so this follow-up cannot pass on the already
    // observed durable user row.
    const revivedReply = delivered
      ? await waitForNeedle(sid, chat, dead, 'assistant', REPLY_MS)
      : { ok: false, ms: 0, items: [] as Item[] }
    const afterReply = await status(sid)
    const pass = killed && gone && (typed ? !delivered : delivered && revivedReply.ok)
    const summary = !control.fired
      ? 'exact-child control did not fire'
      : !killed || !gone
        ? 'the exact Claude child was not confirmed dead, so the dead-session condition was not exercised'
        : pass && typed
          ? 'exact Claude child was killed after a live baseline; dead-session send returned a typed refusal'
          : pass
            ? 'dead-session send was queued and its assistant needle arrived after queue-triggered resurrection; the refusal clause is obsolete'
            : delivered
              ? 'dead-session send was accepted as queued, but its assistant needle did not arrive after queue-triggered resurrection'
              : 'dead-session send was accepted without a typed refusal'
    return result(!control.fired ? 'BLOCKED' : !killed || !gone ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', summary, control, ['BASELINE          ' + short(base), 'BEFORE MAP        ' + short(before, 1800), 'CHILD PID         ' + agent!.pid, 'CHILD CMD         ' + agent!.cmd, 'KILL              SIGKILL sent=' + killed + (killError ? ' error=' + killError : ''), 'CHILD GONE        ' + gone, 'DEAD SEND         ' + short(payload), 'AFTER SEND STATUS ' + short(afterSend), 'TYPED REFUSAL     ' + typed, 'SILENT ACCEPT     ' + delivered, 'RESURRECTED REPLY ' + revivedReply.ok + ' in ' + revivedReply.ms + 'ms', 'AFTER REPLY STATUS ' + short(afterReply)], { sid, dead, payload, typed, delivered, revivedReply: revivedReply.ok, revivedReplyMs: revivedReply.ms, afterSend, afterReply, childPid: agent!.pid, childCmd: agent!.cmd, killed, gone, killError })
  } finally { await cleanup(sid, chat) }
}

async function runA2a() {
  const { sid, chat } = await create('claude')
  try {
    const needle = 'P2874-A2A-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Count from 1 to 180 with one sentence per number. Do not use tools. Include ' + needle + ' in your final line.' })
    const user = await waitForNeedle(sid, chat, needle, 'user', 30_000)
    const samples: { at: number; phase?: string; status?: string; driverId?: string | null; screenBytes: number }[] = []
    const started = Date.now()
    while (Date.now() - started < 15_000) {
      const row = await status(sid)
      samples.push({ at: Date.now() - started, phase: row?.phase, status: row?.status, driverId: row?.driverId, screenBytes: chat.screenBytes })
      await wait(250)
    }
    const workingAt = samples.find((x) => x.phase === 'working')
    const idleDuring = samples.filter((x) => x.phase === 'idle').length
    const assistant = user.ok ? await waitForNeedle(sid, chat, needle, 'assistant', BUSY_MS) : { ok: false, ms: 0, items: [] as Item[] }
    const after = await status(sid)
    const control: Control = { fired: user.ok, what: 'the working-turn prompt appearing as a durable user turn', detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; terminal bytes=' + chat.screenBytes }
    const sustained = assistant.ok || chat.screenBytes > 0
    const pass = Boolean(workingAt && workingAt.at <= 2_000 && idleDuring === 0 && after?.phase !== 'working')
    return result(!control.fired ? 'BLOCKED' : !sustained ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', !control.fired ? 'working-turn control did not land' : !sustained ? 'turn did not produce a measurable in-flight signal' : pass ? 'working appeared within 2s, stayed working through the sample, and returned idle' : 'working badge timing or continuity did not meet the release criterion', control, ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'WORKING AT        ' + short(workingAt ?? null), 'IDLE SAMPLES      ' + idleDuring, 'SAMPLES           ' + JSON.stringify(samples), 'AFTER             ' + short(after)], { sid, user: user.ok, assistant: assistant.ok, workingAt, idleDuring, samples, after })
  } finally { await cleanup(sid, chat) }
}

async function runA2b() {
  const { sid, chat, created } = await create(harness)
  try {
    const row = await status(sid)
    const control: Control = { fired: chat.frameTypes.has('attached') || chat.screenBytes > 0, what: 'new session attach/output evidence independent of the status value', detail: 'created=' + short(created) + '; attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes }
    const pass = row?.phase === 'idle'
    return result(!control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', pass ? 'fresh session reported idle at boot' : 'fresh session reported ' + (row?.phase ?? 'blank') + ' at boot', control, ['STATUS            ' + short(row), 'SESSION ROW       ' + short(await listRow(sid)), 'FRAME TYPES       ' + chat.frameSummary(), 'SCREEN TAIL       ' + JSON.stringify(chat.screenTail(500))], { sid, status: row, row: await listRow(sid) })
  } finally { await cleanup(sid, chat) }
}

async function runA3() {
  const load1m = loadavg()[0]
  if (load1m >= 12) {
    return result('UNDRIVEN', 'host load was ' + load1m.toFixed(2) + ' at the A3 gate; interrupt was not attempted', { fired: false, what: 'load gate below 12 before starting an interrupt turn', detail: '1m load=' + load1m.toFixed(2) + '; threshold=12' }, ['LOAD 1M          ' + load1m.toFixed(2), 'DRIVE             UNDRIVEN'], { load1m, threshold: 12 })
  }
  const { sid, chat } = await create('claude')
  try {
    const needle = 'P2874-A3-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Count from 1 to 220, one sentence per line, without tools. Include ' + needle + ' in the final line.' })
    const user = await waitForNeedle(sid, chat, needle, 'user', 30_000)
    const working = await waitPhase(sid, (phase) => phase === 'working', 15_000, 250)
    const control: Control = { fired: user.ok && working.ok, what: 'the turn producing a durable user item and an observed working phase before interrupt', detail: 'user=' + user.ok + '; working=' + working.ok + '; bytes=' + chat.screenBytes }
    if (!working.ok) return result('BLOCKED', 'no in-flight turn was observed, so interrupt was not exercised', control, ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'PHASE SAMPLES     ' + JSON.stringify(working.samples.slice(-12))], { sid, user: user.ok, working: working.samples })
    const interrupted = await mutate('sessions.interrupt', { sessionId: sid })
    const after = await waitPhase(sid, (phase) => phase !== 'working', 20_000, 500)
    const items = await transcript(sid)
    const hasMarker = items.some((x) => x.event === 'interrupt' || /interrupt|cancel|refus/i.test(textOf(x.text)))
    const payload = interrupted.result?.data ?? interrupted.error ?? null
    const typedRefusal = Boolean(interrupted.error) || /refus|unsupported|cannot|not available/i.test(JSON.stringify(payload))
    const pass = after.ok && (hasMarker || typedRefusal)
    return result(pass ? 'PASS' : 'FAIL', pass ? 'interrupt stopped the turn and left an interrupt/refusal record' : 'interrupt returned without a stopping record', control, ['INTERRUPT         ' + short(payload), 'STOPPED           ' + after.ok + ' in ' + after.ms + 'ms', 'MARKER           ' + hasMarker, 'TYPED REFUSAL     ' + typedRefusal, 'ITEMS             ' + short(items, 1200)], { sid, payload, after, hasMarker, typedRefusal })
  } finally { await cleanup(sid, chat) }
}

async function permissionAsk(sid: string, chat: Chat, marker: string, timeout = 45_000) {
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
  return { asks, terminal, chatFrame, ms: Date.now() - started, marker }
}

async function answerAsk(a: Record<string, unknown>) {
  return mutate('interactions.answer', { id: a.id, answer: { kind: 'permission', decision: 'allow-once' } })
}

async function runA4a() {
  const { sid, chat } = await create('claude')
  try {
    const marker = 'P2874-A4A-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Use your Bash tool to run exactly: printf ' + marker + ' > /tmp/pod-2874-external/' + marker + '.txt ; then tell me whether it succeeded.' })
    const probe = await permissionAsk(sid, chat, marker)
    const items = await transcript(sid)
    const control: Control = { fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0, what: 'the session attach/terminal stream becoming live independent of whether auto mode raises an ask', detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes + '; transcriptItems=' + items.length }
    if (!control.fired) return result('BLOCKED', 'permission probe had no live-session control', control, ['SEND              ' + short(sent)], { sid })
    if (!probe.asks.length) return result('BLOCKED', 'no permission ask was raised under the seeded auto-mode posture', control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms', 'TERMINAL          ' + probe.terminal, 'CHAT FRAME        ' + probe.chatFrame, 'ITEMS             ' + short(items, 1200)], { sid, probe, items })
    const answers = []
    for (const ask of probe.asks) answers.push(await answerAsk(ask))
    const cleared = await waitPhase(sid, (phase) => phase !== 'needs_user', 30_000, 500)
    const pass = probe.terminal && probe.chatFrame && cleared.ok
    return result(pass ? 'PASS' : 'FAIL', pass ? 'permission card/terminal ask matched and answering resolved it' : 'permission ask did not appear and resolve in both views', control, ['ASKS              ' + short(probe.asks, 1400), 'TERMINAL          ' + probe.terminal, 'CHAT FRAME        ' + probe.chatFrame, 'ANSWERS           ' + short(answers), 'RESOLVED          ' + cleared.ok, 'SCREEN TAIL       ' + JSON.stringify(chat.screenTail(1000))], { sid, probe, answers, cleared })
  } finally { await cleanup(sid, chat) }
}

async function runA4b() {
  const { sid, chat } = await create('claude')
  try {
    const marker = 'P2874-A4B-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Use your Bash tool to run exactly: printf ' + marker + ' > /tmp/pod-2874-external/' + marker + '.txt ; then tell me whether it succeeded.' })
    const probe = await permissionAsk(sid, chat, marker)
    const items = await transcript(sid)
    const control: Control = { fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0, what: 'the session attach/terminal stream becoming live before the ask answer test', detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes + '; transcriptItems=' + items.length }
    if (!control.fired) return result('BLOCKED', 'answer-twice probe had no live-session control', control, ['SEND              ' + short(sent)], { sid })
    if (!probe.asks.length) return result('BLOCKED', 'no permission ask was raised under the seeded auto-mode posture', control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms', 'SCREEN TAIL       ' + JSON.stringify(chat.screenTail(1000))], { sid, probe, items })
    const first = await answerAsk(probe.asks[0])
    const second = await answerAsk(probe.asks[0])
    const secondText = JSON.stringify(second.result?.data ?? second.error ?? null)
    const typed = Boolean(second.error) || /already|closed|unknown|not found|answered|invalid|refus/i.test(secondText)
    return result(typed ? 'PASS' : 'FAIL', typed ? 'second answer returned a typed error without a double action' : 'second answer was accepted without a typed error', control, ['ASK               ' + short(probe.asks[0]), 'FIRST             ' + short(first), 'SECOND            ' + short(second), 'TYPED ERROR       ' + typed, 'SECOND TEXT       ' + secondText], { sid, probe, first, second, typed })
  } finally { await cleanup(sid, chat) }
}

function a4InstrumentLimit(cell: string) {
  return result('BLOCKED', 'known Claude instrument limit: claude-code 2.1.231 rewrites permissions.defaultMode manual→auto; permission prompting cannot be exercised hermetically', { fired: false, what: 'documented permission-prompt instrument limit', detail: cell + ' was not retried per POD-1761 standing brief' }, ['DRIVE             NOT RETRIED', 'REASON            claude-code 2.1.231 rewrites permissions.defaultMode manual→auto'], { cell, instrumentLimit: 'permissions.defaultMode manual→auto rewrite', retried: false })
}

async function runA5() {
  const { sid, chat } = await create('claude')
  try {
    const marker = 'P2918-A5-MARKER-' + Date.now().toString(36).toUpperCase()
    writeFileSync(join(cwd, 'transcript-fixture.txt'), 'transcript fixture test marker ' + marker + '\n')
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Use your Bash tool to run cat ' + join(cwd, 'transcript-fixture.txt') + ' and then reply with only the test marker it contains.' })
    const user = await waitForNeedle(sid, chat, 'transcript-fixture.txt', 'user', 30_000)
    const assistant = await waitForNeedle(sid, chat, marker, 'assistant', REPLY_MS)
    const before = await transcript(sid)
    await chat.close()
    const reload = new Chat(sid)
    await reload.open()
    await wait(2_000)
    const after = await transcript(sid)
    const toolItems = before.filter((x) => x.role === 'tool' || x.toolName || /tool/i.test(textOf(x.event)))
    const resultItems = before.filter((x) => (x.role === 'tool' && !x.toolName) || x.role === 'tool_result' || /result/i.test(textOf(x.event)))
    const paired = toolItems.length > 0 && (resultItems.length > 0 || before.some((x) => x.toolName && x.role !== 'tool'))
    const sameHistory = JSON.stringify(before.map((x) => ({ id: x.id, role: x.role, text: x.text, event: x.event, toolName: x.toolName }))) === JSON.stringify(after.map((x) => ({ id: x.id, role: x.role, text: x.text, event: x.event, toolName: x.toolName })))
    const control: Control = { fired: user.ok, what: 'the transcript fixture prompt landing as a durable user turn', detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; items=' + before.length }
    const out = result(!control.fired ? 'BLOCKED' : !toolItems.length ? 'BLOCKED' : paired && sameHistory && assistant.ok ? 'PASS' : 'FAIL', !control.fired ? 'transcript control did not fire' : !toolItems.length ? 'agent did not produce a tool call, so pairing was not exercised' : paired && sameHistory && assistant.ok ? 'tool call/result pair and reload history are intact' : 'tool transcript pairing or reload history failed', control, ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'USER              ' + user.ok, 'ASSISTANT         ' + assistant.ok, 'TOOL ITEMS        ' + short(toolItems, 1200), 'RESULT ITEMS      ' + short(resultItems, 1200), 'RELOAD SAME       ' + sameHistory, 'RELOAD ITEMS      ' + after.length], { sid, marker, before, after, toolItems, resultItems, paired, sameHistory })
    await reload.close()
    return out
  } finally { await cleanup(sid) }
}

async function runA6a() {
  const { sid, chat: one } = await create(harness)
  const two = new Chat(sid)
  try {
    view(one, sid, 'native')
    await wait(2_000)
    await two.open()
    view(two, sid, 'native')
    await wait(2_000)
    const control: Control = { fired: one.frameTypes.has('attached') && one.screenBytes > 0, what: 'the first native viewer receiving an attached terminal stream', detail: 'attached=' + (one.frameTypes.get('attached') ?? 0) + '; screenBytes=' + one.screenBytes }
    const marker = 'P2874-A6A-' + Date.now().toString(36).toUpperCase()
    const beforeGeometry = (await listRow(sid))?.geometry
    input(one, sid, harness === 'shell' ? shellPrint(marker) : marker + '\r')
    const firstScreen = await screenNeedle(one, marker, 20_000)
    const secondScreen = await screenNeedle(two, marker, 20_000)
    one.send({ type: 'resize', sessionId: sid, cols: 100, rows: 30 })
    await wait(2_000)
    const afterGeometry = (await listRow(sid))?.geometry
    const resizeBytes = one.screenBytes
    const resizedViewer = await screenNeedle(two, marker, 2_000)
    const geometryOk = JSON.stringify(afterGeometry) === JSON.stringify({ cols: 100, rows: 30 })
    const pass = firstScreen.ok && secondScreen.ok && geometryOk && resizeBytes > 0
    return result(!control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', !control.fired ? 'native attach control did not fire' : pass ? 'keystrokes echoed, resize refit, and second viewer saw the same screen' : 'terminal attach, echo, resize, or second-viewer parity failed', control, ['MARKER            ' + marker, 'FIRST SCREEN      ' + firstScreen.ok + ' in ' + firstScreen.ms + 'ms', 'SECOND SCREEN     ' + secondScreen.ok + ' in ' + secondScreen.ms + 'ms', 'GEOMETRY BEFORE   ' + short(beforeGeometry), 'GEOMETRY AFTER    ' + short(afterGeometry), 'RESIZE BYTES      ' + resizeBytes, 'SECOND REPLAY     ' + resizedViewer.ok, 'SCREEN 1 TAIL     ' + JSON.stringify(one.screenTail(800)), 'SCREEN 2 TAIL     ' + JSON.stringify(two.screenTail(800))], { sid, marker, firstScreen, secondScreen, beforeGeometry, afterGeometry, geometryOk, resizeBytes })
  } finally { await two.close().catch(() => {}); await cleanup(sid, one) }
}

async function runA6b() {
  const { sid, chat } = await create('claude')
  try {
    view(chat, sid, 'chat')
    const c1 = await baselineReply(sid, chat, 'A6B-CHAT1')
    const control: Control = { fired: c1.user.ok, what: 'the first chat send landing before view switches', detail: 'chat control user=' + c1.user.ok + '; reply=' + c1.assistant.ok }
    if (!control.fired) return result('BLOCKED', 'first chat control did not fire', control, ['CHAT 1            ' + short(c1)], { sid })
    const cli1 = 'P2874-A6B-CLI1-' + Date.now().toString(36).toUpperCase()
    view(chat, sid, 'native'); await wait(1_500); input(chat, sid, harness === 'shell' ? shellPrint(cli1) : cli1 + '\r')
    const cli1Seen = await screenNeedle(chat, cli1, 20_000)
    view(chat, sid, 'chat'); await wait(1_500)
    const c2 = await baselineReply(sid, chat, 'A6B-CHAT2')
    view(chat, sid, 'native'); await wait(1_500)
    const cli2 = 'P2874-A6B-CLI2-' + Date.now().toString(36).toUpperCase()
    input(chat, sid, harness === 'shell' ? shellPrint(cli2) : cli2 + '\r')
    const cli2Seen = await screenNeedle(chat, cli2, 20_000)
    const geom = (await listRow(sid))?.geometry
    const pass = c1.assistant.ok && cli1Seen.ok && c2.assistant.ok && cli2Seen.ok && Boolean(geom)
    return result(pass ? 'PASS' : 'FAIL', pass ? 'chat→CLI→chat→CLI retained one live session and both views remained functional' : 'a chat/CLI switch lost a reply or terminal echo', control, ['CHAT 1            ' + short(c1), 'CLI 1             ' + cli1Seen.ok + ' ' + cli1Seen.ms + 'ms', 'CHAT 2            ' + short(c2), 'CLI 2             ' + cli2Seen.ok + ' ' + cli2Seen.ms + 'ms', 'GEOMETRY          ' + short(geom), 'SCREEN TAIL       ' + JSON.stringify(chat.screenTail(1000))], { sid, c1, cli1, cli1Seen, c2, cli2, cli2Seen, geometry: geom })
  } finally { await cleanup(sid, chat) }
}

async function restartDaemon(mode: Harness): Promise<void> {
  const r = spawnSync('bash', [join(ROOT, 'docs/evidence/pod-2874/drive-daemon.sh'), mode], { encoding: 'utf8', env: { ...process.env, PODIUM_DRIVE_BASE: BASE, POD2874_REPO_ROOT: SOURCE_ROOT, POD2874_INSTANCE: process.env.PODIUM_INSTANCE ?? 'p2918', PODIUM_RUNTIME_CONTRACT: '1' } })
  if (r.status !== 0) throw new Error('daemon restart failed: ' + (r.stdout ?? '') + (r.stderr ?? ''))
}

async function runA7a() {
  const { sid, chat } = await create(harness)
  try {
    const secret = 'P2874-A7A-' + Date.now().toString(36).toUpperCase()
    let base: Record<string, unknown>
    if (harness === 'claude') {
      const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Remember this codeword: ' + secret + '. Reply with exactly ' + secret + '. Do not use tools.' })
      const user = await waitForNeedle(sid, chat, secret, 'user', REPLY_MS)
      const reply = user.ok ? await waitForNeedle(sid, chat, secret, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
      base = { sent: sent.result?.data ?? sent.error ?? null, user: user.ok, reply: reply.ok }
      if (!user.ok) return result('BLOCKED', 'pre-restart codeword control did not land', { fired: false, what: 'pre-restart Claude user turn', detail: short(base) }, ['BASELINE          ' + short(base)], { sid, secret })
    } else {
      view(chat, sid, 'native'); await wait(1_000)
      input(chat, sid, shellSetCode(secret))
      const echo = await screenNeedle(chat, secret, 15_000)
      base = { echo: echo.ok, echoMs: echo.ms }
      if (!echo.ok) return result('BLOCKED', 'pre-restart shell codeword control did not echo', { fired: false, what: 'pre-restart shell terminal echo', detail: short(base) }, ['BASELINE          ' + short(base)], { sid, secret })
    }
    const control: Control = { fired: true, what: harness === 'claude' ? 'pre-restart Claude codeword user turn' : 'pre-restart shell codeword echo', detail: short(base) }
    await chat.close()
    await restartDaemon(harness)
    const postPin = await pinFor('A7A-post-restart')
    const resumed = new Chat(sid); await resumed.open(); await wait(4_000)
    let recall: Record<string, unknown>
    if (harness === 'claude') {
      const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'What codeword did I ask you to remember? Reply with exactly ' + secret + '. Do not use tools.' })
      const got = await waitForNeedle(sid, resumed, secret, 'assistant', REPLY_MS)
      recall = { sent: sent.result?.data ?? sent.error ?? null, assistant: got.ok, ms: got.ms }
    } else {
      input(resumed, sid, 'printf "%s\\n" "$POD2874_CODE"\r')
      const got = await screenNeedle(resumed, secret, 15_000)
      recall = { echo: got.ok, ms: got.ms }
    }
    const pass = harness === 'claude' ? recall.assistant === true : recall.echo === true
    const out = result(pass ? 'PASS' : 'FAIL', pass ? 'daemon restart retained the same live conversation and codeword' : 'daemon restart lost the session or codeword', control, ['BASELINE          ' + short(base), 'POST RESTART PIN   ' + postPin.daemonSha, 'RECALL            ' + short(recall), 'STATUS            ' + short(await status(sid)), 'SCREEN TAIL       ' + JSON.stringify(resumed.screenTail(900))], { sid, secret, base, recall })
    await resumed.close()
    return out
  } finally { await cleanup(sid, chat) }
}

async function runA7b() {
  const { sid, chat } = await create('claude')
  try {
    const secret = 'P2874-A7B-' + Date.now().toString(36).toUpperCase()
    const base = await baselineReply(sid, chat, 'A7B-CONTROL')
    const control: Control = { fired: base.user.ok && base.assistant.ok, what: 'pre-hibernate conversation replying with a unique codeword', detail: 'user=' + base.user.ok + '; reply=' + base.assistant.ok }
    if (!control.fired) return result('BLOCKED', 'pre-hibernate control did not fire', control, ['BASELINE          ' + short(base)], { sid })
    const seeded = await mutate('sessions.sendText', { sessionId: sid, text: 'Remember ' + secret + '. Reply exactly ' + secret + '. Do not use tools.' })
    const seededReply = await waitForNeedle(sid, chat, secret, 'assistant', REPLY_MS)
    const hibernated = await mutate('sessions.hibernate', { sessionId: sid })
    const parked = await waitPhase(sid, (phase, row) => phase === 'idle' && row?.status === 'hibernated', 30_000, 500)
    const resurrected = await mutate('sessions.resurrect', { sessionId: sid })
    const live = await waitPhase(sid, (phase, row) => phase !== 'working' && row?.status === 'live', 45_000, 500)
    const fresh = new Chat(sid); await fresh.open(); await wait(3_000)
    const recall = await mutate('sessions.sendText', { sessionId: sid, text: 'Recall the codeword ' + secret + '; reply exactly ' + secret + '. Do not use tools.' })
    const recalled = await waitForNeedle(sid, fresh, secret, 'assistant', REPLY_MS)
    const pass = seededReply.ok && parked.ok && live.ok && recalled.ok
    const out = result(pass ? 'PASS' : 'FAIL', pass ? 'hibernate/wake preserved the conversation and answered after wake' : 'hibernate/wake lost context or failed to become live', control, ['SEEDED            ' + short(seeded.result?.data ?? seeded.error ?? null), 'SEEDED REPLY      ' + seededReply.ok, 'HIBERNATE         ' + short(hibernated), 'PARKED            ' + parked.ok + ' ' + parked.ms + 'ms', 'RESURRECT         ' + short(resurrected), 'LIVE              ' + live.ok + ' ' + live.ms + 'ms', 'RECALL            ' + short(recall.result?.data ?? recall.error ?? null), 'RECALLED          ' + recalled.ok, 'STATUS            ' + short(await status(sid))], { sid, secret, base, seededReply: seededReply.ok, hibernated, parked, resurrected, live, recall, recalled: recalled.ok })
    await fresh.close()
    return out
  } finally { await cleanup(sid, chat) }
}

async function runA8() {
  const credentials = join(AGENT_HOME, '.claude/.credentials.json')
  const backup = join(BASE, 'claude-credentials.backup')
  if (!existsSync(credentials)) throw new Error('expected seeded credential at ' + credentials)
  spawnSync('cp', ['--', credentials, backup])
  spawnSync('rm', ['--', credentials])
  let sid = ''
  let chat: Chat | undefined
  try {
    const made = await mutate('sessions.create', { cwd, agentKind: 'claude-code' })
    sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId ?? ''
    if (!sid) throw new Error('sessions.create failed ' + short(made))
    chat = new Chat(sid); await chat.open(); await primeTerminalTui(chat, sid); await wait(8_000)
    const screen = chat.screenTail(7000)
    const control: Control = { fired: chat.frameTypes.has('attached') || chat.screenBytes > 0, what: 'logged-out Claude spawn producing a live terminal surface', detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes }
    const loginPath = /log in|login|sign in|oauth|claude\.ai|authenticate|API key/i.test(screen)
    return result(!control.fired ? 'BLOCKED' : loginPath ? 'BLOCKED' : 'FAIL', !control.fired ? 'logged-out spawn had no live control' : loginPath ? 'login path is visible; completing external OAuth is outside this rig' : 'logged-out spawn showed no working login path', control, ['SCREEN            ' + JSON.stringify(screen), 'LOGIN PATH        ' + loginPath, 'STATUS            ' + short(await status(sid))], { sid, loginPath, screen })
  } finally {
    if (chat && sid) await chat.close().catch(() => {})
    if (sid) await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
    spawnSync('cp', ['--', backup, credentials])
    spawnSync('rm', ['--', backup])
  }
}

interface ProcessRow { pid: number; ppid: number; cwd: string; cmd: string }

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

async function runA9() {
  const { sid, chat } = await create(harness)
  try {
    await wait(3_000)
    const before = sessionProcesses(cwd)
    const control: Control = { fired: before.length > 0 && chat.screenBytes > 0, what: 'target session process tree existing before kill', detail: 'processes=' + before.length + '; screenBytes=' + chat.screenBytes }
    const killed = await mutate('sessions.kill', { sessionId: sid })
    const immediate: ProcessRow[][] = []
    for (let i = 0; i < 10; i++) { await wait(500); immediate.push(sessionProcesses(cwd)) }
    await wait(300_000)
    const after = sessionProcesses(cwd)
    const pass = control.fired && after.length === 0
    return result(!control.fired ? 'BLOCKED' : pass ? 'PASS' : 'FAIL', !control.fired ? 'kill control did not show a target process tree' : pass ? 'session process tree was gone immediately and after five minutes' : 'orphaned session processes remained after five minutes', control, ['KILL              ' + short(killed), 'BEFORE            ' + short(before, 1800), 'IMMEDIATE         ' + short(immediate, 1800), 'AFTER 5 MIN       ' + short(after, 1800), 'SERVER/DAEMON      ' + pidInfo(join(BASE, 'server.pid')).alive + '/' + pidInfo(join(BASE, 'daemon.pid')).alive], { sid, before, killed, immediate, after, waitedMs: 300_000 })
  } finally { await cleanup(sid, chat) }
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
      case 'A1A': out = await runA1a(); break
      case 'A1B': out = await runA1b(); break
      case 'A1C': out = await runA1c(); break
      case 'A2A': out = await runA2a(); break
      case 'A2B': out = await runA2b(); break
      case 'A3': out = await runA3(); break
      case 'A4A': out = a4InstrumentLimit('A4A'); break
      case 'A4B': out = a4InstrumentLimit('A4B'); break
      case 'A5': out = await runA5(); break
      case 'A6A': out = await runA6a(); break
      case 'A6B': out = await runA6b(); break
      case 'A7A': out = await runA7a(); break
      case 'A7B': out = await runA7b(); break
      case 'A8': out = await runA8(); break
      case 'A9': out = await runA9(); break
      default: throw new Error('unhandled ' + cell)
    }
  } catch (error) {
    out = result('BLOCKED', 'cell could not be driven: ' + String(error).slice(0, 240), { fired: false, what: 'the complete pinned cell running to a result', detail: String(error) }, ['ERROR             ' + String(error)])
  }
  const reading: Reading = { cell, harness, cwd, at, pin, ...out }
  writeFileSync(join(READING_DIR, READING_PREFIX + '.' + cell.toLowerCase() + '.json'), JSON.stringify(reading, null, 2) + '\n')
  console.log(harness + '/' + cell + ' ' + reading.verdict + ' — ' + reading.summary)
  console.log('control=' + (reading.control.fired ? 'FIRED' : 'MISSING') + ' ' + reading.control.detail)
  for (const line of reading.evidence) console.log(line)
}

await login()
await main()
