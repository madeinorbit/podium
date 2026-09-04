import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Chat, login, mutate, primeTerminalTui, query, wait } from '../pod-2777/rig'

const BASE = '/tmp/pod-3112-oc-interrupt-probe-r6'
const CWD = join(BASE, 'probe-repo')
const OUT = join(process.cwd(), 'docs/evidence/pod-3112/diagnostics')
const EPIC_PIN = 'edc89c8a2685b0a12ee2bf67830aba379a8c98f2'
const instance = 'p3112-oc-interrupt-probe-r6'
const monotonic = () => performance.now()
const wall = () => new Date().toISOString()

function status(sid: string) {
  return query('sessions.status', { ref: sid }).then((r) => r.result?.data ?? null)
}

async function listRow(sid: string) {
  const r = await query('sessions.list', {})
  return (r.result?.data ?? []).find((x: { sessionId?: string }) => x.sessionId === sid) ?? null
}

async function transcript(sid: string) {
  const r = await query('sessions.read', { sessionId: sid, turns: 500 })
  return r.result?.data?.items ?? []
}

function exactSessionProcesses(cwd: string) {
  const rows: Array<{ pid: number; ppid: number; cwd: string; cmdline: string; cgroup: string }> = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (readlinkSync(join('/proc', name, 'cwd')) !== cwd) continue
      const stat = readFileSync(join('/proc', name, 'stat'), 'utf8')
      const ppid = Number(stat.split(') ')[1]?.split(' ')[1] ?? 0)
      rows.push({
        pid: Number(name),
        ppid,
        cwd,
        cmdline: readFileSync(join('/proc', name, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim(),
        cgroup: readFileSync(join('/proc', name, 'cgroup'), 'utf8').trim(),
      })
    } catch {
      // Process exited while being inspected.
    }
  }
  return rows.sort((a, b) => a.pid - b.pid)
}

function listenersFor(pids: number[]) {
  const text = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' })
  return text.split('\n').filter((line) => pids.some((pid) => line.includes(`pid=${pid},`)))
}

mkdirSync(CWD, { recursive: true })
if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: CWD }).status !== 0) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: CWD })
  writeFileSync(join(CWD, 'README.md'), 'POD-3112 r6 interrupt diagnostic\n')
  spawnSync('git', ['add', 'README.md'], { cwd: CWD })
  spawnSync('git', ['-c', 'user.email=drive@localhost', '-c', 'user.name=drive', 'commit', '-qm', 'probe seed'], { cwd: CWD })
}

