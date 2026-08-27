import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  AGENT_KIND,
  Chat,
  login,
  mutate,
  nonce,
  now,
  query,
  sessionRow,
  settle,
  until,
  untilText,
  wait,
} from '../pod-2777/rig'
import { interrupt } from '../pod-2777/probes'
import type { Ctx, ProbeOutcome } from '../pod-2777/probes'

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'REFUSED' | 'UNDRIVEN'
type Arm = 'headless' | 'terminal'
type Proc = { pid: number; cwd: string; cmd: string; ppid: number; location: string; env: Record<string, string> }

const cell = process.argv[2] ?? ''
const arm = (process.argv[3] ?? 'headless') as Arm
const root = process.env.P2919_REPO ?? resolve(import.meta.dir, '../..')
const base = process.env.P2919_BASE ?? '/tmp/pod-2919'
const instance = process.env.P2919_INSTANCE ?? 'oc2919'
const requestedCwd = process.env.P2919_PROBE_CWD ?? process.cwd()
const codePin = process.env.P2919_CODE_PIN ?? ''
const agentKind = AGENT_KIND.opencode
const expectedDriver = arm === 'terminal' ? 'generic-pty' : 'opencode-server'
const expectedFamily = arm === 'terminal' ? 'terminal' : 'server'
const logLines: string[] = []
const log = (line: string) => {
  logLines.push(line)
  console.log(line)
}

const validCells = new Set(['A1a', 'A1b', 'A1c', 'A2b', 'A3', 'A5', 'A6a', 'A7a', 'A9', 'A10'])
if (!validCells.has(cell)) throw new Error(`unsupported cell ${cell}`)
if (arm === 'terminal' && !['A6a', 'A10'].includes(cell)) throw new Error(`${cell} has no terminal arm in this drive`)

function environ(pid: number): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const part of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const at = part.indexOf('=')
      if (at > 0) out[part.slice(0, at)] = part.slice(at + 1)
    }
  } catch {}
  return out
}

function processRows(sid?: string): Proc[] {
  const out: Proc[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    const env = environ(pid)
    const cwd = (() => { try { return readFileSync(`/proc/${pid}/cwd`, 'utf8') } catch { return '' } })()
    let realCwd = ''
    try { realCwd = Bun.file(`/proc/${pid}/cwd`).name ?? '' } catch {}
    // readlink is used below because /proc/<pid>/cwd is a symlink, not a file.
    const cwdResult = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' })
    realCwd = (cwdResult.stdout ?? '').trim() || cwd
    if (!realCwd) continue
    const sidMatch = sid ? Object.values(env).some((value) => value.includes(sid)) : false
    const instanceMatch = env.PODIUM_INSTANCE === instance
    const cwdMatch = realCwd === requestedCwd
    if (!instanceMatch && !sidMatch && !cwdMatch) continue
    let cmd = ''
    let ppid = 0
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      ppid = Number(/PPid:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0)
    } catch {}
    if (/scripts\/(server|daemon)\.ts/.test(cmd)) continue
    const location = realCwd.startsWith('/tmp/') ? 'tmp-state-or-probe' : realCwd.includes('/.worktrees/') ? 'worktree' : 'other'
    out.push({ pid, cwd: realCwd, cmd: cmd.slice(0, 180), ppid, location, env })
  }
  return out
}

function hostSnapshot() {
  const load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3)
  const mem = readFileSync('/proc/meminfo', 'utf8')
  const memAvailableKb = Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1] ?? 0)
  const swapFreeKb = Number(/^SwapFree:\s+(\d+)/m.exec(mem)?.[1] ?? 0)
  const disk = spawnSync('df', ['-Pk', root], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)?.split(/\s+/) ?? []
  return { load, memAvailableKb, swapFreeKb, diskFreeKb: Number(disk[3] ?? 0) }
}

function vmstatQuiet(): boolean {
  const result = spawnSync('vmstat', ['1', '3'], { encoding: 'utf8', timeout: 10_000 })
  const samples = (result.stdout ?? '').split('\n').filter((line) => /^\s*\d/.test(line))
  return samples.every((line) => {
    const fields = line.trim().split(/\s+/)
    return Number(fields[6] ?? 0) < 10_000 && Number(fields[7] ?? 0) < 10_000
  })
}

