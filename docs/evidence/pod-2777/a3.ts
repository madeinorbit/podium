/**
 * TIER-A ROW A3 — interrupt a running turn.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a3.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "turn stops; transcript shows interrupt; refused interrupt says why"
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT NEED drive.ts, AND FINDING THAT OUT IS THE FOURTH TIME TODAY.
 * ---------------------------------------------------------------------------
 * I had A3 listed as blocked on BOTH POD-2885 and the `test:heavy` lock, on the
 * grounds that it runs through `drive.ts` and therefore needs a clean pin and a
 * bundle rebuild. Only the first of those is true.
 *
 * The `interrupt` probe reads exactly ONE field off the drive context — `ctx.sid`
 * — and establishes everything else itself: its own socket, opened immediately
 * before its own long turn, precisely so it is not measuring whatever turn some
 * earlier probe left running. So all it needs is a session id.
 *
 * That is the same mis-scoping I made with A7b (thought it needed drive.ts, did
 * not), A2a (same), and switching arms (thought it needed a rebuild; the arm is
 * a daemon-level setting and needs a daemon restart). Four times, all of them
 * assumptions about MY OWN TOOLING rather than about the product — which is the
 * harder kind to catch, because I wrote the thing I was assuming about.
 *
 * The lesson that generalises: GROUPING BY FILE IS NOT GROUPING BY DEPENDENCY.
 * Three probes living in `drive.ts` does not make them need `drive.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT STILL NEEDS, AND WHY IT WILL REFUSE UNTIL THEN.
 * ---------------------------------------------------------------------------
 * POD-2885. The probe's control is the turn observed IN FLIGHT in the moment
 * before the interrupt — because interrupting nothing always looks like success.
 * While long turns wedge, both the preview plane and the durable transcript
 * freeze within ~20 seconds, so by the time the control samples there is no
 * motion to see and the cell correctly REFUSES. That refusal is right, and it is
 * about POD-2885 rather than about interrupt.
 *
 * Run it anyway after POD-2885 lands: the refusal turning into a score IS the
 * signal that the wedge fix reached this path.
 *
 * The pin is verified by hand and printed, under POD-1761's stale-bundle ruling
 * of 2026-08-26 16:20 CEST, exactly as `a7a.ts`, `a7b.ts`, `a8.ts`, `a9.ts` and
 * `a2a.ts` do.
 */
import { readFileSync } from 'node:fs'
import { AGENT_KIND, Chat, REPO, login, mutate, now, score, sessionRow, settle, until, wait } from './rig'
import type { Ctx } from './probes'
import { interrupt } from './probes'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'
const log = (s: string) => console.log(s)

await login()
log('='.repeat(78))
log(`A3  interrupt a running turn   harness=${harness}`)
log('='.repeat(78))

// --- the pin, by hand, printed --------------------------------------------
for (const name of ['server', 'daemon']) {
  try {
    const pid = readFileSync(`${DRIVE_BASE}/${name}.pid`, 'utf8').trim()
    const sha = readFileSync(`${DRIVE_BASE}/${name}.sha`, 'utf8').trim().slice(0, 9)
    log(`  pin  ${name.padEnd(6)} pid=${pid} spawned at ${sha}`)
  } catch {
    log(`  pin  ${name}: no pidfile — is the rig up?`)
  }
}
log(`  host load ${readFileSync('/proc/loadavg', 'utf8').split(' ')[0]}`)
log('')

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

// The probe wants a context; it reads `sid` and nothing else, but the shape is
// filled in honestly rather than cast, so a future probe that starts reading
// another field fails loudly here instead of seeing undefined.
const arm: 'headless' | 'terminal' = (row0?.driverFamily === 'terminal') ? 'terminal' : 'headless'
const ctx: Ctx = {
  harness,
  arm,
  sid,
  chat,
  row: row0 as NonNullable<typeof row0>,
  results: new Map(),
  log,
}

const t0 = now()
const { outcome, control } = await interrupt.run(ctx)
const scored = score(outcome, control)

log('')
log(`── ${interrupt.id} — ${interrupt.title}`)
log(`   ${scored.verdict}  ${scored.summary}`)
log(`   control: ${control.fired ? 'FIRED' : 'DID NOT FIRE'} — ${control.detail}`)
for (const line of scored.evidence) log(`   ${line}`)
log(`   ELAPSED ${now() - t0}ms`)

if (!control.fired) {
  log('')
  log('   NOTE: while POD-2885 is unfixed this refusal is EXPECTED and is about the')
  log('   wedge, not about interrupt. Both planes freeze within ~20s of a long turn,')
  log('   so there is no motion left to observe in the moment before the call.')
  log('   When this cell starts SCORING instead of refusing, that is the signal the')
  log('   wedge fix reached this path.')
}

await chat.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
process.exit(scored.verdict === 'PASS' ? 0 : scored.verdict === 'REFUSED' ? 3 : 1)
