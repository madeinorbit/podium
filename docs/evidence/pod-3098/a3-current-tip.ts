/** POD-3098: one narrow real-provider A3 cell, including reload and restart. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadavg } from 'node:os'
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  now,
  primeTerminalTui,
  query,
  sessionRow,
  until,
  wait,
} from '../pod-2777/rig'

type Harness = 'codex' | 'opencode' | 'claude' | 'grok'
type Arm = 'headless' | 'terminal'
type Sample = {
  ms: number
  phase: string
  previews: number
  assistantChars: number
  terminalBytes: number
  deltaFrames: number
}

const harness = process.argv[2] as Harness
const arm = process.argv[3] as Arm
if (!['codex', 'opencode', 'claude', 'grok'].includes(harness)) throw new Error(`unknown harness ${harness}`)
if (arm !== 'headless' && arm !== 'terminal') throw new Error(`unknown arm ${arm}`)

const ROOT = process.cwd()
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3098-a3-b605f2a'
const BASE_PIN = '60dd85b2e721a30d4f7a74717b00ce0f8d39d9eb'
const PIN = 'b605f2a6becbadc0b801c103194f7526258b96bb'
const INSTANCE = 'p3098-a3-current-tip'
const STATE_ROOT = join(BASE, 'state')
const AGENT_HOME = join(BASE, 'agent-home')
const RUNTIME = join(ROOT, 'docs/evidence/pod-3098/runtime.sh')
const OUT = join(ROOT, `docs/evidence/pod-3098/readings/a3-${harness}-${arm}.json`)
const expectedDriver: Record<Harness, Record<Arm, string>> = {
  codex: { headless: 'codex-app-server', terminal: 'generic-pty' },
  opencode: { headless: 'opencode-server', terminal: 'generic-pty' },
  claude: { headless: 'claude-sdk', terminal: 'claude-pty' },
  grok: { headless: 'grok-acp', terminal: 'generic-pty' },
}
const runtimeArm = arm === 'headless' ? 'headless' : harness === 'claude' ? 'claude-terminal' : 'terminal'
const STOP_CEILING_MS = 5_000
const POST_WINDOW_MS = 12_000
const CONTROL_MS = 90_000
const stamp = () => new Date().toISOString()
const textOf = (value: unknown) => typeof value === 'string' ? value : String(value ?? '')

function command(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return (result.stdout ?? '').trim()
}

function version(commandName: string): string {
  const result = spawnSync(commandName, ['--version'], { encoding: 'utf8', env: process.env })
  return `${commandName}: ${(result.stdout || result.stderr || '').trim().split('\n')[0] || `exit ${result.status}`}`
}

function sample(chat: Chat, started: number, sid: string): Promise<Sample> {
  return sessionRow(sid).then((row) => ({
    ms: now() - started,
    phase: row?.agentState?.phase ?? 'unknown',
    previews: chat.previews.length,
    assistantChars: chat.assistantText().length,
    terminalBytes: chat.screenBytes,
    deltaFrames: chat.deltaFrames,
  }))
}

function outputValue(s: Sample): number {
  return arm === 'headless' ? s.previews * 1_000_000 + s.assistantChars : s.terminalBytes
}

function markerItems(chat: Chat) {
  return chat.items
    .filter((item) => item.event === 'interrupt')
    .map((item) => ({ id: item.id, role: item.role, event: item.event, text: item.text }))
}

async function waitForMarker(chat: Chat, timeoutMs: number) {
  const deadline = now() + timeoutMs
  while (now() < deadline && markerItems(chat).length === 0) await wait(250)
  return markerItems(chat)
}

async function main() {
  const loadAtAdmission = loadavg()[0]
  if (loadAtAdmission >= 12) throw new Error(`A3 REFUSED: one-minute load ${loadAtAdmission.toFixed(2)} is not below 12`)
  if (!existsSync('/home/mgw/.local/bin/podium') || !process.env.PODIUM_SESSION_RELAY) {
    throw new Error('A3 WAIT: installed Podium relay unavailable; source CLI substitution is forbidden')
  }
  const evidenceHead = command('git', ['rev-parse', 'HEAD'])
  const base = command('git', ['rev-parse', 'refs/heads/issue/1761-agent-runtime'])
  if (base !== BASE_PIN) throw new Error(`integration pin moved: base=${base}`)
  const productDiff = spawnSync('git', ['diff', '--quiet', PIN, evidenceHead, '--', '.', ':!docs'], { cwd: ROOT })
  if (productDiff.status !== 0) throw new Error(`product source differs from exact pin ${PIN}`)
  const head = PIN
  command('bash', [RUNTIME, 'verify', runtimeArm])
  await login()

  const cwd = join(BASE, 'provider-work')
  const created = await mutate('sessions.create', {
    cwd,
    agentKind: AGENT_KIND[harness],
    runtimeContract: expectedDriver[harness][arm],
  })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created).slice(0, 800)}`)
  const bound = await until(sid, (row) => Boolean(row?.driverId), 90_000, 500)
  const row = bound.row ?? await sessionRow(sid)
  if (row?.driverId !== expectedDriver[harness][arm]) {
    await mutate('sessions.kill', { sessionId: sid }).catch(() => null)
    throw new Error(`A3 REFUSED: expected ${expectedDriver[harness][arm]}, bound ${row?.driverId ?? '(none)'}`)
  }

  let chat = new Chat(sid)
  await chat.open(arm === 'terminal' ? 'native' : 'chat')
  const primed = arm === 'terminal' ? await primeTerminalTui(chat, sid) : []
  const idle = await until(sid, (r) => r?.agentState?.phase !== 'working', 60_000, 500)
  if (!idle.ok) throw new Error('A3 REFUSED: session never reached pre-turn idle')

  const nonce = `P3098-A3-${harness}-${arm}-${Date.now().toString(36).toUpperCase()}`
  const baseline: Sample = await sample(chat, now(), sid)
  const prompt = `Produce a long answer of 500 numbered lines, one full sentence per line. Do not use tools, do not summarize, and put ${nonce} only in the final line.`
  const sent = await mutate('sessions.sendText', { sessionId: sid, text: prompt })
  const controlStarted = now()
  const controlSamples: Sample[] = []
  let growthTransitions = 0
  let workingSeen = false
  let controlFired = false
  while (now() - controlStarted < CONTROL_MS) {
    const current = await sample(chat, controlStarted, sid)
    const prev = controlSamples.at(-1)
    if (prev && outputValue(current) > outputValue(prev)) growthTransitions += 1
    if (current.phase === 'working') workingSeen = true
    controlSamples.push(current)
    const enoughOutput = arm === 'headless'
      ? current.previews >= baseline.previews + 3 || current.assistantChars >= baseline.assistantChars + 200
      : current.terminalBytes >= baseline.terminalBytes + 200
    const recentGrowth = controlSamples.slice(-8).some((value, index, tail) => index > 0 && outputValue(value) > outputValue(tail[index - 1]!))
    if (current.phase === 'working' && enoughOutput && growthTransitions >= 2 && recentGrowth) {
      controlFired = true
      break
    }
    await wait(250)
  }

  const beforeMarkers = markerItems(chat)
  const loadAtInterrupt = loadavg()[0]
  if (!controlFired || loadAtInterrupt >= 12 || beforeMarkers.length !== 0) {
    await chat.close()
    await mutate('sessions.kill', { sessionId: sid }).catch(() => null)
    throw new Error(`A3 REFUSED: control=${controlFired} load=${loadAtInterrupt.toFixed(2)} preMarkers=${beforeMarkers.length}`)
  }

  const requestAt = now()
  const atRequest = await sample(chat, requestAt, sid)
  const interrupt = await mutate('sessions.interrupt', { sessionId: sid })
  const postSamples: Sample[] = []
  let stoppedMs: number | null = null
  while (now() - requestAt < POST_WINDOW_MS) {
    const current = await sample(chat, requestAt, sid)
    postSamples.push(current)
    if (stoppedMs === null && current.phase !== 'working') stoppedMs = current.ms
    await wait(250)
  }
  const liveMarkers = await waitForMarker(chat, 15_000)
  const liveItems = chat.items.map((item) => ({ id: item.id, role: item.role, event: item.event, text: textOf(item.text).slice(0, 180) }))
  const outputAfterRequest = {
    previewFrames: chat.previews.length - atRequest.previews,
    assistantChars: chat.assistantText().length - atRequest.assistantChars,
    terminalBytes: chat.screenBytes - atRequest.terminalBytes,
    transcriptDeltaFrames: chat.deltaFrames - atRequest.deltaFrames,
    samples: postSamples,
  }
  const six = postSamples.find((s) => s.ms >= 6_000) ?? postSamples.at(-1)!
  const twelve = postSamples.at(-1)!
  const quietTail = outputValue(twelve) <= outputValue(six) + (arm === 'terminal' ? 200 : 0)

  await chat.close()
  chat = new Chat(sid)
  await chat.open(arm === 'terminal' ? 'native' : 'chat')
  const reloadMarkers = await waitForMarker(chat, 15_000)
  const idsBeforeIdle = new Set(chat.items.map((item) => item.id))
  const idleInterrupt = await mutate('sessions.interrupt', { sessionId: sid })
  await wait(3_000)
  const afterIdleMarkers = markerItems(chat)
  const idleItems = chat.items
    .filter((item) => !idsBeforeIdle.has(item.id))
    .map((item) => ({ id: item.id, role: item.role, event: item.event, text: item.text }))
  const idleWords = JSON.stringify({ response: idleInterrupt.result?.data ?? idleInterrupt.error ?? null, items: idleItems })
  const idleDistinguished = afterIdleMarkers.length === 1
    && !idleItems.some((item) => item.event === 'interrupt')
    && (/refus|no turn|not working|only takes an interrupt while/i.test(idleWords))
  await chat.close()

  const preRestartLedger = command('sqlite3', [
    join(STATE_ROOT, 'podium.db'),
    `SELECT id || '|' || kind || '|' || payload FROM podium_events WHERE subject='${sid}' ORDER BY id; SELECT 'checkpoint|' || observer_generation || '|' || cursor_json || '|' || turn_epoch || '|' || COALESCE(closed_turn_epoch, 'null') FROM runtime_event_checkpoints WHERE session_id='${sid}';`,
  ])

  const restartOutput = command('bash', [RUNTIME, 'restart', runtimeArm])
  await login()
  const afterRestartRow = await until(sid, (r) => Boolean(r), 60_000, 500)
  chat = new Chat(sid)
  await chat.open(arm === 'terminal' ? 'native' : 'chat')
  const restartMarkers = await waitForMarker(chat, 25_000)
  const restartItems = chat.items.map((item) => ({ id: item.id, role: item.role, event: item.event, text: textOf(item.text).slice(0, 180) }))
  const publicRead = await query('sessions.read', { sessionId: sid })
  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => null)

  const callData = interrupt.result?.data as { ok?: boolean; reason?: string } | undefined
  const callAccepted = callData?.ok !== false && !interrupt.error
  const sameMarker = liveMarkers.length === 1 && reloadMarkers.length === 1 && restartMarkers.length === 1
    && liveMarkers[0]?.id === reloadMarkers[0]?.id && liveMarkers[0]?.id === restartMarkers[0]?.id
  const quick = stoppedMs !== null && stoppedMs <= STOP_CEILING_MS
  const pass = callAccepted && quick && quietTail && sameMarker && idleDistinguished && afterRestartRow.ok
  const result = {
    cell: 'A3', harness, arm, verdict: pass ? 'PASS' : 'FAIL', at: stamp(),
    summary: pass
      ? `real turn stopped in ${stoppedMs}ms; exactly one durable interrupt item survived reload and server/daemon restart`
      : `A3 clauses unmet: accepted=${callAccepted} stoppedMs=${stoppedMs} quietTail=${quietTail} exactlyOneDurable=${sameMarker} idleDistinct=${idleDistinguished}`,
    pins: {
      head, base, evidenceHead,
      serverSource: 'b605f2a6becbadc0b801c103194f7526258b96bb',
      daemonSource: '60dd85b2e721a30d4f7a74717b00ce0f8d39d9eb',
      webSource: '574e2666043359d28cf2b876201d41cf241ff629',
      runtimeServer: readFileSync(join(BASE, 'server.sha'), 'utf8').trim(),
      runtimeDaemon: readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim(),
      servedWeb: 'b605f2a',
      instance: INSTANCE, stateRoot: STATE_ROOT, agentHome: AGENT_HOME,
      ports: { server: 19983, hook: 46983, relay: 46984 },
      runtimeArm,
    },
    provider: {
      driverId: row?.driverId, driverFamily: row?.driverFamily,
      versions: [version(harness === 'opencode' ? '/home/mgw/.opencode/bin/opencode' : harness === 'codex' ? '/tmp/pod-2777/bin/codex' : harness)],
      sessionId: sid,
      primed,
    },
    admission: { loadAtAdmission, loadAtInterrupt, limit: 12, installedRelayAvailable: true },
    control: {
      fired: controlFired,
      workingSeen,
      growthTransitions,
      baseline,
      atRequest,
      samples: controlSamples,
      preExistingInterruptItems: beforeMarkers,
      send: sent.result?.data ?? sent.error ?? null,
    },
    interrupt: {
      request: interrupt.result?.data ?? interrupt.error ?? null,
      requestToStoppedMs: stoppedMs,
      quickCeilingMs: STOP_CEILING_MS,
      outputAfterRequest,
      quietTail,
    },
    durable: {
      live: liveMarkers,
      afterClientReload: reloadMarkers,
      afterServerDaemonRestart: restartMarkers,
      exactlyOneStableId: sameMarker,
      liveItems,
      restartItems,
      preRestartLedger,
      publicRead: publicRead.result?.data ?? publicRead.error ?? null,
      restartOutput,
    },
    idleRefusal: {
      response: idleInterrupt.result?.data ?? idleInterrupt.error ?? null,
      newItems: idleItems,
      interruptItemsAfter: afterIdleMarkers,
      distinguishedFromConfirmedStop: idleDistinguished,
    },
  }
  await Bun.write(OUT, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ out: OUT, verdict: result.verdict, summary: result.summary, outputAfterRequest, idleDistinguished }, null, 2))
  process.exit(pass ? 0 : 1)
}

await main()
