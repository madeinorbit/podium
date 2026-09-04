/**
 * DID THE STOP REACH THE WIRE? — the reading POD-2777's probe cannot take.
 *
 *   bun docs/evidence/pod-2792/wire-reading.ts <harness>
 *
 * The acceptance drive's interrupt probe measures the OUTCOME (did the turn
 * stop). This measures the DELIVERY, which is the first of this issue's three
 * questions and the one an outcome cannot answer: a turn that keeps running
 * looks the same whether the frame was dropped in the server, dropped in the
 * daemon, or delivered and ignored by the provider.
 *
 * THE READING IS THE DAEMON'S OWN WORDS. `apps/daemon/src/control/session.ts`
 * logs `discarding input bytes for a bridgeless contract session` with the
 * session id when an `input` frame arrives for a session that has no PTY. That
 * line is a positive observation — the daemon saying what it did with the
 * operator's keystroke — and it is not an inference from silence.
 *
 * THE CONTROLS, both of which must fire or the reading is refused:
 *   1. the turn observed IN FLIGHT immediately before the interrupt, computed
 *      exactly as the acceptance drive computes it. Interrupting nothing always
 *      looks like success, on this reading as much as on the outcome one.
 *   2. THE DAEMON'S LOG IS WHERE THIS SESSION'S DAEMON WRITES, proved by lines
 *      about THIS session id appearing in it before the interrupt. The absence
 *      of a warning is half of what this reading reports, and an absence read
 *      out of the wrong file — or out of a daemon that logs nowhere — is not a
 *      finding.
 *
 *      A FIRST VERSION OF THIS CONTROL WAS WORTHLESS AND IS RECORDED RATHER THAN
 *      QUIETLY REPLACED: it asked whether the log GREW in the 20s after the
 *      interrupt. On the broken build it fired, because the discard warning was
 *      the growth — the control fired only when the defect was present, which is
 *      the one thing a control must never do. On the fixed build the daemon
 *      correctly said nothing and the reading refused itself.
 */
import { readFileSync, statSync } from 'node:fs'
import { AGENT_KIND, Chat, DRIVE_BASE, login, mutate, now, primeTerminalTui, REPO, sessionRow, settle, wait } from './rig.js'

const harness = process.argv[2] ?? 'opencode'
const arm = process.env.PODIUM_RUNTIME_DRIVER === 'generic-pty' ? 'terminal' : 'headless'
const LOG = `${DRIVE_BASE}/logs/daemon.log`
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const INFLIGHT_MS = Number(process.env.P2792_INFLIGHT_MS ?? 120_000)
const SETTLE_MS = Number(process.env.P2792_SETTLE_MS ?? 20_000)

const at = () => statSync(LOG).size
const since = (offset: number): string[] => {
  const buf = readFileSync(LOG)
  return buf.subarray(offset).toString('utf8').split('\n').filter(Boolean)
}

await login()
const logAtCreate = at()
const created = await mutate('sessions.create', { cwd: REPO, agentKind: AGENT_KIND[harness] ?? harness })
const sid = created.result?.data?.sessionId as string
console.log('==============================================================================')
console.log(`WIRE READING       harness=${harness}  arm=${arm}`)
console.log('==============================================================================')
console.log(`session ${sid}`)
await wait(READY_MS)
const row0 = await sessionRow(sid)
console.log(`BOUND DRIVER       ${row0?.driverId} (family ${row0?.driverFamily})`)

const chat = new Chat(sid)
await chat.open()
if (arm === 'terminal') {
  const primed = await primeTerminalTui(chat, sid)
  console.log(`TUI PRIMING        ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
  await settle(sid)
}

const longPrompt =
  'Count from 1 to 150. Put each number on its own line, and after each number ' +
  'write one full sentence about that number — a fact, a property, anything. ' +
  'Do not use any tools. Do not summarise. Write every single line.'
const t0 = now()
await mutate('sessions.sendText', { sessionId: sid, text: longPrompt })

let working = false
let detail = 'never observed in flight'
const deadline = now() + INFLIGHT_MS
while (now() < deadline) {
  await wait(1_000)
  const row = await sessionRow(sid)
  const producing = chat.previews.length > 0 || chat.assistantText().length > 0
  if (row?.agentState?.phase === 'working' && producing) {
    working = true
    detail = `phase=working, ${chat.previews.length} preview frame(s), ${chat.assistantText().length} chars on the transcript`
    break
  }
}

// CONTROL 2, read BEFORE the interrupt: this daemon writes about this session,
// into this file. Everything after is then an absence that means something.
const spoken = since(logAtCreate).filter((l) => l.includes(sid))
const before = at()
const t1 = now()
const res = await mutate('sessions.interrupt', { sessionId: sid })
await wait(SETTLE_MS)
const lines = since(before)
const mine = lines.filter((l) => l.includes(sid))
const discarded = mine.filter((l) => l.includes('bridgeless contract session'))
const rowAfter = await sessionRow(sid)

console.log('')
console.log(`CONTROL 1 in flight   ${working ? 'FIRED' : 'DID NOT FIRE'} — ${detail}`)
console.log(`CONTROL 2 log is ours  ${spoken.length > 0 ? 'FIRED' : 'DID NOT FIRE'} — ${spoken.length} daemon line(s) about this session were written to ${LOG} BEFORE the interrupt`)
console.log('')
console.log(`INTERRUPT SENT        ${JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 200)}`)
console.log(`LINES ABOUT THIS SID  ${mine.length} in the ${SETTLE_MS}ms after (${lines.length} daemon line(s) in total)`)
console.log(`DISCARD WARNINGS      ${discarded.length}`)
for (const l of discarded.slice(0, 3)) console.log(`   ${l.slice(0, 220)}`)
console.log(`PHASE ${SETTLE_MS}ms LATER  ${rowAfter?.agentState?.phase} (was working at the interrupt, ${now() - t1}ms ago)`)
console.log(`AGENT STATE           ${JSON.stringify(rowAfter?.agentState ?? null).slice(0, 400)}`)
if (!working || spoken.length === 0) {
  console.log('')
  console.log('REFUSED — a control did not fire, so this reading is not reported as a finding.')
}
await chat.close()
await mutate('sessions.kill', { sessionId: sid })
