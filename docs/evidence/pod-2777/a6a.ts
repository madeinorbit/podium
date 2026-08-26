/**
 * TIER-A ROW A6a — terminal attach and type.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a6a.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "keystrokes echo; resize refits; second viewer sees the same screen"
 *
 * THE POSITIVE CONTROL is the terminal producing ANY bytes at all on the attach,
 * before a single keystroke is sent. Without it a silent screen after typing is
 * indistinguishable from a session that never had a terminal — and on THIS rig
 * that is not hypothetical: POD-2853 means a named instance may be unable to
 * create the abduco master at all, in which case there is nothing to type into
 * and "keystrokes did not echo" would be a true statement about the wrong thing.
 * A run whose control does not fire reports REFUSED and prints what it saw.
 */
import { readFileSync } from 'node:fs'
import { AGENT_KIND, Chat, DRIVE_BASE, REPO, login, mutate, nonce, now, sessionRow, until, wait } from './rig'

/**
 * What the DAEMON recorded about this session, which is not what a client can see.
 *
 * This exists because of what this row found: a client terminal that cannot be
 * hosted is a `warn` in the daemon log and NOTHING anywhere else — the session
 * stays `live`, `spawnFailure` stays null, and the attach is answered normally
 * with `outputSeen:false`. A probe that reported only what a client sees would
 * say "the terminal was silent" and stop, which is true and useless. Printed
 * under an explicit heading so nobody mistakes a log line for a product surface.
 */
function daemonSaidAbout(sid: string): string[] {
  let raw: string
  try {
    raw = readFileSync(`${DRIVE_BASE}/logs/daemon.log`, 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let d: Record<string, any>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const blob = JSON.stringify(d)
    if (!blob.includes(sid)) continue
    if (d.level !== 'warn' && d.level !== 'error') continue
    out.push(
      `[${d.level}] ${d.ns}: ${d.msg}` +
        (d.label ? `\n            label=${d.label} (${String(d.label).length} chars)` : '') +
        (d.err?.message ? `\n            err=${String(d.err.message).slice(0, 240)}` : ''),
    )
  }
  return out
}

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)

const log = (s: string) => console.log(s)

const ESC = ''
const OSC = new RegExp(`${ESC}\\][^]*(?:|${ESC}\\\\)`, 'g')
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g')
const strip = (s: string) =>
  s
    .replace(OSC, '')
    .replace(CSI, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e\n]/g, '')

await login()
log('='.repeat(78))
log(`A6a  terminal attach and type   harness=${harness}`)
log('='.repeat(78))

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 800)}`)
  process.exit(5)
}
log(`session ${sid} created`)

const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row = bound.row ?? (await sessionRow(sid))
log(`BOUND DRIVER       ${row?.driverId ?? '(none)'} (family ${row?.driverFamily ?? '?'})`)
log(`STATUS             ${row?.status ?? '?'}`)
if (row?.agentState?.error) {
  log(
    `AGENT ERROR        ${row.agentState.error.class}: ${String(row.agentState.error.detail).slice(0, 400)}`,
  )
}

// --- viewer 1 attaches -----------------------------------------------------
const v1 = new Chat(sid)
// 'native' — this row is about the CLI view, so tell the server that is the
// view we have open, exactly as the browser's view switcher does.
await v1.open('native')
await wait(READY_MS)

const controlBytes = v1.screenBytes
const controlFired = controlBytes > 0
const att = v1.attached
log('')
log(`ATTACHED FRAME     ${att ? JSON.stringify({ resumed: att.resumed, outputSeen: att.outputSeen, epoch: att.epoch, geometry: att.geometry, controllerId: att.controllerId }) : '(none — the server never answered the attach)'}`)
log(`CONTROL            terminal produced ${controlBytes} byte(s) on attach, before any keystroke`)
// outputSeen is the PRODUCT'S OWN verdict on the same question. Printed beside
// the byte count so the two can disagree in public: a `true` here with zero
// bytes means the replay window aged out, a `false` means the terminal has
// genuinely never printed, and those are different findings.
log(`                   the product's own durable counter says outputSeen=${att?.outputSeen}`)

