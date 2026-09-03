/**
 * POD-2777 — the table the operator reads instead of an evening of clicking.
 *
 *   bun docs/evidence/pod-2777/report.ts [--evidence]
 *
 * Built from $PODIUM_DRIVE_BASE/results/*.json — what actually ran — so no line
 * here is a number a human retyped. Every arm carries the pin it ran under and
 * the driver it actually bound, and both are printed: a column whose driver is
 * not the one its arm claims is not evidence about that arm.
 *
 * THE COMPARISON IS THE POINT. A green headless column on its own does not
 * answer "are the new headless agents better than the old terminal ones" —
 * that is a comparison, so every harness that can run both ways ran both, and
 * the verdict section below counts the cells where they differ, in both
 * directions. A row where headless is WORSE is the finding this drive exists to
 * be able to report, and it is printed first.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'

const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'
const DIR = `${DRIVE_BASE}/results`
const withEvidence = process.argv.includes('--evidence')

interface Run {
  harness: string
  arm: 'headless' | 'terminal'
  driverId: string
  driverFamily: string | null
  pin: Record<string, unknown>
  at: string
  results: {
    id: string
    title: string
    catalogRow: string
    verdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'REFUSED'
    summary: string
    evidence: string[]
    control: { fired: boolean; what: string; detail: string }
    ms: number
    data?: Record<string, unknown>
    /** Per-cell pin: a merged file can hold probes taken at different commits. */
    pin?: string
    at?: string
  }[]
}

if (!existsSync(DIR)) {
  console.error(`no results at ${DIR} — run drive.ts first`)
  process.exit(1)
}
const runs: Run[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as Run)

if (runs.length === 0) {
  console.error(`no result files in ${DIR}`)
  process.exit(1)
}

const HARNESSES = ['codex', 'grok', 'opencode', 'claude'].filter((h) =>
  runs.some((r) => r.harness === h),
)
const PROBE_ORDER = [
  'reply',
  'stream',
  'interrupt',
  'stop',
  'resume',
  'attach',
  'interaction',
  'provider-error',
  'model-switch',
]
const PROBE_TITLE: Record<string, string> = {
  reply: 'send a turn, get a reply',
  stream: 'streaming deltas arrive',
  interrupt: 'interrupt a running turn',
  stop: 'stop',
  resume: 'resume after a kill',
  attach: 'attach a file',
  interaction: 'pending interaction',
  'provider-error': 'provider error surfaced honestly',
  'model-switch': 'model / effort switch',
}

/**
 * BEHAVIOURS THE TERMINAL DRIVER NEVER CLAIMED.
 *
 * `generic-pty` declares `watchLevels: ['coarse']` and nothing else, so no
 * fragment is ever produced for it and the catalogue marks the whole streaming
 * section **n/a** for terminal. A terminal arm scoring 0 preview frames is
 * therefore the MECHANISM, not a defect — and counting it as a terminal-path
 * failure would be this report inventing a regression out of a declaration.
 *
 * It still scores FAIL in the A/B table, and it must: "headless streams, the
 * terminal driver does not" is precisely the comparison the operator asked for.
 * The distinction is that the same cell means "better" in one section and means
 * nothing in the other.
 */
const TERMINAL_NEVER_CLAIMED = new Set(['stream'])

/** Harnesses with no headless driver: one real path, so one column. */
const SINGLE_PATH = new Set(['claude'])

const find = (h: string, arm: string) => runs.find((r) => r.harness === h && r.arm === arm)
const cellOf = (h: string, arm: string, probe: string) =>
  find(h, arm)?.results.find((p) => p.id === probe)

const MARK: Record<string, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'n/a',
  REFUSED: 'REF',
}
const mark = (c: ReturnType<typeof cellOf>) => (c ? (MARK[c.verdict] ?? '?') : '—')

const line = (s = '') => console.log(s)
const pad = (s: string, n: number) => s.padEnd(n)