async function verifyPin(): Promise<Record<string, unknown>> {
  const result = spawnSync('bash', [`${root}/docs/evidence/pod-2919/verify.sh`], {
    cwd: requestedCwd,
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  for (const line of output.trim().split('\n')) log(`PIN ${line}`)
  if (result.status !== 0) throw new Error(`pin verification failed: ${output.slice(-900)}`)
  const line = output.split('\n').find((item) => item.startsWith('PINJSON '))
  if (!line) throw new Error('pin verifier returned no PINJSON')
  return JSON.parse(line.slice('PINJSON '.length)) as Record<string, unknown>
}

async function actualCwd(sid: string): Promise<{ cwd: string; rows: Proc[] }> {
  const deadline = now() + 90_000
  let rows: Proc[] = []
  while (now() < deadline) {
    rows = processRows(sid)
    const match = rows.find((row) => Object.values(row.env).some((value) => value.includes(sid))) ??
      rows.find((row) => row.cwd === requestedCwd && /opencode|bun/.test(row.cmd))
    if (match) return { cwd: match.cwd, rows }
    await wait(500)
  }
  return { cwd: '', rows }
}

async function createSession(): Promise<{ sid: string; row: any; cwd: string; chat: Chat }> {
  const created = await mutate('sessions.create', { cwd: requestedCwd, agentKind })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created).slice(0, 700)}`)
  const bound = await until(sid, (row) => Boolean(row?.driverId) || row?.status === 'exited', 120_000, 500)
  const row = bound.row ?? await sessionRow(sid)
  const observed = await actualCwd(sid)
  log(`SESSION sid=${sid}`)
  log(`CWD requested=${requestedCwd}`)
  log(`CWD spawn-observed=${observed.cwd || '(not observed)'}`)
  log(`CWD query=${requestedCwd} match=${observed.cwd === requestedCwd}`)
  log(`DRIVER bound=${row?.driverId ?? '(none)'} family=${row?.driverFamily ?? '(none)'} status=${row?.status ?? '(none)'}`)
  if (row?.status === 'exited') throw new Error(`session exited: ${JSON.stringify(row)}`)
  if (row?.driverFamily !== expectedFamily || (arm === 'headless' && row?.driverId !== expectedDriver)) {
    throw new Error(`wrong bound driver: expected ${expectedDriver}/${expectedFamily}`)
  }
  const chat = new Chat(sid)
  await chat.open(arm === 'terminal' ? 'native' : 'chat')
  return { sid, row, cwd: observed.cwd, chat }
}

async function kill(sid: string) {
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}

async function answer(chat: Chat, sid: string, text: string, timeout = 180_000) {
  const before = chat.assistantText().length
  const accepted = await mutate('sessions.sendText', { sessionId: sid, text })
  const got = await untilText(chat, (value) => value.length > before && /\S/.test(value.slice(before)), timeout, { pumpFor: sid })
  return { accepted, got, reply: chat.assistantText().slice(before) }
}

function disposition(result: any): string {
  return String(result?.result?.data?.disposition ?? result?.result?.data?.status ?? '')
}

async function closeAndKill(chat: Chat | undefined, sid: string | undefined) {
  if (chat) await chat.close().catch(() => {})
  if (sid) await kill(sid)
}

async function runA1a(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const marker = nonce('A1A')
    const sent = await answer(s.chat, s.sid, `Reply with exactly this word and nothing else: ${marker}. Do not use any tools.`)
    const user = s.chat.userText().includes(marker)
    const assistant = sent.reply.includes(marker)
    const disp = disposition(sent.accepted)
    log(`CONTROL user durable=${user} assistant reply=${assistant} disposition=${disp || '(none)'}`)
    const pass = user && assistant && disp !== 'queued' && disp !== 'enqueued'
    return { verdict: pass ? 'PASS' : 'FAIL', summary: pass ? 'idle send arrived and settled as delivered' : 'idle send did not produce a durable delivered reply', evidence: [`marker=${marker}`, `userDurable=${user}`, `assistantReply=${assistant}`, `disposition=${disp || '(none)'}`], data: { marker, user, assistant, disposition: disp } }
  } finally { await closeAndKill(s.chat, s.sid) }
}

async function runA1b(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const busy = nonce('BUSY')
    await mutate('sessions.sendText', { sessionId: s.sid, text: `Count slowly from 1 to 60, one per line, then finish with ${busy}. Do not use tools.` })
    const busyControl = await until(s.sid, (row) => row?.agentState?.phase === 'working', 60_000, 500)
    log(`CONTROL phase working=${busyControl.ok}`)
    if (!busyControl.ok) return { verdict: 'REFUSED', summary: 'session never became busy before the queued send', evidence: [`phase=${busyControl.row?.agentState?.phase ?? '(blank)'}`], data: { control: false } }
    const marker = nonce('A1B')
    const sent = await mutate('sessions.sendText', { sessionId: s.sid, text: `Reply with exactly this word and nothing else: ${marker}. Do not use tools.` })
    const data = sent.result?.data ?? {}
    const disp = String(data.disposition ?? '')
    const pos = data.position ?? data.queuePosition ?? s.chat.positionFrames.map((frame) => frame.position ?? frame.queuePosition).find((value) => value !== undefined)
    await s.chat.close()
    const queue = await query('sessions.queue', { sessionId: s.sid }).catch(() => null)
    const queueText = JSON.stringify(queue?.result?.data ?? null)
    const reloaded = new Chat(s.sid)
    await reloaded.open('chat')
    const delivered = await untilText(reloaded, (value) => value.includes(marker), 240_000, { pumpFor: s.sid })
    const positionPresent = pos !== undefined && pos !== null && Number.isFinite(Number(pos))
    const reloadSurvived = queueText !== 'null' || delivered.ok
    const user = reloaded.userText().includes(marker)
    const verdict: Verdict = delivered.ok && disp.match(/queued|enqueued/i) && positionPresent && reloadSurvived && user ? 'PASS' : delivered.ok ? 'PARTIAL' : 'FAIL'
    log(`queued disposition=${disp || '(none)'} position=${pos ?? '(absent)'} reload=${reloadSurvived} delivered=${delivered.ok} userDurable=${user}`)
    await reloaded.close()
    return { verdict, summary: verdict === 'PASS' ? 'queued send exposed a position, survived reload, and delivered' : verdict === 'PARTIAL' ? 'queued send delivered but did not satisfy every visible queue-position assertion' : 'queued send was not delivered', evidence: [`busyControl=${busyControl.ok}`, `marker=${marker}`, `disposition=${disp || '(none)'}`, `position=${pos ?? '(absent)'}`, `queueAfterReload=${queueText.slice(0, 260)}`, `reloadSurvived=${reloadSurvived}`, `delivered=${delivered.ok}`, `userDurable=${user}`], data: { marker, disposition: disp, position: pos ?? null, reloadSurvived, delivered: delivered.ok, userDurable: user } }
  } finally { await closeAndKill(undefined, s.sid) }
}

async function runA1c(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const alive = nonce('ALIVE')
    const control = await answer(s.chat, s.sid, `Reply with exactly this word and nothing else: ${alive}. Do not use tools.`, 90_000)
    if (!control.got.ok) return { verdict: 'REFUSED', summary: 'alive send did not establish the dead-session control', evidence: [`control reply=${control.reply.slice(0, 160)}`], data: { control: false } }
    await s.chat.close()
    await kill(s.sid)
    await wait(2_000)
    const marker = nonce('DEAD')
    const dead = await mutate('sessions.sendText', { sessionId: s.sid, text: `Reply with exactly this word and nothing else: ${marker}.` })
    const d = dead.result?.data ?? {}
    const reason = String(d.reason ?? d.disposition ?? dead.error?.message ?? '')
    const typed = Boolean(dead.error) || d.ok === false || /refus|dead|gone|unknown|resume/i.test(reason)
    const accepted = d.ok === true && !/refus|dead|gone|unknown/i.test(reason)
    const pass = typed && !accepted
    log(`CONTROL alive reply=true dead typedRefusal=${typed} reason=${reason || '(none)'} silentlyAccepted=${accepted}`)
    return { verdict: pass ? 'PASS' : 'FAIL', summary: pass ? 'dead-session send gave a typed refusal' : 'dead-session send was silently accepted or untyped', evidence: [`aliveMarker=${alive}`, `deadMarker=${marker}`, `typedRefusal=${typed}`, `reason=${reason || '(none)'}`, `silentlyAccepted=${accepted}`], data: { typed, reason, accepted } }
  } finally { await closeAndKill(s.chat, s.sid) }
}

async function runA2b(): Promise<ProbeOutcome> {
  const created = await mutate('sessions.create', { cwd: requestedCwd, agentKind })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created).slice(0, 600)}`)
  const phases: { ms: number; phase: string; status: string; driver: string }[] = []
  const t0 = now()
  let row: any
  try {
    while (now() - t0 < 75_000) {
      row = await sessionRow(sid)
      const current = { ms: now() - t0, phase: row?.agentState?.phase ?? '(blank)', status: row?.status ?? '(none)', driver: row?.driverId ?? '(none)' }
      const last = phases.at(-1)
      if (!last || last.phase !== current.phase || last.status !== current.status || last.driver !== current.driver) phases.push(current)
      if (current.driver !== '(none)' && current.phase === 'idle' && current.ms > 25_000) break
      await wait(500)
    }
    const observed = await actualCwd(sid)
    const bound = Boolean(row?.driverId) && row?.status !== 'exited'
    const everWorking = phases.some((phase) => phase.phase === 'working')
    const everBlank = phases.some((phase) => phase.phase === '(blank)' && phase.driver !== '(none)')
    const pass = bound && row?.agentState?.phase === 'idle' && !everWorking && !everBlank && observed.cwd === requestedCwd
    log(`CONTROL bound=${bound} phaseTimeline=${JSON.stringify(phases)} spawnCwd=${observed.cwd || '(none)'}`)
    return { verdict: bound ? pass ? 'PASS' : 'FAIL' : 'REFUSED', summary: pass ? 'fresh session stayed idle at boot' : bound ? 'fresh session boot status was not clean idle' : 'session never bound a live driver', evidence: [`phases=${JSON.stringify(phases)}`, `finalPhase=${row?.agentState?.phase ?? '(blank)'}`, `spawnCwd=${observed.cwd || '(none)'}`, `cwdMatch=${observed.cwd === requestedCwd}`], data: { phases, bound, everWorking, everBlank } }
  } finally { await kill(sid) }
}

