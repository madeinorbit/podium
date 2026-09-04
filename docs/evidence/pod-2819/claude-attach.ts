/**
 * DOES CLAUDE READ AN ATTACHED FILE — ON THE EPIC TIP, AND ON TODAY'S MAIN?
 *
 * POD-2777's matrix scored `claude / attach` FAIL. Claude binds `claude-pty`
 * whatever the driver preference says, so that cell cannot be a headless-driver
 * regression — but the terminal driver it binds is 1,554 lines this epic ADDS
 * against main, so "pre-existing" is not something to assume either. POD-2819's
 * brief is explicit: say which, with the measurement.
 *
 *   POD2819_ARM='main 2066935'  bun … claude-attach.ts <cwd> path-first
 *   POD2819_ARM='main 2066935'  bun … claude-attach.ts <cwd> path-inline
 *
 * ONE SHAPE PER SESSION, AND THAT IS A CORRECTION. The first version sent both
 * shapes down one session: path-first failed, path-inline then also failed, and
 * it reported "not the leading slash". That was not a second measurement at all
 * — the screen showed the session already sitting on a modal the FIRST send had
 * opened, and everything after that goes into the modal. A second arm on a
 * wedged session measures the wedge.
 *
 * THE SHAPE UNDER TEST IS THE ONE MAIN HAS. `sessions.sendText` takes no
 * `attachments` on main — that parameter arrives with this epic — so an A/B
 * through it would compare a build that has the verb against one that cannot.
 * What main's product does is in `apps/web/.../use-chat-surface.ts`: upload the
 * bytes, get an absolute path back, submit `paths.join('\n') + '\n' + text`.
 * That is `path-first`, and it is byte-identical to what the epic's terminal
 * driver builds server side out of `attachments` — which is what makes the two
 * builds comparable at all.
 *
 * `path-inline` is the CONTRAST, not a second product shape: the same bytes,
 * the same file, the same verb, with words in front of the path so the prompt
 * does not BEGIN with `/`. A TUI composer reads a leading `/` as the start of a
 * slash command. If that is what eats the turn, these two arms differ by that
 * one fact and will say so.
 *
 * THE CONTROLS ARE POD-2777's, UNCHANGED.
 *
 * Positive: a plain send on this same session having already answered with a
 * nonce. Without it a silent attach arm and a dead session read the same.
 *
 * Negative: the secret exists only in the bytes of the staged file. An agent
 * can agree that it sees a file without reading one; it cannot produce those
 * bytes without having read them.
 *
 * The screen is printed on a miss. On a PTY arm the transcript plane can be
 * empty while the screen is full — of a modal nobody cleared — and that is the
 * difference between "claude would not read the file" and "the turn never
 * reached claude".
 */

import { randomUUID } from 'node:crypto'
import {
  Chat,
  login,
  mutate,
  primeTerminalTui,
  sessionRow,
  until,
  untilText,
  wait,
} from '../pod-2777/rig'

const cwd = process.argv[2]
const shape = (process.argv[3] ?? 'path-first') as 'path-first' | 'path-inline'
if (!cwd || !['path-first', 'path-inline'].includes(shape)) {
  console.error('usage: claude-attach.ts <cwd> [path-first|path-inline]')
  process.exit(2)
}
const REPLY_MS = Number(process.env.POD2819_REPLY_MS ?? 180_000)
const READY_MS = Number(process.env.POD2819_READY_MS ?? 25_000)
const label = process.env.POD2819_ARM ?? `port ${process.env.PODIUM_PORT ?? '?'}`

const nonce = (tag: string) => `${tag}-${randomUUID().slice(0, 6).toUpperCase()}`
const line = (k: string, v: unknown) => console.log(`   ${k.padEnd(18)} ${String(v)}`)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g')
const plain = (s: string) => s.replace(ANSI, '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n')

await login()
const created = await mutate('sessions.create', { cwd, agentKind: 'claude-code' })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  console.error(`sessions.create failed: ${JSON.stringify(created).slice(0, 400)}`)
  process.exit(3)
}
console.log(`\n=== claude / attach — ${label} — shape=${shape} ===`)
line('SESSION', sid)
await wait(READY_MS)

const bound = await until(sid, (r) => Boolean(r?.driverId) || r?.status === 'live', 90_000, 1_000)
const row = bound.row ?? (await sessionRow(sid))
line('BOUND DRIVER', row?.driverId ?? '(none — this build has no runtime contract)')
line('STATUS', row?.status ?? '(unknown)')

const chat = new Chat(sid)
await chat.open()

/**
 * MODALS, CLEARED BEFORE EVERY SEND — NOT JUST AT STARTUP.
 *
 * POD-2777's primer runs once, ten seconds in, and that was enough for the
 * dialogs it was written for. claude's AUTO-MODE offer is not one of them: it
 * arrives PARTWAY THROUGH a session, after the first turn has already answered.
 * The next injected turn then goes into the dialog, and its Enter selects "1.
 * Set it up" — which is why both builds' screens end on `/auto-mode-setup`
 * having run, with the prompt nowhere.
 *
 * That is a rig fact and it produced a product-shaped reading: `attach FAIL` on
 * a cell where the turn never reached claude at all. So the primer runs again
 * immediately before the measured send, and this local pass adds the one
 * affordance POD-2777's does not know — the auto-mode screens, dismissed with
 * the key they themselves name ("Esc to cancel").
 */
