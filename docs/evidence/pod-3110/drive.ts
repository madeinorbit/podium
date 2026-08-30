/**
 * POD-3110 — Grok-only release acceptance drive.
 *
 * The runner drives rows serially. Each row gets a fresh directory, a memory
 * reading, and a shell pin of the server, web bundle, and daemon before the
 * session is created. A missing positive control is BLOCKED, never a failure.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_KIND,
  BASE,
  DRIVE_BASE,
  login,
  mutate,
  nonce,
  now,
  openAsks,
  primeTerminalTui,
  pumpAsks,
  sessionRow,
  settle,
  until,
  wait,
} from '/home/mgw/src/podium/.worktrees/issue-3110-grok-paired-final-proof/docs/evidence/pod-2777/rig'
import type { AskRow, SessionRow } from '/home/mgw/src/podium/.worktrees/issue-3110-grok-paired-final-proof/docs/evidence/pod-2777/rig'

type Arm = 'headless' | 'terminal'
type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED'

interface Control {
  fired: boolean
  what: string
  detail: string
}

interface Cell {
  id: string
  arm: Arm
  verdict: Verdict
  summary: string
  control: Control
  evidence: string[]
  data: Record<string, unknown>
  cwd: string
  memoryMb: number | null
  pin: string
  sessionIds: string[]
  at: string
}

interface CellReading {
  verdict: Verdict
  summary: string
  control: Control
  evidence: string[]
  data?: Record<string, unknown>
  cwd?: string
  sessionIds?: string[]
}

interface SessionContext {
  arm: Arm
  id: string
  sid: string
  cwd: string
  row: SessionRow
  chat: RichChat
}

const arm = (process.argv[2] ?? 'headless') as Arm
if (arm !== 'headless' && arm !== 'terminal') throw new Error('usage: grok-drive.ts headless|terminal')

const INSTANCE = 'p3110-grok-paired-final-tip-2af0'
const PRODUCT_PIN = '2af0b8f7448d6b1ce4ad7a12af2c8226c54e18cd'
const RUN_TOKEN = process.env.P3110_RUN_TOKEN ?? (() => { throw new Error('P3110_RUN_TOKEN is required') })()
const EVIDENCE_DIR = process.env.PODIUM_EVIDENCE_DIR ?? (() => { throw new Error('PODIUM_EVIDENCE_DIR is required') })()
const CELL_ROOT = join(DRIVE_BASE, 'runs', RUN_TOKEN, 'cells')
const RIG = join(import.meta.dir, 'rig.sh')
const JSON_PATH = join(EVIDENCE_DIR, `grok.${PRODUCT_PIN}.${RUN_TOKEN}.${arm}.json`)
const ROWS = join(EVIDENCE_DIR, `grok.${PRODUCT_PIN}.${RUN_TOKEN}.${arm}.candidate.tsv`)
const REPO = join(import.meta.dir, '../../..')
const LEDGER_REL = 'docs/plans/pod-1761-results.tsv'
const LEDGER = join(REPO, LEDGER_REL)
const REPLY_MS = 120_000
const BIND_MS = 90_000
const LONG_PROMPT =
  'Count from 1 to 60. Put each number on its own line and write one full sentence about each number. ' +
  'Do not use tools and do not summarize.'
let authRestoreRequired = false
process.on('exit', () => {
  if (authRestoreRequired) spawnSync('bash', [RIG, 'auth', 'on'], { cwd: join(import.meta.dir, '../../..'), env: cleanRigEnv(), stdio: 'ignore' })
})

const ONLY = new Set((process.env.PODIUM_ONLY ?? '').split(',').map((value) => value.trim()).filter(Boolean))

if (existsSync(JSON_PATH) || existsSync(ROWS)) throw new Error(`refusing overwrite for immutable run ${RUN_TOKEN} arm ${arm}`)
mkdirSync(CELL_ROOT, { recursive: true })

function short(value: unknown, n = 320): string {
  return JSON.stringify(value ?? null).slice(0, n)
}

function dataOf(res: any): any {
  return res?.result?.data ?? null
}

function cellDir(id: string): string {
  const dir = join(CELL_ROOT, `${arm}-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanRigEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'ABDUCO_SESSION',
    'ABDUCO_SOCKET',
    'ABDUCO_SOCKET_DIR',
    'PODIUM_AGENT_HOME',
    'PODIUM_AGENT_RELAY',
    'PODIUM_AGENT_RELAY_PORT',
    'PODIUM_CODEX_HOOK_SOCKET',
    'PODIUM_CODEX_HOOK_URL',
    'PODIUM_HOME',
    'PODIUM_HOST',
    'PODIUM_HOOK_PORT',
    'PODIUM_INSTANCE',
    'PODIUM_MOBILE_WEB_DIR',
    'PODIUM_PASSWORD',
    'PODIUM_PORT',
    'PODIUM_RUNTIME_DRIVER',
    'PODIUM_SESSION_ID',
    'PODIUM_SESSION_INSTANCE',
    'PODIUM_SESSION_RELAY',
    'PODIUM_STATE_DIR',
    'PODIUM_WEB_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'GROK_HOME',
  ]) delete env[key]
  env.PATH = `/home/mgw/.bun/bin:/home/mgw/.local/bin:/usr/local/bin:/usr/bin:/bin:${env.PATH ?? ''}`
  return env
}

function rig(...args: string[]): { code: number; output: string } {
  const r = spawnSync('bash', [RIG, ...args], {
    cwd: join(import.meta.dir, '../../..'),
    env: cleanRigEnv(),
    encoding: 'utf8',
    maxBuffer: 2_000_000,
  })
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function memoryMb(output: string): number | null {
  const match = output.match(/MEMAVAILABLE_MB=(\d+)/)
  return match ? Number(match[1]) : null
}

function preflight(id: string): { ok: boolean; memory: number | null; pin: string; reason: string } {
  const mem = rig('check-memory')
  const pin = rig('verify', arm, id)
  const mb = memoryMb(mem.output)
  if (mem.code !== 0) return { ok: false, memory: mb, pin: pin.output, reason: `free memory gate failed: ${mem.output}` }
  if (pin.code !== 0) return { ok: false, memory: mb, pin: pin.output, reason: `component pin failed: ${pin.output}` }
  return { ok: true, memory: mb, pin: pin.output, reason: '' }
}

const results: Cell[] = []

function saveResults(): void {
  mkdirSync(join(JSON_PATH, '..'), { recursive: true })
  writeFileSync(JSON_PATH, `${JSON.stringify({ instance: INSTANCE, arm, results }, null, 2)}\n`)
}

function field(value: unknown): string {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim()
}
function canonicalWhatId(id: string): string {
  const ids: Record<string, string> = {
    A1a: 'A1a', A1b: 'A1b', A1c: 'A1c', A2a: 'A2a', A2b: 'A2b', A3: 'A3',
    A4a: 'A4a', A4b: 'A4b', A5: 'A5', A6a: 'A6a', A6b: 'A6b', A7a: 'A7a',
    A7b: 'A7b', A8: 'A8', A9: 'A9', A10: 'A10', A11: 'A11',
    A1A: 'A1a', A1B: 'A1b', A1C: 'A1c', A2A: 'A2a', A2B: 'A2b',
    A4A: 'A4a', A4B: 'A4b', A6A: 'A6a', A6B: 'A6b', A7A: 'A7a', A7B: 'A7b',
    'CLI-sync': 'A6b CLI-sync', 'A8-post-login': 'Bauth post-login',
    'B-provider-error': 'Bquota provider-error', BQUOTA: 'Bquota', BAUTH: 'Bauth',
    'B-oom-kill': 'non-matrix B-oom-kill spot-check',
  }
  const canonical = ids[id]
  if (!canonical) throw new Error(`unknown driven id: ${id}`)
  return canonical
}

function assertExactStagedSet(owned: string[], actual: string[]): void {
  const expected = owned.map((path) => path.slice(REPO.length + 1)).sort()
  const sortedActual = [...actual].sort()
  if (JSON.stringify(sortedActual) !== JSON.stringify(expected)) throw new Error(`refusing staged set: actual=${sortedActual.join(',')} expected=${expected.join(',')}`)
}

function evidenceFields(cell: Cell): string[] {
  const driver = arm === 'headless' ? 'grok-acp' : 'generic-pty'
  const fields = [
    `[single] ${canonicalWhatId(cell.id)} Grok paired final tip run=${RUN_TOKEN}`, driver,
    `${cell.verdict} ${cell.summary}`, PRODUCT_PIN,
    `${cell.control.fired ? 'yes' : 'no'} — ${cell.control.what}: ${cell.control.detail}`,
    `yes — named ${INSTANCE}; sequential ${arm} arm; unique cwd ${cell.cwd}; no runtime override`,
    new Date(cell.at).toISOString().replace('T', ' ').replace('Z', ' UTC'), 'POD-3110',
  ].map(field)
  if (fields.length !== 8 || fields.some((value) => !value)) throw new Error(`refusing malformed evidence row for ${cell.id}`)
  return fields
}

function validateLedger(text: string): void {
  const malformed = text.split('\n').map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#') && line.split('\t').length !== 8)
  if (malformed.length) throw new Error(`authoritative NF==8 refusal at lines ${malformed.map(({ index }) => index).join(',')}`)
}

function appendAuthoritativeRow(cell: Cell, fields: string[], readingPath: string, pinPath: string): void {
  const prior = readFileSync(LEDGER, 'utf8')
  validateLedger(prior)
  const identity = `[single] ${canonicalWhatId(cell.id)} Grok paired final tip run=${RUN_TOKEN}`
  if (prior.split('\n').some((line) => line.startsWith(`${identity}\t`) && line.endsWith('\tPOD-3110'))) {
    throw new Error(`refusing duplicate POD-3110 run identity: ${identity}`)
  }
  const line = fields.join('\t')
  validateLedger(`${prior}${prior.endsWith('\n') ? '' : '\n'}${line}\n`)
  const cleanIndex = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: REPO })
  if (cleanIndex.status !== 0) throw new Error('refusing authoritative append with a non-empty git index')
  const lineCount = prior.endsWith('\n') ? prior.split('\n').length - 1 : prior.split('\n').length
  const patch = `diff --git a/${LEDGER_REL} b/${LEDGER_REL}\n--- a/${LEDGER_REL}\n+++ b/${LEDGER_REL}\n@@ -${lineCount},0 +${lineCount + 1},1 @@\n+${line}\n`
  const applied = spawnSync('git', ['apply', '--unidiff-zero', '-'], { cwd: REPO, input: patch, encoding: 'utf8' })
  if (applied.status !== 0) throw new Error(`authoritative git apply failed: ${applied.stderr}`)
  validateLedger(readFileSync(LEDGER, 'utf8'))
  const owned = [LEDGER, JSON_PATH, ROWS, readingPath, pinPath]
  const added = spawnSync('git', ['add', '-f', '--', ...owned], { cwd: REPO, encoding: 'utf8' })
  if (added.status !== 0) throw new Error(`authoritative git add failed: ${added.stderr}`)
  const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO, encoding: 'utf8' })
  const actual = staged.stdout.trim().split('\n').filter(Boolean).sort()
  assertExactStagedSet(owned, actual)
  const committed = spawnSync('git', ['commit', '-m', `test(evidence): record Grok ${arm} ${cell.id} ${RUN_TOKEN}`, '-m', 'Podium-Issue: POD-3110'], { cwd: REPO, encoding: 'utf8' })
  if (committed.status !== 0) throw new Error(`authoritative evidence commit failed: ${committed.stderr}`)
  const after = readFileSync(LEDGER, 'utf8')
  validateLedger(after)
}

function appendCandidateRow(cell: Cell, fields: string[]): void {
  const line = `${fields.join('\t')}\n`
  const prior = (() => { try { return readFileSync(ROWS, 'utf8') } catch { return '' } })()
  if (prior.includes(line)) throw new Error(`refusing duplicate evidence row for ${cell.id}`)
  appendFileSync(ROWS, line)
}

function record(id: string, prep: ReturnType<typeof preflight>, reading: CellReading): void {
  const cell: Cell = {
    id,
    arm,
    verdict: reading.verdict,
    summary: reading.summary,
    control: reading.control,
    evidence: reading.evidence,
    data: reading.data ?? {},
    cwd: reading.cwd ?? cellDir(id),
    memoryMb: prep.memory,
    pin: prep.pin,
    sessionIds: reading.sessionIds ?? [],
    at: new Date().toISOString(),
  }
  results.push(cell)
  saveResults()
  const fields = evidenceFields(cell)
  appendCandidateRow(cell, fields)
  const safeCell = canonicalWhatId(cell.id).replace(/[^A-Za-z0-9-]+/g, '-')
  const stem = `${PRODUCT_PIN}.${RUN_TOKEN}.${arm}.${safeCell}`
  const readingPath = join(EVIDENCE_DIR, `${stem}.reading.json`)
  const pinPath = join(EVIDENCE_DIR, `${stem}.pin.txt`)
  writeFileSync(readingPath, `${JSON.stringify(cell, null, 2)}\n`, { flag: 'wx' })
  writeFileSync(pinPath, `${cell.pin}\n`, { flag: 'wx' })
  appendAuthoritativeRow(cell, fields, readingPath, pinPath)
  console.log(`${id} ${arm} ${cell.verdict} control=${cell.control.fired ? 'FIRED' : 'MISSING'} — ${cell.summary}`)
}

function recordAndStop(reading: CellReading, writer: () => void): void {
  writer()
  if (reading.verdict !== 'PASS') throw new Error(`STOP-FIRST ${reading.verdict}: ${reading.summary}`)
}

function blocked(id: string, prep: ReturnType<typeof preflight>, reason: string): void {
  record(id, prep, {
    verdict: 'BLOCKED',
    summary: reason,
    control: { fired: false, what: 'the live component pin and memory gate before this cell', detail: reason },
    evidence: [`PREFLIGHT         ${reason}`, `PIN               ${prep.pin || '(none)'}`],
  })
  throw new Error(`STOP-FIRST BLOCKED: ${reason}`)
}

function requireCleanTree(): void {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  if (status.status !== 0 || status.stdout.trim()) throw new Error(`refusing dirty drive tree: ${status.stdout || status.stderr}`)
}

async function runCell(id: string, fn: () => Promise<CellReading>): Promise<void> {
  if (ONLY.size > 0 && !ONLY.has(id)) return
  requireCleanTree()
  const prep = preflight(id)
  if (!prep.ok) {
    blocked(id, prep, prep.reason)
    return
  }
  let reading: CellReading
  try {
    reading = await fn()
  } catch (error) {
    reading = {
      verdict: 'BLOCKED',
      summary: 'probe threw before a positive control fired',
      control: { fired: false, what: 'the cell-specific positive control', detail: String(error) },
      evidence: [`EXCEPTION         ${String(error)}`, `PIN               ${prep.pin}`],
    }
  }
  recordAndStop(reading, () => record(id, prep, reading))
}

// ---------------------------------------------------------------------------
// Client wire helper. It keeps attach receipts, geometry, raw frame names,
// transcript items, previews, and screen bytes in the result evidence.
// ---------------------------------------------------------------------------

interface LiteItem {
  id?: string
  role?: string
  text?: string
  event?: string
  toolName?: string
  tags?: unknown
  [key: string]: unknown
}

class RichChat {
  readonly items: LiteItem[] = []
  readonly frameTypes = new Map<string, number>()
  readonly rawFrames: Record<string, unknown>[] = []
  readonly previews: { atMs: number; chars: number; done: boolean }[] = []
  screen = ''
  screenBytes = 0
  openedAt = 0
  attached: Record<string, unknown> | undefined
  private ws?: WebSocket

  constructor(readonly sid: string) {}

  async open(): Promise<void> {
    const auth = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.PODIUM_PASSWORD ?? 'p3110-grok-final' }),
    })
    const cookie = (auth.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/client`, { headers: { cookie } } as never)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('client websocket failed to open'))
    })
    this.ws = ws
    this.openedAt = now()
    ws.onmessage = (event: MessageEvent) => this.onFrame(String(event.data))
    this.send({ type: 'attach', sessionId: this.sid })
    this.send({ type: 'transcriptSubscribe', sessionId: this.sid })
  }

  private onFrame(raw: string): void {
    let frame: Record<string, unknown>
    try { frame = JSON.parse(raw) as Record<string, unknown> } catch { return }
    this.rawFrames.push(frame)
    const type = String(frame.type ?? '')
    this.frameTypes.set(type, (this.frameTypes.get(type) ?? 0) + 1)
    if (type.toLowerCase().includes('attach') && frame.sessionId === this.sid) {
      this.attached = (frame.attached as Record<string, unknown> | undefined) ?? frame
    }
    if (type === 'transcriptDelta' && frame.sessionId === this.sid) {
      if (frame.reset === true) this.items.length = 0
      for (const item of (frame.items ?? []) as LiteItem[]) this.items.push(item)
    }
    if (type === 'outputFrame' && frame.sessionId === this.sid && typeof frame.data === 'string') {
      try {
        const bytes = Buffer.from(frame.data, 'base64')
        this.screenBytes += bytes.length
        this.screen += bytes.toString('binary')
        if (this.screen.length > 200_000) this.screen = this.screen.slice(-100_000)
      } catch { /* raw frame remains in evidence */ }
    }
    if (type === 'turnPreview' && frame.sessionId === this.sid) {
      const rows = (frame.items ?? []) as { text?: string }[]
      this.previews.push({
        atMs: now() - this.openedAt,
        chars: rows.reduce((n, row) => n + (row.text?.length ?? 0), 0),
        done: frame.done === true,
      })
    }
  }

  send(frame: unknown): void { this.ws?.send(JSON.stringify(frame)) }

  mode(mode: 'chat' | 'native'): void {
    this.send({ type: 'viewState', visible: [this.sid], focused: this.sid, modes: { [this.sid]: mode } })
    if (mode === 'native') this.send({ type: 'attach', sessionId: this.sid })
  }

  assistantText(): string { return this.items.filter((i) => i.role === 'assistant').map((i) => i.text ?? '').join('\n') }
  userText(): string { return this.items.filter((i) => i.role === 'user').map((i) => i.text ?? '').join('\n') }
  toolItems(): LiteItem[] {
    return this.items.filter((i) => i.role === 'tool' || Boolean(i.toolName) || JSON.stringify(i).includes('toolResult'))
  }

  screenTail(n = 500): string {
    return this.screen.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x20-\x7e\n]/g, '').replace(/\n{2,}/g, '\n').trim().slice(-n)
  }

  geometry(): unknown {
    const a = this.attached ?? {}
    return a.geometry ?? a.size ?? a.terminalSize ?? null
  }

  async close(): Promise<void> {
    this.send({ type: 'transcriptUnsubscribe', sessionId: this.sid })
    this.send({ type: 'detach', sessionId: this.sid })
    await wait(250)
    this.ws?.close()
  }
}