if (!controlFired) {
  // Say WHY, with whatever the product recorded, rather than reporting a zero.
  const r2 = await sessionRow(sid)
  log('')
  log('REFUSED — the positive control did not fire.')
  log(`  control watched: the attached terminal emitting any bytes at all within ${READY_MS}ms`)
  log(`  control saw:     0 bytes; frames seen: ${v1.frameSummary()}`)
  log(`  the product agrees: attached.outputSeen=${att?.outputSeen} — ${
    att?.outputSeen === false
      ? 'this terminal has printed nothing since spawn (not a lost replay window)'
      : att?.outputSeen === true
        ? 'the terminal HAS printed before, so this is a lost replay window, not a dead terminal'
        : 'no attached frame at all'
  }`)
  log(`  session status:  ${r2?.status ?? '?'}  driver ${r2?.driverId ?? '(none)'}`)
  if (r2?.agentState?.error)
    log(
      `  agent error:     ${r2.agentState.error.class}: ${String(r2.agentState.error.detail).slice(0, 600)}`,
    )
  log('  A silent screen and a session that never had a terminal are different')
  log('  findings; this run cannot tell them apart, so it reports neither.')
  const said = daemonSaidAbout(sid)
  log('')
  if (said.length === 0) {
    log('  THE DAEMON LOGGED NOTHING about this session at warn or error.')
  } else {
    log('  WHAT THE DAEMON LOGGED — none of which reaches any client surface:')
    for (const l of said) log(`    ${l}`)
  }
  await v1.close()
  await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

// --- 1. keystrokes echo ----------------------------------------------------
const mark = nonce('ECHO')
const beforeEcho = v1.screenBytes
v1.send({
  type: 'input',
  sessionId: sid,
  data: Buffer.from(mark).toString('base64'),
  inputOrigin: 'human',
})
const echoDeadline = now() + 15_000
let echoed = false
while (now() < echoDeadline) {
  if (strip(v1.screen).includes(mark)) {
    echoed = true
    break
  }
  await wait(250)
}
log('')
log(
  `1. ECHO            typed ${JSON.stringify(mark)} -> ${echoed ? 'ECHOED on screen' : 'NOT on screen'} (+${v1.screenBytes - beforeEcho} bytes)`,
)

// --- 2. resize refits ------------------------------------------------------
// A refit is bytes: the TUI repaints at the new width. Measured as growth
// caused by the resize, not as a flag the client set for itself.
const beforeResize = v1.screenBytes
v1.send({ type: 'resize', sessionId: sid, cols: 100, rows: 30 })
await wait(4_000)
const afterNarrow = v1.screenBytes - beforeResize
v1.send({ type: 'resize', sessionId: sid, cols: 160, rows: 45 })
await wait(4_000)
const afterWide = v1.screenBytes - beforeResize - afterNarrow
log(
  `2. RESIZE          ->100x30 repainted ${afterNarrow} byte(s); ->160x45 repainted ${afterWide} byte(s)`,
)

// --- 3. a second viewer sees the same screen -------------------------------
const v2 = new Chat(sid)
await v2.open('native')
await wait(8_000)
const s1 = strip(v1.screen)
  .trim()
  .split('\n')
  .filter((l) => l.trim())
  .slice(-12)
const s2 = strip(v2.screen)
  .trim()
  .split('\n')
  .filter((l) => l.trim())
  .slice(-12)
const shared = s2.filter((l) => s1.includes(l)).length
const v2SeesMark = strip(v2.screen).includes(mark)
log(
  `3. SECOND VIEWER   received ${v2.screenBytes} byte(s); ${shared}/${s2.length} of its last lines also on viewer 1; sees the typed mark: ${v2SeesMark ? 'yes' : 'no'}`,
)

log('')
log('   viewer 1 tail:')
for (const l of s1.slice(-6)) log(`     | ${l.slice(0, 100)}`)
log('   viewer 2 tail:')
for (const l of s2.slice(-6)) log(`     | ${l.slice(0, 100)}`)

const pass =
  echoed && afterNarrow + afterWide > 0 && v2.screenBytes > 0 && (shared > 0 || v2SeesMark)
log('')
log('='.repeat(78))
log(
  `A6a  ${pass ? 'PASS' : 'FAIL'}   echo=${echoed}  resize-repaint=${afterNarrow + afterWide}B  second-viewer=${v2.screenBytes}B/${shared} shared lines`,
)
log(`     control FIRED — ${controlBytes} terminal byte(s) before any keystroke`)
log('='.repeat(78))

await v1.close()
await v2.close()
await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
process.exit(pass ? 0 : 1)
