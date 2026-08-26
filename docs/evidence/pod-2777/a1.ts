/**
 * TIER-A ROWS A1b and A1c — sending when the session cannot take it now.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a1.ts codex
 *
 * Pass criteria, from docs/plans/pod-1761-release-ledger.md:
 *   A1b  "shows `queued` with position; survives a page reload; delivered when idle"
 *   A1c  "typed refusal or resume-and-send offered; never a lost message"
 *
 * ---------------------------------------------------------------------------
 * BOTH ROWS ARE ABOUT A MESSAGE NOT BEING LOST, SO BOTH FOLLOW THE MESSAGE.
 * ---------------------------------------------------------------------------
 * The tempting shortcut is to read the send's return value and stop. That
 * answers "was I told something reasonable", not "did my message arrive" — and
 * the two came apart on this epic before: a send answered `{ok:true}` while the
 * turn it claimed to have queued never ran. So each row plants a NONCE and then
 * looks for that nonce in the place it was promised to end up.
 *
 * A1b's "survives a page reload" is driven as a real reload: the websocket is
 * CLOSED and a new one opened, which is what the browser does. A queue that
 * lives in the open connection would pass a check that never drops the socket.
 */
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  nonce,
  now,
  query,
  sessionRow,
  settle,
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const log = (s: string) => console.log(s)

let a1bVerdict = 'NOT RUN'
let a1cVerdict = 'NOT RUN'

await login()
log('='.repeat(78))
log(`A1b / A1c  sending when the session cannot take it now   harness=${harness}`)
log('='.repeat(78))

// ===========================================================================
// A1b — send while busy
// ===========================================================================
log('')
log('A1b  send while busy')
log('-'.repeat(78))

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 600)}`)
  process.exit(5)
}
log(`  session ${sid}`)
await wait(READY_MS)
const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row0 = bound.row ?? (await sessionRow(sid))
log(`  driver           ${row0?.driverId ?? '(none)'} (family ${row0?.driverFamily ?? '?'})`)
if (row0?.status === 'exited') {
  log(`  SESSION EXITED   spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
  log('  REFUSED — nothing to send to.')
  process.exit(3)
}

let chat = new Chat(sid)
await chat.open('chat')
await settle(sid)

