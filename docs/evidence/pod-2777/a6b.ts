/**
 * TIER-A ROW A6b — chat → CLI → chat → CLI, twice.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a6b.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "chat→CLI→chat→CLI: no restart, no scrollback corruption, correct size
 *    (POD-2761/2602 fixed); after the switches, a chat send still answers AND
 *    typing in the CLI still echoes — the session is fully functional in BOTH
 *    views"
 *
 * ---------------------------------------------------------------------------
 * WHAT "NO RESTART" IS MEASURED AS, and why not the obvious thing.
 * ---------------------------------------------------------------------------
 * Not "the session row still says live" — a cold-started replacement says that
 * too. Three independent witnesses, each of which a restart would disturb:
 *
 *   1. THE TERMINAL EPOCH on the attach frame. `SessionTerminal` bumps it when
 *      the underlying terminal is replaced, so an unchanged epoch across four
 *      switches is the server's own statement that it did not rebuild.
 *   2. THE AGENT'S PROCESS ID, read from /proc by environment. A restarted
 *      harness is a new pid whatever any frame says.
 *   3. A SCROLLBACK MARKER typed before the first switch. POD-2761's finding was
 *      precisely that a view switch could call `start()` on an ADOPTED live
 *      terminal, resetting scrollback nothing would redraw. So the marker is
 *      typed once, at the beginning, and looked for after every switch — if it
 *      disappears, the scrollback was destroyed even if nothing else moved.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL IS THE SESSION WORKING IN BOTH VIEWS *BEFORE* SWITCHING.
 * ---------------------------------------------------------------------------
 * The row's real payload is the last clause — that the session still works in
 * both views AFTERWARDS. A session that never worked in one of them would
 * satisfy "still broken afterwards" without any switch being at fault. So chat
 * is proved to answer and the CLI is proved to echo BEFORE the switching starts,
 * and the same two checks are repeated after. Without the before-reading the
 * after-reading means nothing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  primeTerminalTui,
  mutate,
  nonce,
  now,
  sessionRow,
  primeTerminalTui,
  settle,
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p2777'
const log = (s: string) => console.log(s)

const ESC = ''
const OSC = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g')
const strip = (s: string) =>
  s
    .replace(OSC, '')
    .replace(CSI, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e\n]/g, '')

/**
 * THE AGENT'S PROCESSES, SEPARATED FROM THE VIEW'S — and the separation is a
 * correction, not a refinement.
 *
 * The first version counted every non-daemon process this instance owns and
 * required the set to be identical across all four switches. It was not: a
 * TRIPLET of pids appeared whenever the CLI was declared and vanished whenever
 * chat was, and the probe reported A6b FAIL for "agent pid(s) unchanged: false".
 *
 * Those three are the ATTACH CLIENT — the TUI started to render the native view
 * — and tearing it down on leaving the view is correct: the catalogue is
 * explicit that "an attach-client exit must never end the session" (section 10),
 * and section 9 records that a view switch cold-starts the client today
 * ("cold start does not fake continuity", absent for every server driver).
 *
 * "No restart" in this row means the SESSION did not restart, which is the agent
 * process. So the two are counted separately: the agent set must be identical,
 * and the client churn is RECORDED rather than scored, because it is a known
 * declared gap and not this row's subject.
 */
function procSets(): { pids: number[]; cmds: Map<number, string> } {
  const pids: number[] = []
  const cmds = new Map<number, string>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'utf8')
      if (!env.includes(`PODIUM_INSTANCE=${INSTANCE}`)) continue
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      if (/scripts\/(daemon|server)\.ts/.test(cmd)) continue
      pids.push(Number(name))
      cmds.set(Number(name), cmd.slice(0, 100))
    } catch {
      // gone, or not ours
    }
  }
  return { pids: pids.sort((a, b) => a - b), cmds }
}