async function waitFor<T>(
  check: () => T | Promise<T>,
  done: (value: T) => boolean,
  ms: number,
  sid?: string,
): Promise<{ value: T; ok: boolean; ms: number }> {
  const started = now()
  while (now() - started < ms) {
    const value = await check()
    if (done(value)) return { value, ok: true, ms: now() - started }
    if (sid && (await sessionRow(sid))?.agentState?.phase === 'needs_user') await pumpAsks(sid)
    await wait(500)
  }
  const value = await check()
  return { value, ok: done(value), ms: now() - started }
}

async function sendAndWait(chat: RichChat, sid: string, text: string, token: string): Promise<{
  response: any
  user: boolean
  answer: boolean
  ms: number
}> {
  const response = await mutate('sessions.sendText', { sessionId: sid, text })
  const started = now()
  while (now() - started < REPLY_MS) {
    const user = chat.userText().includes(token)
    if (user && chat.assistantText().includes(token)) return { response, user, answer: true, ms: now() - started }
    if ((await sessionRow(sid))?.agentState?.phase === 'needs_user') await pumpAsks(sid)
    await wait(500)
  }
  return { response, user: chat.userText().includes(token), answer: chat.assistantText().includes(token), ms: now() - started }
}

async function createSession(id: string, suffix = ''): Promise<{ sid: string; cwd: string; response: any }> {
  const cwd = suffix ? join(cellDir(id), suffix) : cellDir(id)
  mkdirSync(cwd, { recursive: true })
  const response = await mutate('sessions.create', {
    cwd,
    agentKind: AGENT_KIND.grok,
    ...(arm === 'headless' ? { runtimeContract: 'grok-acp' } : {}),
  })
  const sid = dataOf(response)?.sessionId as string | undefined
  if (!sid) throw new Error(`sessions.create failed: ${short(response, 600)}`)
  return { sid, cwd, response }
}

