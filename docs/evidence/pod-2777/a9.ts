/**
 * TIER-A ROW A9 — kill session.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a9.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "process tree gone (check the process table, not the UI);
 *    no orphan servers after 5 min"
 *
 * ---------------------------------------------------------------------------
 * THE ROW SAYS "NOT THE UI", SO THE UI IS NOT ASKED.
 * ---------------------------------------------------------------------------
 * Every number here comes from /proc. The session row's own opinion is READ and
 * PRINTED — because a disagreement between the row and the process table is
 * itself the finding — but it is never what decides the verdict.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL IS THE PROCESS TREE EXISTING BEFORE THE KILL.
 * ---------------------------------------------------------------------------
 * "No processes after the kill" is trivially true of a session that never
 * started any — and on this rig that is a live possibility, not a hypothetical:
 * POD-2853 makes a terminal-arm session exit at spawn, so its process count is
 * zero before anyone kills anything. A run that cannot name the processes it
 * expects to see die reports REFUSED.
 *
 * Processes are attributed by /proc/<pid>/environ: every original and rebound
 * target must carry the exact named-instance UUID and exact target session ID. Other
 * instances on this box run identically-named binaries, and a `pkill -f codex`
 * would take the operator's own sessions down while reporting a clean sweep.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { AGENT_KIND, Chat, REPO, login, mutate, nonce, now, sessionRow, until, wait } from './rig'
import { scoreA9, type ProcessIdentity } from './scorer-contracts'

const harness = (process.argv[2] ?? 'codex') as string
/**
 * WHICH VERB, AND WHY IT IS A PARAMETER.
 *
 * The row is called "kill session", and `sessions.kill` is the operator's kill
 * (`command-plane.ts:599`). The first run of this probe drove `sessions.stop`
 * instead and reported PASS — the process tree WAS gone, so the observation was
 * true, but the row it answered was a different one: stop came back
 * `status=hibernated stopReason=parent`, which is a park, not a kill. A park
 * that tidies its processes says nothing about whether a kill does.
 *
 * Both are worth having, so the verb is a parameter and the report names which
 * one produced each number rather than letting "the tree was gone" stand
 * unattributed.
 */
const verb = (process.argv[3] ?? 'kill') as 'kill' | 'stop'
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
/** The row says five minutes. Overridable for a smoke run, and the value used
 *  is printed, so a shortened wait can never be read as the full one. */
const ORPHAN_WAIT_MS = Number(process.env.P2777_ORPHAN_MS ?? 5 * 60_000)
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p2777'

const log = (s: string) => console.log(s)

interface Proc {
  pid: number
  startTimeTicks: string
  cmd: string
  cwd: string
  env: Record<string, string>
  rssKb: number
  why: string
}

function environOf(pid: number): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=')
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
    }
  } catch {
    // gone, or not ours to read
  }
  return out
}

function startTimeTicksOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const close = stat.lastIndexOf(')')
  if (close < 0) throw new Error(`cannot parse /proc/${pid}/stat`)
  const fieldsAfterCommand = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const startTimeTicks = fieldsAfterCommand[19]
  if (!startTimeTicks) throw new Error(`no start time in /proc/${pid}/stat`)
  return startTimeTicks
}

const identityOf = (row: Proc): ProcessIdentity => ({
  pid: row.pid,
  startTimeTicks: row.startTimeTicks,
})
const identityKey = (identity: ProcessIdentity) => `${identity.pid}:${identity.startTimeTicks}`

function daemonStamp(): { uuid: string; source: string } {
  const stateRoot = process.env.PODIUM_RIG_STATE_ROOT ?? ''
  if (stateRoot) {
    try {
      const marker = JSON.parse(readFileSync(`${stateRoot}/instance.json`, 'utf8')) as {
        instanceId?: unknown
        instanceUuid?: unknown
      }
      if (
        marker.instanceId === INSTANCE &&
        typeof marker.instanceUuid === 'string' &&
        marker.instanceUuid
      ) {
        return { uuid: marker.instanceUuid, source: `${stateRoot}/instance.json` }
      }
    } catch {}
  }
  return { uuid: '', source: '(missing)' }
}

/**
 * Processes belonging to one exact runtime instance and session.
 *
 * Command names and working directories are recorded only for diagnostics;
 * neither is accepted as attribution evidence.
 */
