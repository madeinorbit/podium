/**
 * POD-2875 follow-up — does a turn parked behind the CLI view SURVIVE a daemon
 * restart, or is it lost?
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/parked-turn-survives.ts codex
 *
 * POD-1761 asked for this specifically, and the reason is severity rather than
 * curiosity: "delivered and parked" is a reporting defect that can plausibly be
 * waived at release; "delivered and then GONE" is data loss and cannot. The
 * answer changes which of those POD-2875 is.
 *
 * ---------------------------------------------------------------------------
 * THREE CONTROLS, because this measurement has three ways to be vacuous.
 * ---------------------------------------------------------------------------
 * C1  THE TURN ACTUALLY PARKED. If the send were delivered normally there would
 *     be nothing parked to lose, and a later arrival would prove nothing. So the
 *     probe first confirms the defect: sent under a declared native view, and
 *     still absent from the transcript after the settle window.
 * C2  THE DAEMON ACTUALLY RESTARTED — a changed pid, read back from
 *     restart-daemon.sh. Survival across a restart that did not happen is the
 *     purest vacuous pass available.
 * C3  THE SESSION IS STILL USABLE AFTERWARDS. If the session were dead after the
 *     restart, "the parked turn never arrived" would be true of a corpse and
 *     would say nothing about the parking. So a FRESH turn is sent at the end
 *     and must answer.
 *
 * The verdict is deliberately three-way. LOST and SURVIVED are different
 * findings, and "the session died" is neither.
 */
import { spawnSync } from 'node:child_process'
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  nonce,
  now,
  sessionRow,
  settle,
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const PARK_WINDOW_MS = Number(process.env.P2777_PARK_MS ?? 45_000)
const log = (s: string) => console.log(s)

await login()
log('='.repeat(78))
log(`POD-2875 follow-up — does a parked turn survive a daemon restart?  harness=${harness}`)
log('='.repeat(78))

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 600)}`)
  process.exit(5)
}
await wait(READY_MS)
const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row0 = bound.row ?? (await sessionRow(sid))
log(`session ${sid}`)
log(`BOUND DRIVER       ${row0?.driverId ?? '(none)'} (family ${row0?.driverFamily ?? '?'})`)
if (row0?.status === 'exited') {
  log(`REFUSED — session exited: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
  process.exit(3)
}

const view = new Chat(sid)
await view.open('native')
await wait(READY_MS)
await settle(sid)

// --- C1: park a turn -------------------------------------------------------
const parked = nonce('PARKED')
const sendRes = await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${parked}. Do not use any tools.`,
})
log('')
log(`SENT under a declared native view`)
log(`  returned         ${JSON.stringify(sendRes.result?.data ?? sendRes.error ?? null)}`)
await wait(PARK_WINDOW_MS)
const arrivedEarly = view.assistantText().includes(parked)
const rowParked = await sessionRow(sid)
log(`  after ${PARK_WINDOW_MS / 1000}s     transcript items=${view.items.length} deltas=${view.deltaFrames} nonce present=${arrivedEarly} phase=${rowParked?.agentState?.phase}`)

if (arrivedEarly) {
  log('')
  log('REFUSED — control C1 did not fire.')
  log('  control watched: the turn PARKING, i.e. POD-2875 reproducing on this arm')
  log('  control saw:     the turn was delivered normally, so nothing was parked')
  log('  Nothing parked cannot be shown to survive or be lost. This is a')
  log(`  legitimate result about ${harness} on this arm: POD-2875 does not reproduce here.`)
  await view.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(2)
}
log(`  C1 FIRED — the turn is parked (POD-2875 reproduces on this arm)`)

// --- C2: restart the daemon ------------------------------------------------
log('')
log('RESTARTING THE DAEMON while the native view is still the declared mode …')
const restart = spawnSync('bash', [`${import.meta.dir}/restart-daemon.sh`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const out = `${restart.stdout ?? ''}${restart.stderr ?? ''}`
const oldPid = /OLD_DAEMON_PID=(\d+)/.exec(out)?.[1]
const newPid = /NEW_DAEMON_PID=(\d+)/.exec(out)?.[1]
const reconnected = /DAEMON_RECONNECTED=1/.test(out)
log(`  daemon pid       ${oldPid} -> ${newPid}   reconnected=${reconnected}`)
if (!(oldPid && newPid && oldPid !== newPid && reconnected)) {
  log('')
  log('REFUSED — control C2 did not fire: the daemon did not actually restart.')
  for (const l of out.trim().split('\n').slice(-6)) log(`    ${l}`)
  await view.close()
  process.exit(3)
}
log('  C2 FIRED')

await wait(15_000)

// --- now declare chat, which is what drained it before the restart ---------
await view.close()
const after = new Chat(sid)
await after.open('chat')
await wait(30_000)

const survived = after.assistantText().includes(parked)
log('')
log(`AFTER THE RESTART, with a chat view declared:`)
log(`  parked turn arrived: ${survived} (${parked})`)
log(`  transcript items:    ${after.items.length}`)

// --- C3: the session must still be usable ---------------------------------
const fresh = nonce('FRESH')
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${fresh}. Do not use any tools.`,
})
const freshOk = await (async () => {
  const dl = now() + 120_000
  while (now() < dl) {
    if (after.assistantText().includes(fresh)) return true
    await wait(2_000)
  }
  return false
})()
log(`  C3 a FRESH turn still answers: ${freshOk} (${fresh})`)

log('')
log('='.repeat(78))
if (!freshOk) {
  log('INCONCLUSIVE — the session is not usable after the restart, so the parked')
  log("turn's absence says nothing about parking. Report the session death instead.")
} else if (survived) {
  log('SURVIVED — the parked turn came back after the daemon restart.')
  log('POD-2875 is a REPORTING defect only: the message is durable, it is the')
  log("send's `delivered` disposition that is untrue. Waivable at release with a")
  log('documented note, if the operator chooses.')
} else {
  log('LOST — the parked turn did NOT come back after the daemon restart, and a')
  log('fresh turn on the same session answers fine, so the session is healthy and')
  log('the message is simply gone.')
  log('POD-2875 is then DATA LOSS wearing a delivered receipt, not a reporting')
  log('defect, and the severity is different: a message the product said it had')
  log('delivered no longer exists anywhere.')
}
log(`  controls: C1 parked FIRED, C2 daemon ${oldPid}->${newPid} FIRED, C3 session usable=${freshOk}`)
log('='.repeat(78))

await after.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
process.exit(survived ? 0 : 1)
