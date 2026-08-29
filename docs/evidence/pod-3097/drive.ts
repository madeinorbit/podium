import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { Chat, login, mutate, query, sessionRow, wait } from '/home/mgw/src/podium/.worktrees/issue-3097-current-tip-configure-proof/docs/evidence/pod-2777/rig.ts'

type Cell = 'codex' | 'opencode' | 'claude' | 'grok' | 'terminal'
type Row = Awaited<ReturnType<typeof sessionRow>>

const cell = (process.argv[2] ?? '') as Cell
const SUPPORTED = new Set<Cell>(['codex', 'opencode', 'claude'])
if (![...SUPPORTED, 'grok', 'terminal'].includes(cell)) throw new Error('cell must be codex|opencode|claude|grok|terminal')

const ROOT = process.env.P3097_REPO!
const BASE = process.env.P3097_BASE!
const STATE = process.env.P3097_STATE_ROOT!
const AGENT_HOME = process.env.P3097_AGENT_HOME!
const PIN = process.env.P3097_SHA!
const INSTANCE = process.env.P3097_INSTANCE!
const PORT = process.env.P3097_PORT!
const HOOK_PORT = process.env.P3097_HOOK_PORT!
const RELAY_PORT = process.env.P3097_RELAY_PORT!
const RIG = join(ROOT, 'docs/evidence/pod-3097/rig.sh')
const OUT_DIR = join(BASE, 'readings')
const PROBE_REPO = join(BASE, 'repo')
const ts = () => new Date().toISOString()
const events: { at: string; event: string; detail?: unknown }[] = []
const mark = (event: string, detail?: unknown) => {
  const row = { at: ts(), event, ...(detail === undefined ? {} : { detail }) }
  events.push(row)
  console.log(`${row.at} ${event}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
}

function out(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return (result.stdout ?? '').trim()
}

function pidFact(name: 'server' | 'daemon') {
  const pid = readFileSync(join(BASE, `${name}.pid`), 'utf8').trim()
  process.kill(Number(pid), 0)
  const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  return {
    pid,
    sha: readFileSync(join(BASE, `${name}.sha`), 'utf8').trim(),
    cwd: out('readlink', [`/proc/${pid}/cwd`]),
    instance: env.find((x) => x.startsWith('PODIUM_INSTANCE='))?.slice('PODIUM_INSTANCE='.length),
    stateRoot: env.find((x) => x.startsWith('PODIUM_STATE_DIR='))?.slice('PODIUM_STATE_DIR='.length),
    agentHome: env.find((x) => x.startsWith('PODIUM_AGENT_HOME='))?.slice('PODIUM_AGENT_HOME='.length),
    port: env.find((x) => x.startsWith('PODIUM_PORT='))?.slice('PODIUM_PORT='.length),
    hookPort: env.find((x) => x.startsWith('PODIUM_HOOK_PORT='))?.slice('PODIUM_HOOK_PORT='.length),
    relayPort: env.find((x) => x.startsWith('PODIUM_AGENT_RELAY_PORT='))?.slice('PODIUM_AGENT_RELAY_PORT='.length),
  }
}

async function pins() {
  const web = await (await fetch(`http://127.0.0.1:${PORT}/podium-build.json`)).json() as Record<string, unknown>
  const server = pidFact('server')
  const daemon = pidFact('daemon')
  const fact = {
    at: ts(),
    head: out('git', ['-C', ROOT, 'rev-parse', 'HEAD']),
    integrationTip: out('git', ['-C', ROOT, 'rev-parse', 'refs/heads/issue/1761-agent-runtime']),
    mergeBase: out('git', ['-C', ROOT, 'merge-base', 'HEAD', 'refs/heads/issue/1761-agent-runtime']),
    nonEvidenceChanges: out('git', ['-C', ROOT, 'diff', '--name-only', `${PIN}..HEAD`]).split('\n').filter((path) => path && !path.startsWith('docs/')),
    trees: {
      server: out('git', ['-C', ROOT, 'rev-parse', 'HEAD:apps/server']),
      daemon: out('git', ['-C', ROOT, 'rev-parse', 'HEAD:apps/daemon']),
      web: out('git', ['-C', ROOT, 'rev-parse', 'HEAD:apps/web']),
    },
    servedWeb: web,
    server,
    daemon,
    instance: INSTANCE,
    stateRoot: STATE,
    agentHome: AGENT_HOME,
    ports: { server: PORT, hook: HOOK_PORT, relay: RELAY_PORT, operatorForbidden: '19797' },
    generation: readFileSync(join(BASE, 'generation'), 'utf8').trim(),
    capacity: {
      load1m: loadavg()[0],
      memAvailable: readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(.+)$/m)?.[1],
      rootFreeKiB: Number(out('df', ['-kP', '/']).split('\n')[1]?.trim().split(/\s+/)[3]),
    },
    harnesses: {
      codex: out('codex', ['--version']),
      opencode: out('/home/mgw/.opencode/bin/opencode', ['--version']),
      claude: out('claude', ['--version']),
      grok: out('grok', ['--version']),
    },
  }
  const processFacts = [server, daemon]
  const exact = fact.integrationTip === PIN && fact.mergeBase === PIN && fact.nonEvidenceChanges.length === 0 &&
    fact.trees.server === out('git', ['-C', ROOT, 'rev-parse', `${PIN}:apps/server`]) &&
    fact.trees.daemon === out('git', ['-C', ROOT, 'rev-parse', `${PIN}:apps/daemon`]) &&
    fact.trees.web === out('git', ['-C', ROOT, 'rev-parse', `${PIN}:apps/web`])
  const webExact = String(web.sourceSha) === PIN.slice(0, 7)
  const processesExact = processFacts.every((p) => p.sha === PIN && p.cwd === ROOT && p.instance === INSTANCE && p.stateRoot === STATE && p.agentHome === AGENT_HOME && p.port === PORT && p.hookPort === HOOK_PORT && p.relayPort === RELAY_PORT)
  if (!exact || !webExact || !processesExact || [PORT, HOOK_PORT, RELAY_PORT].includes('19797')) {
    throw new Error(`pin refusal ${JSON.stringify({ exact, webExact, processesExact, fact })}`)
  }
  return fact
}

