/**
 * POD-2775 — what happens to a SERVER-FAMILY session when it is hibernated and
 * then resumed. Two arms: `codex` (default) and `opencode`.
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
 * 3. THE RESUME — does the row come back to a live status, and is it the SAME
 *    CONVERSATION, proved twice over? Codex resumes from a rollout JSONL its
 *    child writes on the way out, so "came back live" and "came back with the
 *    conversation" can fail independently and the drive asks both.
 *
 *    IDENTITY, NOT PRESENCE (POD-2775, review 2). This leg used to look for the
 *    literal words ALPHA and BRAVO, which any transcript containing those words
 *    satisfies — including a brand-new session that had just been told to say
 *    them. Two things fix that. The witnesses are NONCED per run, so the words
 *    exist in exactly one conversation on this machine; and the binding journal's
 *    `threadId` is read off disk before the park and after the resume, which is
 *    the mechanism itself rather than a proxy for it. A resume that started a
 *    fresh thread comes back with a different id even if it says all the right
 *    words.
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
const PORT = process.env.PODIUM_PORT ?? '19867'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2775'
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2775'
const REPO = `${DRIVE_BASE}/repo`
const DAEMON_LOG = `${DRIVE_BASE}/logs/daemon.log`
const STATE_DIR = process.env.PODIUM_STATE_DIR ?? `${DRIVE_BASE}/state`

/**
 * THE WITNESSES, NONCED. `ALPHA`/`BRAVO` as bare words are satisfied by any
 * transcript containing them — a fresh session told to say them passes just as
 * well as a resumed one, which is exactly the hole review 2 found. A nonce makes
 * each witness unique to THIS run, so finding it is finding this conversation.
 */
const NONCE =
  process.env.PODIUM_DRIVE_NONCE ??
  createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex').slice(0, 8)
const ALPHA = `ALPHA-${NONCE}`
const BRAVO = `BRAVO-${NONCE}`

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

/**
 * THE TWO ARMS, AND WHY THIS RIG HAS TWO (POD-2775, review 1).
 *
 * The fix under measurement is ONE route in the daemon serving THREE families,
 * and the first round of this issue drove exactly one of them. That is how a
 * parked opencode session shipped unable to come back: codex's `adopt` was
 * already written as resume-not-rebind, so the shared route looked proven when
 * only the family that never needed it had been checked.
 *
 * Everything below the arm table is family-independent. What differs is only
 * how this machine NAMES the session's server: which journal directory holds
 * it, which field in there is the conversation, how its child appears in the
 * process table, and what its transient scope is called.
 *
 *   bun docs/evidence/pod-2775/drive.ts codex
 *   bun docs/evidence/pod-2775/drive.ts opencode
 */
interface JournalEntry {
  /** codex: the rollout thread. */
  threadId?: string
  /** opencode: the `ses_…` row set in its database. */
  opencodeSessionId?: string
  baseUrl?: string
  model?: { model?: string; effort?: string }
  process?: { pid?: number }
}

interface Arm {
  agentKind: string
  /**
   * A MODEL TO PIN THE SESSION TO, where this host has one it will accept.
   *
   * Without it the journalled policy is empty on both sides of the park and the
   * drive cannot show that a wake KEEPS the operator's choice — the third
   * review finding. `sessions.create` takes it, and the daemon carries it into
   * the spec every later turn is sent with.
   *
   * Absent for opencode: this host's only provider credential is `opencode-go`
   * and the family refuses anything that is not `provider/model`, so naming one
   * here would be a guess. That arm's model property is pinned in the
   * conformance corpus instead, where the fixture knows what its harness takes.
   */
  model?: { model: string; effort?: string }
  /** Where the daemon persists this family's binding journal. */
  journalDir: string
  /** The field that names the CONVERSATION — the value a resume must reuse. */
  conversation(entry: JournalEntry | undefined): string | undefined
  /** This session's server children, matched on identity rather than on "any
   *  process of this harness". */
  children(sid: string, entry: JournalEntry | undefined): { pid: string; args: string }[]
  scopeUnit(sid: string): string
}

const ps = (): string[] =>
  (spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout ?? '').split('\n')
const asChild = (line: string): { pid: string; args: string } => {
  const t = line.trim()
  const sp = t.indexOf(' ')
  return { pid: t.slice(0, sp), args: t.slice(sp + 1) }
}