async function runA5(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const marker = nonce('A5')
    const sent = await answer(s.chat, s.sid, `Use your shell tool to run exactly: echo ${marker}. Then reply with ${marker} on its own line. Actually run the command.`, 180_000)
    const tools = s.chat.items.filter((item) => item.role === 'tool' || item.toolName)
    const byId = new Map<string, { call: boolean; result: boolean }>()
    let orphans = 0
    for (const item of tools) {
      if (!item.toolUseId) { orphans++; continue }
      const old = byId.get(item.toolUseId) ?? { call: false, result: false }
      old.call ||= Boolean(item.toolInput || item.toolName)
      old.result ||= typeof item.toolResult === 'string' && item.toolResult.length > 0
      byId.set(item.toolUseId, old)
    }
    const liveIds = s.chat.items.map((item) => item.id)
    await s.chat.close()
    const reloaded = new Chat(s.sid)
    await reloaded.open('chat')
    await wait(8_000)
    const reloadIds = reloaded.items.map((item) => item.id)
    const missing = liveIds.filter((id) => !reloadIds.includes(id))
    const paired = byId.size > 0 && orphans === 0 && [...byId.values()].every((pair) => pair.call && pair.result)
    const history = reloaded.assistantText().includes(marker)
    const control = tools.length > 0 && sent.got.ok
    const pass = control && paired && missing.length === 0 && history
    log(`CONTROL toolItems=${tools.length} assistant=${sent.got.ok} paired=${paired} reloadMissing=${missing.length} historyMarker=${history}`)
    await reloaded.close()
    return { verdict: control ? pass ? 'PASS' : 'FAIL' : 'REFUSED', summary: pass ? 'tool calls paired to results and transcript survived reload' : control ? 'tool pairing or reload history failed' : 'turn produced no tool item control', evidence: [`marker=${marker}`, `toolItems=${tools.length}`, `toolUseIds=${byId.size}`, `orphans=${orphans}`, `paired=${paired}`, `liveItems=${liveIds.length}`, `reloadItems=${reloadIds.length}`, `missing=${missing.length}`, `historyMarker=${history}`], data: { marker, toolItems: tools.length, paired, missing, history } }
  } finally { await closeAndKill(undefined, s.sid) }
}

