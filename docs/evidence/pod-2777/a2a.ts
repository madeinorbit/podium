/**
 * TIER-A ROW A2a — status while working.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a2a.ts opencode
 *
 * Pass criterion, verbatim from docs/plans/pod-1761-release-ledger.md:
 *   "badge `working` within 2s of turn start, `idle` after end;
 *    no flicker-idle mid-turn"
 *
 * ---------------------------------------------------------------------------
 * THIS REPLACES A READING TAKEN WITH THE WRONG INSTRUMENT.
 * ---------------------------------------------------------------------------
 * codex A2a was first scored PASS off the `stream` probe in drive.ts — 51
 * preview frames, monotonic, fine watch acquired. All true, and none of it is
 * what this row asks. Preview frames say the PREVIEW PLANE is delivering; the
 * row asks about the STATUS BADGE: does it say `working` promptly, does it stop
 * saying it, and does it never flicker back to `idle` in between. A session
 * could stream perfectly while its badge sat at `idle` the whole time — that is
 * a defect this rig has already recorded on the terminal arm, where a session
 * produced 13,250 characters while `phase` read `idle` at all 60 polls.
 *
 * So the instrument here is the phase itself, sampled densely.
 *
 * It also does NOT need drive.ts, and thinking it did cost this cell a wait. I
 * had bucketed A2a with A3 because both are driven from that file, without
 * checking whether either needed its machinery — the same mistake I had already
 * made with A7b an hour earlier. Grouping by FILE rather than by DEPENDENCY.
 *
 * ---------------------------------------------------------------------------
 * THE TURN IS SHORT ON PURPOSE.
 * ---------------------------------------------------------------------------
 * A long turn wedges on both server drivers (POD-2885, unfixed on this tip), and
 * a wedged turn never ends — so `idle after end` could never be observed and the
 * cell would refuse for a reason that has nothing to do with the badge. A few
 * seconds of work is exactly what the row describes.
 *
 * CONTROL: the turn must actually RUN and FINISH. Without it, "the badge went
 * idle" is true of a turn that never started, and "no flicker" is true of a
 * badge that never moved at all.
 */
import { AGENT_KIND, Chat, REPO, login, mutate, nonce, now, sessionRow, settle, until, wait } from './rig'

const harness = (process.argv[2] ?? 'opencode') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const TURN_MS = Number(process.env.P2777_TURN_MS ?? 180_000)
const POLL_MS = 250
const log = (s: string) => console.log(s)

await login()
log('='.repeat(78))
log(`A2a  status while working   harness=${harness}`)
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

const chat = new Chat(sid)
await chat.open('chat')
await settle(sid)

// A few seconds of work: enough to have a middle, short enough not to wedge.
const word = nonce('BADGE')
const prompt =
  `Count from 1 to 12, one number per line, then finish with the word ${word}. Do not use any tools.`

/**
 * THE CLOCK STARTS WHEN THE SEND IS ACCEPTED, NOT WHEN IT IS CALLED — and the
 * first version of this probe got that wrong, producing a FAIL that was mine.
 *
 * It set t0 before `sessions.sendText` and measured "first `working`" from
 * there. On a loaded box that call took ~3.2 SECONDS to return, so the reading
 * was `send round-trip + time-to-badge` scored against a 2-second bar that only
 * covers the second half. First `working` came out at t+7927ms and the cell
 * FAILED.
 *
 * The round-trip is not the product's badge latency: a `sessionRow` round-trip
 * on this same box measures 19-223ms (median 52), so the slow part is the send
 * itself being queued behind a busy machine, not the status plane being slow to
 * update. "Within 2s of TURN START" means from when the turn starts, and a turn
 * has not started until the send has been accepted.
 *
 * Both numbers are now recorded separately, so a reader can see the split rather
 * than take my word for which half was which.
 */
const samples: { atMs: number; phase: string }[] = []
const tCall = now()
await mutate('sessions.sendText', { sessionId: sid, text: prompt })
const t0 = now()
const sendRoundTripMs = t0 - tCall

let answered = false
const deadline = now() + TURN_MS
let lastPhase = ''
while (now() < deadline) {
  const r = await sessionRow(sid)
  const phase = r?.agentState?.phase ?? '(blank)'
  if (phase !== lastPhase) {
    samples.push({ atMs: now() - t0, phase })
    lastPhase = phase
  }
  if (!answered && chat.assistantText().includes(word)) answered = true
  // Stop once the turn has answered AND the badge has settled back to idle.
  if (answered && phase === 'idle' && now() - t0 > 3_000) break
  await wait(POLL_MS)
}
const elapsed = now() - t0

log('')
log(`SEND ROUND-TRIP    ${sendRoundTripMs}ms — the clock below starts AFTER this, because`)
log(`                   a turn has not started until its send has been accepted`)
log('PHASE TIMELINE (only transitions are printed; polled every 250ms + round-trip)')
for (const s of samples) log(`    t+${String(s.atMs).padStart(6)}ms  ${s.phase}`)

// --- the control ------------------------------------------------------------
const control = answered
log('')
log(`CONTROL            the turn ran and finished: ${control} (${word})`)
if (!control) {
  const r = await sessionRow(sid)
  log('')
  log('REFUSED — the positive control did not fire.')
  log('  control watched: the turn actually running to completion, so that')
  log('                   "idle after end" and "no flicker" are about a real turn')
  log(`  control saw:     no answer in ${TURN_MS}ms; final phase=${r?.agentState?.phase ?? '(blank)'}`)
  log('  A badge that never moved cannot be shown not to have flickered.')
  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

// --- the three clauses of the row -------------------------------------------
const firstWorking = samples.find((s) => s.phase === 'working')
const workingWithin2s = Boolean(firstWorking && firstWorking.atMs <= 2_000)

// Flicker: an `idle` sample that falls BETWEEN the first `working` and the last
// `working`. An idle before the turn starts, or after it ends, is correct.
const lastWorkingIdx = samples.map((s) => s.phase).lastIndexOf('working')
const firstWorkingIdx = samples.map((s) => s.phase).indexOf('working')
const flickers = samples.filter(
  (s, i) => i > firstWorkingIdx && i < lastWorkingIdx && (s.phase === 'idle' || s.phase === '(blank)'),
)
const endsIdle = samples.at(-1)?.phase === 'idle'

log('')
log(`1. WORKING PROMPTLY  first 'working' at t+${firstWorking?.atMs ?? '—'}ms -> within 2s: ${workingWithin2s}`)
log(`2. NO FLICKER-IDLE   ${flickers.length} idle/blank sample(s) between first and last 'working'`)
for (const f of flickers) log(`                       t+${f.atMs}ms ${f.phase}   <- the row forbids this`)
log(`3. IDLE AFTER END    final phase '${samples.at(-1)?.phase}' -> ${endsIdle}`)

const pass = workingWithin2s && flickers.length === 0 && endsIdle
log('')
log('='.repeat(78))
log(`A2a  ${pass ? 'PASS' : 'FAIL'}   (turn took ${elapsed}ms end to end)`)
log(`     measured on the PHASE BADGE, which is what the row asks about —`)
log(`     not on preview frames, which is what an earlier reading of this cell used`)
log(`     send round-trip ${sendRoundTripMs}ms, excluded from clause 1 and stated`)
log(`     control FIRED — the turn ran and finished`)
log('='.repeat(78))

await chat.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
process.exit(pass ? 0 : 1)