async function openSession(id: string, suffix = ''): Promise<SessionContext> {
  const made = await createSession(id, suffix)
  let chat: RichChat | undefined
  try {
    const bound = await until(made.sid, (row) => Boolean(row?.driverId), BIND_MS, 500)
    const row = bound.row ?? (await sessionRow(made.sid))
    if (!row?.driverId) throw new Error(`no driver binding after ${bound.ms}ms for ${made.sid}`)
    const bindingOk = arm === 'headless'
      ? row.requestedDriverId === 'grok-acp' && row.driverId === 'grok-acp' && row.driverFamily === 'server'
      : !row.requestedDriverId && row.driverId === 'generic-pty' && row.driverFamily === 'terminal'
    if (!bindingOk) throw new Error(`wrong binding: driver=${row.driverId} family=${row.driverFamily}`)
    chat = new RichChat(made.sid)
    await chat.open()
    chat.mode(arm === 'terminal' ? 'native' : 'chat')
    if (arm === 'terminal') {
      await primeTerminalTui(chat as never, made.sid)
      // A logged-out TUI can still produce bytes and accept an attach, but it
      // cannot exercise the normal release rows. Preserve that distinction:
      // A8 owns the logged-out path; every other terminal cell is BLOCKED.
      const loggedOut = /log[ -]?in|sign[ -]?in|authenticate|api key|device code|browser|credential|unauthori[sz]ed/i.test(chat.screenTail(8_000))
      if (loggedOut && id !== 'A8') throw new Error('Grok terminal is logged out; authenticated acceptance control unavailable')
    }
    return { arm, id, sid: made.sid, cwd: made.cwd, row, chat }
  } catch (error) {
    await chat?.close().catch(() => {})
    await mutate('sessions.kill', { sessionId: made.sid }).catch(() => {})
    throw error
  }
}

async function closeSession(ctx: SessionContext, extra: RichChat[] = []): Promise<void> {
  await ctx.chat.close().catch(() => {})
  for (const chat of extra) await chat.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: ctx.sid }).catch(() => {})
}

async function withSession(id: string, fn: (ctx: SessionContext) => Promise<CellReading>): Promise<CellReading> {
  let ctx: SessionContext | undefined
  const extras: RichChat[] = []
  try {
    ctx = await openSession(id)
    const reading = await fn(ctx)
    return { ...reading, cwd: reading.cwd ?? ctx.cwd, sessionIds: [...(reading.sessionIds ?? []), ctx.sid] }
  } finally {
    if (ctx) await closeSession(ctx, extras)
  }
}

async function baseline(ctx: SessionContext, tag: string): Promise<{
  token: string
  response: any
  user: boolean
  answer: boolean
  ms: number
}> {
  await settle(ctx.sid, 90_000).catch(() => {})
  const token = nonce(tag)
  const result = await sendAndWait(ctx.chat, ctx.sid, `Reply with exactly this word and nothing else: ${token}. Do not use tools.`, token)
  return { token, ...result }
}

function controlForReply(result: { token: string; user: boolean; answer: boolean }, chat: RichChat): Control {
  return {
    fired: result.user,
    what: 'the same socket receiving the probe prompt as a durable user transcript item',
    detail: `user=${result.user} answer=${result.answer} transcriptDelta=${chat.frameTypes.get('transcriptDelta') ?? 0} assistantChars=${chat.assistantText().length}`,
  }
}

function phase(row: SessionRow | undefined): string { return row?.agentState?.phase ?? '?' }

function responseDisposition(response: any): string {
  const data = dataOf(response)
  return String(data?.disposition ?? data?.status ?? data?.state ?? '')
}

function responseOk(response: any): boolean {
  const data = dataOf(response)
  return !response?.error && data?.ok !== false
}

function responsePosition(response: any): unknown {
  const data = dataOf(response)
  return data?.position ?? data?.queuePosition ?? data?.turn?.position ?? null
}

function ownedPids(): { pids: number[]; cmds: Map<number, string> } {
  const pids: number[] = []
  const cmds = new Map<number, string>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'utf8')
      if (!env.includes(`PODIUM_INSTANCE=${INSTANCE}`)) continue
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (/scripts\/(daemon|server)\.ts|grok-drive\.ts|docs\/evidence\/pod-3110\/drive\.ts/.test(cmd)) continue
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      if (stat.split(') ')[1]?.startsWith('Z ')) continue
      pids.push(Number(name))
      cmds.set(Number(name), cmd.slice(0, 160))
    } catch { /* process exited between /proc reads */ }
  }
  return { pids: pids.sort((a, b) => a - b), cmds }
}

async function waitTurnActive(ctx: SessionContext, ms = 20_000): Promise<{
  fired: boolean
  phase: string
  atMs: number | null
  samples: { atMs: number; phase: string; bytes: number; previews: number }[]
}> {
  const started = now()
  const samples: { atMs: number; phase: string; bytes: number; previews: number }[] = []
  let fired = false
  let activeAt: number | null = null
  while (now() - started < ms) {
    const row = await sessionRow(ctx.sid)
    const p = phase(row)
    samples.push({ atMs: now() - started, phase: p, bytes: ctx.chat.screenBytes, previews: ctx.chat.previews.length })
    if (p === 'working' || ctx.chat.screenBytes > 0 || ctx.chat.previews.length > 0) {
      fired = true
      activeAt ??= now() - started
      break
    }
    await wait(250)
  }
  return { fired, phase: phase(await sessionRow(ctx.sid)), atMs: activeAt, samples }
}

async function waitTurnQuiet(ctx: SessionContext, initialBytes: number, ms = 120_000): Promise<{
  idle: boolean
  quiet: boolean
  final: SessionRow | undefined
}> {
  const started = now()
  let lastBytes = ctx.chat.screenBytes
  let lastChange = now()
  let idle = false
  while (now() - started < ms) {
    const row = await sessionRow(ctx.sid)
    if (phase(row) !== 'working') idle = true
    if (ctx.chat.screenBytes !== lastBytes) {
      lastBytes = ctx.chat.screenBytes
      lastChange = now()
    }
    const previewDone = ctx.chat.previews.some((entry) => entry.done)
    if (idle && (previewDone || now() - lastChange > 3_000 || ctx.chat.screenBytes === initialBytes)) {
      return { idle: true, quiet: now() - lastChange > 1_000, final: row }
    }
    await wait(500)
  }
  return { idle, quiet: now() - lastChange > 1_000, final: await sessionRow(ctx.sid) }
}

function askScreen(chat: RichChat, asks: AskRow[]): boolean {
  if (asks.length === 0) return false
  const blob = `${chat.screenTail(5_000)} ${asks.map((ask) => JSON.stringify(ask)).join(' ')}`.toLowerCase()
  return /permission|allow|approve|run|execute|yes|deny|tool/.test(blob)
}

async function findAsk(sid: string, ms = 90_000): Promise<AskRow[]> {
  const started = now()
  while (now() - started < ms) {
    const asks = await openAsks(sid)
    if (asks.length > 0) return asks
    await wait(1_000)
  }
  return openAsks(sid)
}

async function answerOne(id: string): Promise<any> {
  return mutate('interactions.answer', { id, answer: { kind: 'permission', decision: 'allow-once' } })
}

// ---------------------------------------------------------------------------
// Tier-A rows, in matrix order.
// ---------------------------------------------------------------------------

async function a1a(): Promise<void> {
  await runCell('A1a', () => withSession('A1a', async (ctx) => {
    const r = await baseline(ctx, 'IDLE')
    const control = controlForReply(r, ctx.chat)
    const disposition = responseDisposition(r.response)
    const sent = /delivered|sent/i.test(disposition) && responseOk(r.response)
    return {
      verdict: !control.fired ? 'BLOCKED' : r.answer && sent ? 'PASS' : r.answer ? 'PARTIAL' : 'FAIL',
      summary: r.answer && sent ? 'idle send replied and returned a sent/delivered disposition' : r.answer ? 'reply arrived but send did not expose sent/delivered' : 'idle send did not reply',
      control,
      evidence: [`SEND              ${short(dataOf(r.response) ?? r.response)}`, `DISPOSITION       ${disposition || '(absent)'}`, `REPLY             ${r.answer} after ${r.ms}ms`, `USER DURABLE      ${r.user}`],
      data: { disposition, sent, replied: r.answer, token: r.token },
    }
  }))
}