async function runA3(): Promise<ProbeOutcome> {
  const host = hostSnapshot()
  const load = Number(host.load[0])
  const quiet = vmstatQuiet()
  log(`A3 capacity load=${load} memAvailableKb=${host.memAvailableKb} swapFreeKb=${host.swapFreeKb} vmstatQuiet=${quiet}`)
  if (!(load < 12 && quiet)) return { verdict: 'UNDRIVEN', summary: 'not driven because measured host load was not below the required 12 ceiling or vmstat was not quiet', evidence: [`load1=${load}`, `vmstatQuiet=${quiet}`, 'A3 is intentionally conditional; a busy host can make an interrupt appear to stop when it did not'], data: { load, quiet } }
  const s = await createSession()
  try {
    const ctx: Ctx = { harness: 'opencode', arm: 'headless', sid: s.sid, chat: s.chat, row: s.row, results: new Map(), log }
    const result = await interrupt.run(ctx)
    const scored = (await import('../pod-2777/rig')).score(result.outcome, result.control)
    log(`A3 control=${result.control.fired} verdict=${scored.verdict}`)
    return { ...scored, data: { ...(scored.data ?? {}), host } }
  } finally { await closeAndKill(s.chat, s.sid) }
}

async function runA6a(): Promise<ProbeOutcome> {
  const s = await createSession()
  let second: Chat | undefined
  try {
    await wait(20_000)
    const controlBytes = s.chat.screenBytes
    if (arm !== 'terminal' || controlBytes === 0) return { verdict: 'REFUSED', summary: 'terminal attach emitted no positive-control bytes', evidence: [`arm=${arm}`, `attachBytes=${controlBytes}`, `frameSummary=${s.chat.frameSummary()}`], data: { controlBytes } }
    const marker = nonce('ECHO')
    const beforeEcho = s.chat.screenBytes
    s.chat.send({ type: 'input', sessionId: s.sid, data: Buffer.from(marker).toString('base64'), inputOrigin: 'human' })
    let echoed = false
    for (let i = 0; i < 60; i++) { if (s.chat.screenTail(4000).includes(marker)) { echoed = true; break }; await wait(250) }
    const beforeResize = s.chat.screenBytes
    s.chat.send({ type: 'resize', sessionId: s.sid, cols: 100, rows: 30 })
    await wait(3_000)
    const narrow = s.chat.screenBytes - beforeResize
    s.chat.send({ type: 'resize', sessionId: s.sid, cols: 160, rows: 45 })
    await wait(3_000)
    const wide = s.chat.screenBytes - beforeResize - narrow
    second = new Chat(s.sid)
    await second.open('native')
    await wait(6_000)
    const secondText = second.screenTail(4000)
    const shared = secondText.includes(marker) || s.chat.screenTail(4000).split('\n').filter((line) => line && secondText.includes(line)).length > 0
    const pass = echoed && narrow + wide > 0 && second.screenBytes > 0 && shared
    log(`CONTROL attachBytes=${controlBytes} echo=${echoed} resizeBytes=${narrow + wide} secondViewerBytes=${second.screenBytes} shared=${shared}`)
    await second.close()
    return { verdict: pass ? 'PASS' : 'FAIL', summary: pass ? 'terminal echo, resize repaint, and second-viewer sharing all observed' : 'terminal attach interaction did not satisfy all checks', evidence: [`marker=${marker}`, `attachBytes=${controlBytes}`, `echoed=${echoed}`, `echoDelta=${s.chat.screenBytes - beforeEcho}`, `resizeNarrowBytes=${narrow}`, `resizeWideBytes=${wide}`, `secondViewerBytes=${second.screenBytes}`, `shared=${shared}`, `tail=${s.chat.screenTail(260)}`], data: { marker, controlBytes, echoed, narrow, wide, secondViewerBytes: second.screenBytes, shared } }
  } finally { await second?.close().catch(() => {}); await closeAndKill(s.chat, s.sid) }
}

