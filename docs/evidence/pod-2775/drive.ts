/**
 * POD-2775 — what happens to a codex app-server session when it is hibernated
 * and then resumed.
 *
 *   bash docs/evidence/pod-2775/drive-up.sh
 *   bash docs/evidence/pod-2775/drive-verify.sh HEAD
 *   bun  docs/evidence/pod-2775/drive.ts
 *
 * FOUR THINGS ARE MEASURED, and they are deliberately different in kind — the
 * report ("it never comes back live") is one sentence covering at least two
 * separable facts, and a drive that collapsed them could not tell which one a
 * fix had actually moved.
 *
 * 1. THE PARK'S RECEIPT — how long `sessions.hibernate` takes to settle the row,
 *    and which teardown lines the daemon logged while it did. `could not
 *    complete the server-driver verb` and `needs measured escalation` are the
 *    two the report names; both are read out of the log by their real text, not
 *    inferred.
 *
 * 2. THE PROCESS — did the codex app-server child actually die, and did its
 *    systemd scope get reclaimed? A park that leaves either behind is the
 *    POD-2249 lie (the row says parked, the credentialed child runs on), and it
 *    is also what makes the NEXT spawn land in an occupied scope.
 *
 * 3. THE RESUME — does the row come back to a live status, and is the SAME
 *    conversation still there? Codex resumes from a rollout JSONL its child
 *    writes on the way out, so "came back live" and "came back with the
 *    conversation" can fail independently and the drive asks both.
 *
 * 4. THE RESUMED SESSION ANSWERS — one more exchange after the resume. A row
 *    that flips to `running` while nothing behind it can take a turn is exactly
 *    the state POD-2761's drive was blocked by, so the row's word is never the
 *    last word here.
 *
 * IT REPORTS, IT DOES NOT ASSERT. A red run has to stay readable, because the
 * first thing this rig is asked to do is REPRODUCE a defect.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19847'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2775'
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2775'
const REPO = `${DRIVE_BASE}/repo`
const DAEMON_LOG = `${DRIVE_BASE}/logs/daemon.log`

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

/**
 * REFUSE TO DRIVE A STARVED BOX.
 *
 * A rig whose codex child is OOM-killed mid-park produces a SILENT ZERO that
 * reads exactly like a working fix: no surviving process, no escalation line,
 * nothing to see. This epic has already had one drive report a zero on code that
 * worked. So the memory headroom is a precondition, checked before anything is
 * created, and stated in the output either way — a reader must never have to
 * wonder which kind of zero they are looking at.
 */
const availableMb = ((): number => {
  try {
    const line = readFileSync('/proc/meminfo', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('MemAvailable:'))
    return Math.round(Number((line ?? '').replace(/\D+/g, '')) / 1024)
  } catch {
    return Number.NaN
  }
})()
const MIN_AVAILABLE_MB = 900
if (Number.isFinite(availableMb) && availableMb < MIN_AVAILABLE_MB) {
  console.error(
    `NO MEASUREMENT: ${availableMb}MB available, under the ${MIN_AVAILABLE_MB}MB this drive needs.\n` +
      `  A codex app-server killed for memory mid-park is indistinguishable from a clean park,\n` +
      `  so a run from here could only produce a number nobody should believe.`,
  )
  process.exit(1)
}
console.log(`host: ${availableMb}MB available (floor ${MIN_AVAILABLE_MB}MB)`)

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

