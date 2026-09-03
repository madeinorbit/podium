/**
 * ONE CELL OF POD-2777's MATRIX, DRIVEN UNTIL IT IS MEASURABLE.
 *
 *   bun docs/evidence/pod-2792/interrupt-drive.ts <harness>
 *
 * WHY THIS EXISTS AND WHAT IT DOES NOT CHANGE. The probe is POD-2777's
 * `interrupt` probe, imported from `./probes.ts` and run through the same
 * `score()`; its control is the same sentence — "the turn observed IN FLIGHT
 * (phase=working, output growing) immediately before the interrupt" — computed
 * from the same two readings and passed in the same way. Nothing here relaxes
 * it, and a control that does not fire still REFUSES the measurement.
 *
 * WHAT IS DIFFERENT IS WHEN THE INTERRUPT IS ATTEMPTED, and only that. The
 * matrix runner sends its long prompt and then interrupts at a FIXED offset
 * (`JOIN_MS + STREAM_MS`, 33.5s) because it is measuring the streaming probe's
 * late-join ordering on the way past. On this box that fixed offset missed the
 * in-flight window on every terminal-arm harness tried — opencode was already
 * idle by 8.6s with 6.6k characters on the transcript, codex had not started at
 * all — and the cell came back REFUSED four times without ever saying whether
 * interrupt works. A refusal is the honest answer to "was this measured", and a
 * useless one to "does the stop button work on the old path", which is the
 * question this issue has to settle before anything is fixed.
 *
 * So this runner POLLS for the control instead of assuming it: it waits until
 * the phase reads `working` AND the output is observed growing, and only then
 * sends the interrupt. Waiting for a control to fire is not weakening it. The
 * one thing that would be — interrupting a turn that had already ended and
 * reading the idle that followed as success — is exactly what the control
 * exists to catch, and it still does.
 */
import {
  AGENT_KIND,
  Chat,
  login,
  mutate,
  now,
  primeTerminalTui,
  REPO,
  score,
  sessionRow,
  settle,
  wait,
} from './rig.js'
import { interrupt } from './probes.js'

const harness = process.argv[2] ?? 'opencode'
const arm = process.env.PODIUM_RUNTIME_DRIVER === 'generic-pty' ? 'terminal' : 'headless'
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
/** How long to wait for the control to fire before giving up on the cell. */
const INFLIGHT_MS = Number(process.env.P2792_INFLIGHT_MS ?? 90_000)

const log = (s: string) => console.log(s)

await login()
const created = await mutate('sessions.create', { cwd: REPO, agentKind: AGENT_KIND[harness] ?? harness })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  console.error(`sessions.create failed: ${JSON.stringify(created).slice(0, 400)}`)
  process.exit(5)
}
log('==============================================================================')
log(`INTERRUPT CELL     harness=${harness}  arm=${arm}`)
log('==============================================================================')
log(`session ${sid} created; giving the harness ${READY_MS}ms to come up`)
await wait(READY_MS)
const row0 = await sessionRow(sid)
log(`BOUND DRIVER       ${row0?.driverId} (family ${row0?.driverFamily})`)

const chat = new Chat(sid)
await chat.open()
if (arm === 'terminal') {
  const primed = await primeTerminalTui(chat, sid)
  log(`TUI PRIMING        ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
  await settle(sid)
}

// THE SAME PROMPT THE MATRIX SENDS, so the turn under interrupt is the same turn.
const longPrompt =
  'Count from 1 to 150. Put each number on its own line, and after each number ' +
  'write one full sentence about that number — a fact, a property, anything. ' +
  'Do not use any tools. Do not summarise. Write every single line.'
const t0 = now()
await mutate('sessions.sendText', { sessionId: sid, text: longPrompt })

// --- wait for the control, rather than assuming it -------------------------
// THE CONDITION IS THE MATRIX RUNNER'S, COPIED RATHER THAN RESTATED:
//
//   const working  = liveRow?.agentState?.phase === 'working'
//   const producing = late.previews.length > 0 || late.assistantText().length > 0
//
// (drive.ts, the two lines above the interrupt probe). A first pass here asked
// for output that GREW between two samples instead, which is strictly stronger
// than what the rig asks and cost a real measurement: codex/terminal publishes
// its transcript in one step — 0 chars for 33s, then 6,446 — so "grew over the
// last second" was false at every sample of a turn that was plainly in flight.
// The rig's own reading is the one that gets used.
let working = false
let detail = 'never observed in flight'
const deadline = now() + INFLIGHT_MS
while (now() < deadline) {
  await wait(1_000)
  const row = await sessionRow(sid)
  const phase = row?.agentState?.phase
  const producing = chat.previews.length > 0 || chat.assistantText().length > 0
  // A REFUSAL HAS TO BE DIAGNOSABLE. "Never observed in flight" with nothing
  // under it cannot tell a turn that never ran from a control that was watched
  // in the wrong place, and this cell has already burned four runs on that.
  log(`  +${String(now() - t0).padStart(6)}ms phase=${phase} previews=${chat.previews.length} chars=${chat.assistantText().length}`)
  if (phase === 'working' && producing) {
    working = true
    detail = `phase=working, ${chat.previews.length} preview frame(s), ${chat.assistantText().length} chars on the transcript`
    break
  }
}
log('')
log(`IN FLIGHT AFTER    ${now() - t0}ms — ${working ? 'control fired' : 'control never fired'}`)

const probe = interrupt(working, detail)
const t1 = now()
const { outcome, control } = await probe.run({
  harness,
  arm,
  sid,
  chat,
  row: row0 as never,
  results: new Map(),
  log,
} as never)
const scored = score(outcome, control)
log('')
log(`── ${probe.id} — ${probe.title}`)
log(`   ${scored.verdict}  ${scored.summary}   (${now() - t1}ms)`)
log(`   control: ${control.fired ? 'FIRED' : 'DID NOT FIRE'} — ${control.detail}`)
for (const line of scored.evidence) log(`   ${line}`)
await chat.close()
await mutate('sessions.kill', { sessionId: sid })