async function untilRow(sid: string, pred: (row: Row) => boolean, ms = 120_000): Promise<Row> {
  const deadline = Date.now() + ms
  let row: Row
  while (Date.now() < deadline) {
    row = await sessionRow(sid)
    if (pred(row)) return row
    await wait(500)
  }
  throw new Error(`row timeout for ${sid}: ${JSON.stringify(row)}`)
}

async function sendProviderTurn(chat: Chat, sid: string, marker: string) {
  const startedAt = ts()
  const sent = await mutate('sessions.sendText', {
    sessionId: sid,
    text: `Reply with exactly ${marker} and nothing else. Do not use tools.`,
  })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline && !chat.assistantText().includes(marker)) await wait(500)
  const finishedAt = ts()
  const row = await sessionRow(sid)
  return {
    marker,
    startedAt,
    finishedAt,
    sent: sent.result?.data ?? sent,
    userObserved: chat.userText().includes(marker),
    assistantObserved: chat.assistantText().includes(marker),
    row,
  }
}

function marker(tag: string): string {
  return `P3097-${tag}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`
}

function snapshot(row: Row) {
  if (!row) return null
  return {
    sessionId: row.sessionId,
    status: row.status,
    phase: row.agentState?.phase,
    driverId: row.driverId,
    driverFamily: row.driverFamily,
    configureFields: row.configureFields,
    model: row.model,
    effort: row.effort,
    requestedModel: row.requestedModel,
    requestedEffort: row.requestedEffort,
    observedModel: row.observedModel,
    observedEffort: row.observedEffort,
    resume: row.resume,
    conversationId: row.conversationId,
  }
}

