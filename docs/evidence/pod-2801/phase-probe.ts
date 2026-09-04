/**
 * DOES A BUSY TERMINAL SESSION EVER SAY `working`?
 *
 *   bash docs/evidence/pod-2801/drive-up.sh
 *   bun  docs/evidence/pod-2801/phase-probe.ts opencode cursor claude codex grok
 *
 * One question, one field. POD-2777's acceptance drive found this while scoring
 * a different cell: 13,250 characters of output across 60 polls on the terminal
 * arm, and `agentState.phase` read `idle` at every single one. This probe is
 * that reading, isolated, and run per harness — because "the terminal driver
 * never reports working" and "THIS harness's observer never reports working"
 * are different defects with different fixes, and the drive only measured one
 * harness.
 *
 * THE CONTROL IS THE PTY'S OWN OUTPUT BYTES, and it is not a convenience.
 * A phase that reads `idle` for sixty seconds is the CORRECT reading for a
 * session that is not doing anything — a TUI sitting on a trust dialog, a
 * harness that never got the prompt, an agent that answered in 2s. So the probe
 * refuses to report anything unless it can show the agent was producing output
 * at the time: bytes arriving on the PTY stream, counted monotonically. Without
 * that, a zero from a dead rig and a zero from a broken phase are the same
 * number.
 *
 * WHY BYTES AND NOT THE TRANSCRIPT. The transcript plane is fed by the same
 * per-harness observer that feeds the phase on some arms, so using it as the
 * control would let one broken thing vouch for another. The PTY byte stream
 * crosses none of that code: it is the child process's stdout, mirrored.
 */
import {
  AGENT_KIND,
  Chat,
  login,
  mutate,
  nonce,
  primeTerminalTui,
  query,
  REPO,
  sessionRow,
  wait,
  now,
  type SessionRow,
} from '../pod-2777/rig.ts'

const HARNESSES = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (HARNESSES.length === 0) HARNESSES.push('opencode')

/** How long the harness gets to boot its TUI before anything is measured.
 *  Claude's first interactive boot paints a release-notes/permission-mode notice
 *  that takes tens of seconds to settle on this box, so it is worth raising. */
const READY_MS = Number(process.env.P2801_READY_MS ?? 12_000)
/** Sixty polls a second apart — the same shape as the reading being reproduced. */
const POLLS = 60
const POLL_MS = 1_000

/**
 * LONG ENOUGH THAT THE ANSWER OUTLIVES THE POLL WINDOW. A prompt answered in
 * four seconds makes `idle` the right answer for 56 of 60 polls, and the probe
 * would be measuring its own impatience. 150 numbered sentences is minutes of
 * generation on every harness here — the identical prompt POD-2777 used, so the
 * two readings stay comparable.
 */
const PROMPT =
  'Count from 1 to 150. Put each number on its own line, and after each number ' +
  'write one full sentence about that number — a fact, a property, anything. ' +
  'Do not use any tools. Do not summarise. Write every single line.'

interface Sample {
  atMs: number
  phase: string
  bytes: number
  chars: number
}

interface Reading {
  harness: string
  driverId: string
  driverFamily: string
  verdict: 'PASS' | 'FAIL' | 'REFUSED'
  summary: string
  everWorking: boolean
  phases: Record<string, number>
  bytesGrew: number
  /** How many of the one-second polls saw MORE output than the poll before it. */
  growthIntervals: number
  charsGrew: number
  samples: Sample[]
  /** The tail of the TUI's own screen — the diagnosis when the control refuses. */
  screen: string
}