async function a1b(): Promise<void> {
  await runCell('A1b', () => withSession('A1b', async (ctx) => {
    const started = now()
    const first = await mutate('sessions.sendText', { sessionId: ctx.sid, text: LONG_PROMPT })
    const active = await waitTurnActive(ctx)
    const control: Control = {
      fired: ctx.chat.userText().includes('Count from 1 to 60') && active.fired,
      what: 'the first turn is durably present and demonstrably in flight before the busy send',
      detail: `user=${ctx.chat.userText().includes('Count from 1 to 60')} active=${active.fired} phase=${active.phase} previews=${ctx.chat.previews.length} screenBytes=${ctx.chat.screenBytes}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'could not establish the positive busy-turn control', control, evidence: [`FIRST SEND         ${short(dataOf(first) ?? first)}`, `SAMPLES            ${short(active.samples)}`] }
    await ctx.chat.close()
    const reloaded = new RichChat(ctx.sid)
    await reloaded.open()
    reloaded.mode(arm === 'terminal' ? 'native' : 'chat')
    ctx.chat = reloaded
    const token = nonce('QUEUED')
    const second = await mutate('sessions.sendText', { sessionId: ctx.sid, text: `Reply with exactly ${token} after the current turn is done.` })
    const userSeen = await waitFor(() => reloaded.userText(), (text) => text.includes(token), 15_000)
    const position = responsePosition(second)
    const queued = dataOf(second)?.queued === true || /queued/i.test(responseDisposition(second))
    const answer = await waitFor(() => reloaded.assistantText(), (text) => text.includes(token), REPLY_MS, ctx.sid)
    const quiet = await waitTurnQuiet(ctx, reloaded.screenBytes, 60_000)
    const hasPosition = position !== null && position !== undefined && position !== ''
    const verdict: Verdict = queued && answer.ok && hasPosition ? 'PASS' : queued && answer.ok ? 'PARTIAL' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'busy send queued with a position, survived transcript reload, and delivered idle' : verdict === 'PARTIAL' ? 'busy send queued and delivered, but no durable queue position was returned' : 'busy send was not shown queued and delivered',
      control,
      evidence: [`FIRST SEND         ${short(dataOf(first) ?? first)}`, `BUSY CONTROL       ${short(active.samples)}`, `RELOAD             closed first viewer and opened a fresh viewer after ${now() - started}ms`, `SECOND SEND        ${short(dataOf(second) ?? second)}`, `QUEUED             ${queued}`, `POSITION           ${short(position)}`, `USER AFTER RELOAD  ${userSeen.ok}`, `DELIVERED          ${answer.ok} after ${answer.ms}ms`, `FINAL              phase=${phase(quiet.final)} idle=${quiet.idle} quiet=${quiet.quiet}`],
      data: { queued, position, hasPosition, delivered: answer.ok, reload: true },
    }
  }))
}

async function a1c(): Promise<void> {
  await runCell('A1c', () => withSession('A1c', async (ctx) => {
    const before = await baseline(ctx, 'ALIVE')
    const control = controlForReply(before, ctx.chat)
    const killed = await mutate('sessions.kill', { sessionId: ctx.sid })
    const gone = await until(ctx.sid, (row) => row === undefined, 15_000, 500)
    const token = nonce('DEAD')
    const deadSend = await mutate('sessions.sendText', { sessionId: ctx.sid, text: `Reply ${token}` })
    const data = dataOf(deadSend)
    const typed = Boolean(deadSend.error) || data?.ok === false || Boolean(data?.reason) || /dead|resume|refus/i.test(JSON.stringify(deadSend))
    return {
      verdict: !control.fired ? 'BLOCKED' : gone.ok && typed && !responseOk(deadSend) ? 'PASS' : 'FAIL',
      summary: gone.ok && typed && !responseOk(deadSend) ? 'dead-session send returned a typed refusal/resume signal and was not lost' : 'dead-session send did not produce the required typed refusal',
      control,
      evidence: [`BASELINE          ${before.answer} (${before.token})`, `KILL              ${short(dataOf(killed) ?? killed)}`, `ROW GONE          ${gone.ok} after ${gone.ms}ms`, `DEAD SEND         ${short(data ?? deadSend)}`, `TYPED             ${typed} responseOk=${responseOk(deadSend)}`],
      data: { gone: gone.ok, typed, deadSend: data ?? deadSend },
    }
  }))
}

async function a2a(): Promise<void> {
  await runCell('A2a', () => withSession('A2a', async (ctx) => {
    const started = now()
    const send = await mutate('sessions.sendText', { sessionId: ctx.sid, text: LONG_PROMPT })
    const active = await waitTurnActive(ctx, 20_000)
    const control: Control = {
      fired: ctx.chat.userText().includes('Count from 1 to 60') && active.fired,
      what: 'the working-turn prompt is durable and produces a status/output signal',
      detail: `user=${ctx.chat.userText().includes('Count from 1 to 60')} phase=${active.phase} activeAt=${active.atMs}ms previews=${ctx.chat.previews.length} bytes=${ctx.chat.screenBytes}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'working-turn positive control did not fire', control, evidence: [`SEND              ${short(dataOf(send) ?? send)}`, `SAMPLES            ${short(active.samples)}`] }
    const samples = [...active.samples]
    let firstWorking: number | null = active.samples.find((sample) => sample.phase === 'working')?.atMs ?? null
    let flickerIdle = false
    let lastPhase = active.phase
    const deadline = now() + 120_000
    while (now() < deadline) {
      const row = await sessionRow(ctx.sid)
      const p = phase(row)
      const atMs = now() - started
      samples.push({ atMs, phase: p, bytes: ctx.chat.screenBytes, previews: ctx.chat.previews.length })
      if (p === 'working') firstWorking ??= atMs
      if (p === 'idle' && firstWorking !== null && lastPhase === 'working' && ctx.chat.previews.length > 0 && !ctx.chat.previews.some((entry) => entry.done)) flickerIdle = true
      lastPhase = p
      if (firstWorking !== null && p !== 'working' && (ctx.chat.previews.some((entry) => entry.done) || ctx.chat.assistantText().length > 0)) break
      await wait(250)
    }
    const final = await sessionRow(ctx.sid)
    const finalIdle = phase(final) === 'idle' || final?.status === 'exited'
    const withinTwoSeconds = firstWorking !== null && firstWorking <= 2_000
    const verdict: Verdict = withinTwoSeconds && finalIdle && !flickerIdle ? 'PASS' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'working appeared within 2s, remained working until completion, then became idle' : 'status timing or working-state continuity missed the row criterion',
      control,
      evidence: [`SEND              ${short(dataOf(send) ?? send)}`, `FIRST WORKING     ${firstWorking === null ? '(never)' : `${firstWorking}ms`}`, `WITHIN 2S         ${withinTwoSeconds}`, `FLICKER IDLE       ${flickerIdle}`, `FINAL              phase=${phase(final)} status=${final?.status ?? '?'}`, `SAMPLES            ${short(samples, 2_000)}`],
      data: { firstWorking, withinTwoSeconds, flickerIdle, finalPhase: phase(final), samples: samples.slice(-40) },
    }
  }))
}

async function a2b(): Promise<void> {
  await runCell('A2b', () => withSession('A2b', async (ctx) => {
    const samples: string[] = []
    const started = now()
    while (now() - started < 8_000) {
      samples.push(phase(await sessionRow(ctx.sid)))
      await wait(400)
    }
    const control: Control = {
      fired: Boolean(ctx.row.driverId),
      what: 'fresh session bound to Grok and was readable before any user turn',
      detail: `driver=${ctx.row.driverId} family=${ctx.row.driverFamily} phases=${samples.join(',')}`,
    }
    const idle = samples.includes('idle')
    const bad = samples.includes('working') || samples.includes('?')
    return {
      verdict: !control.fired ? 'BLOCKED' : idle && !bad ? 'PASS' : 'FAIL',
      summary: idle && !bad ? 'fresh bound session reported idle without a working/blank sample' : 'fresh session did not present stable idle status at boot',
      control,
      evidence: [`BOUND             driver=${ctx.row.driverId} family=${ctx.row.driverFamily}`, `PHASES             ${samples.join(' -> ')}`, `IDLE SEEN          ${idle}`, `WORKING/BLANK      ${bad}`],
      data: { samples, idle, bad },
    }
  }))
}