await login()
log('='.repeat(78))
log(`A6b  chat -> CLI -> chat -> CLI, twice   harness=${harness}`)
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
  log(`SESSION EXITED     spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
  log('REFUSED — no session to switch views on.')
  process.exit(3)
}

const view = new Chat(sid)
await view.open('native')
await wait(READY_MS)
await settle(sid)

/**
 * CLEAR THE FIRST-RUN MODAL BEFORE MEASURING ANYTHING.
 *
 * A fresh TUI opens on a dialog, not on the conversation — codex on "Hooks need
 * review", claude on its onboarding. A rig that skips this MEASURES THE MODAL:
 * the prompt is typed into a dialog, no turn ever runs, and the row reports that
 * chat stopped answering. That is exactly what this probe did on its first
 * terminal-arm run — control B false, with 599,437 bytes of terminal output that
 * were a dialog repainting.
 *
 * drive.ts has always primed; these probes did not, because on the HEADLESS arm
 * there is no TUI in the way and the omission never showed. The terminal arm is
 * the first thing to ask for it.
 */
const primed = await primeTerminalTui(view, sid)
log(`TUI PRIMING        ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)

/**
 * ACT IN A VIEW BY FIRST DECLARING IT — which is what a person does, and what
 * POD-2875 makes mandatory.
 *
 * A chat send made while `native` is the declared mode is accepted with
 * `disposition:'delivered'` and then PARKS indefinitely: 0 transcript items, 0
 * deltas, nonce nowhere, phase idle, until some client declares a chat view and
 * drains it. Measured on this rig at this commit, one variable, both arms; filed
 * as POD-2875.
 *
 * That defect is NOT what row A6b is about, and letting it sit inside this
 * probe's control would refuse the row forever for an unrelated reason. So each
 * action declares the view it belongs to first. That is also the honest shape of
 * the row: a person reading chat sends from chat, and a person at the CLI types
 * at the CLI. The switching is still real — four declared switches, and the
 * marker, epoch and pid witnesses span all of them.
 */
/**
 * The settle after declaring a view is 10s, not 3s, and the extra 7 seconds are
 * a RIG correction rather than a product allowance.
 *
 * At 3s this refused on opencode/headless — control B, "chat answers before
 * switching", came back false — while the identical sequence passed on codex.
 * The two-arm diagnostic showed POD-2875 reproduces on opencode exactly as on
 * codex (declared-native parks, declared-chat delivers), so the mode change is
 * honoured; it simply had not taken effect by the time the send went out. A
 * send that races its own view declaration measures the race, and on this
 * loaded host (load ~20) 3s was not enough.
 *
 * A readback would be better than a delay, but the client is never told its own
 * effective view mode — there is no frame to wait on. So the wait is generous
 * and the reason is written down, rather than a tight number that will refuse
 * again the next time the box is busy.
 */
async function inChat<T>(fn: () => Promise<T>): Promise<T> {
  view.send({ type: 'viewState', visible: [sid], focused: sid, modes: { [sid]: 'chat' } })
  await wait(10_000)
  return fn()
}

async function inCli<T>(fn: () => Promise<T>): Promise<T> {
  view.send({ type: 'viewState', visible: [sid], focused: sid, modes: { [sid]: 'native' } })
  view.send({ type: 'attach', sessionId: sid })
  await wait(3_000)
  return fn()
}

// --- CONTROL B FIRST: chat answers, on a session nobody has typed into ----
//
// ORDER CORRECTED AFTER A FALSE REFUSAL OF MY OWN MAKING. The first version
// typed the scrollback marker into the CLI and THEN sent a chat turn, and the
// chat turn never answered — control B failed and the row refused. The cause
// was the probe: keystrokes sent to the TUI land in its COMPOSER, so the marker
// was still sitting in the input line when the chat send arrived. That is a rig
// artefact, not a product defect, and reporting it as "chat stopped answering"
// would have been a fabricated regression in the most sensitive row on the
// matrix.
//
// The reordering also makes the marker BETTER. What the row needs is a marker in
// SCROLLBACK — POD-2761's defect was a view switch resetting scrollback nothing
// would redraw — and text parked in a composer is not scrollback at all. The
// answered chat turn IS painted into the TUI's scrollback, so the chat nonce is
// the marker, and it is a marker the product wrote rather than one the probe
// pasted.
const chatWordBefore = nonce('CHATBEFORE')
const chatBefore = await inChat(async () => {
  await mutate('sessions.sendText', {
    sessionId: sid,
    text: `Reply with exactly this word and nothing else: ${chatWordBefore}. Do not use any tools.`,
  })
  const dl = now() + 120_000
  while (now() < dl) {
    if (view.assistantText().includes(chatWordBefore)) return true
    await wait(1_500)
  }
  return false
})
log('')
log(`CONTROL B          chat answers BEFORE switching: ${chatBefore}`)