function chooseTarget(cell: Cell, baseline: NonNullable<Row>, catalog: any): { model: string; effort: string } {
  const agent = cell === 'claude' ? 'claude-code' : cell
  const models = catalog.byAgent?.[agent] ?? []
  const preferences: Record<string, string[]> = {
    codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    opencode: ['opencode-go/kimi-k3', 'opencode-go/glm-5.3', 'opencode-go/gpt-5.6-luna'],
    claude: ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5'],
  }
  const picked = [...(preferences[cell] ?? []), ...models.map((x: any) => x.value)]
    .map((value) => models.find((x: any) => x.value === value))
    .find((x) => x && x.value !== baseline.observedModel)
  if (!picked) throw new Error(`no alternate live model for ${cell}; baseline=${baseline.observedModel}`)
  const ladder = picked.efforts?.length ? picked.efforts : ['minimal', 'low', 'medium', 'high', 'max']
  const effort = [...ladder].reverse().find((value) => value !== baseline.observedEffort)
  if (!effort) throw new Error(`no alternate live effort for ${cell}; baseline=${baseline.observedEffort}`)
  return { model: picked.value, effort }
}

function sameRequested(a: Row, b: Row): boolean {
  return a?.requestedModel === b?.requestedModel && a?.requestedEffort === b?.requestedEffort
}

function restartRig() {
  mark('isolated-restart-start')
  const result = spawnSync('bash', [RIG, 'restart'], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 180_000 })
  if (result.status !== 0) throw new Error(`isolated restart failed: ${result.stderr || result.stdout}`)
  mark('isolated-restart-complete', { stdout: result.stdout.trim() })
}

await login()
mark('cell-start', { cell })
const initialPins = await pins()
mark('initial-pins-proved', initialPins)
const catalogReply = await mutate('models.refresh', {})
const catalog = catalogReply.result?.data
if (!catalog?.byAgent) throw new Error(`model catalog unavailable: ${JSON.stringify(catalogReply)}`)
mark('live-catalog-read', { fetchedAt: catalog.fetchedAt, counts: Object.fromEntries(Object.entries(catalog.byAgent).map(([k, v]) => [k, (v as unknown[]).length])) })

const agentKind = cell === 'claude' ? 'claude-code' : cell === 'terminal' ? 'shell' : cell
const expectedDriver: Record<Cell, string> = {
  codex: 'codex-app-server',
  opencode: 'opencode-server',
  claude: 'claude-sdk',
  grok: 'grok-acp',
  terminal: 'generic-pty',
}
const created = await mutate('sessions.create', { cwd: PROBE_REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) throw new Error(`create failed: ${JSON.stringify(created)}`)
mark('session-created', { sid, agentKind })
const bound = await untilRow(sid, (row) => row?.driverId === expectedDriver[cell])
mark('driver-bound', snapshot(bound))

let chat = new Chat(sid)
await chat.open(cell === 'terminal' ? 'native' : 'chat')
let control: any
if (cell === 'terminal') {
  const controlMarker = marker('TERMINAL-CONTROL')
  const startedAt = ts()
  chat.send({ type: 'input', sessionId: sid, data: Buffer.from(`printf '%s\\n' '${controlMarker}'\r`).toString('base64'), inputOrigin: 'human' })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !chat.screen.includes(controlMarker)) await wait(250)
  control = { marker: controlMarker, startedAt, finishedAt: ts(), fired: chat.screen.includes(controlMarker), screenTail: chat.screenTail(600) }
} else {
  const turn = await sendProviderTurn(chat, sid, marker(`${cell.toUpperCase()}-CONTROL`))
  let observed = turn.row
  if (turn.assistantObserved) {
    try { observed = await untilRow(sid, (row) => Boolean(row?.observedModel), 30_000) } catch { /* recorded below */ }
  }
  control = { ...turn, row: snapshot(observed), fired: turn.userObserved && turn.assistantObserved }
}
mark('independent-positive-control', control)

const before = await sessionRow(sid)
let target: { model: string; effort: string }
if (SUPPORTED.has(cell)) target = chooseTarget(cell, before!, catalog)
else target = cell === 'grok' ? { model: 'grok-4.5', effort: 'high' } : { model: 'terminal-control-model', effort: 'high' }
mark('configure-request', target)
const configuredAt = ts()
const configureReply = await mutate('sessions.configure', { sessionId: sid, ...target })
const configureOutcome = configureReply.result?.data ?? configureReply
const immediate = await sessionRow(sid)
mark('configure-reply', { configureOutcome, immediate: snapshot(immediate) })

let nextTurn: any = null
let afterTurn: Row = immediate
let reloaded: Row
let restarted: Row
let persistenceTurn: any = null
let finalRow: Row