async function a3(): Promise<void> {
  await runCell('A3', () => withSession('A3', async (ctx) => {
    const send = await mutate('sessions.sendText', { sessionId: ctx.sid, text: LONG_PROMPT })
    const active = await waitTurnActive(ctx, 20_000)
    const control: Control = {
      fired: ctx.chat.userText().includes('Count from 1 to 60') && active.fired,
      what: 'a turn is demonstrably in flight immediately before sessions.interrupt',
      detail: `user=${ctx.chat.userText().includes('Count from 1 to 60')} phase=${active.phase} previews=${ctx.chat.previews.length} bytes=${ctx.chat.screenBytes}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'could not establish an in-flight turn to interrupt', control, evidence: [`SEND              ${short(dataOf(send) ?? send)}`, `SAMPLES            ${short(active.samples)}`] }
    const beforeBytes = ctx.chat.screenBytes
    const interrupt = await mutate('sessions.interrupt', { sessionId: ctx.sid })
    const settled = await until(ctx.sid, (row) => phase(row) !== 'working', 20_000, 250)
    await wait(2_000)
    const bytesAt2s = ctx.chat.screenBytes
    await wait(2_000)
    const bytesAt4s = ctx.chat.screenBytes
    const marked = ctx.chat.items.some((item) => item.event === 'interrupt') || /interrupt/i.test(ctx.chat.assistantText())
    const callOk = responseOk(interrupt)
    const stopped = settled.ok && bytesAt4s <= bytesAt2s + 200
    return {
      verdict: callOk && stopped && marked ? 'PASS' : 'FAIL',
      summary: callOk && stopped && marked ? 'interrupt stopped the running turn and the transcript marked the action' : 'interrupt did not satisfy stop, call receipt, and transcript-marker criteria together',
      control,
      evidence: [`INTERRUPT         ${short(dataOf(interrupt) ?? interrupt)}`, `CALL OK           ${callOk}`, `SETTLED           ${settled.ok} after ${settled.ms}ms phase=${phase(settled.row)}`, `TRANSCRIPT MARK   ${marked}`, `OUTPUT            ${beforeBytes} before -> ${bytesAt2s} at 2s -> ${bytesAt4s} at 4s`, `AFTER              ${short(await sessionRow(ctx.sid))}`],
      data: { callOk, settled: settled.ok, marked, stopped, bytesAt2s, bytesAt4s },
    }
  }))
}

async function a4a(): Promise<void> {
  await runCell('A4a', () => withSession('A4a', async (ctx) => {
    ctx.chat.mode('chat')
    const before = await baseline(ctx, 'PERMBASE')
    const control = controlForReply(before, ctx.chat)
    const terminal = new RichChat(ctx.sid)
    await terminal.open()
    terminal.mode('native')
    const marker = nonce('PERMISSION')
    const askSend = await mutate('sessions.sendText', {
      sessionId: ctx.sid,
      text: `Use your shell tool to run exactly: echo ${marker} > ${join(ctx.cwd, `${marker}.txt`)} and then tell me it succeeded. You must actually run the command.`,
    })
    const asks = await findAsk(ctx.sid)
    const structured = asks.find((ask) => ask.answerable === 'structured') ?? asks[0]
    const listed = asks.length > 0
    const terminalSameAsk = askScreen(terminal, asks)
    if (!listed) {
      const toolRan = ctx.chat.toolItems().length > 0
      await terminal.close()
      return {
        verdict: toolRan ? 'BLOCKED' : 'FAIL',
        summary: toolRan ? 'no permission ask was exposed because the harness ran the tool permissively' : 'no permission ask appeared and no tool ran',
        control,
        evidence: [`ASK SEND          ${short(dataOf(askSend) ?? askSend)}`, 'INTERACTIONS      empty after 90s', `TOOL ITEMS        ${ctx.chat.toolItems().length}`, 'The ask path did not fire, so no chat/terminal comparison exists.'],
        data: { asks: 0, toolRan },
      }
    }
    const answered = await answerOne(structured!.id)
    const cleared = await waitFor(() => openAsks(ctx.sid), (open) => open.every((ask) => ask.id !== structured!.id), 60_000)
    const cardFrame = [...ctx.chat.frameTypes.keys()].filter((type) => /interaction|pending|approval/i.test(type))
    const terminalTail = terminal.screenTail(600)
    await terminal.close()
    const resolved = cleared.ok
    const verdict: Verdict = resolved && terminalSameAsk ? 'PASS' : resolved ? 'PARTIAL' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'permission card/list and the same terminal ask both appeared; allow-once resolved it' : verdict === 'PARTIAL' ? 'chat-side ask resolved, but the terminal did not show the same ask' : 'permission ask did not resolve',
      control,
      evidence: [`ASKS              ${short(asks)}`, `STRUCTURED        ${short(structured)}`, `CHAT CARD FRAMES  ${cardFrame.join(', ') || '(aggregate interactions.list only)'}`, `TERMINAL SCREEN    ${terminalSameAsk} tail=${terminalTail}`, `ANSWER             ${short(dataOf(answered) ?? answered)}`, `CLEARED            ${resolved} after ${cleared.ms}ms`, `FILE               ${short(await Bun.file(join(ctx.cwd, `${marker}.txt`)).exists())}`],
      data: { asks: asks.length, terminalSameAsk, resolved, cardFrame, marker },
    }
  }))
}

async function a4b(): Promise<void> {
  await runCell('A4b', () => withSession('A4b', async (ctx) => {
    const before = await baseline(ctx, 'TWICEBASE')
    const control = controlForReply(before, ctx.chat)
    const marker = nonce('TWICE')
    await mutate('sessions.sendText', { sessionId: ctx.sid, text: `Use a shell tool to run: echo ${marker} > ${join(ctx.cwd, `${marker}.txt`)}. Actually run it.` })
    const asks = await findAsk(ctx.sid)
    if (asks.length === 0) return { verdict: 'BLOCKED', summary: 'permission ask did not fire, so answer-twice cannot be measured', control, evidence: ['INTERACTIONS      empty after 90s'] }
    const ask = asks.find((entry) => entry.answerable === 'structured') ?? asks[0]
    const first = await answerOne(ask!.id)
    const cleared = await waitFor(() => openAsks(ctx.sid), (open) => open.every((entry) => entry.id !== ask!.id), 60_000)
    const second = await answerOne(ask!.id)
    const secondTyped = Boolean(second.error) || dataOf(second)?.ok === false || /already|unknown|closed|answer/i.test(JSON.stringify(second))
    return {
      verdict: cleared.ok && secondTyped ? 'PASS' : 'FAIL',
      summary: cleared.ok && secondTyped ? 'second answer returned a typed refusal/error and did not double-act' : 'second answer was not a typed refusal after the first resolved',
      control,
      evidence: [`ASK               ${short(ask)}`, `FIRST             ${short(dataOf(first) ?? first)}`, `FIRST CLEARED      ${cleared.ok}`, `SECOND            ${short(dataOf(second) ?? second)}`, `TYPED SECOND      ${secondTyped}`],
      data: { firstCleared: cleared.ok, secondTyped, first: dataOf(first), second: dataOf(second) ?? second },
    }
  }))
}

async function a5(): Promise<void> {
  await runCell('A5', () => withSession('A5', async (ctx) => {
    const before = await baseline(ctx, 'HISTORYBASE')
    const control = controlForReply(before, ctx.chat)
    const marker = nonce('TRANSCRIPT')
    const send = await mutate('sessions.sendText', {
      sessionId: ctx.sid,
      text: `Use your shell tool to write the exact text ${marker} into ${join(ctx.cwd, `${marker}.txt`)}, read it back, and reply with ${marker}. Actually use the tool.`,
    })
    const answer = await waitFor(() => ctx.chat.assistantText(), (text) => text.includes(marker), REPLY_MS, ctx.sid)
    const toolsBeforeReload = ctx.chat.toolItems()
    const toolBlob = toolsBeforeReload.map((item) => JSON.stringify(item)).join('\n')
    const hasCall = toolsBeforeReload.length > 0
    const hasResult = toolsBeforeReload.some((item) => Boolean(item.text) || /result|output|success|toolResult/i.test(JSON.stringify(item)))
    const paired = hasCall && hasResult && (toolsBeforeReload.length > 1 || /result|output|toolResult/i.test(toolBlob))
    await ctx.chat.close()
    const reloaded = new RichChat(ctx.sid)
    await reloaded.open()
    reloaded.mode(arm === 'terminal' ? 'native' : 'chat')
    ctx.chat = reloaded
    await wait(2_000)
    const sameHistory = reloaded.userText().includes(marker) && reloaded.assistantText().includes(marker)
    const toolsAfterReload = reloaded.toolItems()
    const verdict: Verdict = !control.fired ? 'BLOCKED' : paired && answer.ok && sameHistory ? 'PASS' : hasCall ? 'FAIL' : 'BLOCKED'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'tool call/result pairing rendered and the same history returned after reload' : verdict === 'BLOCKED' ? 'tool call path did not fire, so transcript pairing was not measurable' : 'tool/history transcript did not satisfy the paired-and-reload criterion',
      control,
      evidence: [`SEND              ${short(dataOf(send) ?? send)}`, `ANSWER            ${answer.ok} after ${answer.ms}ms`, `TOOLS BEFORE      ${toolsBeforeReload.length} ${short(toolsBeforeReload, 1_500)}`, `CALL              ${hasCall} RESULT=${hasResult} PAIRED=${paired}`, `RELOAD            user=${reloaded.userText().includes(marker)} assistant=${reloaded.assistantText().includes(marker)} toolItems=${toolsAfterReload.length}`, `HISTORY SAME      ${sameHistory}`],
      data: { hasCall, hasResult, paired, sameHistory, toolsBefore: toolsBeforeReload.length, toolsAfter: toolsAfterReload.length },
    }
  }))
}

async function a6a(): Promise<void> {
  await runCell('A6a', () => withSession('A6a', async (ctx) => {
    const controlBytes = ctx.chat.screenBytes
    const control: Control = {
      fired: controlBytes > 0,
      what: 'native attach emits terminal bytes before any keystroke',
      detail: `${controlBytes} byte(s), frames=${[...ctx.chat.frameTypes.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'native attach emitted no positive-control bytes', control, evidence: [`SCREEN BYTES      ${controlBytes}`, `FRAMES            ${short(Object.fromEntries(ctx.chat.frameTypes))}`, `ATTACHED          ${short(ctx.chat.attached)}`] }
    const marker = nonce('ECHO')
    const beforeEcho = ctx.chat.screenBytes
    ctx.chat.send({ type: 'input', sessionId: ctx.sid, data: Buffer.from(marker).toString('base64'), inputOrigin: 'human' })
    const echo = await waitFor(() => ctx.chat.screenTail(5_000), (text) => text.includes(marker), 20_000)
    const beforeNarrow = ctx.chat.screenBytes
    ctx.chat.send({ type: 'resize', sessionId: ctx.sid, cols: 100, rows: 30 })
    await wait(3_000)
    const narrow = ctx.chat.screenBytes - beforeNarrow
    const beforeWide = ctx.chat.screenBytes
    ctx.chat.send({ type: 'resize', sessionId: ctx.sid, cols: 160, rows: 45 })
    await wait(3_000)
    const wide = ctx.chat.screenBytes - beforeWide
    const second = new RichChat(ctx.sid)
    await second.open()
    second.mode('native')
    await wait(5_000)
    const secondTail = second.screenTail(8_000)
    const shared = secondTail.includes(marker) || secondTail.split('\n').some((line) => ctx.chat.screenTail(8_000).includes(line) && line.trim().length > 3)
    const pass = echo.ok && narrow + wide > 0 && second.screenBytes > 0 && shared
    const geometry = ctx.chat.geometry()
    await second.close()
    return {
      verdict: pass ? 'PASS' : 'FAIL',
      summary: pass ? 'keystrokes echoed, both resizes repainted, and a second viewer saw the same screen' : 'terminal attach/type, resize, or second-viewer criterion failed after control fired',
      control,
      evidence: [`ATTACHED          ${short(ctx.chat.attached)}`, `GEOMETRY           ${short(geometry)}`, `ECHO              ${marker} -> ${echo.ok} (+${ctx.chat.screenBytes - beforeEcho} bytes)`, `RESIZE 100x30     ${narrow} bytes`, `RESIZE 160x45     ${wide} bytes`, `SECOND VIEWER      ${second.screenBytes} bytes shared=${shared}`, `VIEWER TAIL        ${secondTail.slice(-700)}`],
      data: { echo: echo.ok, narrow, wide, secondBytes: second.screenBytes, shared, geometry },
    }
  }))
}

async function a6b(): Promise<void> {
  await runCell('A6b', () => withSession('A6b', async (ctx) => {
    const inChat = async () => { ctx.chat.mode('chat'); await wait(1_500) }
    const inCli = async () => { ctx.chat.mode('native'); await wait(2_500) }
    await inChat()
    const beforeChat = await baseline(ctx, 'CHATBEFORE')
    await inCli()
    const cliMarker = nonce('CLIBEFORE')
    ctx.chat.send({ type: 'input', sessionId: ctx.sid, data: Buffer.from(cliMarker).toString('base64'), inputOrigin: 'human' })
    const beforeCli = await waitFor(() => ctx.chat.screenTail(6_000), (text) => text.includes(cliMarker), 20_000)
    const control: Control = {
      fired: beforeChat.user && beforeChat.answer && beforeCli.ok,
      what: 'chat answers and CLI echoes on the same session before any view switch',
      detail: `chat=${beforeChat.answer} cli=${beforeCli.ok} bytes=${ctx.chat.screenBytes} driver=${ctx.row.driverId}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'both-view positive control did not fire before switching', control, evidence: [`CHAT BEFORE       user=${beforeChat.user} answer=${beforeChat.answer}`, `CLI BEFORE        ${beforeCli.ok} marker=${cliMarker}`, `SCREEN            ${ctx.chat.screenTail(700)}`] }
    await inChat()
    const pids0 = ownedPids()
    const geometry0 = ctx.chat.geometry()
    const marker = beforeChat.token
    const observations: Record<string, unknown>[] = []
    for (const [mode, label] of [['chat', '1 chat'], ['native', '2 CLI'], ['chat', '3 chat'], ['native', '4 CLI']] as const) {
      ctx.chat.mode(mode)
      await wait(3_500)
      observations.push({ label, mode, marker: mode === 'chat' ? ctx.chat.userText().includes(marker) : ctx.chat.screenTail(8_000).includes(marker), bytes: ctx.chat.screenBytes, geometry: ctx.chat.geometry(), pids: ownedPids().pids })
    }
    await inChat()
    const afterChat = await baseline(ctx, 'CHATAFTER')
    await inCli()
    const afterMarker = nonce('CLIAFTER')
    ctx.chat.send({ type: 'input', sessionId: ctx.sid, data: Buffer.from(afterMarker).toString('base64'), inputOrigin: 'human' })
    const afterCli = await waitFor(() => ctx.chat.screenTail(8_000), (text) => text.includes(afterMarker), 20_000)
    const pidsAfter = ownedPids()
    const pidStable = pids0.pids.every((pid) => pidsAfter.pids.includes(pid))
    const geometries = [geometry0, ...observations.map((observation) => observation.geometry)].filter((value) => value !== null && value !== undefined)
    const sizeKnown = geometries.length === 5
    const sizeStable = sizeKnown && geometries.every((value) => JSON.stringify(value) === JSON.stringify(geometry0))
    const markers = observations.every((observation) => observation.marker === true)
    const core = pidStable && markers && afterChat.answer && afterCli.ok
    const verdict: Verdict = core && sizeStable ? 'PASS' : core ? 'PARTIAL' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'four view switches preserved the session, scrollback, geometry, and both post-switch controls' : verdict === 'PARTIAL' ? 'switches and both views survived, but attach geometry was not observable on every switch' : 'view switching lost continuity or one of the post-switch views stopped working',
      control,
      evidence: [`AGENT PIDS        before=${pids0.pids.join(',') || '(none)'} after=${pidsAfter.pids.join(',') || '(none)'} stable=${pidStable}`, `GEOMETRY BASE     ${short(geometry0)}`, `SWITCHES           ${short(observations, 2_000)}`, `MARKERS            ${markers}`, `CHAT AFTER         ${afterChat.answer} (${afterChat.token})`, `CLI AFTER          ${afterCli.ok} (${afterMarker})`, `GEOMETRY STABLE    ${sizeStable} known=${sizeKnown}`],
      data: { pidStable, markers, sizeStable, sizeKnown, afterChat: afterChat.answer, afterCli: afterCli.ok, observations },
    }
  }))
}

async function a7a(): Promise<void> {
  await runCell('A7a', () => withSession('A7a', async (ctx) => {
    const before = await baseline(ctx, 'RESTARTBASE')
    const control = controlForReply(before, ctx.chat)
    const beforeRow = await sessionRow(ctx.sid)
    const conversationBefore = beforeRow?.conversationId ?? beforeRow?.conversationPodiumId ?? null
    const oldDaemon = Number(rig('info').output.match(/daemonPid=(\d+)/)?.[1] ?? 0)
    await ctx.chat.close()
    const restarted = rig('restart-daemon', arm)
    await wait(5_000)
    const newDaemon = Number(rig('info').output.match(/daemonPid=(\d+)/)?.[1] ?? 0)
    const afterPin = rig('verify', arm, 'A7a-after-restart')
    const row = await until(ctx.sid, (candidate) => Boolean(candidate?.driverId), 60_000, 500)
    const reloaded = new RichChat(ctx.sid)
    await reloaded.open()
    reloaded.mode(arm === 'terminal' ? 'native' : 'chat')
    ctx.chat = reloaded
    const sent = await mutate('sessions.sendText', { sessionId: ctx.sid, text: `What exact word did I ask you to remember? Reply with ${before.token}.` })
    const answer = await waitFor(() => reloaded.assistantText(), (text) => text.includes(before.token), REPLY_MS, ctx.sid)
    const afterRow = await sessionRow(ctx.sid)
    const conversationAfter = afterRow?.conversationId ?? afterRow?.conversationPodiumId ?? null
    const same = conversationBefore !== null && conversationBefore === conversationAfter
    const restartedOk = restarted.code === 0 && oldDaemon !== 0 && newDaemon !== 0 && oldDaemon !== newDaemon
    return {
      verdict: control.fired && restartedOk && row.ok && answer.ok && same ? 'PASS' : 'FAIL',
      summary: control.fired && restartedOk && row.ok && answer.ok && same ? 'daemon restart preserved the live row, the same conversation pointer, and codeword recall' : 'daemon restart did not preserve the same live conversation and recall path',
      control,
      evidence: [`BASELINE          ${before.answer} codeword=${before.token}`, `DAEMON             before=${oldDaemon} after=${newDaemon} changed=${oldDaemon !== newDaemon}`, `RESTART            ${restarted.output}`, `PIN AFTER          code=${afterPin.code} ${afterPin.output}`, `BOUND AFTER        ${row.ok} driver=${row.value?.driverId ?? '?'}`, `RECALL SEND        ${short(dataOf(sent) ?? sent)}`, `RECALL             ${answer.ok}`, `CONVERSATION       before=${conversationBefore} after=${conversationAfter} same=${same}`],
      data: { oldDaemon, newDaemon, restartedOk, recalled: answer.ok, sameConversation: same, conversationBefore, conversationAfter },
    }
  }))
}

async function a7b(): Promise<void> {
  await runCell('A7b', () => withSession('A7b', async (ctx) => {
    const before = await baseline(ctx, 'HIBERNATEBASE')
    const control = controlForReply(before, ctx.chat)
    const conversationBefore = (await sessionRow(ctx.sid))?.conversationId ?? null
    await settle(ctx.sid, 90_000).catch(() => {})
    const hibernated = await mutate('sessions.hibernate', { sessionId: ctx.sid })
    const parked = await until(ctx.sid, (row) => row === undefined || (row.status !== 'live' && row.status !== 'running'), 60_000, 500)
    const resurrected = await mutate('sessions.resurrect', { sessionId: ctx.sid })
    const live = await until(ctx.sid, (row) => row?.status === 'live', 60_000, 500)
    const recall = await mutate('sessions.resumeAndSend', { sessionId: ctx.sid, text: `Reply with the remembered codeword ${before.token}.` })
    const answer = await waitFor(() => ctx.chat.assistantText(), (text) => text.includes(before.token), REPLY_MS, ctx.sid)
    const conversationAfter = (await sessionRow(ctx.sid))?.conversationId ?? null
    const same = conversationBefore !== null && conversationBefore === conversationAfter
    const hibernatedOk = dataOf(hibernated)?.ok !== false && parked.ok
    const wakeOk = dataOf(resurrected)?.ok !== false && live.ok
    return {
      verdict: control.fired && hibernatedOk && wakeOk && answer.ok && same ? 'PASS' : 'FAIL',
      summary: control.fired && hibernatedOk && wakeOk && answer.ok && same ? 'hibernate/resurrect and resume-and-send woke the same conversation with context intact' : 'hibernate/wake did not preserve a live, same-conversation recall path',
      control,
      evidence: [`BASELINE          ${before.answer} codeword=${before.token}`, `HIBERNATE         ${short(dataOf(hibernated) ?? hibernated)} parked=${parked.ok}`, `RESURRECT         ${short(dataOf(resurrected) ?? resurrected)} live=${live.ok}`, `RESUMEANDSEND     ${short(dataOf(recall) ?? recall)}`, `RECALL            ${answer.ok}`, `CONVERSATION       before=${conversationBefore} after=${conversationAfter} same=${same}`],
      data: { hibernatedOk, wakeOk, recalled: answer.ok, sameConversation: same },
    }
  }))
}

async function a8(): Promise<void> {
  await runCell('A8', async () => {
    const cwd = cellDir('A8')
    const off = rig('auth', 'off')
    // If the normal home was already logged out, there is no state transition
    // to reload. Avoid restarting the persistent daemon from this short-lived
    // runner process: the host reaps descendants when the command returns.
    authRestoreRequired = false
    const authChanged = /moved aside/i.test(off.output)
    authRestoreRequired = authChanged
    const restarted = authChanged
      ? rig('restart-daemon', arm)
      : { code: 0, output: 'daemon left running; derived Grok credential was already absent' }
    let loggedOut: { sid: string; chat: RichChat } | undefined
    let restored: { sid: string; row: SessionRow | undefined } | undefined
    try {
      const first = await createSession('A8', 'logged-out')
      const bound = await until(first.sid, (row) => Boolean(row?.driverId), BIND_MS, 500)
      const row = bound.row ?? (await sessionRow(first.sid))
      const chat = new RichChat(first.sid)
      await chat.open()
      chat.mode('native')
      await wait(8_000)
      loggedOut = { sid: first.sid, chat }
      const control: Control = {
        fired: Boolean(row?.driverId) && chat.screenBytes > 0,
        what: 'a logged-out Grok spawn binds and produces a visible native login path',
        detail: `driver=${row?.driverId ?? '?'} family=${row?.driverFamily ?? '?'} screenBytes=${chat.screenBytes}`,
      }
      const screen = chat.screenTail(8_000)
      const loginPath = /log[ -]?in|sign[ -]?in|authenticate|api key|device code|browser|credential/i.test(screen)
      await chat.close()
      await mutate('sessions.kill', { sessionId: first.sid }).catch(() => {})

      const on = rig('auth', 'on')
      authRestoreRequired = false
      const rearmed = authChanged
        ? rig('restart-daemon', arm)
        : { code: 0, output: 'daemon left running; there was no credential to restore' }
      const second = await createSession('A8', 'after-restore')
      const bound2 = await until(second.sid, (candidate) => Boolean(candidate?.driverId), BIND_MS, 500)
      restored = { sid: second.sid, row: bound2.row ?? (await sessionRow(second.sid)) }
      await mutate('sessions.kill', { sessionId: second.sid }).catch(() => {})
      const serverAfterRestore = restored.row?.driverFamily === 'server' && /grok/i.test(restored.row?.driverId ?? '')
      const expectedServer = arm === 'headless'
      const verdict: Verdict = control.fired && loginPath ? 'PARTIAL' : control.fired ? 'FAIL' : 'BLOCKED'
      return {
        verdict,
        summary: verdict === 'PARTIAL'
          ? serverAfterRestore
            ? 'logged-out spawn exposed a login path; the authenticated Grok server driver returned after restoring the fixture credential (the login action itself was not automated)'
            : 'logged-out spawn exposed a login path, but no credential was available to restore the authenticated Grok server driver'
          : verdict === 'FAIL' ? 'logged-out spawn had output but no working login path' : 'logged-out spawn did not produce a controllable login path',
        control,
        evidence: [`AUTH OFF          ${off.output}`, `DAEMON RESTART     ${restarted.output}`, `LOGGED OUT         driver=${row?.driverId ?? '?'} family=${row?.driverFamily ?? '?'} screen=${loginPath}`, `LOGIN SCREEN       ${screen}`, `AUTH RESTORED      ${on.output}`, `DAEMON REARMED     ${rearmed.output}`, `NEXT SESSION       driver=${restored.row?.driverId ?? '?'} family=${restored.row?.driverFamily ?? '?'} server=${serverAfterRestore}`, `LIMIT              no operator OAuth/login was performed; restored fixture credential is not counted as completing login`],
        data: { loginPath, expectedServer, authChanged, loggedOutDriver: row?.driverId, loggedOutFamily: row?.driverFamily, restoredDriver: restored.row?.driverId, restoredFamily: restored.row?.driverFamily, serverAfterRestore },
        cwd,
        sessionIds: [first.sid, second.sid],
      }
    } finally {
      if (loggedOut) { await loggedOut.chat.close().catch(() => {}); await mutate('sessions.kill', { sessionId: loggedOut.sid }).catch(() => {}) }
      if (restored) await mutate('sessions.kill', { sessionId: restored.sid }).catch(() => {})
      rig('auth', 'on')
      authRestoreRequired = false
      if (authChanged) rig('restart-daemon', arm)
    }
  })
}

async function a9(): Promise<void> {
  await runCell('A9', () => withSession('A9', async (ctx) => {
    const before = await baseline(ctx, 'KILLBASE')
    const beforePids = ownedPids()
    const control: Control = {
      fired: before.user && beforePids.pids.length > 0,
      what: 'a durable baseline and an instance-owned agent process exist before sessions.kill',
      detail: `baseline=${before.answer} ownedPids=${beforePids.pids.join(',') || '(none)'}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'no instance-owned process was available for the process-table control', control, evidence: [`BASELINE          ${before.answer}`, `OWNED PIDS        ${beforePids.pids.join(',') || '(none)'}`, ...[...beforePids.cmds.entries()].map(([pid, cmd]) => `                    ${pid} ${cmd}`)] }
    const killed = await mutate('sessions.kill', { sessionId: ctx.sid })
    const observations: { atSec: number; pids: number[] }[] = []
    const started = now()
    let gone = false
    let rebound = false
    while (now() - started < 300_000) {
      const current = ownedPids()
      const survivors = current.pids.filter((pid) => beforePids.pids.includes(pid))
      const replacements = current.pids.filter((pid) => !beforePids.pids.includes(pid))
      observations.push({ atSec: Math.round((now() - started) / 1000), pids: [...survivors, ...replacements] })
      if (survivors.length === 0) gone = true
      if (gone && replacements.length > 0) rebound = true
      await wait(10_000)
    }
    const leftovers = ownedPids().pids
    for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL') } catch { /* exact child may have exited */ } }
    return {
      verdict: gone && !rebound && leftovers.length === 0 ? 'PASS' : 'FAIL',
      summary: gone && !rebound && leftovers.length === 0 ? 'sessions.kill removed the exact stamped process set with no rebound during the full five-minute watch' : 'an instance-owned process survived or rebounded during the full five-minute watch',
      control,
      evidence: [`KILL              ${short(dataOf(killed) ?? killed)}`, `BEFORE PIDS        ${beforePids.pids.join(',')}`, `WATCH             ${short(observations, 2_000)}`, `GONE              ${gone}`, `LEFTOVERS         ${leftovers.join(',') || '(none)'}`, 'The process table, not the session UI, is the scored source.'],
      data: { beforePids: beforePids.pids, gone, rebound, observations, leftovers },
    }
  }))
}

async function cliSync(): Promise<void> {
  if (arm !== 'terminal') return
  await runCell('CLI-sync', () => withSession('CLI-sync', async (ctx) => {
    ctx.chat.mode('native')
    const marker = nonce('CLIORIGIN')
    const prompt = `Reply with exactly ${marker} and nothing else. Do not use tools.`
    const started = now()
    ctx.chat.send({ type: 'input', sessionId: ctx.sid, data: Buffer.from(prompt + '\r').toString('base64'), inputOrigin: 'human' })
    const landed = await waitFor(() => ctx.chat.assistantText(), (text) => text.includes(marker), REPLY_MS, ctx.sid)
    const firstCount = ctx.chat.items.filter((item) => item.role === 'assistant' && (item.text ?? '').includes(marker)).length
    const control: Control = {
      fired: ctx.chat.screenTail(8_000).includes(marker) || ctx.chat.userText().includes(marker),
      what: 'the prompt typed through the headed PTY appeared on a product-owned surface',
      detail: `screen=${ctx.chat.screenTail(8_000).includes(marker)} transcriptUser=${ctx.chat.userText().includes(marker)}`,
    }
    await ctx.chat.close()
    const reloaded = new RichChat(ctx.sid)
    await reloaded.open()
    reloaded.mode('chat')
    await wait(3_000)
    ctx.chat = reloaded
    const replayCount = reloaded.items.filter((item) => item.role === 'assistant' && (item.text ?? '').includes(marker)).length
    return {
      verdict: control.fired && landed.ok && firstCount === 1 && replayCount === 1 ? 'PASS' : 'FAIL',
      summary: 'CLI-originated provider reply synchronized into Chat exactly once and remained single after transcript replay',
      control,
      evidence: [`PROMPT            ${prompt}`, `REPLY LATENCY     ${landed.ms}ms`, `FIRST COUNT       ${firstCount}`, `REPLAY COUNT      ${replayCount}`, `ASSISTANT         ${reloaded.assistantText().slice(-800)}`],
      data: { marker, startedAt: new Date(started).toISOString(), latencyMs: landed.ms, firstCount, replayCount },
    }
  }))
}

async function a11(): Promise<void> {
  await runCell('A11', () => withSession('A11', async (ctx) => {
    const base = await baseline(ctx, 'A11BASE')
    const control = controlForReply(base, ctx.chat)
    const before = await sessionRow(ctx.sid)
    const target = { model: 'grok-unsupported-proof-model', effort: 'high' }
    const first = await mutate('sessions.configure', { sessionId: ctx.sid, ...target })
    const afterFirst = await sessionRow(ctx.sid)
    await ctx.chat.close()
    const reloaded = new RichChat(ctx.sid)
    await reloaded.open(arm === 'terminal' ? 'native' : 'chat')
    ctx.chat = reloaded
    const afterReload = await sessionRow(ctx.sid)
    const second = await mutate('sessions.configure', { sessionId: ctx.sid, ...target })
    const afterSecond = await sessionRow(ctx.sid)
    const typed = (value: any) => value?.result?.data?.reason === 'unsupported' || /unsupported/.test(JSON.stringify(value).toLowerCase())
    const unchanged = (row: SessionRow | undefined) =>
      row?.model === before?.model && row?.effort === before?.effort &&
      row?.requestedModel === before?.requestedModel && row?.requestedEffort === before?.requestedEffort &&
      row?.observedModel === before?.observedModel && row?.observedEffort === before?.observedEffort
    return {
      verdict: control.fired && typed(first) && typed(second) && unchanged(afterFirst) && unchanged(afterReload) && unchanged(afterSecond) ? 'PASS' : 'FAIL',
      summary: 'two A11 configure attempts returned typed unsupported outcomes with no immediate or reloaded mutation',
      control,
      evidence: [`BEFORE            ${short(before, 1_000)}`, `FIRST             ${short(first, 1_000)}`, `AFTER FIRST       ${short(afterFirst, 1_000)}`, `AFTER RELOAD      ${short(afterReload, 1_000)}`, `SECOND            ${short(second, 1_000)}`, `AFTER SECOND      ${short(afterSecond, 1_000)}`],
      data: { target, firstTyped: typed(first), secondTyped: typed(second), firstUnchanged: unchanged(afterFirst), reloadUnchanged: unchanged(afterReload), secondUnchanged: unchanged(afterSecond) },
    }
  }))
}
async function a10(): Promise<void> {
  await runCell('A10', () => withSession('A10', async (ctx) => {
    const control: Control = {
      fired: Boolean(ctx.row.driverId) && Boolean(ctx.row.driverFamily),
      what: 'the fresh session binding receipt, which exists independently of model output',
      detail: `driver=${ctx.row.driverId ?? '?'} family=${ctx.row.driverFamily ?? '?'} session=${ctx.sid}`,
    }
    const serverFamily = ctx.row.driverFamily === 'server'
    const grokServer = /grok/i.test(ctx.row.driverId ?? '')
    const genericOverride = arm === 'terminal' && ctx.row.driverId === 'generic-pty'
    const terminalFamily = arm === 'terminal' && ctx.row.driverFamily === 'terminal'
    const expected = arm === 'headless' ? serverFamily && grokServer : genericOverride && terminalFamily
    const verdict: Verdict = !control.fired ? 'BLOCKED' : expected ? 'PASS' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? arm === 'headless' ? 'fresh logged-in Grok session bound the Grok server family' : 'generic-pty override demoted the logged-in Grok session to the terminal driver' : 'driver identity did not match this arm’s expected server/escape-hatch identity',
      control,
      evidence: [`SESSION           ${ctx.sid}`, `DRIVER            ${ctx.row.driverId}`, `FAMILY            ${ctx.row.driverFamily}`, `EXPECTATION       ${arm === 'headless' ? 'server family + grok driver' : 'generic-pty terminal demotion'}`, `MATCH             ${expected}`],
      data: { driverId: ctx.row.driverId, driverFamily: ctx.row.driverFamily, serverFamily, grokServer, genericOverride, terminalFamily, expected },
    }
  }))
}

/** A8's post-login half is a binding check, not a turn. Quota may prevent
 * output, but an authenticated fresh session must still select grok-acp. The
 * terminal arm is intentionally excluded: its explicit escape hatch is the
 * comparison covered by A10, not the server-driver half of A8. */
async function a8PostLogin(): Promise<void> {
  if (arm !== 'headless') return
  await runCell('A8-post-login', () => withSession('A8-post-login', async (ctx) => {
    const control: Control = {
      fired: Boolean(ctx.row.driverId) && Boolean(ctx.row.driverFamily),
      what: 'the fresh post-login session binding receipt',
      detail: `driver=${ctx.row.driverId ?? '?'} family=${ctx.row.driverFamily ?? '?'} session=${ctx.sid}`,
    }
    const server = ctx.row.driverFamily === 'server' && /grok/i.test(ctx.row.driverId ?? '')
    const verdict: Verdict = !control.fired ? 'BLOCKED' : server ? 'PASS' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'fresh post-login session bound grok-acp in the server family' : 'fresh post-login session did not bind the Grok server driver',
      control,
      evidence: [`SESSION           ${ctx.sid}`, `DRIVER            ${ctx.row.driverId}`, `FAMILY            ${ctx.row.driverFamily}`, `EXPECTATION       grok-acp / server`, `MATCH             ${server}`],
      data: { driverId: ctx.row.driverId, driverFamily: ctx.row.driverFamily, server },
    }
  }))
}