function exactStampedProcesses(
  instanceUuid: string,
  sid: string,
  excludePids: number[] = [],
): Proc[] {
  const found: Proc[] = []
  if (!instanceUuid || !sid) return found
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid || excludePids.includes(pid)) continue
    const env = environOf(pid)
    if (
      env.PODIUM_INSTANCE_UUID !== instanceUuid ||
      env.PODIUM_SESSION_ID !== sid
    ) {
      continue
    }
    let cmd = ''
    let cwd = ''
    let rssKb = 0
    let startTimeTicks = ''
    try {
      startTimeTicks = startTimeTicksOf(pid)
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      cwd = readlinkSync(`/proc/${pid}/cwd`)
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      rssKb = Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0)
    } catch {
      // exited between readdir and read
    }
    if (!startTimeTicks) continue
    found.push({
      pid,
      startTimeTicks,
      cmd: cmd.slice(0, 140),
      cwd,
      env,
      rssKb,
      why: 'exact PODIUM_INSTANCE_UUID+PODIUM_SESSION_ID',
    })
  }
  return found
}

await login()
log('='.repeat(78))
log(
  `A9  kill session — is the process tree really gone?   harness=${harness}  verb=sessions.${verb}`,
)
log('='.repeat(78))

const daemonPid = Number(
  readFileSync(`${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'}/daemon.pid`, 'utf8').trim(),
)
const serverPid = Number(
  readFileSync(`${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'}/server.pid`, 'utf8').trim(),
)
const infra = [daemonPid, serverPid]
const stamp = daemonStamp()
log(
  `rig infrastructure (excluded, and checked alive at the end): server ${serverPid}, daemon ${daemonPid}`,
)
log(`target stamp       uuid=${stamp.uuid || '(missing)'} source=${stamp.source}`)

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 800)}`)
  process.exit(5)
}
log(`session ${sid} created`)
await wait(READY_MS)

const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row0 = bound.row ?? (await sessionRow(sid))
log(`BOUND DRIVER       ${row0?.driverId ?? '(none)'} (family ${row0?.driverFamily ?? '?'})`)
if (harness === 'grok' && (row0?.driverId !== 'grok-acp' || row0.driverFamily !== 'server')) {
  throw new Error(
    `refusing A9: expected product driver grok-acp/server, received ${row0?.driverId ?? '(none)'}/${row0?.driverFamily ?? '(none)'}`,
  )
}
if (row0?.status === 'exited') {
  log(
    `SESSION EXITED     spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`,
  )
}

// Give it a real turn, so the tree includes whatever a working session spawns
// rather than only what boots.
const chat = new Chat(sid)
await chat.open('chat')
const word = nonce('ALIVE')
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${word}. Do not use any tools.`,
})
const replied = await (async () => {
  const dl = now() + 90_000
  while (now() < dl) {
    if (chat.assistantText().includes(word)) return true
    await wait(1_000)
  }
  return false
})()
log(`turn before kill   ${replied ? `replied with ${word}` : 'NO REPLY'}`)

// --- the control: what is there to kill, and is it exactly stamped? --------
const before = exactStampedProcesses(stamp.uuid, sid, infra)
const stampProven = stamp.uuid.length > 0 && before.length > 0
const controlFired = replied && stampProven
log('')
log(`CONTROL            reply=${replied} exactStamped=${before.length}`)
log(`STAMP PROOF        ${stampProven} exact UUID+session attribution only`)
for (const row of before) {
  log(
    `PRE                 pid=${row.pid} start=${row.startTimeTicks} rss=${row.rssKb}kB session=${row.env.PODIUM_SESSION_ID} cwd=${row.cwd} cmd=${row.cmd}`,
  )
}

if (!controlFired) {
  log('')
  log('REFUSED — the positive control or target stamp proof did not fire.')
  log('  control watched: an answered turn plus at least one exact target PID')
  log('                   carrying this daemon UUID and target session stamp.')
  log(`  control saw:     reply=${replied}; daemonUuid=${stamp.uuid || '(missing)'}`)
  log(`                   exactStamped=${before.length}`)
  log(
    `                   session status ${row0?.status ?? '?'}; spawnFailure ${(row0 as Record<string, unknown> | undefined)?.spawnFailure ?? '(none)'}`,
  )
  await chat.close()
  process.exit(3)
}

// --- kill ------------------------------------------------------------------
log('')
log(`KILLING via sessions.${verb} …`)
const killed = await mutate(`sessions.${verb}`, { sessionId: sid })
const killedAt = now()
log(
  `  returned         ${JSON.stringify(killed.result?.data ?? killed.error ?? null).slice(0, 240)}`,
)

const originalProcesses = before.map(identityOf)
const originalKeys = new Set(originalProcesses.map(identityKey))
const originalRows = new Map(before.map((row) => [identityKey(identityOf(row)), row]))
const originalProcessesAlive = () =>
  originalProcesses.filter((identity) => {
    try {
      return startTimeTicksOf(identity.pid) === identity.startTimeTicks
    } catch {
      return false
    }
  })
const targetSample = () => exactStampedProcesses(stamp.uuid, sid, infra)
const reboundRows = (rows: Proc[]) =>
  rows.filter((row) => !originalKeys.has(identityKey(identityOf(row))))