// Make it busy with a turn long enough to send into. Counting to 40 out loud is
// slow for a model and needs no tools, so the session is genuinely occupied
// rather than merely slow to start.
const busyWord = nonce('BUSY')
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Count slowly from 1 to 40, writing each number on its own line, then finish with the word ${busyWord}. Do not use any tools.`,
})

// CONTROL: it must actually be working before a "send while busy" means anything.
const becameBusy = await until(sid, (r) => r?.agentState?.phase === 'working', 60_000, 500)
log(`  CONTROL          phase reached 'working': ${becameBusy.ok} (${becameBusy.ms}ms)`)

if (!becameBusy.ok) {
  const r = await sessionRow(sid)
  log('  REFUSED — the positive control did not fire.')
  log("  control watched: the session reporting phase 'working' before the second send")
  log(`  control saw:     phase=${r?.agentState?.phase ?? '(blank)'} after 60s`)
  log('  A send that is not "while busy" measures the ordinary send path.')
  a1bVerdict = 'REFUSED'
} else {
  const queuedWord = nonce('QUEUED')
  const sendRes = await mutate('sessions.sendText', {
    sessionId: sid,
    text: `Reply with exactly this word and nothing else: ${queuedWord}. Do not use any tools.`,
  })
  const data = sendRes.result?.data as Record<string, unknown> | undefined
  log(`  second send      ${JSON.stringify(data ?? sendRes.error ?? null).slice(0, 240)}`)

  const disposition = String(data?.disposition ?? '')
  const saysQueued = disposition === 'queued' || disposition === 'enqueued'
  // Look for a position EVERYWHERE a chat caller could find one, not only in
  // the mutation's return: the send result, and every frame on the socket.
  await wait(4_000)
  const positionInReturn = data?.position ?? data?.queuePosition
  const positionFrames = chat.positionFrames
  const positionAnywhere =
    positionInReturn ??
    positionFrames
      .map((f) => (f as Record<string, unknown>).position ?? (f as Record<string, unknown>).queuePosition)
      .find((v) => v !== undefined)
  log(`  disposition      ${JSON.stringify(disposition)}`)
  log(`  position in the send's return: ${positionInReturn ?? '(absent)'}`)
  log(`  position in any socket frame:  ${positionFrames.length === 0 ? '(no frame carried one)' : JSON.stringify(positionFrames.slice(0, 2))}`)
  log(`  frames seen      ${chat.frameSummary()}`)
  const position = positionAnywhere

  // --- the reload: drop the socket entirely and open a new one -------------
  await chat.close()
  await wait(3_000)
  const listedAfterReload = await query('sessions.queue', { sessionId: sid }).catch(() => null)
  chat = new Chat(sid)
  await chat.open('chat')
  await wait(5_000)
  const queueVisible = JSON.stringify(listedAfterReload?.result?.data ?? null)
  log(`  after reload     sessions.queue -> ${queueVisible.slice(0, 240)}`)

  // --- delivered when idle -------------------------------------------------
  log('  waiting for the busy turn to finish and the queued one to run …')
  const delivered = await (async () => {
    const dl = now() + 240_000
    while (now() < dl) {
      if (chat.assistantText().includes(queuedWord)) return true
      await wait(2_000)
    }
    return false
  })()
  const busyFinished = chat.assistantText().includes(busyWord)
  log(`  busy turn ended  ${busyFinished} (${busyWord})`)
  log(`  queued delivered ${delivered} (${queuedWord})`)

  const reloadSurvived = queueVisible !== 'null' || delivered
  // STRICT ON POSITION, and this is a correction against my own first scoring.
  // The first run scored PASS on `delivered && saysQueued`, silently dropping
  // the two words "with position" from the row's criterion. The message not
  // being lost and the caller being able to say WHERE IN THE QUEUE it is are
  // different promises, and only one of them was measured.
  const hasPosition = position !== undefined && position !== null
  a1bVerdict = delivered && saysQueued && hasPosition ? 'PASS' : delivered ? 'PARTIAL' : 'FAIL'
  log('')
  log(`  A1b ${a1bVerdict}`)
  log(`      queued with position: ${saysQueued ? `yes (${disposition}, position ${position ?? 'not reported'})` : `NO — disposition was ${JSON.stringify(disposition)}`}`)
  log(`      survived a real reload (socket closed and reopened): ${reloadSurvived}`)
  log(`      delivered when idle: ${delivered}`)
  if (delivered && saysQueued && !hasPosition) {
    log('      PARTIAL, not PASS: the message was NOT lost — it reported itself as')
    log('      queued, survived the reload and ran when the session went idle — but NO')
    log('      POSITION reached the caller, on the return or on any socket frame.')
    log('      The product does compute one (runtime-gateway.ts:49, 1-based, read off')
    log('      the real queue depth); sessions.sendText narrows its reply to four')
    log('      pinned keys (command-plane.ts:459) and position is not among them, and')
    log('      the receipt that does carry it travels the MESSAGE path, not the chat')
    log('      one. So a chat UI cannot show a person where they are in a queue.')
  }
  if (delivered && !saysQueued) {
    log('      PARTIAL, not PASS: the message was NOT lost — it ran and answered — but')
    log('      the send did not report itself as queued with a position, which is half')
    log('      of what the row asks for. A caller cannot show a person where they are')
    log('      in a queue it was never told about.')
  }
}

// ===========================================================================
// A1c — send to a dead session
// ===========================================================================
log('')
log('A1c  send to a DEAD session')
log('-'.repeat(78))