// ---------------------------------------------------------------------------
// Tier-B spot checks. They are reported separately from the Tier-A red count.
// ---------------------------------------------------------------------------

async function providerSpot(): Promise<void> {
  await runCell('B-provider-error', () => withSession('B-provider-error', async (ctx) => {
    const control: Control = {
      fired: Boolean(ctx.row.driverId) && Boolean(ctx.row.driverFamily),
      what: 'the fresh authenticated session binding receipt before the exhausted-quota turn',
      detail: `driver=${ctx.row.driverId ?? '?'} family=${ctx.row.driverFamily ?? '?'} session=${ctx.sid}`,
    }
    if (!control.fired) return { verdict: 'BLOCKED', summary: 'no session binding control fired, so the quota fault was not measurable', control, evidence: [`BINDING           ${control.detail}`] }

    // Keep the probe token neutral. A token containing "QUOTA" would make a
    // terminal screenshot pass the vocabulary assertion even if the provider
    // had not shown its own quota state.
    const token = nonce('PROBE')
    const send = await mutate('sessions.sendText', { sessionId: ctx.sid, text: `Reply with exactly this word and nothing else: ${token}.` })
    const started = now()
    let row: SessionRow | undefined
    let faultVisible = false
    while (now() - started < 45_000) {
      row = await sessionRow(ctx.sid)
      const visible = JSON.stringify({ row, assistant: ctx.chat.assistantText(), screen: ctx.chat.screenTail(4_000) })
      faultVisible = Boolean(row?.agentState?.error) || phase(row) === 'errored' || row?.status === 'exited' || /quota|rate|limit|usage|capacity|exhausted|credits/i.test(visible)
      if (faultVisible) break
      await wait(500)
    }
    row ??= await sessionRow(ctx.sid)
    const visible = JSON.stringify({ row, assistant: ctx.chat.assistantText(), screen: ctx.chat.screenTail(4_000) })
    const namesQuota = /quota|rate|limit|usage|capacity|exhausted|credits/i.test(visible)
    const elapsed = now() - started
    const verdict: Verdict = faultVisible && namesQuota ? 'PASS' : faultVisible ? 'PARTIAL' : 'FAIL'
    return {
      verdict,
      summary: verdict === 'PASS' ? 'exhausted-quota provider fault surfaced with explicit quota/rate/limit wording' : verdict === 'PARTIAL' ? 'provider fault surfaced without an explicit quota reason' : 'authenticated quota probe produced no provider fault before timeout',
      control,
      evidence: [`SEND              ${short(dataOf(send) ?? send, 800)}`, `FAULT VISIBLE     ${faultVisible} after ${elapsed}ms`, `ROW               ${short(row, 1_000)}`, `ASSISTANT         ${ctx.chat.assistantText().slice(-600)}`, `SCREEN            ${ctx.chat.screenTail(1_000)}`, `QUOTA WORDING     ${namesQuota}`],
      data: { faultVisible, namesQuota, elapsed, driverId: ctx.row.driverId, driverFamily: ctx.row.driverFamily },
    }
  }))
}