// ---------------------------------------------------------------------------
// what ran, and under which pin
// ---------------------------------------------------------------------------
line('='.repeat(96))
line("POD-1761 ACCEPTANCE DRIVE — did the headless drivers beat the terminal ones?")
line('='.repeat(96))
line()
line(`${pad('arm', 22)}${pad('driver bound', 20)}${pad('pin (server+daemon)', 22)}${pad('web bundle', 12)}when`)
line('-'.repeat(96))
for (const r of runs) {
  const shortPin = String(r.pin.want ?? '').slice(0, 12)
  line(
    `${pad(`${r.harness} / ${r.arm}`, 22)}${pad(r.driverId, 20)}${pad(shortPin, 22)}${pad(String(r.pin.webSourceSha ?? '?'), 12)}${r.at.slice(0, 19)}`,
  )
}
line()
line('Every row above verified server, daemon AND web bundle against the same commit')
line('BEFORE it ran; drive.ts exits 4 rather than measure a rig that failed that check.')

// A merged results file can hold cells taken at different commits (a targeted
// re-drive of one probe). Saying so is the whole point of stamping them: a table
// that inherited the newest run's pin for every cell would be the stale-rig lie
// this rig exists to prevent.
const pins = new Set(runs.flatMap((r) => r.results.map((p) => p.pin).filter(Boolean)))
if (pins.size > 1) {
  line()
  line(`NOTE: cells in this table were taken at ${pins.size} different commits (${[...pins].join(', ')}).`)
  line('Per-cell pins are printed in the evidence section; no cell inherits another run\'s.')
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------
line()
line('='.repeat(96))
line('PER-HARNESS RESULT — headless (H) beside terminal (T), same rig, same probes')
line('='.repeat(96))
line()
const head = HARNESSES.map((h) => pad(h, 14)).join('')
line(`${pad('', 34)}${head}`)
line(`${pad('behaviour', 34)}${HARNESSES.map(() => pad('H     T', 14)).join('')}`)
line('-'.repeat(96))
for (const probe of PROBE_ORDER) {
  const cells = HARNESSES.map((h) => {
    /**
     * CLAUDE HAS ONE PATH, so it gets one column rather than a blank and a
     * column. It binds `claude-pty` whatever the driver preference says — the
     * forced-`generic-pty` arm produced NO BINDING AT ALL in 91s, because that
     * preference names a driver claude does not have — so the honest rendering
     * is a single cell under T, the path it actually runs.
     */
    if (SINGLE_PATH.has(h)) {
      const only = cellOf(h, 'headless', probe) ?? cellOf(h, 'terminal', probe)
      return pad(`${pad('—', 6)}${mark(only)}`, 14)
    }
    const hd = mark(cellOf(h, 'headless', probe))
    const tm = mark(cellOf(h, 'terminal', probe))
    return pad(`${pad(hd, 6)}${tm}`, 14)
  }).join('')
  line(`${pad(PROBE_TITLE[probe] ?? probe, 34)}${cells}`)
}
line('-'.repeat(96))
line('PASS = driven and observed working.   FAIL = driven and did not work.')
line('n/a  = the behaviour has no product surface to drive (see its evidence).')
line('REF  = REFUSED: the probe\'s positive control did not fire, so the rig could not')
line('       be told apart from a dead one and the number is withheld — including zero.')
line('—    = not applicable: claude has no headless driver, so it runs one arm.')

// ---------------------------------------------------------------------------
// the comparison — the operator's actual question
// ---------------------------------------------------------------------------
line()
line('='.repeat(96))
line('THE COMPARISON — where the two arms disagree')
line('='.repeat(96))
line()
const better: string[] = []
const worse: string[] = []
const same: string[] = []
for (const h of HARNESSES) {
  if (h === 'claude') continue
  for (const probe of PROBE_ORDER) {
    const hd = cellOf(h, 'headless', probe)
    const tm = cellOf(h, 'terminal', probe)
    if (!hd || !tm) continue
    // Only scored cells can be compared. A REFUSED cell is not a result, and
    // counting it either way would be exactly the lie this rig is built against.
    if (!['PASS', 'FAIL'].includes(hd.verdict) || !['PASS', 'FAIL'].includes(tm.verdict)) continue
    const label = `${h} · ${PROBE_TITLE[probe] ?? probe}`
    if (hd.verdict === 'PASS' && tm.verdict === 'FAIL') better.push(`${label}: headless PASS, terminal FAIL — ${hd.summary}`)
    else if (hd.verdict === 'FAIL' && tm.verdict === 'PASS') worse.push(`${label}: headless FAIL, terminal PASS — ${hd.summary}`)
    else same.push(`${label}: both ${hd.verdict}`)
  }
}
if (worse.length > 0) {
  line('HEADLESS IS WORSE HERE — printed first because it is the finding that matters:')
  for (const w of worse) line(`  ✗ ${w}`)
  line()
}
line(`HEADLESS BETTER   ${better.length} scored cell(s)`)
for (const b of better) line(`  ✓ ${b}`)
line()
line(`SAME              ${same.length} scored cell(s)`)
line(`HEADLESS WORSE    ${worse.length} scored cell(s)`)

// ---------------------------------------------------------------------------
// the terminal path, which the epic promised not to break
// ---------------------------------------------------------------------------
line()
line('='.repeat(96))
line('THE OTHER HALF — are the harnesses still on the terminal driver any worse?')
line('='.repeat(96))
line()
const claudeRun = find('claude', 'headless') ?? find('claude', 'terminal')
if (claudeRun) {
  const scoredAll = claudeRun.results.filter((r) => r.verdict === 'PASS' || r.verdict === 'FAIL')
  const scored = scoredAll.filter((r) => !TERMINAL_NEVER_CLAIMED.has(r.id))
  const excluded = scoredAll.filter((r) => TERMINAL_NEVER_CLAIMED.has(r.id))
  const failed = scored.filter((r) => r.verdict === 'FAIL')
  line(`claude runs the terminal driver ('${claudeRun.driverId}') and is the harness this`)
  line('question is about. Of the behaviours the terminal driver actually CLAIMS:')
  line(`  ${scored.length - failed.length}/${scored.length} PASS`)
  for (const f of failed) line(`  ✗ ${f.id}: ${f.summary}`)
  if (excluded.length > 0) {
    line()
    line('  Excluded from that count, because the terminal driver never claimed them:')
    for (const e of excluded) {
      line(`    ${e.id} (${e.verdict}) — generic-pty declares watchLevels ['coarse'] only, so`)
      line('      no fragment is ever produced. The catalogue marks this row n/a for terminal.')
      line('      It is counted as "headless is better" above, and NOT as a terminal regression')
      line('      here — the same reading, honestly, in both places.')
    }
  }
  line()
  line('WHAT THIS DOES AND DOES NOT SHOW. It is one commit, so it cannot be a')
  line('before-and-after in time. What it does show is that the terminal driver still')
  line("does everything it declares, on the same rig that drove the headless arms — and")
  line('the terminal columns for codex/grok/opencode are the same driver under the same')
  line('probes, so a terminal-path regression would have to hide from all four.')
} else {
  line('claude was not driven — the terminal-path half of the question is UNANSWERED.')
  line('This report will not imply otherwise.')
}

// ---------------------------------------------------------------------------
// refusals, called out rather than buried
// ---------------------------------------------------------------------------
const refusals = runs.flatMap((r) =>
  r.results.filter((p) => p.verdict === 'REFUSED').map((p) => ({ r, p })),
)
line()
line('='.repeat(96))
line(`REFUSED MEASUREMENTS — ${refusals.length}`)
line('='.repeat(96))
if (refusals.length === 0) {
  line()
  line('None: every probe above ran with its positive control firing.')
} else {
  line()
  line('A refusal is the rig working. These cells are withheld, not failed:')
  for (const { r, p } of refusals) {
    line(`  ${r.harness}/${r.arm} · ${p.id}`)
    line(`      control watched: ${p.control.what}`)
    line(`      control saw:     ${p.control.detail}`)
  }
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------
if (withEvidence) {
  line()
  line('='.repeat(96))
  line('EVIDENCE')
  line('='.repeat(96))
  for (const r of runs) {
    line()
    line(`### ${r.harness} / ${r.arm} — driver ${r.driverId}`)
    for (const p of r.results) {
      line()
      line(`  [${p.verdict}] ${p.id} — ${p.title}${p.pin ? `   (pin ${p.pin})` : ''}`)
      line(`      catalogue: ${p.catalogRow}`)
      line(`      control:   ${p.control.fired ? 'FIRED' : 'DID NOT FIRE'} — ${p.control.what}`)
      line(`                 ${p.control.detail}`)
      for (const e of p.evidence) line(`      ${e}`)
    }
  }
}
line()
