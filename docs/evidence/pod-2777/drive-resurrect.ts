/**
 * POD-1761: is resurrect's 'exited' reproducible on the CURRENT tip, and if so
 * WHY — the daemon log for that session is the thing nobody has looked at.
 *
 * What is already established and shapes this measurement:
 *  - both verbs settle the row ASYNCHRONOUSLY (~10s), so 'resumeAndSend blocks
 *    and resurrect does not' is dead; my earlier 'live after 6217ms' was a poll
 *    loop, not a call that waited.
 *  - A HEALTHY WAKE NEVER PASSES THROUGH `exited`. The intermediate state is
 *    `starting`. `exited` is TERMINAL. So a window that is merely too early
 *    shows `starting`, never `exited` — a drive that read `exited` read a
 *    genuine failure, and sampling cannot explain it away.
 *
 * So this captures the three things together, in one artefact:
 *   1. the row status series at 0/1/2/5/10/15/20s
 *   2. the DAEMON LOG for this session across the same window
 *   3. the binding journal before and after
 */
import { Chat, login, mutate, REPO, sessionRow, settle, untilText, wait, AGENT_KIND, nonce } from './rig'

const harness = (process.argv[2] ?? 'opencode') as 'opencode' | 'codex'
const LOG = `${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'}/logs/daemon.log`

const daemonLinesFor = async (sid: string, sinceByte: number) => {
  try {
    const f = Bun.file(LOG)
    const text = await f.text()
    return { text: text.slice(sinceByte).split('\n').filter((l) => l.includes(sid)), size: text.length }
  } catch {
    return { text: [] as string[], size: sinceByte }
  }
}
const journalOf = async (sid: string) => {
  const r = await sessionRow(sid)
  return JSON.stringify({ status: r?.status, phase: r?.agentState?.phase, resume: r?.resume ?? null, conv: r?.conversationId ?? r?.conversationPodiumId ?? null })
}

await login()
const c = await mutate('sessions.create', { cwd: REPO, agentKind: AGENT_KIND[harness] })
const sid = c.result?.data?.sessionId as string
console.log(`harness=${harness} session=${sid}`)
await wait(25_000)
const chat = new Chat(sid); await chat.open()
const secret = nonce('RESUR')
await mutate('sessions.sendText', { sessionId: sid, text: `Remember this word: ${secret}. Reply with just that word. No tools.` })
const pre = await untilText(chat, (t) => t.includes(secret), 180_000, { pumpFor: sid })
console.log('pre-park turn answered:', pre.ok)
await settle(sid)

console.log('')
console.log('BINDING JOURNAL BEFORE PARK: ' + (await journalOf(sid)))
const hib = await mutate('sessions.hibernate', { sessionId: sid })
console.log('hibernate:', JSON.stringify(hib.result?.data))
for (let i = 0; i < 20 && (await sessionRow(sid))?.status === 'live'; i++) await wait(500)
console.log('BINDING JOURNAL AFTER PARK:  ' + (await journalOf(sid)))

const before = await daemonLinesFor(sid, 0)
console.log('')
console.log('=== sessions.resurrect, status series ===')
const t0 = Date.now()
const res = await mutate('sessions.resurrect', { sessionId: sid })
console.log(`resurrect returned in ${Date.now() - t0}ms: ${JSON.stringify(res.result?.data ?? res.error)}`)
for (const at of [0, 1, 2, 5, 10, 15, 20]) {
  while (Date.now() - t0 < at * 1000) await wait(150)
  const r = await sessionRow(sid)
  console.log(`  +${String(at).padStart(2)}s  status=${r?.status ?? 'gone'}  phase=${r?.agentState?.phase ?? '-'}`)
}
console.log('BINDING JOURNAL AFTER RESURRECT: ' + (await journalOf(sid)))

console.log('')
console.log('=== DAEMON LOG for this session across that window ===')
const after = await daemonLinesFor(sid, before.size)
if (after.text.length === 0) console.log('  (no daemon lines mention this session in the window)')
for (const l of after.text.slice(-40)) console.log('  ' + l.slice(0, 240))
await chat.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