async function oomSpot(): Promise<void> {
  await runCell('B-oom-kill', () => withSession('B-oom-kill', async (ctx) => {
    const before = await baseline(ctx, 'OOMBASE')
    const control = controlForReply(before, ctx.chat)
    return {
      verdict: 'BLOCKED',
      summary: 'no safe release-level OOM injector was used; a raw SIGKILL would not prove OOM classification',
      control,
      evidence: [`BASELINE          ${before.answer} (${before.token})`, 'FAULT             not fired: this drive did not manufacture host memory pressure', 'REASON             a raw SIGKILL is an unclean death, not an OOM-killed session, so it would not satisfy this spot-check'],
      data: { faultFired: false },
    }
  }))
}

if (process.env.P3110_STATIC_SELF_TEST === '1') {
  const fake = (id: string, verdict: Verdict = 'PASS', fired = true): Cell => ({ id, arm, verdict, summary: 'self-test', control: { fired, what: 'self-test', detail: 'fired' }, evidence: [], data: {}, cwd: '/tmp/self-test', memoryMb: 1, pin: 'pin', sessionIds: [], at: '2026-08-30T00:00:00.000Z' })
  const cases: [string, string][] = [['A1a','A1a'],['A1b','A1b'],['A1c','A1c'],['A2a','A2a'],['A2b','A2b'],['A3','A3'],['A4a','A4a'],['A4b','A4b'],['A5','A5'],['A6a','A6a'],['A6b','A6b'],['A7a','A7a'],['A7b','A7b'],['A8','A8'],['A9','A9'],['A10','A10'],['A11','A11'],['CLI-sync','A6b'],['A8-post-login','Bauth'],['B-provider-error','Bquota'],['B-oom-kill','non-matrix']]
  for (const [id, expected] of cases) {
    const got = evidenceFields(fake(id))[0].split(' ')[1]
    if (got !== expected) throw new Error(`canonical self-test failed ${id}: ${got}`)
  }
  let unknownRejected = false
  try { evidenceFields(fake('UNKNOWN')) } catch { unknownRejected = true }
  if (!unknownRejected) throw new Error('unknown id was not rejected')
  const blockedFired = evidenceFields(fake('A3', 'BLOCKED', true))[4]
  const blockedMissing = evidenceFields(fake('A3', 'BLOCKED', false))[4]
  if (!blockedFired.startsWith('yes —') || !blockedMissing.startsWith('no —')) throw new Error('BLOCKED control fidelity failed')
  const owned = [LEDGER, JSON_PATH, ROWS, join(EVIDENCE_DIR, 'reading'), join(EVIDENCE_DIR, 'pin')]
  const exact = owned.map((path) => path.slice(REPO.length + 1))
  assertExactStagedSet(owned, exact)
  let foreignRejected = false
  try { assertExactStagedSet(owned, [...exact, 'foreign.file']) } catch { foreignRejected = true }
  if (!foreignRejected) throw new Error('foreign staged file was not rejected')
  let rows = 0
  let later = 0
  try {
    recordAndStop({ verdict: 'FAIL', summary: 'expected', control: { fired: true, what: 'x', detail: 'x' }, evidence: [] }, () => { rows++ })
    later++
  } catch (error) {
    if (!String(error).includes('STOP-FIRST')) throw error
  }
  if (rows !== 1 || later !== 0) throw new Error(`stop-first self-test failed rows=${rows} later=${later}`)
  console.log(`STATIC_SELF_TEST_OK canonical=${cases.length} unknownRejected=${unknownRejected} blockedFired=yes blockedMissing=no stagedExact=5 foreignRejected=${foreignRejected} failRows=${rows} laterCells=${later}`)
  process.exit(0)
}

requireCleanTree()
await login()
console.log(`Grok acceptance drive: arm=${arm} instance=${INSTANCE} base=${BASE}`)
console.log('Rows: A1a A1b A1c A2a A2b A3 A4a A4b A5 A6a A6b A7a A7b A8 A9 CLI-sync A11 A10')

await a1a()
await a1b()
await a1c()
await a2a()
await a2b()
await a3()
await a4a()
await a4b()
await a5()
await a6a()
await a6b()
await a7a()
await a7b()
await a8()
await a8PostLogin()
await a9()
await cliSync()
await a11()
await a10()
await providerSpot()
await oomSpot()

console.log(`Completed ${results.length} Grok ${arm} readings; JSON at ${JSON_PATH}; rows at ${ROWS}`)
