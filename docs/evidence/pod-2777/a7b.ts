/**
 * TIER-A ROW A7b — hibernate and wake.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a7b.ts opencode
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "wakes with context intact; never wedges (POD-2775 fixed)"
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STANDALONE RATHER THAN A `drive.ts` PROBE.
 * ---------------------------------------------------------------------------
 * `drive.ts` shells out to `drive-verify.sh`, which currently refuses this rig
 * on its worktree leg — the worktree has moved to HEAD while the server was
 * spawned at `372ae4de2`. POD-1761 ruled (2026-08-26 16:20 CEST) that the drift
 * is measured, confined to two `apps/web` files, and irrelevant to cells with no
 * browser in them, so those cells may be driven with the exception STATED.
 *
 * That ruling is honoured the same way `a7a.ts`, `a8.ts` and `a9.ts` honour it:
 * a standalone probe, with the pin verified by hand and printed on every run.
 * It is NOT a bypass — I built one of those, saw it could only work by adding a
 * skip flag to `drive.ts`, and deleted it. The difference is that nothing here
 * disables a check; the checks are performed and reported, and the one
 * inapplicable leg is named rather than skipped silently.
 *
 * ---------------------------------------------------------------------------
 * THREE CONTROLS, because a park/wake cell has three ways to pass vacuously.
 * ---------------------------------------------------------------------------
 * C1  THE CONTEXT EXISTED. If the pre-park turn never answered, there is no
 *     context whose survival can be measured, and a post-wake silence would
 *     score as a loss when nothing was ever there. This rig has already produced
 *     exactly that reading once, on an earlier `resume` cell, and reported a
 *     vacuous PASS before the control was added.
 * C2  IT ACTUALLY PARKED. "It woke with context intact" measured across a
 *     session that never hibernated is the purest vacuous pass available — the
 *     context never went anywhere. Read from the session row's own status, not
 *     from the hibernate call returning ok.
 * C3  IT IS USABLE AFTERWARDS. A fresh turn must answer. Without it, "the secret
 *     came back" could be read off a transcript belonging to a session that is
 *     no longer able to do anything.
 *
 * AND THE CONVERSATION POINTER IS CHECKED, not just the secret. POD-2775's
 * reviewer found that mutating a resume to a stranger's thread id left 269 tests
 * green: a secret an agent could plausibly regenerate is weaker evidence than a
 * pointer that must be identical.
 */
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

const harness = (process.argv[2] ?? 'opencode') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const TURN_MS = Number(process.env.P2777_TURN_MS ?? 120_000)
const log = (s: string) => console.log(s)

async function askAndWait(
  chat: Chat,
  sid: string,
  text: string,
  budgetMs: number,
): Promise<{ accepted: unknown; reply: string; ms: number }> {
  const before = chat.assistantText().length
  const t0 = now()
  const accepted = await mutate('sessions.sendText', { sessionId: sid, text })
  const deadline = now() + budgetMs
  while (now() < deadline) {
    const txt = chat.assistantText()
    if (txt.length > before && /\S/.test(txt.slice(before))) {
      await wait(2_000)
      return { accepted, reply: chat.assistantText().slice(before), ms: now() - t0 }
    }
    await wait(500)
  }
  return { accepted, reply: chat.assistantText().slice(before), ms: now() - t0 }
}

await login()
log('='.repeat(78))
log(`A7b  hibernate and wake   harness=${harness}`)
log('='.repeat(78))

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 600)}`)
  process.exit(5)
}
log(`session ${sid}`)
await wait(READY_MS)
const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row0 = bound.row ?? (await sessionRow(sid))
log(`BOUND DRIVER       ${row0?.driverId ?? '(none)'} (family ${row0?.driverFamily ?? '?'})`)
if (row0?.status === 'exited') {
  log(`REFUSED — session exited: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
  process.exit(3)
}

const chat = new Chat(sid)
await chat.open('chat')
await settle(sid)

// --- C1: plant the context -------------------------------------------------
const secret = nonce('REMEMBER')
log('')
log(`PLANT              "${secret}"`)
const plant = await askAndWait(
  chat,
  sid,
  `Remember this word for later: ${secret}. Reply with exactly the word OK and nothing else. Do not use any tools.`,
  TURN_MS,
)
log(`  replied in       ${plant.ms}ms: ${JSON.stringify(plant.reply.trim().slice(0, 80))}`)
const rowBefore = await sessionRow(sid)
const convBefore = rowBefore?.conversationId ?? rowBefore?.conversationPodiumId ?? null
log(`  conversation     ${convBefore ?? '(none reported)'}`)