const trpc = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}
const query = async (path: string, input: unknown = {}): Promise<unknown> => {
  const res = await fetch(
    `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    {
      headers: { cookie },
    },
  )
  const body = (await res.json()) as { result?: { data?: unknown } }
  return body.result?.data
}

interface Row {
  sessionId: string
  status: string
  agentKind: string
  agentState?: { phase?: string }
  spawnFailure?: unknown
  [k: string]: unknown
}
const row = async (sid: string): Promise<Row | undefined> => {
  const list = (await query('sessions.list')) as Row[] | undefined
  return list?.find((s) => s.sessionId === sid)
}

/** The daemon's own words, matched on the real strings the source logs. */
const logLines = (needle: string): string[] => {
  try {
    return readFileSync(DAEMON_LOG, 'utf8')
      .split('\n')
      .filter((l) => l.includes(needle))
  } catch {
    return []
  }
}
const logMark = (): number => {
  try {
    return readFileSync(DAEMON_LOG, 'utf8').length
  } catch {
    return 0
  }
}
const logSince = (mark: number, needle: string): string[] =>
  (() => {
    try {
      return readFileSync(DAEMON_LOG, 'utf8')
        .slice(mark)
        .split('\n')
        .filter((l) => l.includes(needle))
    } catch {
      return []
    }
  })()

/** The codex app-server children of THIS session. The listener path is a
 *  sha256 prefix of the session id (`codexClientSocketPath`), so the process
 *  table can be filtered by identity rather than by "any codex". */
const codexChildren = (sid: string): { pid: string; args: string }[] => {
  const tag = createHash('sha256').update(sid).digest('hex').slice(0, 12)
  const ps = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout ?? ''
  return ps
    .split('\n')
    .filter((l) => l.includes('codex') && l.includes(tag) && !l.includes('ps -eo'))
    .map((l) => {
      const t = l.trim()
      const sp = t.indexOf(' ')
      return { pid: t.slice(0, sp), args: t.slice(sp + 1) }
    })
}

/** The transient scope the child was launched into, if this host scopes at all. */
const scopeState = (sid: string): string => {
  const unit = `podium-cx-${sid}.scope`
  const out = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], {
    encoding: 'utf8',
  })
  return (out.stdout ?? '').trim() || 'unknown'
}

const pollRow = async (
  sid: string,
  want: (r: Row | undefined) => boolean,
  budgetMs: number,
): Promise<{ r: Row | undefined; ms: number; ok: boolean }> => {
  const t0 = Date.now()
  for (;;) {
    const r = await row(sid)
    if (want(r)) return { r, ms: Date.now() - t0, ok: true }
    if (Date.now() - t0 > budgetMs) return { r, ms: Date.now() - t0, ok: false }
    await wait(500)
  }
}

// --- a live codex session, with a conversation in it ------------------------
console.log('creating a codex session with one exchange…')
const created = (await trpc('sessions.create', {
  cwd: REPO,
  agentKind: 'codex',
  initialPrompt: 'Say the word ALPHA and nothing else.',
})) as { result?: { data?: { sessionId?: string } }; error?: unknown }
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`  session ${sid}`)

/**
 * WAIT FOR IDLE, AND THE FIRST RUN OF THIS RIG IS WHY.
 *
 * `hibernateSession` REFUSES a working agent — "let it reach idle first" — and
 * it refuses by returning `{ ok: false, reason }`, not by erroring. A drive that
 * slept a fixed twenty seconds and then read the row got a session that was
 * still `live` with no park attempted at all, and every measurement after that
 * point described a session nobody had touched. So the park is only attempted
 * from the state the park is defined for, and the refusal reason is printed.
 */
const idle = await pollRow(
  sid,
  (r) => r?.agentState?.phase === 'idle' || r?.agentState?.phase === 'ended',
  120_000,
)
console.log(`  reached '${idle.r?.agentState?.phase ?? 'no state'}' after ${secs(idle.ms)}`)

/**
 * THE CONTROL, AND IT IS THE SAME ONE POD-2761's RIG LEARNED THE HARD WAY.
 * A codex the version gate refuses, or a logged-out home, degrades the driver to
 * `generic-pty` behind one warn line. That session answers prompts and looks
 * healthy — and it is a PTY session, so it never enters the server-driver
 * teardown this issue is about. Measuring it would produce a clean hibernate and
 * a confident, worthless PASS.
 */
const live = await row(sid)
const children = codexChildren(sid)
const driverLine = (logLines('preferred runtime driver').at(-1) ?? '').trim()
if (children.length === 0) {
  let why = 'no driver-degrade line in the daemon log — look further up it'
  if (driverLine) {
    const m = /\{.*\}/.exec(driverLine)
    if (m) {
      const p = JSON.parse(m[0]) as { preferred?: string; resolved?: string; reason?: string }
      why = `the daemon wanted '${p.preferred}' and got '${p.resolved}' — ${p.reason}`
    }
  }
  console.error(
    `\nNO MEASUREMENT: this session has no codex app-server child, so it is not a\n` +
      `  server-driver session and the teardown under test is never entered.\n` +
      `  ${why}\n` +
      `  row: ${JSON.stringify(live)}`,
  )
  await trpc('sessions.kill', { sessionId: sid })
  process.exit(1)
}
console.log(`  app-server children: ${children.map((c) => c.pid).join(', ')}`)
console.log(`  scope ${`podium-cx-${sid}.scope`}: ${scopeState(sid)}`)
console.log(`  row status before the park: ${live?.status}`)

// --- 1. the park's receipt --------------------------------------------------
console.log('\nhibernating…')
const mark = logMark()
const t0 = Date.now()
const hib = await trpc('sessions.hibernate', { sessionId: sid })
const callMs = Date.now() - t0
// THE COMMAND'S OWN VERDICT. `sessions.hibernate` answers `{ ok, reason }`; a
// refusal is a 200 with `ok:false`, so reading only `error` reads every refusal
// as a success.
const hibResult = (hib.result as { data?: { ok?: boolean; reason?: string } } | undefined)?.data
if (hib.error) console.log(`  sessions.hibernate returned an error: ${JSON.stringify(hib.error)}`)
if (hibResult?.ok === false) console.log(`  sessions.hibernate REFUSED: ${hibResult.reason}`)
const parked = await pollRow(
  sid,
  (r) => r?.status === 'hibernated' || r?.status === 'parked',
  30_000,
)
console.log(
  `  the call returned in ${secs(callMs)}; the row read '${parked.r?.status}' after ${secs(parked.ms)}`,
)

await wait(6_000)
const verbFail = logSince(mark, 'could not complete the server-driver verb')
const escalate = logSince(mark, 'needs measured escalation')
const stillRunning = logSince(mark, 'is STILL running after a kill')
console.log("\n1. THE PARK'S RECEIPT — the daemon's own lines")
console.log(`     "could not complete the server-driver verb" : ${verbFail.length}`)
console.log(`     "needs measured escalation"                 : ${escalate.length}`)
console.log(`     "is STILL running after a kill"             : ${stillRunning.length}`)
for (const l of [...verbFail, ...escalate, ...stillRunning])
  console.log(`       | ${l.trim().slice(0, 220)}`)

// --- 2. the process ---------------------------------------------------------
const after = codexChildren(sid)
console.log('\n2. THE PROCESS')
console.log(
  `     app-server children still alive: ${after.length ? after.map((c) => c.pid).join(', ') : 'none'}`,
)
console.log(`     scope ActiveState: ${scopeState(sid)}`)

// --- 3. the resume ----------------------------------------------------------
console.log('\nresuming with a new message…')
const mark2 = logMark()
const t1 = Date.now()
const res = await trpc('sessions.resumeAndSend', {
  sessionId: sid,
  text: 'Say the word BRAVO and nothing else.',
})
const resumeCallMs = Date.now() - t1
if (res.error)
  console.log(`  sessions.resumeAndSend returned an error: ${JSON.stringify(res.error)}`)
const back = await pollRow(
  sid,
  (r) =>
    r !== undefined &&
    r.status !== 'hibernated' &&
    r.status !== 'parked' &&
    r.status !== 'starting',
  90_000,
)
console.log('\n3. THE RESUME')
console.log(`     the call returned in ${secs(resumeCallMs)}`)
console.log(
  `     the row reads '${back.r?.status}' after ${secs(back.ms)}${back.ok ? '' : ' (BUDGET EXHAUSTED)'}`,
)
const revived = codexChildren(sid)
console.log(
  `     app-server children after the resume: ${revived.length ? revived.map((c) => c.pid).join(', ') : 'NONE'}`,
)
console.log(`     scope ActiveState: ${scopeState(sid)}`)
const spawnFailure = back.r?.spawnFailure
if (spawnFailure) console.log(`     spawnFailure on the row: ${JSON.stringify(spawnFailure)}`)

// --- 4. does the resumed session actually answer? ---------------------------
console.log('\nwaiting for the resumed session to answer…')
await wait(45_000)
const items = (await query('sessions.transcriptRead', {
  sessionId: sid,
  direction: 'before',
  limit: 200,
})) as { items?: unknown[] } | unknown[] | undefined
const text = JSON.stringify(items ?? [])
const has = (w: string): boolean => new RegExp(`\\b${w}\\b`).test(text)
console.log('\n4. THE RESUMED SESSION')
console.log(`     ALPHA (before the park) present in the transcript: ${has('ALPHA')}`)
console.log(`     BRAVO (after the resume) present in the transcript: ${has('BRAVO')}`)
/**
 * THE RESUME LEG'S POSITIVE CONTROL. `BRAVO` missing is the finding — but only
 * if something could have been read at all. ALPHA was written before the park,
 * so its presence proves this transcript read reaches this session's history; if
 * ALPHA is gone too, the read is what failed and BRAVO's absence says nothing
 * about the resume.
 */
if (!has('ALPHA')) {
  console.log(
    '     ⚠ CONTROL MISSING: the pre-park exchange is not readable either, so the absence of\n' +
      '       BRAVO is not evidence about the resume — it is evidence about this read.',
  )
}
const resumeErrs = logSince(mark2, 'codex')
  .filter((l) => /warn|error/i.test(l))
  .slice(-8)
for (const l of resumeErrs) console.log(`       | ${l.trim().slice(0, 220)}`)

// --- the verdict ------------------------------------------------------------
/**
 * TWO VERDICTS, BECAUSE THEY ARE TWO DEFECTS. The park's receipt and the
 * resume's outcome fail independently — the resume failed here against a park
 * whose child died cleanly — and one combined line would have hidden that.
 */
const parkQuiet = hibResult?.ok === true && verbFail.length === 0 && escalate.length === 0
const parkReaped = hibResult?.ok === true && after.length === 0
const resumeLive = back.ok && revived.length > 0 && has('BRAVO')
console.log('\n=== VERDICT ===')
console.log(
  `  park receipt : ${parkQuiet ? 'CLEAN — the stop verb completed inside its bound' : 'WEDGED — the verb could not complete; see the lines above'}`,
)
console.log(
  `  park process : ${parkReaped ? 'REAPED — no app-server child survived' : 'SURVIVED — a child is still running'}`,
)
console.log(
  `  resume       : ${resumeLive ? 'LIVE — a fresh app-server resumed the thread and took a turn' : 'DEAD — the session did not come back'}`,
)
console.log(
  `  overall      : ${
    !has('ALPHA')
      ? 'NO MEASUREMENT — the positive control is missing'
      : parkQuiet && parkReaped && resumeLive
        ? 'PASS'
        : 'REPRODUCED'
  }`,
)

await trpc('sessions.kill', { sessionId: sid })