const c2 = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid2 = c2.result?.data?.sessionId as string | undefined
if (!sid2) {
  log(`  sessions.create FAILED: ${JSON.stringify(c2).slice(0, 400)}`)
  a1cVerdict = 'REFUSED'
} else {
  log(`  session ${sid2}`)
  await wait(READY_MS)
  await until(sid2, (r) => Boolean(r?.driverId), 90_000, 1_000)
  const chat2 = new Chat(sid2)
  await chat2.open('chat')
  await settle(sid2)

  // CONTROL: a send to this session works WHILE IT IS ALIVE. Without it, a
  // refusal after the kill could just be a send path that never worked.
  const aliveWord = nonce('ALIVE')
  await mutate('sessions.sendText', {
    sessionId: sid2,
    text: `Reply with exactly this word and nothing else: ${aliveWord}. Do not use any tools.`,
  })
  const aliveOk = await (async () => {
    const dl = now() + 90_000
    while (now() < dl) {
      if (chat2.assistantText().includes(aliveWord)) return true
      await wait(1_000)
    }
    return false
  })()
  log(`  CONTROL          a send to this session WHILE ALIVE was answered: ${aliveOk}`)

  if (!aliveOk) {
    log('  REFUSED — the positive control did not fire.')
    log('  control watched: a send succeeding while the session is alive')
    log('  control saw:     no reply in 90s')
    log('  A send path that never worked cannot show how it refuses a dead session.')
    a1cVerdict = 'REFUSED'
  } else {
    await mutate('sessions.kill', { sessionId: sid2 })
    await wait(10_000)
    const deadRow = await sessionRow(sid2)
    log(`  after kill       row: ${deadRow ? `status=${deadRow.status}` : '(row gone entirely)'}`)

    const deadWord = nonce('AFTERDEATH')
    const res = await mutate('sessions.sendText', {
      sessionId: sid2,
      text: `Reply with exactly this word and nothing else: ${deadWord}.`,
    })
    const d = res.result?.data as Record<string, unknown> | undefined
    log(`  send to dead     ${JSON.stringify(d ?? res.error ?? null).slice(0, 300)}`)

    // A typed refusal: an explicit negative outcome carrying a reason, or a
    // thrown error naming the situation, or an offer to resume-and-send.
    const errMsg = String(res.error?.message ?? res.error?.json?.message ?? '')
    const reason = String(d?.reason ?? d?.disposition ?? '')
    const typedRefusal =
      (d?.ok === false && reason.length > 0) ||
      (Boolean(res.error) && errMsg.length > 0) ||
      /resume/i.test(reason)
    const offersResume = /resume/i.test(reason) || /resume/i.test(errMsg)
    // The one outcome the row forbids outright.
    const silentlyAccepted = d?.ok === true && !/refus|dead|gone|unknown/i.test(reason)

    log(`  typed refusal    ${typedRefusal}${typedRefusal ? ` — reason=${JSON.stringify(reason || errMsg.slice(0, 120))}` : ''}`)
    log(`  offers resume    ${offersResume}`)
    log(`  silently accepted (the forbidden outcome): ${silentlyAccepted}`)

    a1cVerdict = typedRefusal && !silentlyAccepted ? 'PASS' : 'FAIL'
    log('')
    log(`  A1c ${a1cVerdict}`)
    if (silentlyAccepted) {
      log('      FAIL: the send was accepted for a session that is gone. That is the')
      log('      "lost message" the row exists to forbid — the caller has no way to')
      log('      know their text will never be delivered.')
    }
    await chat2.close()
  }
}

await chat.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})

log('')
log('='.repeat(78))
log(`A1b  ${a1bVerdict}`)
log(`A1c  ${a1cVerdict}`)
log('='.repeat(78))
process.exit(a1bVerdict === 'PASS' && a1cVerdict === 'PASS' ? 0 : 1)