const AUTO_MODE = /Set ?up ?auto ?mode|auto ?mode ?lets ?Claude|Don't ?show ?again/i
const MODAL = /Esc ?to ?cancel|Enter ?to ?continue|Enter ?to ?confirm/i
async function dismissModals(where: string): Promise<string[]> {
  const cleared = [...(await primeTerminalTui(chat, sid!))]
  for (let round = 0; round < 4; round++) {
    const screen = chat.screenTail(3_000)
    if (!AUTO_MODE.test(screen) && !MODAL.test(screen)) break
    // Esc, because the screen says Esc. Reading the affordance off the screen
    // rather than replaying a key that worked on another build is the lesson
    // POD-2777's primer records in its own comments.
    chat.send({
      type: 'input',
      sessionId: sid!,
      data: Buffer.from(String.fromCharCode(27)).toString('base64'),
      inputOrigin: 'human',
    })
    cleared.push(`${where}: Esc (${AUTO_MODE.test(screen) ? 'auto-mode offer' : 'a modal'})`)
    await wait(2_500)
  }
  return cleared
}

const primed = await dismissModals('startup')
line('TUI PRIMER', primed.length > 0 ? primed.join(' · ') : 'nothing to clear')

// -- the positive control ----------------------------------------------------
const hello = nonce('PODIUM')
const before0 = chat.assistantText().length
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${hello}. Do not use any tools.`,
})
const replied = await untilText(chat, (t) => t.slice(before0).includes(hello), REPLY_MS, {
  pumpFor: sid,
})
line('CONTROL', replied.ok ? `FIRED — replied ${hello} in ${replied.ms}ms` : 'DID NOT FIRE')
if (!replied.ok) {
  console.log('   REFUSED — a plain send did not answer, so an attach result here')
  console.log('   could not be told apart from a dead session.')
  console.log(`--- SCREEN ---\n${plain(chat.screen.slice(-2500))}`)
  process.exit(0)
}

// -- the attachment ----------------------------------------------------------
const secret = nonce('FILESECRET')
const body = `This file exists only for the POD-2819 claude measurement.\nThe secret word is ${secret}.\n`
const up = await mutate('sessions.uploadImage', {
  sessionId: sid,
  filename: 'podium-2819-secret.txt',
  mimeType: 'text/plain',
  dataBase64: Buffer.from(body, 'utf8').toString('base64'),
})
const data = up.result?.data as { path?: string; refusal?: { reason?: string; detail?: string } }
if (!data?.path) {
  line('UPLOAD REFUSED', JSON.stringify(data?.refusal ?? up.error ?? up).slice(0, 200))
  process.exit(0)
}
line('STAGED', data.path)
line('SECRET IN FILE', `${secret} — present in the bytes and nowhere else`)

const text =
  shape === 'path-first'
    ? `${data.path}\nRead the attached text file and reply with ONLY the secret word it contains.`
    : `Read the file at ${data.path} and reply with ONLY the secret word it contains.`
line('PROMPT BEGINS', JSON.stringify(text.slice(0, 40)))

// AGAIN, RIGHT BEFORE THE MEASURED SEND. The auto-mode offer arrives after the
// control turn, so clearing it at startup is clearing it too early.
const primed2 = await dismissModals('pre-attach')
line('PRE-ATTACH', primed2.length > 0 ? primed2.join(' · ') : 'screen clear')

const before = chat.assistantText().length
const screenBefore = chat.screenBytes
const sent = await mutate('sessions.sendText', { sessionId: sid, text })
line('SEND', JSON.stringify(sent.result?.data ?? sent.error ?? null).slice(0, 140))
const echoed = await untilText(chat, (t) => t.slice(before).includes(secret), REPLY_MS, {
  pumpFor: sid,
})
line('ECHOED BACK', echoed.ok ? `yes, after ${echoed.ms}ms` : 'no')
line('APPROVALS', echoed.asksAnswered)
line('PTY BYTES', `${chat.screenBytes - screenBefore} arrived after the send`)
/**
 * A MISS WITH A MODAL ON SCREEN IS NOT A FAIL. The turn never reached claude,
 * so the reading cannot be told apart from one where it did and claude refused
 * — which is POD-2777's own rule about a control that did not isolate what it
 * claims to. Reported as REFUSED, with the screen, rather than as a red cell.
 */
const endScreen = chat.screenTail(3_000)
const wedged = !echoed.ok && (AUTO_MODE.test(endScreen) || MODAL.test(endScreen))
const verdict = echoed.ok ? 'PASS' : wedged ? 'REFUSED' : 'FAIL'
console.log(`\n   ${verdict} — ${label} — shape=${shape}`)
if (wedged) {
  console.log('   a modal was on screen when the window closed, so this turn never')
  console.log('   reached claude. Refusing to report it as an attachment result.')
}
console.log(`   ASSISTANT SAID  ${JSON.stringify(chat.assistantText().slice(before)).slice(0, 400)}`)
if (!echoed.ok) console.log(`--- SCREEN ---\n${plain(chat.screen.slice(-2500))}`)
process.exit(0)