async function probe(harness: string): Promise<Reading> {
  const agentKind = AGENT_KIND[harness] ?? harness
  const label = `[${harness}]`
  const say = (m: string) => console.log(`${label} ${m}`)

  const created = await mutate('sessions.create', { cwd: REPO, agentKind })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) {
    return {
      harness,
      driverId: '(none)',
      driverFamily: '(none)',
      verdict: 'REFUSED',
      summary: `sessions.create failed: ${JSON.stringify(created).slice(0, 200)}`,
      everWorking: false,
      phases: {},
      bytesGrew: 0,
      growthIntervals: 0,
      charsGrew: 0,
      samples: [],
      screen: '',
    }
  }
  say(`session ${sid} created; ${READY_MS}ms for the TUI to come up`)
  await wait(READY_MS)

  const row0 = (await sessionRow(sid)) as SessionRow | undefined
  const driverId = row0?.driverId ?? '(unknown)'
  const driverFamily = row0?.driverFamily ?? '(unknown)'
  say(`bound driver ${driverId} (family ${driverFamily})`)

  const chat = new Chat(sid)
  await chat.open()

  // A PTY session opens on whatever first-run dialog its harness shows, and a
  // rig that sends immediately types its prompt INTO that dialog: no turn runs,
  // no bytes flow, and the control correctly refuses. Clear it first.
  const primed = await primeTerminalTui(chat, sid)
  say(`TUI priming: ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)

  const baseBytes = chat.screenBytes
  const baseChars = chat.assistantText().length
  const t0 = now()
  await mutate('sessions.sendText', { sessionId: sid, text: `${PROMPT} (${nonce('P2801')})` })

  const samples: Sample[] = []
  for (let i = 0; i < POLLS; i++) {
    await wait(POLL_MS)
    const row = (await sessionRow(sid)) as SessionRow | undefined
    samples.push({
      atMs: now() - t0,
      phase: row?.agentState?.phase ?? 'unknown',
      bytes: chat.screenBytes - baseBytes,
      chars: chat.assistantText().length - baseChars,
    })
  }

  const phases: Record<string, number> = {}
  for (const s of samples) phases[s.phase] = (phases[s.phase] ?? 0) + 1
  const everWorking = samples.some((s) => s.phase === 'working' || s.phase === 'compacting')
  const bytesGrew = samples.at(-1)?.bytes ?? 0
  const charsGrew = samples.at(-1)?.chars ?? 0
  // SUSTAINED production, not a total. A TUI that painted one first-run dialog
  // and then sat there has a positive byte total and produced nothing: codex
  // scored 3,984 bytes that way on this rig's first pass, all of it a modal.
  // Counting the INTERVALS that grew separates a repaint from a turn.
  let growthIntervals = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.bytes > samples[i - 1]!.bytes) growthIntervals++
  }
  const screen = chat.screenTail(1_500)

  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})

  // THE CONTROL. Output must have been arriving over time, or this measures
  // nothing: `idle` is the CORRECT reading for a session that is not working.
  const MIN_GROWTH_INTERVALS = 5
  if (growthIntervals < MIN_GROWTH_INTERVALS) {
    return {
      harness,
      driverId,
      driverFamily,
      verdict: 'REFUSED',
      summary:
        `output grew in only ${growthIntervals} of ${samples.length - 1} one-second intervals ` +
        `(${bytesGrew} bytes total) — no turn can be shown to have been in flight, so a phase ` +
        'reading here cannot be told apart from a correct one',
      everWorking,
      phases,
      bytesGrew,
      growthIntervals,
      charsGrew,
      samples,
      screen,
    }
  }

  return {
    harness,
    driverId,
    driverFamily,
    verdict: everWorking ? 'PASS' : 'FAIL',
    summary: everWorking
      ? `reported working while producing ${bytesGrew} bytes of output`
      : `produced ${bytesGrew} bytes of output over ${growthIntervals} growing intervals and never once reported working`,
    everWorking,
    phases,
    bytesGrew,
    growthIntervals,
    charsGrew,
    samples,
    screen,
  }
}

await login()
const health = await query('sessions.list', {})
if (health.error) {
  console.error(`the instance is not answering: ${JSON.stringify(health.error).slice(0, 300)}`)
  process.exit(4)
}

const readings: Reading[] = []
for (const harness of HARNESSES) {
  readings.push(await probe(harness))
}

console.log('')
console.log('=== phase while producing output ===')
console.log('')
console.log('| harness | driver | verdict | phases seen | EVER working | output bytes | growing intervals |')
console.log('|---|---|---|---|---|---|---|')
for (const r of readings) {
  const seen = Object.entries(r.phases)
    .map(([p, n]) => `${p}=${n}`)
    .join(' ')
  console.log(
    `| ${r.harness} | ${r.driverId} | **${r.verdict}** | ${seen} | ${r.everWorking} | ${r.bytesGrew} | ${r.growthIntervals}/${Math.max(0, r.samples.length - 1)} |`,
  )
}
console.log('')
for (const r of readings) {
  console.log(`--- ${r.harness} (${r.driverId}) — ${r.verdict}: ${r.summary}`)
  for (const s of r.samples.filter((_, i) => i % 10 === 0 || i === r.samples.length - 1)) {
    console.log(
      `    +${String(s.atMs).padStart(6)}ms  phase=${s.phase.padEnd(10)} ptyBytes=${String(s.bytes).padStart(7)}  transcriptChars=${s.chars}`,
    )
  }
  if (r.verdict === 'REFUSED' && r.screen) {
    console.log('    screen tail at the end of the window:')
    for (const line of r.screen.split('\n').slice(-12)) console.log(`      | ${line}`)
  }
  console.log('')
}

const failed = readings.filter((r) => r.verdict === 'FAIL')
console.log(
  failed.length > 0
    ? `${failed.length} of ${readings.length} harness(es) never reported working: ${failed.map((r) => r.harness).join(', ')}`
    : 'every harness measured reported working while it was working',
)
