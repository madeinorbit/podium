/**
 * POD-3112 — OpenCode default headed vs explicit server acceptance at the current 1761 tip.
 *
 *   bun docs/evidence/pod-3112/drive.ts A1a opencode-server
 *   bun docs/evidence/pod-3112/drive.ts A1a default-headed
 *
 * One JSON reading per cell. Pin server, web, daemon before each run.
 * TOS acknowledgement is PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 on the daemon plus
 * an explicit per-spawn runtimeContract=opencode-server. No token values are logged.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { Chat, login, mutate, primeTerminalTui, query, wait } from '../pod-2777/rig'
import { canonicalCellTitle } from './recorder-contract'
import { A2aPushObserver } from './a2a-push-observer'

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'UNDRIVEN' | 'REFUSED'
type Driver = 'opencode-server' | 'default-headed'
type Mode = 'native' | 'chat'

interface Status {
  sessionId?: string
  driverId?: string | null
  requestedDriverId?: string | null
  driverFamily?: string | null
  status?: string
  phase?: string
  error?: { class?: string; detail?: string } | null
  configureFields?: string[]
  requestedModel?: string | null
  requestedEffort?: string | null
  observedModel?: string | null
  observedEffort?: string | null
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
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3112'
const PORT = process.env.PODIUM_PORT ?? '19936'
const ROOT = process.cwd()
const READING_DIR = join(ROOT, 'docs/evidence/pod-3112/readings')
const PIN_DIR = join(ROOT, 'docs/evidence/pod-3112/pins')
const EPIC_LEDGER = join(ROOT, 'docs/plans/pod-1761-results.tsv')
const AGENT_HOME =
  process.env.P3112_STATE_ROOT
    ? join(process.env.P3112_STATE_ROOT, 'agent-home')
    : join(process.env.HOME ?? '', '.local/state/podium/p3112-oc-paired-r4/agent-home')
const REPLY_MS = Number(process.env.P3112_REPLY_MS ?? 180_000)
const BUSY_MS = Number(process.env.P3112_BUSY_MS ?? 90_000)
const STEP_MS = 500
const QUOTA = /(?:weekly|usage|rate) limit|monthly spend limit|spend limit|quota|hit your limit|used\s+\d+%|resets?\s+[A-Z][a-z]{2}|resets?\s+\d/i
const LOGGED_OUT = /not logged in|run\s+\/login|sign in|oauth|token expired|refresh required/i

const CELLS = new Set([
  'A1A', 'A1B', 'A1C', 'A2A', 'A2B', 'A3', 'A4A', 'A4B', 'A5',
  'A6A', 'A6B', 'A7A', 'A7B', 'A8', 'A9', 'A10', 'A11', 'BQUOTA', 'BAUTH',
])

if (!CELLS.has(cell)) throw new Error('unsupported cell ' + cell)
if (driver !== 'opencode-server' && driver !== 'default-headed') throw new Error('driver must be opencode-server or default-headed')
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
  const live = join(process.env.HOME ?? '', '.local/share/opencode/auth.json')
  const isolated = join(AGENT_HOME, '.local/share/opencode/auth.json')
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

async function pinFor(label: string, runToken: string): Promise<Pin> {
  const checkoutSha = outputOf('git', ['-C', ROOT, 'rev-parse', 'HEAD'])
  const pinSha = process.env.P3112_PIN_SHA ?? '2af0b8f7448d6b1ce4ad7a12af2c8226c54e18cd'
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
  for (const key of ['PODIUM_STATE_DIR', 'ABDUCO_SOCKET_DIR', 'PODIUM_RUNTIME_DRIVER']) {
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
  const isolatedCred = join(AGENT_HOME, '.local/share/opencode/auth.json')
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
  writeFileSync(join(PIN_DIR, driver + '-' + label.toLowerCase() + '-' + runToken + '.json'), JSON.stringify(pin, null, 2) + '\n')
  const overrides = Object.entries(forbiddenOverrides).filter(([, value]) => value !== null)
  const webOk = webMatchesHead || reuse.status === 0
  if (!existsSync(isolatedCred) || !lstatSync(isolatedCred).isSymbolicLink()) {
    throw new Error('isolated OpenCode credential must be a symlink to the live credential: ' + isolatedCred)
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
    false
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
    writeFileSync(join(cwd, 'README.md'), `POD-3112 ${driver} ${cell}\n`)
    spawnSync('git', ['add', 'README.md'], { cwd })
    spawnSync('git', ['-c', 'user.email=drive@localhost', '-c', 'user.name=drive', 'commit', '-qm', 'probe seed'], { cwd })
  }
  const body: Record<string, unknown> = { cwd, agentKind: 'opencode' }
  if (driver === 'opencode-server') body.runtimeContract = 'opencode-server'
  else delete body.runtimeContract
  const made = await mutate('sessions.create', body)
  const sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId
  if (!sid) throw new Error('sessions.create failed ' + short(made))
  const chat = new Chat(sid)
  await chat.open(driver === 'default-headed' ? 'native' : 'chat')
  const bound = await waitPhase(sid, (_phase, row) => Boolean(row?.driverId) || Boolean(row?.driverFamily), 30_000, 250)
  if (driver === 'default-headed') await primeTerminalTui(chat, sid)
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
  if (driver === 'opencode-server') return row.driverId === 'opencode-server'
  return row.driverId === 'generic-pty'
}

async function baselineReply(sid: string, chat: Chat, tag: string) {
  const needle = 'P3112-' + tag + '-' + Date.now().toString(36).toUpperCase()
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
  const inst = process.env.PODIUM_INSTANCE ?? 'p3112-oc-paired-r4'
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
      const needle = 'P3112-A1A-' + driver + '-' + i + '-' + Date.now().toString(36).toUpperCase()
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
    const first = 'P3112-A1B-FIRST-' + Date.now().toString(36).toUpperCase()
    const queued = 'P3112-A1B-QUEUED-' + Date.now().toString(36).toUpperCase()
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
    const position =
      payloadObject?.position ?? payloadObject?.queuePosition ?? framePosition?.position ?? framePosition?.queuePosition ?? null
    const finalPayloadHasPosition = Boolean(
      payloadObject && (Object.hasOwn(payloadObject, 'position') || Object.hasOwn(payloadObject, 'queuePosition')),
    )
    const historicalPositionObserved = positionFrames.some(
      (frame) => Object.hasOwn(frame, 'position') || Object.hasOwn(frame, 'queuePosition'),
    )
    const queuedValue = payloadObject?.queued
    const disposition = payloadObject?.disposition
    const stillQueued = queuedValue === true && disposition === 'queued' && finalPayloadHasPosition
    const blockingDelivered = queuedValue !== true && disposition === 'delivered' && !finalPayloadHasPosition
    const finalStateConsistent = stillQueued || blockingDelivered
    const survivedReload = secondUser.ok && secondAssistant.ok
    const pass = finalStateConsistent && survivedReload
    const out = result(
      pass ? 'PASS' : 'FAIL',
      pass
        ? stillQueued
          ? 'busy send remained queued with a truthful position and survived reload'
          : 'busy send upgraded to blocking delivery without a stale position and survived reload'
        : 'busy send final state was contradictory or the user/reply did not survive reload',
      control,
      [
        'FIRST SEND        ' + short(firstSent),
        'SECOND SEND       ' + short(payload),
        'FINAL STATE       ' + (stillQueued ? 'still-queued' : blockingDelivered ? 'blocking-delivered' : 'contradictory'),
        'QUEUE POSITION    ' + String(position),
        'FINAL PAYLOAD POSITION ' + finalPayloadHasPosition,
        'HISTORICAL POSITION    ' + historicalPositionObserved,
        'RELOADED USER     ' + secondUser.ok + ' in ' + secondUser.ms + 'ms',
        'RELOADED REPLY    ' + secondAssistant.ok + ' in ' + secondAssistant.ms + 'ms',
      ],
      { sid, first, queued, firstUser: firstUser.ok, working: working.samples, second: payload, secondUser: secondUser.ok, secondAssistant: secondAssistant.ok, position, finalPayloadHasPosition, historicalPositionObserved, queuedValue, disposition, stillQueued, blockingDelivered, finalStateConsistent, survivedReload },
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
    const before = [...sessionProcesses(cwd), ...instanceProcesses().filter((row) => /opencode|opencode-server-host/i.test(row.cmd))]
    const agent = before.find((row) => /claude(?:-code)?(?:\s|$|\/)|opencode-server-host/i.test(row.cmd))
    const control: Control = {
      fired: (base.user.ok || base.assistant.ok) && Boolean(agent),
      what: 'a baseline prompt/reply and the exact OpenCode child PID appearing before death',
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
    const dead = 'P3112-A1C-DEAD-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', { sessionId: sid, text: 'Reply with exactly this word and nothing else: ' + dead + '.' })
    const payload = sent.result?.data ?? sent.error ?? null
    const text = JSON.stringify(payload)
    const typed = Boolean(sent.error) || /refus|not found|dead|retir|exited|unknown session|cannot/i.test(text)
    const delivered = /disposition[^}]*delivered|queued[^}]*true|"ok"\s*:\s*true/i.test(text) && !typed
    const afterSend = await status(sid)
    const revivedReply = delivered ? await waitForNeedle(sid, chat, dead, 'assistant', REPLY_MS) : { ok: false, ms: 0, items: [] as Item[] }
    const pass = killed && gone && (typed ? !delivered : delivered && revivedReply.ok)
    const summary = !killed || !gone
      ? 'the exact OpenCode child was not confirmed dead, so the dead-session condition was not exercised'
      : pass && typed
        ? 'exact OpenCode child was killed after a live baseline; dead-session send returned a typed refusal'
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
  const needle = 'P3112-A2A-' + Date.now().toString(36).toUpperCase()
  const observer = new A2aPushObserver('http://127.0.0.1:' + PORT, process.env.PODIUM_PASSWORD ?? '', sid, needle)
  try {
    await observer.open()
    const calledAt = Date.now()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Count from 1 to 12, one number per line, then finish with the word ' + needle + '. Do not use tools.',
    })
    const sendRoundTripMs = Date.now() - calledAt
    observer.markAccepted()
    const assessment = await observer.waitForSettled(BUSY_MS)
    const control: Control = {
      fired: assessment.assistantNonceAtMonoMs !== null && assessment.firstWorkingReceiveMs !== null,
      what: 'the direct push observer receiving both a working state and the assistant nonce',
      detail: 'assistant=' + (assessment.assistantNonceAtMonoMs !== null) + '; workingReceiveMs=' + assessment.firstWorkingReceiveMs,
    }
    return result(
      assessment.verdict,
      assessment.reason,
      control,
      [
        'SEND              ' + short(sent.result?.data ?? sent.error ?? null),
        'SEND ROUND-TRIP   ' + sendRoundTripMs + 'ms (excluded)',
        'TIMING            ' + assessment.timing + ' receive=' + assessment.firstWorkingReceiveMs + 'ms source=' + assessment.sourceDeltaMs + 'ms',
        'MID-TURN FLICKERS ' + assessment.flickers.length,
        'PUSHED FINAL IDLE ' + assessment.finalIdle,
      ],
      { sid, sendRoundTripMs, assessment, pushes: observer.pushes },
    )
  } finally {
    observer.close()
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

async function runA3() {
  const load1m = loadavg()[0]
  if (load1m >= 12) {
    return result('UNDRIVEN', 'host load was ' + load1m.toFixed(2) + ' at the A3 gate; interrupt was not attempted', {
      fired: false,
      what: 'load gate below 12 before starting an interrupt turn',
      detail: '1m load=' + load1m.toFixed(2) + '; threshold=12',
    }, ['LOAD 1M          ' + load1m.toFixed(2)], { load1m, threshold: 12 })
  }
  const { sid, chat } = await create()
  try {
    const needle = 'P3112-A3-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Count from 1 to 220, one sentence per line, without tools. Include ' + needle + ' in the final line.',
    })
    const user = await waitForNeedle(sid, chat, needle, 'user', 5_000)
    const working = await waitPhase(sid, (phase) => phase === 'working', 15_000, 250)
    const control: Control = {
      fired: user.ok || working.ok || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok),
      what: 'the turn send delivering and an observed working phase before interrupt',
      detail: 'user=' + user.ok + '; working=' + working.ok,
    }
    if (!working.ok) {
      return result('BLOCKED', 'no in-flight turn was observed, so interrupt was not exercised', control, ['SEND              ' + short(sent.result?.data ?? sent.error ?? null)], { sid, user: user.ok, working: working.samples })
    }
    const interrupted = await mutate('sessions.interrupt', { sessionId: sid })
    const after = await waitPhase(sid, (phase) => phase !== 'working', 20_000, 500)
    const items = await transcript(sid)
    const hasMarker = items.some((x) => x.event === 'interrupt' || /interrupt|cancel|refus/i.test(textOf(x.text)))
    const payload = interrupted.result?.data ?? interrupted.error ?? null
    const typedRefusal = Boolean(interrupted.error) || /refus|unsupported|cannot|not available/i.test(JSON.stringify(payload))
    const pass = after.ok && (hasMarker || typedRefusal)
    return result(
      pass ? 'PASS' : 'FAIL',
      pass ? 'interrupt stopped the turn and left an interrupt/refusal record' : 'interrupt returned without a stopping record',
      control,
      ['INTERRUPT         ' + short(payload), 'STOPPED           ' + after.ok + ' in ' + after.ms + 'ms', 'MARKER           ' + hasMarker, 'TYPED REFUSAL     ' + typedRefusal],
      { sid, payload, after, hasMarker, typedRefusal },
    )
  } finally {
    await cleanup(sid, chat)
  }
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
    const marker = 'P3112-A4A-' + Date.now().toString(36).toUpperCase()
    const outside = join('/tmp', 'pod-3112-external')
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
      return result('BLOCKED', 'no permission ask was raised', control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms', 'TERMINAL          ' + probe.terminal, 'ITEMS             ' + short(items, 1200)], { sid, probe, items })
    }
    const answers = []
    for (const ask of probe.asks) answers.push(await answerAsk(ask))
    const cleared = await waitPhase(sid, (phase) => phase !== 'needs_user', 30_000, 500)
    const bothViews = driver === 'default-headed' ? probe.terminal : true
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
    const marker = 'P3112-A4B-' + Date.now().toString(36).toUpperCase()
    const outside = join('/tmp', 'pod-3112-external')
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
      return result('BLOCKED', 'no permission ask was raised', control, ['SEND              ' + short(sent), 'ASK LIST          [] after ' + probe.ms + 'ms'], { sid, probe, items })
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
    const marker = 'P3112-A5-MARKER-' + Date.now().toString(36).toUpperCase()
    writeFileSync(join(cwd, 'transcript-fixture.txt'), 'transcript fixture test marker ' + marker + '\n')
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Use your Bash tool to run cat ' + join(cwd, 'transcript-fixture.txt') + ' and then reply with only the test marker it contains.',
    })
    const user = await waitForNeedle(sid, chat, 'transcript-fixture.txt', 'user', 5_000)
    const assistant = await waitForNeedle(sid, chat, marker, 'assistant', REPLY_MS)
    const before = await transcript(sid)
    await chat.close()
    const reload = new Chat(sid)
    await reload.open()
    await wait(2_000)
    const after = await transcript(sid)
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
    const out = result(
      !control.fired ? 'BLOCKED' : !toolItems.length ? 'BLOCKED' : paired && sameHistory && assistant.ok ? 'PASS' : 'FAIL',
      !control.fired
        ? 'transcript control did not fire'
        : !toolItems.length
          ? 'agent did not produce a tool call, so pairing was not exercised'
          : paired && sameHistory && assistant.ok
            ? 'tool call/result pair and reload history are intact'
            : 'tool transcript pairing or reload history failed',
      control,
      ['SEND              ' + short(sent.result?.data ?? sent.error ?? null), 'USER              ' + user.ok, 'ASSISTANT         ' + assistant.ok, 'TOOL ITEMS        ' + short(toolItems, 1200), 'RELOAD SAME       ' + sameHistory],
      { sid, marker, before, after, toolItems, resultItems, paired, sameHistory },
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
    if (driver === 'opencode-server' && row?.driverFamily && row.driverFamily !== 'terminal' && one.screenBytes === 0) {
      const control: Control = { fired: Boolean(row.driverId), what: 'SDK session bound so terminal-applicability can be judged', detail: 'driverId=' + (row.driverId ?? '(none)') + '; family=' + (row.driverFamily ?? '(none)') }
      return result('BLOCKED', 'opencode-server arm has no client terminal; A6a is not applicable', control, ['IDENTITY          ' + short(row), 'SCREEN BYTES      ' + one.screenBytes], { sid, applicable: false, row })
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
    const marker = 'P3112-A6A-' + Date.now().toString(36).toUpperCase()
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
    if (driver === 'opencode-server' && row?.driverFamily && row.driverFamily !== 'terminal' && chat.screenBytes === 0) {
      const control: Control = { fired: Boolean(row.driverId), what: 'SDK session bound so chat/CLI-applicability can be judged', detail: short(row) }
      return result('BLOCKED', 'opencode-server arm has no CLI terminal; A6b is not applicable', control, ['IDENTITY          ' + short(row)], { sid, applicable: false, row })
    }
    view(chat, sid, 'chat')
    const c1 = await baselineReply(sid, chat, 'A6B-CHAT1')
    const control: Control = { fired: c1.user.ok || c1.assistant.ok, what: 'the first chat send landing before view switches', detail: 'chat control user=' + c1.user.ok + '; reply=' + c1.assistant.ok }
    if (!c1.assistant.ok) return result('BLOCKED', 'first chat control did not fire', control, ['CHAT 1            ' + short(c1)], { sid })
    const cli1 = 'P3112-A6B-CLI1-' + Date.now().toString(36).toUpperCase()
    view(chat, sid, 'native')
    await wait(1_500)
    input(chat, sid, cli1 + '\r')
    const cli1Seen = await screenNeedle(chat, cli1, 20_000)
    view(chat, sid, 'chat')
    await wait(1_500)
    const c2 = await baselineReply(sid, chat, 'A6B-CHAT2')
    view(chat, sid, 'native')
    await wait(1_500)
    const cli2 = 'P3112-A6B-CLI2-' + Date.now().toString(36).toUpperCase()
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
  const r = spawnSync('bash', [join(ROOT, 'docs/evidence/pod-3112/restart-daemon.sh')], { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw new Error('daemon restart failed: ' + (r.stdout ?? '') + (r.stderr ?? ''))
  const newPid = pidInfo(join(BASE, 'daemon.pid')).pid
  if (!newPid || newPid === oldPid) throw new Error('daemon pid did not change: old=' + oldPid + ' new=' + newPid)
  return { oldPid, newPid, out: r.stdout }
}

async function runA7a() {
  const { sid, chat } = await create()
  try {
    const secret = 'P3112-A7A-' + Date.now().toString(36).toUpperCase()
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text: 'Remember this codeword: ' + secret + '. Reply with exactly ' + secret + '. Do not use tools.',
    })
    const user = await waitForNeedle(sid, chat, secret, 'user', 5_000)
    const reply = await waitForNeedle(sid, chat, secret, 'assistant', REPLY_MS)
    const control: Control = { fired: user.ok || reply.ok, what: 'pre-restart OpenCode codeword send/reply', detail: 'user=' + user.ok + '; reply=' + reply.ok }
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
    const secret = 'P3112-A7B-' + Date.now().toString(36).toUpperCase()
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
  const credentials = join(AGENT_HOME, '.local/share/opencode/auth.json')
  if (existsSync(credentials)) {
    throw new Error('isolated credential present; A8 must not copy or move it')
  }
  let sid = ''
  let chat: Chat | undefined
  try {
    const made = await mutate('sessions.create', {
      cwd,
      agentKind: 'opencode',
      ...(driver === 'opencode-server' ? { runtimeContract: 'opencode-server' } : {}),
    })
    sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId ?? ''
    if (!sid) throw new Error('sessions.create failed ' + short(made))
    chat = new Chat(sid)
    await chat.open()
    if (driver === 'default-headed') await primeTerminalTui(chat, sid)
    await wait(8_000)
    const items = await transcript(sid)
    const screen = chat.screenTail(7000)
    const text = joined(items) + '\n' + screen
    const control: Control = {
      fired: chat.frameTypes.has('attached') || chat.screenBytes > 0 || items.length > 0 || Boolean((await status(sid))?.driverId),
      what: 'logged-out OpenCode spawn producing a live surface',
      detail: 'attached=' + (chat.frameTypes.get('attached') ?? 0) + '; screenBytes=' + chat.screenBytes + '; items=' + items.length,
    }
    const loginPath = LOGGED_OUT.test(text) || /log in|login|sign in|oauth|opencode.ai|authenticate|API key/i.test(text)
    const cls = classifyText(text)
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
    const before = [...sessionProcesses(cwd), ...instanceProcesses().filter((row) => row.cmd.includes(sid) || /opencode|opencode-server-host/i.test(row.cmd))]
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

async function runA11() {
  const { sid, chat } = await create()
  try {
    const before = await status(sid)
    const controlReply = await baselineReply(sid, chat, 'A11-CONTROL')
    const catalogReply = await mutate('models.refresh', {})
    const catalog = catalogReply.result?.data as { byAgent?: Record<string, { value: string; efforts?: string[] }[]> } | undefined
    const models = catalog?.byAgent?.opencode ?? []
    const targetModel = models.find((entry) => entry.value !== before?.observedModel)?.value
    const targetEntry = models.find((entry) => entry.value === targetModel)
    const targetEffort = targetEntry?.efforts?.find((effort) => effort !== before?.observedEffort)
    const target = { model: targetModel ?? 'opencode-control-model', effort: targetEffort ?? 'high' }
    const configured = await mutate('sessions.configure', { sessionId: sid, ...target })
    const immediate = await status(sid)
    const supports = driver === 'opencode-server'
    let afterRestart = immediate
    let configuredTurn: Awaited<ReturnType<typeof baselineReply>> | undefined
    if (supports && (configured.result?.data as { ok?: boolean } | undefined)?.ok) {
      configuredTurn = await baselineReply(sid, chat, 'A11-CONFIGURED')
      const restart = spawnSync('bash', [join(ROOT, 'docs/evidence/pod-3112/restart-daemon.sh')], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 180_000 })
      if (restart.status !== 0) throw new Error('daemon restart failed: ' + (restart.stderr || restart.stdout))
      await login()
      afterRestart = (await waitPhase(sid, (_phase, row) => row?.driverId === 'opencode-server', 120_000, 500)).row
    }
    const outcome = configured.result?.data as { ok?: boolean; reason?: string; effective?: string } | undefined
    const control: Control = { fired: controlReply.assistant.ok, what: 'live provider reply before model/effort configuration', detail: 'assistant=' + controlReply.assistant.ok }
    const pass = supports
      ? control.fired && outcome?.ok === true && outcome.effective === 'next-turn' && immediate?.requestedModel === target.model && immediate?.requestedEffort === target.effort && afterRestart?.requestedModel === target.model && afterRestart?.requestedEffort === target.effort && configuredTurn?.assistant.ok === true
      : control.fired && outcome?.reason === 'unsupported' && immediate?.requestedModel === before?.requestedModel && immediate?.requestedEffort === before?.requestedEffort
    return result(!control.fired ? 'REFUSED' : pass ? 'PASS' : 'FAIL', supports ? 'A11 sticky model/effort request checked through a provider turn and daemon restart' : 'A11 unsupported model/effort request checked for typed refusal without state change', control, ['BEFORE            ' + short(before), 'CONFIGURE         ' + short(outcome), 'IMMEDIATE         ' + short(immediate), 'AFTER RESTART     ' + short(afterRestart)], { sid, target, before, configured: outcome, immediate, afterRestart, configuredTurn })
  } finally {
    await cleanup(sid, chat)
  }
}

async function runBquota() {
  const { sid, chat } = await create()
  try {
    const needle = 'P3112-BQUOTA-' + Date.now().toString(36).toUpperCase()
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
  const runToken = (process.env.P3112_PIN_SHA ?? 'UNPINNED') + '-' + at.replace(/[-:.]/g, '')
  const pinRel = 'docs/evidence/pod-3112/pins/' + driver + '-' + cell.toLowerCase() + '-' + runToken + '.json'
  let pin: Pin | undefined
  let out: ReturnType<typeof result>
  try {
    pin = await pinFor(cell, runToken)
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
      case 'A11':
        out = await runA11()
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
  mkdirSync(READING_DIR, { recursive: true })
  mkdirSync(PIN_DIR, { recursive: true })
  const readingRel = 'docs/evidence/pod-3112/readings/' + driver + '.' + cell.toLowerCase() + '.' + runToken + '.json'
  writeFileSync(join(ROOT, readingRel), JSON.stringify(reading, null, 2) + '\n')
  const clean = (value: unknown) => textOf(value).replace(/[\t\r\n]+/g, ' ')
  appendFileSync(join(ROOT, 'docs/evidence/pod-3112/results.tsv'), [stamp(), 'POD-3112', pin?.pinSha ?? 'UNPINNED', driver, cell, reading.verdict, reading.control.fired ? 'FIRED' : 'MISSING', clean(readingRel)].join('\t') + '\n')
  if (reading.verdict !== 'REFUSED') {
    const ledger = readFileSync(EPIC_LEDGER, 'utf8')
    const malformed = ledger.split('\n').find((line) => line && !line.startsWith('#') && line.split('\t').length !== 8)
    if (malformed) throw new Error('authoritative epic ledger has non-eight-field row: ' + malformed.slice(0, 160))
    const duplicate = ledger.split('\n').some((line) => line.split('\t')[7] === 'POD-3112' && line.includes(runToken))
    if (duplicate) throw new Error('duplicate authoritative epic ledger issue+run identity: POD-3112 ' + runToken)
    const identity = driver === 'default-headed' ? 'generic-pty' : 'opencode-server'
    const title = canonicalCellTitle(cell)
    const controlFired = reading.control.fired
    const epicRow = [
      '[single] ' + title + ' (POD-3112 run ' + runToken + ')',
      identity,
      reading.verdict + ' ' + clean(reading.summary) + '; reading ' + readingRel,
      pin?.pinSha ?? 'UNPINNED',
      (controlFired ? 'yes — ' : 'no — ') + clean(reading.control.what) + '; ' + clean(reading.control.detail),
      'yes — named ' + (process.env.PODIUM_INSTANCE ?? 'unknown') + '; cwd ' + cwd + '; port ' + PORT + '; immutable run ' + runToken,
      stamp(),
      'POD-3112',
    ]
    if (epicRow.length !== 8 || epicRow.some((field) => /[\t\r\n]/.test(field))) throw new Error('refusing malformed authoritative epic row')
    appendFileSync(EPIC_LEDGER, epicRow.join('\t') + '\n')
  }
  console.log(driver + '/' + cell + ' ' + reading.verdict + ' — ' + reading.summary)
  console.log('control=' + (reading.control.fired ? 'FIRED' : 'MISSING') + ' ' + reading.control.detail)
  for (const line of reading.evidence) console.log(line)
  console.log(['P3112_ARTIFACTS', readingRel, pinRel, process.env.P3112_ADJUDICATION_FILE ?? ''].join('\t'))
}

await login()
await main()