// The marker is the chat turn's own text, once the TUI has painted it.
const marker = chatWordBefore
const markerOnScreen = await inCli(async () => {
  const dl = now() + 30_000
  while (now() < dl) {
    if (strip(view.screen).includes(marker)) return true
    await wait(500)
  }
  return false
})
log(`                   and the TUI painted it into scrollback: ${markerOnScreen}`)

// --- CONTROL A: the CLI echoes -------------------------------------------
// Typed AFTER the chat turn, and cleared immediately: anything left in the
// composer is input the session has not been asked to run, and it is what broke
// the first version of this probe.
const typed = nonce('ECHO')
view.send({
  type: 'input',
  sessionId: sid,
  data: Buffer.from(typed).toString('base64'),
  inputOrigin: 'human',
})
const echoedBefore = await (async () => {
  const dl = now() + 20_000
  while (now() < dl) {
    if (strip(view.screen).includes(typed)) return true
    await wait(250)
  }
  return false
})()
log(`CONTROL A          CLI echoes BEFORE switching: ${echoedBefore} (${view.screenBytes} terminal bytes)`)
// Clear the composer: backspace once per character, then Esc.
view.send({
  type: 'input',
  sessionId: sid,
  data: Buffer.from('\u007f'.repeat(typed.length) + '\u001b').toString('base64'),
  inputOrigin: 'human',
})
await wait(2_000)