const ARMS: Record<string, Arm> = {
  codex: {
    agentKind: 'codex',
    journalDir: 'codex-app-servers',
    conversation: (e) => e?.threadId,
    // The listener path is a sha256 prefix of the session id
    // (`codexClientSocketPath`), so the process table can be filtered by
    // identity rather than by "any codex".
    children: (sid) => {
      const tag = createHash('sha256').update(sid).digest('hex').slice(0, 12)
      return ps()
        .filter((l) => l.includes('codex') && l.includes(tag) && !l.includes('ps -eo'))
        .map(asChild)
    },
    model: { model: 'gpt-5-codex', effort: 'high' },
    scopeUnit: (sid) => `podium-cx-${sid}.scope`,
  },
  opencode: {
    agentKind: 'opencode',
    journalDir: 'opencode-servers',
    conversation: (e) => e?.opencodeSessionId,
    /**
     * `opencode serve --port <port>`, and the PORT is the identity. This family
     * has no per-session socket path to match on, but the journal records the
     * base url the daemon bound — so the entry passed in decides which
     * incarnation is being asked about. That matters here more than anywhere
     * else in this rig: the whole point of the opencode arm is that the resume
     * relaunches on a NEW port, so "is a child alive" has to be asked of a
     * named incarnation rather than of the session in general.
     */
    children: (_sid, entry) => {
      const port = entry?.baseUrl ? new URL(entry.baseUrl).port : undefined
      if (!port) return []
      return ps()
        .filter(
          (l) => l.includes('opencode') && l.includes(`--port ${port}`) && !l.includes('ps -eo'),
        )
        .map(asChild)
    },
    scopeUnit: (sid) => `podium-oc-${sid}.scope`,
  },
}

const KIND = process.argv[2] ?? process.env.PODIUM_DRIVE_KIND ?? 'codex'
const arm = ARMS[KIND]
if (!arm) throw new Error(`unknown arm '${KIND}' — expected one of ${Object.keys(ARMS).join(', ')}`)
console.log(`arm: ${KIND}`)

/** The transient scope the child was launched into, if this host scopes at all. */
const scopeState = (sid: string): string => {
  const out = spawnSync(
    'systemctl',
    ['--user', 'show', arm.scopeUnit(sid), '-p', 'ActiveState', '--value'],
    { encoding: 'utf8' },
  )
  return (out.stdout ?? '').trim() || 'unknown'
}

/**
 * THE BINDING JOURNAL THIS MACHINE WROTE FOR THIS SESSION.
 *
 * The daemon persists it under its own state dir, one file per session, and it
 * is the record the resume path reads: the conversation id, and the model policy
 * every later turn is sent with. Reading it directly is what makes the identity
 * claim a MECHANISM check rather than a text one — a resume that quietly started
 * a new conversation writes a new id here whatever the transcript ends up
 * saying.
 */
const journalEntry = (sid: string): JournalEntry | undefined => {
  try {
    return JSON.parse(
      readFileSync(`${STATE_DIR}/${arm.journalDir}/${encodeURIComponent(sid)}.json`, 'utf8'),
    ) as JournalEntry
  } catch {
    return undefined
  }
}

/** The session's transcript as the browser reads it, flattened to text. */
const transcriptText = async (sid: string): Promise<string> =>
  JSON.stringify(
    (await query('sessions.transcriptRead', { sessionId: sid, direction: 'before', limit: 200 })) ??
      [],
  )

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
console.log(`creating a ${KIND} session with one exchange…`)
const created = (await trpc('sessions.create', {
  cwd: REPO,
  agentKind: arm.agentKind,
  ...(arm.model ?? {}),
  initialPrompt: `Say the word ${ALPHA} and nothing else.`,
})) as { result?: { data?: { sessionId?: string } }; error?: unknown }
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`  session ${sid}`)

/**
 * THE PRE-PARK EXCHANGE HAS TO BE ON THE TRANSCRIPT, AND ONLY THEN MAY THE
 * SESSION BE PARKED. Both halves were learned by driving the opencode arm, and
 * the order between them is the whole lesson.
 *
 * AN IDLE ROW IS NOT AN EXCHANGE. This rig waited for
 * `agentState.phase === 'idle'` and parked at once. For codex that is safe —
 * the initial prompt opens the thread's first turn, so the session cannot be
 * idle before it has been asked. For opencode the initial prompt is a
 * `when-ready` send AFTER `POST /session`, and the row is idle in the window
 * before it goes out. The park landed on a conversation with nothing in it and
 * the run ended at NO MEASUREMENT, because the control it needs after the
 * resume had never existed.
 *
 * AND AN EXCHANGE ON THE TRANSCRIPT IS NOT AN IDLE SESSION. Waiting for the
 * witness alone put the park on an OPEN TURN, and `hibernateSession` refuses
 * one ("agent is working — let it reach idle first"). So the witness is waited
 * for first, where it has to be true, and idle is waited for after it.
 */
const t0Alpha = Date.now()
let preParkText = ''
while (Date.now() - t0Alpha < 180_000) {
  preParkText = await transcriptText(sid)
  if (preParkText.includes(ALPHA)) break
  await wait(2_000)
}
if (!preParkText.includes(ALPHA)) {
  console.error(
    `\nNO MEASUREMENT: ${ALPHA} never reached the transcript, so there is no pre-park\n` +
      `  exchange for the resume to be judged against. Parking here would measure the\n` +
      `  wake of an EMPTY conversation, which succeeds for reasons that say nothing\n` +
      `  about this fix.`,
  )
  await trpc('sessions.kill', { sessionId: sid })
  process.exit(1)
}
console.log(`  ${ALPHA} on the transcript after ${secs(Date.now() - t0Alpha)}`)

const idle = await pollRow(
  sid,
  (r) => r?.agentState?.phase === 'idle' || r?.agentState?.phase === 'ended',
  180_000,
)
console.log(`  reached '${idle.r?.agentState?.phase ?? 'no state'}' after ${secs(idle.ms)}`)