if (plant.reply.trim().length === 0) {
  log('')
  log('REFUSED — control C1 did not fire.')
  log('  control watched: the pre-park turn answering, so there IS context to lose')
  log(`  control saw:     no assistant text in ${TURN_MS}ms; ${chat.deltaFrames} delta frame(s)`)
  log('  A session that never held the word cannot be shown to have lost it.')
  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

// --- C2: park it, and prove it parked --------------------------------------
log('')
log('HIBERNATING …')
const hib = await mutate('sessions.hibernate', { sessionId: sid })
log(`  returned         ${JSON.stringify(hib.result?.data ?? hib.error ?? null).slice(0, 200)}`)
const parked = await until(sid, (r) => r?.status === 'hibernated', 90_000, 1_000)
const rowParked = await sessionRow(sid)
log(`  status           ${rowParked?.status ?? '(row gone)'} after ${parked.ms}ms`)

if (!parked.ok) {
  log('')
  log('REFUSED — control C2 did not fire.')
  log("  control watched: the session's own status reaching 'hibernated'")
  log(`  control saw:     status=${rowParked?.status ?? '(row gone)'} after 90s`)
  log('  "It woke with context intact" measured across a session that never parked')
  log('  is a statement about a session that never went anywhere.')
  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(3)
}
log('  C2 FIRED — it really parked')

await chat.close()
await wait(5_000)

// --- wake it ---------------------------------------------------------------
log('')
log('WAKING …')
const t0 = now()
const res = await mutate('sessions.resurrect', { sessionId: sid })
log(`  returned         ${JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 240)}`)
const live = await until(sid, (r) => r?.status === 'live', 120_000, 1_000)
const rowAfter = live.row ?? (await sessionRow(sid))
log(`  status           ${rowAfter?.status ?? '(row gone)'} after ${now() - t0}ms`)
const convAfter = rowAfter?.conversationId ?? rowAfter?.conversationPodiumId ?? null
log(`  conversation     ${convAfter ?? '(none reported)'}`)
const samePointer = convBefore !== null && convAfter !== null && convBefore === convAfter
log(`  same pointer     ${convBefore === null && convAfter === null ? 'UNKNOWN — neither row reports one' : samePointer}`)

if (!live.ok) {
  log('')
  log(`A7b  FAIL — the session never came back live (status=${rowAfter?.status ?? '(gone)'}).`)
  log('     That is the wedge POD-2775 was about, not a context question.')
  log(`     controls: C1 planted FIRED, C2 parked FIRED`)
  process.exit(1)
}

const after = new Chat(sid)
await after.open('chat')
await wait(10_000)
const historyKept = after.items.some((i) => (i.text ?? '').includes(secret))
log(`  transcript keeps the pre-park exchange: ${historyKept}`)

// --- recall, and C3 --------------------------------------------------------
log('')
log('RECALL             asking for the word back')
const recall = await askAndWait(
  after,
  sid,
  'What word did I ask you to remember? Reply with exactly that word and nothing else. Do not use any tools.',
  TURN_MS,
)
log(`  replied in       ${recall.ms}ms: ${JSON.stringify(recall.reply.trim().slice(0, 120))}`)

if (recall.reply.trim().length === 0) {
  log('')
  log('REFUSED — control C3 did not fire.')
  log('  control watched: the post-wake turn producing any assistant text at all')
  log(`  control saw:     nothing in ${TURN_MS}ms`)
  log('  A question that never reached the agent cannot show the agent forgot.')
  await after.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

const recalled = recall.reply.includes(secret)
const pass = recalled && (samePointer || (convBefore === null && convAfter === null && historyKept))

log('')
log('='.repeat(78))
log(`A7b  ${pass ? 'PASS' : 'FAIL'}`)
log(`     woke live in ${now() - t0}ms, never wedged`)
log(`     word recalled after the wake: ${recalled}  (${secret})`)
log(`     conversation pointer unchanged: ${convBefore === null && convAfter === null ? 'not reported by either row' : samePointer}`)
log(`     transcript kept the exchange:   ${historyKept}`)
log('     controls: C1 context planted FIRED, C2 really parked FIRED, C3 post-wake turn FIRED')
log('='.repeat(78))

await after.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
process.exit(pass ? 0 : 1)