async function runA7a(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const codeword = nonce('CODEWORD')
    const plant = await answer(s.chat, s.sid, `Remember this codeword for later: ${codeword}. Reply with exactly OK and nothing else. Do not use tools.`, 120_000)
    if (!plant.got.ok) return { verdict: 'REFUSED', summary: 'pre-restart codeword control did not answer', evidence: [`codeword=${codeword}`, `reply=${plant.reply.slice(0, 160)}`], data: { control: false } }
    const before = await sessionRow(s.sid)
    const pointerBefore = before?.conversationId ?? before?.conversationPodiumId ?? null
    const restart = spawnSync('bash', [`${root}/docs/evidence/pod-2919/restart-daemon.sh`], { cwd: requestedCwd, encoding: 'utf8', env: process.env })
    const restartOutput = `${restart.stdout ?? ''}${restart.stderr ?? ''}`
    log(restartOutput.trim())
    const oldPid = /OLD_DAEMON_PID=(\d+)/.exec(restartOutput)?.[1]
    const newPid = /NEW_DAEMON_PID=(\d+)/.exec(restartOutput)?.[1]
    const restarted = Boolean(oldPid && newPid && oldPid !== newPid && /DAEMON_RECONNECTED=1/.test(restartOutput))
    if (!restarted) return { verdict: 'REFUSED', summary: 'daemon restart control did not prove a changed, reconnecting daemon', evidence: [`oldPid=${oldPid ?? '(none)'}`, `newPid=${newPid ?? '(none)'}`, `restartExit=${restart.status}`, restartOutput.slice(-600)], data: { restarted: false } }
    await wait(8_000)
    const after = new Chat(s.sid)
    await after.open('chat')
    await wait(10_000)
    const rowAfter = await sessionRow(s.sid)
    const pointerAfter = rowAfter?.conversationId ?? rowAfter?.conversationPodiumId ?? null
    const history = after.items.some((item) => item.text.includes(codeword))
    const recalled = await answer(after, s.sid, 'What was the codeword I asked you to remember? Reply with exactly that word and nothing else. Do not use tools.', 120_000)
    const samePointer = pointerBefore !== null && pointerAfter !== null && pointerBefore === pointerAfter
    const sameConversation = samePointer || (pointerBefore === null && pointerAfter === null && history)
    const pass = restarted && history && recalled.got.ok && recalled.reply.includes(codeword) && sameConversation
    log(`CONTROL daemonRestarted=${restarted} history=${history} recallReply=${recalled.got.ok} pointerBefore=${pointerBefore ?? '(none)'} pointerAfter=${pointerAfter ?? '(none)'} sameConversation=${sameConversation}`)
    await after.close()
    return { verdict: pass ? 'PASS' : 'FAIL', summary: pass ? 'daemon restart preserved the same opencode conversation' : 'daemon restart did not preserve the same conversation', evidence: [`codeword=${codeword}`, `oldDaemonPid=${oldPid}`, `newDaemonPid=${newPid}`, `history=${history}`, `recalled=${recalled.got.ok}`, `reply=${recalled.reply.trim().slice(0, 180)}`, `pointerBefore=${pointerBefore ?? '(none)'}`, `pointerAfter=${pointerAfter ?? '(none)'}`, `sameConversation=${sameConversation}`], data: { restarted, history, recalled: recalled.got.ok, samePointer, sameConversation } }
  } finally { await closeAndKill(s.chat, s.sid) }
}

