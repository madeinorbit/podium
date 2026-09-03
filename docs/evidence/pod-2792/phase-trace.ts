/**
 * A DIAGNOSTIC, NOT A PROBE. The interrupt probe's control is "the turn observed
 * IN FLIGHT", and on the terminal arm that control refused to fire twice — at
 * 2.5s into the turn (`phase=idle`, 0 chars) and at 33.5s (`phase=idle`, 6.6k
 * chars). Those two readings are only consistent if the phase never reads
 * `working` at all on this arm, which would make the cell unmeasurable for a
 * reason that has nothing to do with interrupt.
 *
 * So: send the same long prompt the drive sends, and print the phase and the
 * transcript length once a second. If `working` never appears while the
 * transcript grows, the phase is the problem; if it appears, this prints the
 * window the probe has to aim at.
 */
import { AGENT_KIND, Chat, login, mutate, now, primeTerminalTui, REPO, sessionRow, settle, wait } from './rig.js'

const harness = process.argv[2] ?? 'opencode'
const seconds = Number(process.argv[3] ?? 90)
await login()
const created = await mutate('sessions.create', { cwd: REPO, agentKind: AGENT_KIND[harness] })
const sid = created.result?.data?.sessionId as string
console.log(`session ${sid}`)
await wait(25_000)
const row0 = await sessionRow(sid)
console.log(`bound driver ${row0?.driverId} status=${row0?.status} phase=${row0?.agentState?.phase}`)

const chat = new Chat(sid)
await chat.open()
if (process.env.PODIUM_RUNTIME_DRIVER === 'generic-pty') {
  const primed = await primeTerminalTui(chat, sid)
  console.log(`TUI PRIMING ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
  await settle(sid)
}

const prompt =
  'Count from 1 to 150. Put each number on its own line, and after each number ' +
  'write one full sentence about that number — a fact, a property, anything. ' +
  'Do not use any tools. Do not summarise. Write every single line.'
const t0 = now()
await mutate('sessions.sendText', { sessionId: sid, text: prompt })
for (let i = 0; i < seconds; i++) {
  await wait(1000)
  const row = await sessionRow(sid)
  console.log(
    `+${String(now() - t0).padStart(6)}ms  status=${row?.status} phase=${row?.agentState?.phase} previews=${chat.previews.length} chars=${chat.assistantText().length} items=${chat.items.length}`,
  )
}
await mutate('sessions.kill', { sessionId: sid })