if (!echoedBefore || !chatBefore || !markerOnScreen) {
  log('')
  log('REFUSED — a control did not fire.')
  log('  control watched: the session working in BOTH views before any switch, and a')
  log('                   scrollback marker actually present to watch for corruption')
  log(`  control saw:     CLI echo=${echoedBefore}, chat answer=${chatBefore}, marker painted=${markerOnScreen}`)
  log('  A view that never worked cannot be shown to have been broken by a switch.')
  await view.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

const epoch0 = view.attached?.epoch
/**
 * THE AGENT BASELINE IS TAKEN WITH CHAT DECLARED, and that is what makes it an
 * agent baseline rather than a guess.
 *
 * Two earlier attempts tried to tell the agent's processes from the view's by
 * pattern-matching their command lines, and both got it wrong — the attach
 * client runs the same binary with the same `--listen` shape as the app-server,
 * so no substring separates them. Taking the census while the CLI view is NOT
 * declared removes the need to: whatever is running then is not the view's,
 * because the view is not open.
 *
 * "No restart" is then the exact property the row means — every process that
 * was serving this session before the switching is still serving it after.
 * Processes that APPEAR during a CLI step are the view's and are recorded, not
 * scored: the catalogue already declares that a view switch cold-starts the
 * client, and that is not this row's subject.
 */
const sets0 = await inChat(async () => procSets())
const pids0 = sets0.pids
log(`baseline           epoch=${epoch0}  geometry=${JSON.stringify(view.attached?.geometry)}`)
log(`                   agent pids (census taken with chat declared, so no view processes):`)
for (const pid of sets0.pids) log(`                     ${pid}  ${sets0.cmds.get(pid)}`)

// --- the switches ----------------------------------------------------------
// A switch is a viewState frame naming the mode, plus (for a return to native)
// a fresh attach — which is what the browser's view switcher does.
const observations: {
  step: string
  epoch: unknown
  geometry: unknown
  markerPresent: boolean
  bytes: number
  pids: string
  clientPids: number
}[] = []

async function switchTo(mode: 'chat' | 'native', step: string): Promise<void> {
  view.send({
    type: 'viewState',
    visible: [sid],
    focused: sid,
    modes: { [sid]: mode },
  })
  if (mode === 'native') view.send({ type: 'attach', sessionId: sid })
  await wait(6_000)
  observations.push({
    step,
    epoch: view.attached?.epoch,
    geometry: view.attached?.geometry,
    markerPresent: strip(view.screen).includes(marker),
    bytes: view.screenBytes,
    pids: procSets().pids.filter((x) => pids0.includes(x)).join(','),
    clientPids: procSets().pids.filter((x) => !pids0.includes(x)).length,
  })
}

log('')
log('switching …')
await switchTo('chat', '1. -> chat')
await switchTo('native', '2. -> CLI')
await switchTo('chat', '3. -> chat')
await switchTo('native', '4. -> CLI')

log('')
log('  step          epoch  geometry            marker kept  term bytes  agent pids                 view procs')
for (const o of observations) {
  log(
    `  ${o.step.padEnd(12)}  ${String(o.epoch).padEnd(5)}  ${JSON.stringify(o.geometry).padEnd(18)}  ${String(o.markerPresent).padEnd(11)}  ${String(o.bytes).padEnd(10)}  ${o.pids.padEnd(24)}  ${o.clientPids}`,
  )
}

const epochStable = observations.every((o) => o.epoch === epoch0)
const markerKept = observations.every((o) => o.markerPresent)
const pidsStable = observations.every((o) => o.pids === pids0.join(','))
const extra = procSets()
const extraPids = extra.pids.filter((x) => !pids0.includes(x))
const sizeOk = observations.every(
  (o) => JSON.stringify(o.geometry) === JSON.stringify(view.attached?.geometry),
)

// --- AFTERWARDS: both views must still work --------------------------------
log('')
log('after the four switches:')
const chatWordAfter = nonce('CHATAFTER')
const chatAfter = await inChat(async () => {
  await mutate('sessions.sendText', {
    sessionId: sid,
    text: `Reply with exactly this word and nothing else: ${chatWordAfter}. Do not use any tools.`,
  })
  const dl = now() + 120_000
  while (now() < dl) {
    if (view.assistantText().includes(chatWordAfter)) return true
    await wait(1_500)
  }
  return false
})
log(`  chat send still answers: ${chatAfter} (${chatWordAfter})`)

const markAfter = nonce('ECHOAFTER')
const bytesBeforeMark = view.screenBytes
const echoAfter = await inCli(async () => {
  view.send({
    type: 'input',
    sessionId: sid,
    data: Buffer.from(markAfter).toString('base64'),
    inputOrigin: 'human',
  })
  const dl = now() + 20_000
  while (now() < dl) {
    if (strip(view.screen).includes(markAfter)) return true
    await wait(250)
  }
  return false
})
log(`  CLI typing still echoes: ${echoAfter} (+${view.screenBytes - bytesBeforeMark} bytes)`)

const pass = epochStable && markerKept && pidsStable && sizeOk && chatAfter && echoAfter
log('')
log('='.repeat(78))
log(`A6b  ${pass ? 'PASS' : 'FAIL'}`)
log(`     no restart      epoch stable across all four: ${epochStable} (${epoch0})`)
log(`                     AGENT pid(s) unchanged:       ${pidsStable} [${pids0.join(', ')}]`)
log(`                     processes the VIEW adds while the CLI is declared, recorded not scored:`)
for (const pid of extraPids) log(`                       ${pid}  ${extra.cmds.get(pid)}`)
log(`                     (they come and go with the view. An attach-client cold start on a`)
log(`                      view switch is a declared gap in the catalogue — section 9, "cold`)
log(`                      start does not fake continuity", absent for every server driver —`)
log(`                      and an attach-client exit must never end the session, section 10.)`)
log(`     no corruption   scrollback marker survived every switch: ${markerKept}`)
log(`     correct size    geometry unchanged: ${sizeOk}`)
log(`     both views work chat answers: ${chatAfter}   CLI echoes: ${echoAfter}`)
log(`     controls FIRED  CLI echoed and chat answered BEFORE any switching`)
log('='.repeat(78))

await view.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
process.exit(pass ? 0 : 1)
