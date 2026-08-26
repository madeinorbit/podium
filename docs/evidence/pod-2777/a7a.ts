/**
 * TIER-A ROW A7a — daemon restart.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a7a.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "session survives or auto-resumes as the SAME conversation
 *    (asks it to recall a codeword from before)"
 *
 * ---------------------------------------------------------------------------
 * THREE CONTROLS, because this row has three separate ways to pass vacuously.
 * ---------------------------------------------------------------------------
 *
 * C1 — THE CODEWORD WAS PLANTED. If the pre-restart turn never answered, there
 *      is no conversation whose survival could be measured, and a post-restart
 *      silence would score as a loss when nothing was ever there. This is the
 *      exact shape that made an earlier `resume` cell on this rig report a
 *      vacuous PASS.
 *
 * C2 — THE DAEMON ACTUALLY RESTARTED. Measured as a CHANGED PID, read back from
 *      restart-daemon.sh, not from the fact that a restart script was called.
 *      "Survived a restart" across a daemon that never restarted is the purest
 *      vacuous pass available, and it is invisible in every other number here.
 *
 * C3 — THE POST-RESTART TURN WAS DELIVERED AT ALL. A send that is refused, or
 *      that never produces an assistant item, means the recall question never
 *      reached the agent — which is a different finding from an agent that
 *      answered and had forgotten. Reported separately.
 *
 * AND THE CONVERSATION POINTER IS CHECKED, not just the word. POD-2775's
 * reviewer found that nothing asserted a resumed session was the RIGHT
 * conversation: mutating a resume to a stranger's thread id left 269 tests
 * green. A codeword an agent could plausibly regenerate is a weaker signal than
 * a pointer that must be identical, so this row reports both and passes only on
 * both.
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
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const TURN_MS = Number(process.env.P2777_TURN_MS ?? 90_000)

const log = (s: string) => console.log(s)

async function askAndWait(
  chat: Chat,
  sid: string,
  text: string,
  budgetMs: number,
): Promise<{ accepted: unknown; reply: string; ms: number }> {
  const before = chat
    .assistantText()
    .length
  const t0 = now()
  const accepted = await mutate('sessions.sendText', { sessionId: sid, text })
  const deadline = now() + budgetMs
  while (now() < deadline) {
    const txt = chat.assistantText()
    if (txt.length > before && /\S/.test(txt.slice(before))) {
      // Let a short reply finish arriving rather than reading the first token.
      await wait(2_000)
      return { accepted, reply: chat.assistantText().slice(before), ms: now() - t0 }
    }
    await wait(500)
  }
  return { accepted, reply: chat.assistantText().slice(before), ms: now() - t0 }
}

await login()
log('='.repeat(78))
log(`A7a  daemon restart — same conversation?   harness=${harness}`)
log('='.repeat(78))

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
if (row0?.status === 'exited') {
  log(`SESSION EXITED     spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
}

const chat = new Chat(sid)
await chat.open('chat')

// --- C1: plant the codeword ------------------------------------------------
const codeword = nonce('CODEWORD')
log('')
log(`PLANT              "${codeword}"`)
const plant = await askAndWait(
  chat,
  sid,
  `Remember this codeword for later: ${codeword}. Reply with exactly the word OK and nothing else. Do not use any tools.`,
  TURN_MS,
)
log(`  send accepted    ${JSON.stringify(plant.accepted?.result?.data ?? plant.accepted).slice(0, 160)}`)
log(`  replied in       ${plant.ms}ms: ${JSON.stringify(plant.reply.trim().slice(0, 120))}`)

const c1Fired = plant.reply.trim().length > 0
const rowBefore = await sessionRow(sid)
const convBefore = rowBefore?.conversationId ?? rowBefore?.conversationPodiumId ?? null
log(`  conversation     ${convBefore ?? '(none reported)'}`)

if (!c1Fired) {
  log('')
  log('REFUSED — control C1 did not fire.')
  log('  control watched: the pre-restart turn answering at all, so that there IS a')
  log('                   conversation whose survival can be measured')
  log(`  control saw:     no assistant text in ${TURN_MS}ms; ${chat.deltaFrames} transcriptDelta frame(s)`)
  log(`  session status:  ${rowBefore?.status ?? '?'}  driver ${rowBefore?.driverId ?? '(none)'}`)
  log('  A session that never held the codeword cannot be shown to have lost it.')
  await chat.close()
  process.exit(3)
}

// --- C2: restart the daemon, and prove it restarted ------------------------
log('')
log('RESTARTING THE DAEMON …')
const restart = spawnSync('bash', [`${import.meta.dir}/restart-daemon.sh`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const out = `${restart.stdout ?? ''}${restart.stderr ?? ''}`
const oldPid = /OLD_DAEMON_PID=(\d+)/.exec(out)?.[1]
const newPid = /NEW_DAEMON_PID=(\d+)/.exec(out)?.[1]
const reconnected = /DAEMON_RECONNECTED=1/.test(out)
log(`  old pid          ${oldPid ?? '(not reported)'}`)
log(`  new pid          ${newPid ?? '(not reported)'}`)
log(`  reconnected      ${reconnected}`)

const c2Fired = Boolean(oldPid && newPid && oldPid !== newPid && reconnected)
if (!c2Fired) {
  log('')
  log('REFUSED — control C2 did not fire.')
  log('  control watched: the daemon pid CHANGING and the new daemon reconnecting')
  log(`  control saw:     old=${oldPid ?? '?'} new=${newPid ?? '?'} reconnected=${reconnected}`)
  log(`  restart script exit ${restart.status}; output:`)
  for (const l of out.trim().split('\n').slice(-8)) log(`    ${l}`)
  log('  Measuring survival across a daemon that did not restart proves nothing.')
  await chat.close()
  process.exit(3)
}

// The client socket rides the SERVER, which was left up, so the chat stays
// open across the daemon restart. Re-open anyway: an operator who reloads the
// page is the case the row is really about, and a fresh socket also proves the
// history is durable rather than held in this connection's memory.
await chat.close()
await wait(10_000)
const after = new Chat(sid)
await after.open('chat')
await wait(15_000)

const rowAfter = await sessionRow(sid)
const convAfter = rowAfter?.conversationId ?? rowAfter?.conversationPodiumId ?? null
log('')
log(`AFTER RESTART      status ${rowAfter?.status ?? '?'}  driver ${rowAfter?.driverId ?? '(none)'}`)
log(`  conversation     ${convAfter ?? '(none reported)'}`)
const samePointer = convBefore !== null && convAfter !== null && convBefore === convAfter
log(
  `  same pointer     ${convBefore === null && convAfter === null ? 'UNKNOWN — neither row reports a conversation id' : samePointer}`,
)

// The pre-restart exchange should still be in the transcript a fresh client is
// served. This is separate from recall: it is Podium's own history, not the
// agent's memory.
const historyHasPlant = after.items.some((i) => (i.text ?? '').includes(codeword))
log(`  transcript keeps the pre-restart exchange: ${historyHasPlant}`)

// --- C3 + the measurement: ask it to recall --------------------------------
log('')
log('RECALL             asking for the codeword back')
const recall = await askAndWait(
  after,
  sid,
  'What was the codeword I asked you to remember? Reply with exactly that word and nothing else. Do not use any tools.',
  TURN_MS,
)
const accepted = JSON.stringify(recall.accepted?.result?.data ?? recall.accepted)
log(`  send accepted    ${accepted.slice(0, 200)}`)
log(`  replied in       ${recall.ms}ms: ${JSON.stringify(recall.reply.trim().slice(0, 160))}`)

const c3Fired = recall.reply.trim().length > 0
if (!c3Fired) {
  log('')
  log('REFUSED — control C3 did not fire.')
  log('  control watched: the post-restart turn producing any assistant text at all')
  log(`  control saw:     nothing in ${TURN_MS}ms; send answered ${accepted.slice(0, 200)}`)
  log('  A question that never reached the agent cannot show the agent forgot.')
  await after.close()
  process.exit(3)
}

const recalled = recall.reply.includes(codeword)
const pass = recalled && (samePointer || (convBefore === null && convAfter === null && historyHasPlant))

log('')
log('='.repeat(78))
log(`A7a  ${pass ? 'PASS' : 'FAIL'}`)
log(`     codeword recalled after restart: ${recalled}  (${codeword})`)
log(`     conversation pointer unchanged:  ${convBefore === null && convAfter === null ? 'not reported by either row' : samePointer}`)
log(`     transcript kept the exchange:    ${historyHasPlant}`)
log(`     controls: C1 plant FIRED, C2 daemon pid ${oldPid}->${newPid} FIRED, C3 recall turn FIRED`)
log('='.repeat(78))

await after.close()
await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
process.exit(pass ? 0 : 1)