async function runA9(): Promise<ProbeOutcome> {
  const s = await createSession()
  const serverPid = Number(readFileSync(`${base}/server.pid`, 'utf8').trim())
  const daemonPid = Number(readFileSync(`${base}/daemon.pid`, 'utf8').trim())
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> d7b61ccfe (pod-2919 read daemon identity from state marker)
  const daemonEnvUuid = environ(daemonPid).PODIUM_INSTANCE_UUID ?? ''
  const stateRoot = process.env.P2919_STATE_ROOT ?? process.env.PODIUM_RIG_STATE_ROOT ?? ''
  let daemonInstanceUuid = daemonEnvUuid
  let uuidSource = daemonEnvUuid ? 'daemon /proc environment' : '(missing)'
  if (!daemonInstanceUuid && stateRoot) {
    try {
      const marker = JSON.parse(readFileSync(`${stateRoot}/instance.json`, 'utf8')) as { instanceUuid?: unknown }
      if (typeof marker.instanceUuid === 'string') {
        daemonInstanceUuid = marker.instanceUuid
        uuidSource = 'state instance.json'
      }
    } catch {}
  }
  const eligible = (row: Proc) =>
    row.env.PODIUM_INSTANCE_UUID === daemonInstanceUuid && Boolean(row.env.PODIUM_SESSION_ID)
  const touchesSession = (row: Proc) =>
<<<<<<< HEAD
    row.cwd === requestedCwd || Object.values(row.env).some((value) => value.includes(s.sid))
=======
  const daemonInstanceUuid = environ(daemonPid).PODIUM_INSTANCE_UUID ?? ''
<<<<<<< HEAD
  const exactSession = (row: Proc) =>
    row.env.PODIUM_INSTANCE_UUID === daemonInstanceUuid && row.env.PODIUM_SESSION_ID === s.sid
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
  const eligible = (row: Proc) =>
    row.env.PODIUM_INSTANCE_UUID === daemonInstanceUuid && Boolean(row.env.PODIUM_SESSION_ID)
  const touchesSession = (row: Proc) =>
    row.cwd === requestedCwd || Object.values(row.env).some((value) => value.includes(s.sid))
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
=======
    log(`STAMP daemonUuid=${daemonInstanceUuid || '(missing)'} uuidSource=${uuidSource} attributable=${attributable.length} eligible=${before.length} unstampedInScope=${unstamped.length} foreignExcluded=${foreign.length}`)
>>>>>>> d7b61ccfe (pod-2919 read daemon identity from state marker)
  try {
    const marker = nonce('A9')
    const control = await answer(s.chat, s.sid, `Reply with exactly this word and nothing else: ${marker}. Do not use tools.`, 90_000)
    const attributable = processRows(s.sid).filter((row) => row.pid !== serverPid && row.pid !== daemonPid)
<<<<<<< HEAD
<<<<<<< HEAD
    const unstamped = attributable.filter((row) => touchesSession(row) && !eligible(row))
    const foreign = attributable.filter((row) => !touchesSession(row) && !eligible(row))
    const before = attributable.filter(eligible)
    log(`CONTROL pre-kill session processes=${before.length}`)
    log(`STAMP daemonUuid=${daemonInstanceUuid || '(missing)'} uuidSource=${uuidSource} attributable=${attributable.length} eligible=${before.length} unstampedInScope=${unstamped.length} foreignExcluded=${foreign.length}`)
    for (const row of before) log(`PRE pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    for (const row of foreign) log(`FOREIGN_EXCLUDED pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} instanceUuid=${row.env.PODIUM_INSTANCE_UUID || '(missing)'} session=${row.env.PODIUM_SESSION_ID || '(missing)'} cmd=${row.cmd}`)
=======
    const unstamped = attributable.filter((row) => !exactSession(row))
    const before = attributable.filter(exactSession)
    log(`CONTROL pre-kill session processes=${before.length}`)
    log(`STAMP daemonUuid=${daemonInstanceUuid || '(missing)'} attributable=${attributable.length} stamped=${before.length} unstamped=${unstamped.length}`)
    for (const row of before) log(`PRE pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} cmd=${row.cmd}`)
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
    const unstamped = attributable.filter((row) => touchesSession(row) && !eligible(row))
    const foreign = attributable.filter((row) => !touchesSession(row) && !eligible(row))
    const before = attributable.filter(eligible)
    log(`CONTROL pre-kill session processes=${before.length}`)
    log(`STAMP daemonUuid=${daemonInstanceUuid || '(missing)'} attributable=${attributable.length} eligible=${before.length} unstampedInScope=${unstamped.length} foreignExcluded=${foreign.length}`)
    for (const row of before) log(`PRE pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    for (const row of foreign) log(`FOREIGN_EXCLUDED pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} instanceUuid=${row.env.PODIUM_INSTANCE_UUID || '(missing)'} session=${row.env.PODIUM_SESSION_ID || '(missing)'} cmd=${row.cmd}`)
<<<<<<< HEAD
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
    if (!daemonInstanceUuid || unstamped.length > 0 || before.length === 0) {
=======
          `daemonInstanceUuid=${daemonInstanceUuid || '(missing)'}`,
          `uuidSource=${uuidSource}`,
>>>>>>> d7b61ccfe (pod-2919 read daemon identity from state marker)
      const reason = !daemonInstanceUuid
        ? 'daemon had no instance stamp to establish eligibility'
        : unstamped.length > 0
<<<<<<< HEAD
<<<<<<< HEAD
          ? 'an in-scope process was not stamped for this daemon and session'
=======
          ? 'an attributable process was not stamped for this daemon and session'
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
          ? 'an in-scope process was not stamped for this daemon and session'
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
          : 'no stamped session-owned process appeared before kill'
      return {
        verdict: 'REFUSED',
        summary: reason,
        evidence: [
          `replyControl=${control.got.ok}`,
          `daemonInstanceUuid=${daemonInstanceUuid || '(missing)'}`,
<<<<<<< HEAD
          `uuidSource=${uuidSource}`,
          `attributable=${attributable.length}`,
          `eligible=${before.length}`,
          `unstampedInScope=${unstamped.length}`,
          `foreignExcluded=${foreign.length}`,
          'only current-daemon PODIUM_INSTANCE_UUID + any PODIUM_SESSION_ID rows are eligible',
        ],
        data: { control: false, daemonInstanceUuid, uuidSource, attributable: attributable.length, eligible: before.length, unstampedInScope: unstamped.length, foreignExcluded: foreign.length },
=======
          `attributable=${attributable.length}`,
          `eligible=${before.length}`,
          `unstampedInScope=${unstamped.length}`,
          `foreignExcluded=${foreign.length}`,
          'only current-daemon PODIUM_INSTANCE_UUID + any PODIUM_SESSION_ID rows are eligible',
        ],
<<<<<<< HEAD
        data: { control: false, daemonInstanceUuid, attributable: attributable.length, stamped: before.length, unstamped: unstamped.length },
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
        data: { control: false, daemonInstanceUuid, attributable: attributable.length, eligible: before.length, unstampedInScope: unstamped.length, foreignExcluded: foreign.length },
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
      }
    }
    await mutate('sessions.kill', { sessionId: s.sid })
    await s.chat.close().catch(() => {})
    await wait(15_000)