if (SUPPORTED.has(cell)) {
  nextTurn = await sendProviderTurn(chat, sid, marker(`${cell.toUpperCase()}-CONFIGURED`))
  try {
    afterTurn = await untilRow(sid, (row) => row?.observedModel === target.model && row?.observedEffort === target.effort, 45_000)
  } catch {
    afterTurn = await sessionRow(sid)
  }
  mark('next-provider-turn-observed', { turn: nextTurn, row: snapshot(afterTurn) })
  await login()
  reloaded = await sessionRow(sid)
  mark('fresh-client-reload', snapshot(reloaded))
  await chat.close()
  restartRig()
  await login()
  restarted = await untilRow(sid, (row) => row?.driverId === expectedDriver[cell] && row?.status === 'live', 120_000)
  mark('post-server-daemon-restart', snapshot(restarted))
  chat = new Chat(sid)
  await chat.open('chat')
  persistenceTurn = await sendProviderTurn(chat, sid, marker(`${cell.toUpperCase()}-PERSISTED`))
  try {
    finalRow = await untilRow(sid, (row) => row?.observedModel === target.model && row?.observedEffort === target.effort, 45_000)
  } catch {
    finalRow = await sessionRow(sid)
  }
  mark('post-restart-provider-turn-observed', { turn: persistenceTurn, row: snapshot(finalRow) })
} else {
  await login()
  reloaded = await sessionRow(sid)
  mark('fresh-client-reload', snapshot(reloaded))
  await chat.close()
  restartRig()
  await login()
  restarted = await untilRow(sid, (row) => row?.driverId === expectedDriver[cell] && row?.status === 'live', 120_000)
  mark('post-server-daemon-restart', snapshot(restarted))
  finalRow = restarted
}

const finalPins = await pins()
mark('final-pins-proved', finalPins)
const supportedPass =
  SUPPORTED.has(cell) &&
  control.fired === true &&
  Array.isArray(before?.configureFields) &&
  before!.configureFields!.includes('model') &&
  before!.configureFields!.includes('effort') &&
  configureOutcome?.ok === true &&
  configureOutcome?.effective === 'next-turn' &&
  immediate?.requestedModel === target.model &&
  immediate?.requestedEffort === target.effort &&
  immediate?.observedModel === before?.observedModel &&
  immediate?.observedEffort === before?.observedEffort &&
  nextTurn?.assistantObserved === true &&
  afterTurn?.observedModel === target.model &&
  afterTurn?.observedEffort === target.effort &&
  reloaded?.requestedModel === target.model &&
  reloaded?.requestedEffort === target.effort &&
  restarted?.requestedModel === target.model &&
  restarted?.requestedEffort === target.effort &&
  persistenceTurn?.assistantObserved === true &&
  finalRow?.observedModel === target.model &&
  finalRow?.observedEffort === target.effort

const unsupportedPass =
  !SUPPORTED.has(cell) &&
  control.fired === true &&
  configureOutcome?.reason === 'unsupported' &&
  sameRequested(before, immediate) &&
  sameRequested(before, reloaded) &&
  sameRequested(before, restarted) &&
  sameRequested(before, finalRow)

const result = {
  schema: 'pod-3097-a11-v1',
  issue: 'POD-3097',
  cell,
  verdict: supportedPass || unsupportedPass ? 'PASS' : control.fired ? 'FAIL' : 'REFUSED',
  startedAt: events[0]?.at,
  finishedAt: ts(),
  control,
  expectedDriver: expectedDriver[cell],
  before: snapshot(before),
  target,
  configuredAt,
  configureOutcome,
  immediate: snapshot(immediate),
  nextTurn,
  afterTurn: snapshot(afterTurn),
  reloaded: snapshot(reloaded),
  restarted: snapshot(restarted),
  persistenceTurn,
  final: snapshot(finalRow),
  initialPins,
  finalPins,
  events,
}

mkdirSync(OUT_DIR, { recursive: true })
const outputPath = join(OUT_DIR, `${cell}.json`)
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n')
console.log(`READING ${outputPath}`)
console.log(`VERDICT ${result.verdict}`)
await chat.close().catch(() => {})
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
if (result.verdict !== 'PASS') process.exitCode = 1