/**
 * THE CONTROL, AND IT IS THE SAME ONE POD-2761's RIG LEARNED THE HARD WAY.
 * A codex the version gate refuses, an opencode binary that is not on the
 * daemon's PATH, or a logged-out home degrades the driver to `generic-pty`
 * behind one warn line. That session answers prompts and looks
 * healthy — and it is a PTY session, so it never enters the server-driver
 * teardown this issue is about. Measuring it would produce a clean hibernate and
 * a confident, worthless PASS.
 */
const live = await row(sid)
const journalBefore = journalEntry(sid)
const children = arm.children(sid, journalBefore)
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
    `\nNO MEASUREMENT: this session has no ${KIND} server child, so it is not a\n` +
      `  server-driver session and the teardown under test is never entered.\n` +
      `  ${why}\n` +
      `  row: ${JSON.stringify(live)}`,
  )
  await trpc('sessions.kill', { sessionId: sid })
  process.exit(1)
}
console.log(`  app-server children: ${children.map((c) => c.pid).join(', ')}`)
console.log(`  scope ${arm.scopeUnit(sid)}: ${scopeState(sid)}`)
console.log(`  row status before the park: ${live?.status}`)

/**
 * THE CONVERSATION'S IDENTITY, read before the park (it is taken above, because
 * the process check needs the same entry). Everything after this point is
 * compared against it, and a run that could not read it says so rather than
 * comparing two undefineds and calling them equal.
 */
console.log(`  binding journal conversation: ${arm.conversation(journalBefore) ?? 'UNREADABLE'}`)
console.log(
  `  binding journal model:        ${JSON.stringify(journalBefore?.model ?? null)}${arm.model ? ` (asked for ${JSON.stringify(arm.model)})` : ''}`,
)

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
const after = arm.children(sid, journalBefore)
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
  text: `Say the word ${BRAVO} and nothing else.`,
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
const revived = arm.children(sid, journalEntry(sid))
console.log(
  `     app-server children after the resume: ${revived.length ? revived.map((c) => c.pid).join(', ') : 'NONE'}`,
)
console.log(`     scope ActiveState: ${scopeState(sid)}`)
const spawnFailure = back.r?.spawnFailure
if (spawnFailure) console.log(`     spawnFailure on the row: ${JSON.stringify(spawnFailure)}`)

// --- 4. does the resumed session actually answer? ---------------------------
console.log('\nwaiting for the resumed session to answer…')
await wait(45_000)
const text = await transcriptText(sid)
const has = (w: string): boolean => text.includes(w)
const journalAfter = journalEntry(sid)
const conversationBefore = arm.conversation(journalBefore)
const conversationAfter = arm.conversation(journalAfter)
const sameThread = conversationBefore !== undefined && conversationAfter === conversationBefore
console.log('\n4. THE RESUMED SESSION')
console.log(`     ${ALPHA} (before the park) present in the transcript: ${has(ALPHA)}`)
console.log(`     ${BRAVO} (after the resume) present in the transcript: ${has(BRAVO)}`)
/**
 * THE MECHANISM, BESIDE THE TEXT. A nonced witness proves the transcript is this
 * conversation; the journalled thread id proves the RESUME addressed it, and it
 * is the value the wrong-thread mutant moves. They can disagree — a session that
 * resumed the right thread but cannot take a turn shows a matching id and no
 * BRAVO — and that is precisely why both are printed.
 */
console.log(
  `     journalled conversation: before ${conversationBefore ?? 'UNREADABLE'} / after ${conversationAfter ?? 'UNREADABLE'} → ${sameThread ? 'SAME CONVERSATION' : 'DIFFERENT — the resume did not rejoin it'}`,
)
console.log(
  `     journalled model:        before ${JSON.stringify(journalBefore?.model ?? null)} / after ${JSON.stringify(journalAfter?.model ?? null)}`,
)
/**
 * THE RESUME LEG'S POSITIVE CONTROL. `BRAVO` missing is the finding — but only
 * if something could have been read at all. ALPHA was written before the park,
 * so its presence proves this transcript read reaches this session's history; if
 * ALPHA is gone too, the read is what failed and BRAVO's absence says nothing
 * about the resume.
 */
if (!has(ALPHA)) {
  console.log(
    '     ⚠ CONTROL MISSING: the pre-park exchange is not readable either, so the absence of\n' +
      '       BRAVO is not evidence about the resume — it is evidence about this read.',
  )
}
const resumeErrs = logSince(mark2, KIND)
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
const resumeLive = back.ok && revived.length > 0 && has(BRAVO)
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
  `  conversation : ${sameThread ? 'SAME — the journalled thread id survived the round trip' : 'NOT PROVED — the thread id moved, or could not be read'}`,
)
console.log(
  `  overall      : ${
    !has(ALPHA)
      ? 'NO MEASUREMENT — the positive control is missing'
      : parkQuiet && parkReaped && resumeLive && sameThread
        ? 'PASS'
        : 'REPRODUCED'
  }`,
)

await trpc('sessions.kill', { sessionId: sid })