<<<<<<< HEAD
<<<<<<< HEAD
    const immediate = processRows(s.sid).filter(eligible).filter((row) => before.some((old) => old.pid === row.pid))
=======
    const immediate = processRows(s.sid).filter(exactSession).filter((row) => before.some((old) => old.pid === row.pid))
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
    const immediate = processRows(s.sid).filter(eligible).filter((row) => before.some((old) => old.pid === row.pid))
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
    log(`after15s survivors=${immediate.length}`)
    const deadline = now() + 300_000
    let last = immediate.length
    while (now() < deadline) {
      await wait(Math.min(30_000, deadline - now()))
<<<<<<< HEAD
<<<<<<< HEAD
      const current = processRows(s.sid).filter(eligible).filter((row) => before.some((old) => old.pid === row.pid))
      if (current.length !== last) { log(`orphanWatch t+${Math.round((300_000 - (deadline - now())) / 1000)}s survivors=${current.length}`); last = current.length }
    }
    const beforePids = new Set(before.map((row) => row.pid))
    const after = processRows(s.sid).filter(eligible)
    const orphans = after.filter((row) => beforePids.has(row.pid))
    const rebound = after.filter((row) => !beforePids.has(row.pid))
    const infraAlive = [serverPid, daemonPid].filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } }).length
    log(`after300s orphans=${orphans.length} rebound=${rebound.length} eligibleRowsAfter=${after.length} infrastructure=${infraAlive}/2`)
    for (const row of orphans) log(`ORPHAN pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    for (const row of rebound) log(`REBOUND pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    const pass = orphans.length === 0 && rebound.length === 0 && infraAlive === 2
    return {
      verdict: pass ? 'PASS' : 'FAIL',
      summary: pass ? 'kill removed all current-daemon stamped session processes and left infrastructure intact' : 'kill left a current-daemon stamped session orphan, rebound process, or damaged infrastructure',
<<<<<<< HEAD
=======
      const current = processRows(s.sid).filter(exactSession).filter((row) => before.some((old) => old.pid === row.pid))
=======
      const current = processRows(s.sid).filter(eligible).filter((row) => before.some((old) => old.pid === row.pid))
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
      if (current.length !== last) { log(`orphanWatch t+${Math.round((300_000 - (deadline - now())) / 1000)}s survivors=${current.length}`); last = current.length }
    }
    const beforePids = new Set(before.map((row) => row.pid))
    const after = processRows(s.sid).filter(eligible)
    const orphans = after.filter((row) => beforePids.has(row.pid))
    const rebound = after.filter((row) => !beforePids.has(row.pid))
    const infraAlive = [serverPid, daemonPid].filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } }).length
    log(`after300s orphans=${orphans.length} rebound=${rebound.length} eligibleRowsAfter=${after.length} infrastructure=${infraAlive}/2`)
    for (const row of orphans) log(`ORPHAN pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    for (const row of rebound) log(`REBOUND pid=${row.pid} ppid=${row.ppid} cwd=${row.cwd} location=${row.location} session=${row.env.PODIUM_SESSION_ID} cmd=${row.cmd}`)
    const pass = orphans.length === 0 && rebound.length === 0 && infraAlive === 2
    return {
      verdict: pass ? 'PASS' : 'FAIL',
<<<<<<< HEAD
      summary: pass ? 'kill removed the stamped session process tree and left infrastructure intact' : 'kill left a stamped session orphan, rebound process, or damaged infrastructure',
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
      summary: pass ? 'kill removed all current-daemon stamped session processes and left infrastructure intact' : 'kill left a current-daemon stamped session orphan, rebound process, or damaged infrastructure',
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
      evidence: [
=======
        `daemonInstanceUuid=${daemonInstanceUuid}`,
        `uuidSource=${uuidSource}`,
>>>>>>> d7b61ccfe (pod-2919 read daemon identity from state marker)
        `marker=${marker}`,
        `replyControl=${control.got.ok}`,
        `daemonInstanceUuid=${daemonInstanceUuid}`,
<<<<<<< HEAD
        `uuidSource=${uuidSource}`,
        `sessionId=${s.sid}`,
        `beforeEligible=${before.length}`,
        `after15s=${immediate.length}`,
        `after300sOrphans=${orphans.length}`,
        `rebound=${rebound.length}`,
        `eligibleRowsAfter=${after.length}`,
        `foreignExcluded=${foreign.length}`,
        `infraAlive=${infraAlive}/2`,
        'attribution=exact current-daemon PODIUM_INSTANCE_UUID + nonempty PODIUM_SESSION_ID, cwd map includes tmp and worktree',
=======
        `sessionId=${s.sid}`,
        `beforeEligible=${before.length}`,
        `after15s=${immediate.length}`,
        `after300sOrphans=${orphans.length}`,
        `rebound=${rebound.length}`,
        `eligibleRowsAfter=${after.length}`,
        `foreignExcluded=${foreign.length}`,
        `infraAlive=${infraAlive}/2`,
<<<<<<< HEAD
        'attribution=exact environment/PODIUM_INSTANCE_UUID+PODIUM_SESSION_ID, cwd map includes tmp and worktree',
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
        'attribution=exact current-daemon PODIUM_INSTANCE_UUID + nonempty PODIUM_SESSION_ID, cwd map includes tmp and worktree',
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
      ],
      data: {
        before: before.map((row) => ({ pid: row.pid, ppid: row.ppid, cwd: row.cwd, location: row.location, instanceUuid: row.env.PODIUM_INSTANCE_UUID, sessionId: row.env.PODIUM_SESSION_ID })),
        immediate: immediate.length,
        orphans: orphans.length,
        rebound: rebound.length,
<<<<<<< HEAD
<<<<<<< HEAD
        eligibleRowsAfter: after.length,
        foreignExcluded: foreign.length,
=======
>>>>>>> fb67ef227 (pod-2919 harden A9 reaper scorer)
=======
        eligibleRowsAfter: after.length,
        foreignExcluded: foreign.length,
>>>>>>> c8c4ef2d5 (pod-2919 scope A9 to stamped processes)
        infraAlive,
      },
    }
  } finally { await kill(s.sid) }
}

async function runA10(): Promise<ProbeOutcome> {
  const s = await createSession()
  try {
    const control = Boolean(s.row.driverId) && s.row.driverFamily === expectedFamily
    const driver = `${s.row.driverId ?? '(none)'}/${s.row.driverFamily ?? '(none)'}`
    const pass = control && s.row.driverFamily === expectedFamily && (arm === 'terminal' ? /terminal/i.test(s.row.driverFamily ?? '') : s.row.driverId === expectedDriver)
    log(`CONTROL identity=${driver} attachOrBound=${control}`)
    return { verdict: pass ? 'PASS' : control ? 'FAIL' : 'REFUSED', summary: pass ? `identity reported ${driver}` : `identity did not report expected ${expectedDriver}/${expectedFamily}`, evidence: [`arm=${arm}`, `driverId=${s.row.driverId ?? '(none)'}`, `driverFamily=${s.row.driverFamily ?? '(none)'}`, `control=${control}`, `expected=${expectedDriver}/${expectedFamily}`], data: { driverId: s.row.driverId, driverFamily: s.row.driverFamily, control } }
  } finally { await closeAndKill(s.chat, s.sid) }
}

async function run(): Promise<ProbeOutcome> {
  if (!codePin) throw new Error('P2919_CODE_PIN is required')
  await login()
  const pin = await verifyPin()
  log(`HOST ${JSON.stringify(hostSnapshot())}`)
  if (cell === 'A1a') return await runA1a()
  if (cell === 'A1b') return await runA1b()
  if (cell === 'A1c') return await runA1c()
  if (cell === 'A2b') return await runA2b()
  if (cell === 'A3') return await runA3()
  if (cell === 'A5') return await runA5()
  if (cell === 'A6a') return await runA6a()
  if (cell === 'A7a') return await runA7a()
  if (cell === 'A9') return await runA9()
  return await runA10()
}

let outcome: ProbeOutcome
let error = ''
let pin: Record<string, unknown> | null = null
try {
  await login()
  pin = await verifyPin()
  log(`HOST ${JSON.stringify(hostSnapshot())}`)
  if (cell === 'A1a') outcome = await runA1a()
  else if (cell === 'A1b') outcome = await runA1b()
  else if (cell === 'A1c') outcome = await runA1c()
  else if (cell === 'A2b') outcome = await runA2b()
  else if (cell === 'A3') outcome = await runA3()
  else if (cell === 'A5') outcome = await runA5()
  else if (cell === 'A6a') outcome = await runA6a()
  else if (cell === 'A7a') outcome = await runA7a()
  else if (cell === 'A9') outcome = await runA9()
  else outcome = await runA10()
} catch (err) {
  error = err instanceof Error ? err.message : String(err)
  outcome = { verdict: 'REFUSED', summary: `drive could not establish a trustworthy cell: ${error}`, evidence: [error], data: { error } }
  log(`REFUSED ${error}`)
}

const reading = {
  cell,
  arm,
  harness: 'opencode',
  verdict: outcome.verdict,
  summary: outcome.summary,
  evidence: outcome.evidence,
  data: outcome.data ?? {},
  requestedCwd,
  cwdFromSpawn: (outcome.data as any)?.cwdFromSpawn ?? null,
  instance,
  codePin,
  pin,
  host: hostSnapshot(),
  at: new Date().toISOString(),
  error,
  log: logLines,
}
const output = `${root}/docs/evidence/pod-2919/readings/${cell.toLowerCase()}-${arm}.json`
await Bun.write(output, JSON.stringify(reading, null, 2) + '\n')
console.log(`READING ${output}`)
console.log(`RESULT ${cell} ${arm} ${outcome.verdict} — ${outcome.summary}`)
process.exit(outcome.verdict === 'PASS' || outcome.verdict === 'PARTIAL' || outcome.verdict === 'UNDRIVEN' ? 0 : 1)