// First independent checkpoint: both old PIDs and brand-new stamped PIDs.
await wait(Math.max(0, killedAt + 15_000 - now()))
const rowAfter = await sessionRow(sid)
const after15 = targetSample()
const originalProcessesAliveAt15s = originalProcessesAlive()
const reboundsAt15s = reboundRows(after15)
log(
  `  row says         status=${rowAfter?.status ?? '(row gone)'} stopReason=${(rowAfter as Record<string, unknown> | undefined)?.stopReason ?? '?'}`,
)
log(
  `  after 15s        directOriginalAlive=${originalProcessesAliveAt15s.length} rebounds=${reboundsAt15s.length} stamped=${after15.length}`,
)
for (const identity of originalProcessesAliveAt15s) {
  const row = originalRows.get(identityKey(identity))
  log(
    `SURVIVOR_15         pid=${identity.pid} start=${identity.startTimeTicks} stampNow=${after15.some((current) => identityKey(identityOf(current)) === identityKey(identity))} cwd=${row?.cwd ?? '?'} cmd=${row?.cmd ?? '?'}`,
  )
}
for (const row of reboundsAt15s) {
  log(
    `REBOUND_15          pid=${row.pid} start=${row.startTimeTicks} session=${row.env.PODIUM_SESSION_ID} cwd=${row.cwd} cmd=${row.cmd}`,
  )
}

// Second independent checkpoint: wait to t+300s even when t+15s is clean.
log('')
log(
  `ORPHAN WATCH       waiting through t+${Math.round(ORPHAN_WAIT_MS / 1000)}s (the row says 300s)`,
)
const deadline = killedAt + ORPHAN_WAIT_MS
let lastShape = `${originalProcessesAliveAt15s.length}/${reboundsAt15s.length}`
while (now() < deadline) {
  await wait(Math.min(30_000, deadline - now()))
  const currentStamped = targetSample()
  const currentAlive = originalProcessesAlive()
  const currentRebounds = reboundRows(currentStamped)
  const shape = `${currentAlive.length}/${currentRebounds.length}`
  if (shape !== lastShape) {
    log(
      `  t+${Math.round((now() - killedAt) / 1000)}s: directOriginalAlive=${currentAlive.length} rebounds=${currentRebounds.length}`,
    )
    lastShape = shape
  }
}
const after300 = targetSample()
const originalProcessesAliveAt300s = originalProcessesAlive()
const reboundsAt300s = reboundRows(after300)
log(
  `  after 300s       directOriginalAlive=${originalProcessesAliveAt300s.length} rebounds=${reboundsAt300s.length} stamped=${after300.length}`,
)
for (const identity of originalProcessesAliveAt300s) {
  const row = originalRows.get(identityKey(identity))
  log(
    `SURVIVOR_300        pid=${identity.pid} start=${identity.startTimeTicks} stampNow=${after300.some((current) => identityKey(identityOf(current)) === identityKey(identity))} cwd=${row?.cwd ?? '?'} cmd=${row?.cmd ?? '?'}`,
  )
}
for (const row of reboundsAt300s) {
  log(
    `REBOUND_300         pid=${row.pid} start=${row.startTimeTicks} session=${row.env.PODIUM_SESSION_ID} cwd=${row.cwd} cmd=${row.cmd}`,
  )
}

const infraAlive = infra.filter((pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
})
const fullWindow = ORPHAN_WAIT_MS === 300_000
const score = scoreA9({
  controlFired,
  stampProven: stampProven && fullWindow,
  originalProcesses,
  originalProcessesAliveAt15s,
  originalProcessesAliveAt300s,
  stampedProcessesAt15s: after15.map(identityOf),
  stampedProcessesAt300s: after300.map(identityOf),
  infrastructureAlive: infraAlive.length,
})
log(`  rig intact       ${infraAlive.length}/2 infrastructure process(es) still alive`)

log('')
log('='.repeat(78))
log(`A9  ${score.verdict}`)
log(
  `    stamp proof=${stampProven}; exact target identities before kill=${originalProcesses
    .map(identityKey)
    .join(',')}`,
)
log(`    15s survivors=${score.survivorsAt15s.length} rebounds=${score.reboundsAt15s.length}`)
log(`    300s survivors=${score.survivorsAt300s.length} rebounds=${score.reboundsAt300s.length}`)
log(
  `    measured in /proc; original liveness uses PID+start-time identity independently of stamped rebound censuses`,
)
log(`    verb driven: sessions.${verb}; full 300s window=${fullWindow}`)
log(
  `    the row's own opinion was status=${rowAfter?.status ?? '(gone)'} — recorded, not used as the verdict`,
)
log(
  `    control ${controlFired ? 'FIRED' : 'DID NOT FIRE'} — answered turn and exact target stamp proof`,
)
log('='.repeat(78))

await chat.close()
process.exit(score.verdict === 'PASS' ? 0 : score.verdict === 'REFUSED' ? 3 : 1)