await login()
const created = await mutate('sessions.create', { cwd: CWD, agentKind: 'opencode', runtimeContract: 'generic-pty' })
const sid = created.result?.data?.sessionId
if (!sid) throw new Error('session create failed: ' + JSON.stringify(created))
const chat = new Chat(sid)
let providerTurns = 0
try {
  await chat.open('native')
  await primeTerminalTui(chat, sid)
  let identity = null
  for (let i = 0; i < 120; i++) {
    identity = await listRow(sid)
    if (identity?.driverId && identity?.driverFamily) break
    await wait(250)
  }
  const identityProof = {
    driverId: identity?.driverId ?? null,
    requestedDriverId: identity?.requestedDriverId ?? null,
    driverFamily: identity?.driverFamily ?? null,
  }
  if (identityProof.driverId !== 'generic-pty' || identityProof.requestedDriverId !== 'generic-pty' || identityProof.driverFamily !== 'terminal') {
    throw new Error('REFUSED identity mismatch: ' + JSON.stringify(identityProof))
  }

  const nonce = `P3112-R6-NATURAL-FINAL-${Date.now().toString(36).toUpperCase()}`
  const prompt = `Count slowly from 1 through 2000, printing every integer on its own line. Do not use tools. Only after 2000 print ${nonce}.`
  const acceptedAtMono = monotonic()
  const acceptedAtWall = wall()
  const sent = await mutate('sessions.sendText', { sessionId: sid, text: prompt })
  if (!sent.result?.data?.ok) throw new Error('send not accepted: ' + JSON.stringify(sent))
  providerTurns = 1

  const growthControl: Array<Record<string, unknown>> = []
  let working = false
  let growing = false
  let previousBytes = chat.screenBytes
  for (let i = 0; i < 240; i++) {
    const row = await status(sid)
    const sample = { msFromAcceptance: monotonic() - acceptedAtMono, at: wall(), phase: row?.phase ?? null, status: row?.status ?? null, screenBytes: chat.screenBytes, delta: chat.screenBytes - previousBytes }
    growthControl.push(sample)
    working ||= row?.phase === 'working'
    growing ||= chat.screenBytes > previousBytes
    previousBytes = chat.screenBytes
    if (working && growing && growthControl.length >= 2) break
    await wait(250)
  }
  if (!working || !growing) throw new Error(`positive control missing: working=${working} growing=${growing}`)

  const processes = exactSessionProcesses(CWD)
  const listeners = listenersFor(processes.map((x) => x.pid))
  // No native session id is derivable from the PTY process trace. A listener
  // alone is insufficient, so the documented PTY-only double-Escape path wins.
  const addressableEndpoint = null
  const nativeSessionId = null

  const beforeItems = await transcript(sid)
  const requestAtMono = monotonic()
  const requestAtWall = wall()
  const requestBaseline = { screenBytes: chat.screenBytes, transcriptCount: beforeItems.length, transcriptTextLength: beforeItems.reduce((n: number, x: { text?: string }) => n + String(x.text ?? '').length, 0) }
  chat.send({ type: 'input', sessionId: sid, data: Buffer.from('\x1b\x1b').toString('base64'), inputOrigin: 'human' })

  const quiescence: Array<Record<string, unknown>> = []
  let priorBytes = chat.screenBytes
  let priorCount = beforeItems.length
  let priorTextLength = requestBaseline.transcriptTextLength
  let residualGrowthSamples = 0
  let consecutiveZeroNonWorking = 0
  let quiescentAtMono: number | null = null
  for (let i = 0; i < 120; i++) {
    await wait(250)
    const [phaseRow, items] = await Promise.all([status(sid), transcript(sid)])
    const textLength = items.reduce((n: number, x: { text?: string }) => n + String(x.text ?? '').length, 0)
    const screenDelta = chat.screenBytes - priorBytes
    const countDelta = items.length - priorCount
    const textDelta = textLength - priorTextLength
    const grew = screenDelta > 0 || countDelta > 0 || textDelta > 0
    if (grew) residualGrowthSamples++
    const nonWorking = phaseRow?.phase !== 'working'
    consecutiveZeroNonWorking = !grew && nonWorking ? consecutiveZeroNonWorking + 1 : 0
    quiescence.push({ msFromRequest: monotonic() - requestAtMono, at: wall(), phase: phaseRow?.phase ?? null, status: phaseRow?.status ?? null, screenBytes: chat.screenBytes, screenDelta, transcriptCount: items.length, countDelta, transcriptTextLength: textLength, textDelta, grew, consecutiveZeroNonWorking })
    priorBytes = chat.screenBytes
    priorCount = items.length
    priorTextLength = textLength
    if (consecutiveZeroNonWorking >= 4) {
      quiescentAtMono = monotonic()
      break
    }
  }

  const finalStatus = await status(sid)
  const finalIdentity = await listRow(sid)
  const finalItems = await transcript(sid)
  const durableMarkers = finalItems.filter((x: { event?: string; text?: string }) => x.event === 'interrupt' || /interrupt/i.test(String(x.text ?? '')))
  const naturalFinalNonceSeen = finalItems.some((x: { text?: string }) => String(x.text ?? '').includes(nonce))
  const diagnostic = {
    at: wall(),
    issue: 'POD-3112',
    kind: 'interrupt-diagnostic-not-acceptance',
    acceptanceLedgerRowsWritten: 0,
    epicPin: EPIC_PIN,
    instance,
    ports: [20316, 47320, 47321],
    serverPid: 2863293,
    daemonPid: 2863414,
    providerTurns,
    sessionId: sid,
    requestedRuntimeContract: 'generic-pty',
    identityFrom: 'sessions.list',
    identity: identityProof,
    phaseFrom: 'sessions.status',
    send: { acceptedAtWall, acceptedAtMono, result: sent.result?.data ?? null, nonce },
    positiveControl: { working, growing, samples: growthControl },
    processTrace: { processes, listeners, addressableEndpoint, nativeSessionId, inspectedEnvironment: false },
    interrupt: { mechanism: 'one documented double-Escape sequence', bytesSent: 2, repetitions: 1, ctrlC: false, requestAtWall, requestAtMono, requestBaseline },
    quiescence: { samples: quiescence, residualGrowthSamples, consecutiveZeroNonWorking, requestToFourSampleQuiescenceMs: quiescentAtMono === null ? null : quiescentAtMono - requestAtMono },
    final: { phase: finalStatus?.phase ?? null, status: finalStatus?.status ?? null, cliSurvived: finalIdentity?.status === 'live', naturalFinalNonceSeen, durableMarkers },
  }
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `r6-interrupt-${new Date().toISOString().replaceAll(/[-:.]/g, '')}.json`)
  writeFileSync(path, JSON.stringify(diagnostic, null, 2) + '\n')
  console.log(JSON.stringify({ path, identity: identityProof, providerTurns, working, growing, processes: processes.length, listeners: listeners.length, requestToFourSampleQuiescenceMs: diagnostic.quiescence.requestToFourSampleQuiescenceMs, residualGrowthSamples, consecutiveZeroNonWorking, final: diagnostic.final }, null, 2))
} finally {
  await chat.close().catch(() => {})
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}
