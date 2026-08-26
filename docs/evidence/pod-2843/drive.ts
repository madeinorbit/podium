/**
 * POD-2843 — does a send into a REATTACHED claude session ever arrive?
 *
 *   bash docs/evidence/pod-2843/drive-up.sh
 *   bun  docs/evidence/pod-2843/drive.ts server     # restart the server half
 *   bun  docs/evidence/pod-2843/drive.ts daemon     # restart the daemon half
 *   bun  docs/evidence/pod-2843/drive.ts none       # the control: no restart
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE EXPERIMENT
 * ---------------------------------------------------------------------------
 *
 * Send #1 goes into a session whose daemon this server watched bind. It is the
 * POSITIVE CONTROL and it is not optional: POD-2836 reported "the same session
 * accepted messages fine before the restart", and a drive that cannot reproduce
 * the working half has not reproduced anything. If send #1 does not land, no
 * verdict about send #2 is printed at all.
 *
 * Then ONE half restarts, and send #2 goes into the session that came back.
 * `none` runs the identical script with the restart skipped, which is what
 * separates "the restart broke it" from "the second send in a session is broken".
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS ARRIVAL, AND WHY IT IS READ TWICE
 * ---------------------------------------------------------------------------
 *
 * "No user turn ever appeared in the transcript" was read through the SERVER.
 * That is one reading of two different facts — the CLI never got the bytes, or
 * the CLI got them and this server cannot see the turn — and they are different
 * bugs with different fixes. So arrival is read BOTH ways on every send:
 *
 *   DISK   the claude-code CLI's own JSONL under the rig's isolated agent home,
 *          parsed directly. This is the CLI's own record, written by the CLI,
 *          and it does not care whether Podium is running at all.
 *   SERVER `sessions.read`, the product's own view — the same signal the drain's
 *          confirm() watches.
 *
 * A disagreement between them IS the finding, so both are printed even when
 * they agree.
 *
 * ---------------------------------------------------------------------------
 * AND THE DRAIN'S OWN STATE
 * ---------------------------------------------------------------------------
 *
 * `attempts` on the durable queue row is the fence the brief points at, so it
 * is read straight out of the sqlite the server writes rather than inferred
 * from log lines. Five is the cap. A row that reaches five and stays is the
 * reported shape; a row that never reaches one is a different bug entirely
 * (the drain never typed), and the count is what tells them apart.
 */

import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19877'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2843'
const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2843'
const REPO = `${DRIVE_BASE}/repo`
const STATE = process.env.PODIUM_STATE_DIR ?? `${DRIVE_BASE}/state`
const AGENT_HOME = `${STATE}/agent-home`
const DB = `${STATE}/podium.db`
const HERE = import.meta.dir

// The operator's live instance is 19797 and the default install is 3000. A rig
// that types a prompt into either would be typing at a human's agent.
if (PORT === '19797' || PORT === '3000') throw new Error(`refusing to drive port ${PORT}`)

const half = (process.argv[2] ?? 'server') as 'server' | 'daemon' | 'none'
if (!['server', 'daemon', 'none'].includes(half)) throw new Error(`unknown half: ${half}`)

/** How long the claude CLI gets to boot before send #1. */
const READY_MS = Number(process.env.P2843_READY_MS ?? 30_000)
/** How long a send gets to become a transcript turn. Generous on purpose: the
 *  claim under test is "never arrives", and a short wait would prove "slow". */
const ARRIVE_MS = Number(process.env.P2843_ARRIVE_MS ?? 120_000)
/** Settle time after the restart before send #2 — the reattach has to happen. */
const REATTACH_MS = Number(process.env.P2843_REATTACH_MS ?? 20_000)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const stamp = () => new Date().toISOString()

// Short, distinct, and NOT a question — a prompt that makes claude think for a
// minute would put the turn behind a long computation and confuse "arrived
// slowly" with "arrived at all". The nonce is what the transcript is searched
// for, so it must not appear anywhere else on the box.
const nonce = (n: number) => `pod2843-${half}-${process.pid}-${n}`
const promptFor = (n: number) => `Reply with exactly this word and nothing else: ${nonce(n)}`

let cookie = ''
const login = async () => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
}

const trpc = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
}
const trpcQuery = async (path: string, input: unknown) => {
  const url = `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
  const res = await fetch(url, { headers: { cookie } })
  return (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
}

/** The durable queue row for this session, straight out of the server's sqlite.
 *  Opened read-only per call: the server owns this file and is writing it. */
const queueRows = (sid: string): { id: string; attempts: number; text: string }[] => {
  if (!existsSync(DB)) return []
  const db = new Database(DB, { readonly: true })
  try {
    return db
      .prepare('SELECT id, attempts, text FROM queued_messages WHERE session_id = ? ORDER BY id')
      .all(sid) as { id: string; attempts: number; text: string }[]
  } catch {
    return []
  } finally {
    db.close()
  }
}

/**
 * THE CLI'S OWN RECORD. claude-code writes one JSONL per session under
 * <home>/.claude/projects/<cwd with every non-alphanumeric turned into ->.
 * Read as raw text and searched for the nonce: the point of this reading is
 * that it does not depend on Podium's parser, so it deliberately does not use
 * one.
 */
const transcriptFiles = (): string[] => {
  const root = join(AGENT_HOME, '.claude', 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    if (!statSync(full).isDirectory()) continue
    for (const f of readdirSync(full)) if (f.endsWith('.jsonl')) out.push(join(full, f))
  }
  return out
}
/** Does the CLI's own transcript hold a USER turn carrying this nonce? Matching
 *  on `"type":"user"` in the same record is what keeps the agent's echo of the
 *  word — an assistant turn — from being read as proof the prompt arrived. */
const onDisk = (needle: string): { user: boolean; anywhere: boolean; copies: number } => {
  let anywhere = false
  // COUNTED, NOT MERELY FOUND. A drain that retypes an unconfirmed row types
  // the SAME prompt again, and if the CLI took every copy the agent saw the
  // request five times while the operator was being told it never arrived.
  // That is a different and worse bug than silent loss, and one number
  // separates them.
  let copies = 0
  for (const f of transcriptFiles()) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(needle)) continue
    anywhere = true
    for (const line of text.split('\n')) {
      if (!line.includes(needle)) continue
      try {
        const rec = JSON.parse(line) as { type?: string }
        if (rec.type === 'user') copies += 1
      } catch {
        /* a partially-written tail line is not evidence either way */
      }
    }
  }
  return { user: copies > 0, anywhere, copies }
}

const sessionMeta = async (sid: string) => {
  const r = (await trpcQuery('sessions.status', { ref: sid })) as {
    result?: { data?: Record<string, unknown> }
  }
  return r.result?.data
}

const serverSees = async (sid: string, needle: string): Promise<boolean> => {
  const r = (await trpcQuery('sessions.read', { sessionId: sid, turns: 12 })) as {
    result?: { data?: unknown }
  }
  return JSON.stringify(r.result?.data ?? '').includes(needle)
}

const restart = (which: 'server' | 'daemon') => {
  const r = spawnSync('bash', [join(HERE, 'drive-restart.sh'), which], {
    encoding: 'utf8',
    timeout: 180_000,
  })
  process.stdout.write(r.stdout ?? '')
  process.stderr.write(r.stderr ?? '')
  if (r.status !== 0) throw new Error(`drive-restart.sh ${which} failed`)
}

// --- the run ---------------------------------------------------------------

console.log(`[${stamp()}] POD-2843 drive — restart half: ${half}`)
await login()

const created = (await trpc('sessions.create', { cwd: REPO, agentKind: 'claude-code' })) as {
  result?: { data?: { sessionId?: string } }
  error?: { message?: string }
}
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`[${stamp()}] session ${sid} created; ${READY_MS}ms for the CLI to come up`)
await wait(READY_MS)

/** Send, then watch both readings until one of them says it arrived. Returns
 *  everything observed, including the attempt count, whether it arrived or not. */
const sendAndWatch = async (n: number, label: string) => {
  const text = promptFor(n)
  const needle = nonce(n)
  const t0 = now()
  const meta0 = await sessionMeta(sid)
  console.log(
    `[${stamp()}] ${label}: sending (session status=${String((meta0 as Record<string, unknown> | undefined)?.status ?? '?')})`,
  )
  const sent = await trpc('sessions.sendText', { sessionId: sid, text })
  if (sent.error) console.log(`[${stamp()}] ${label}: sendText returned error ${sent.error.message}`)

  let diskAt: number | undefined
  let serverAt: number | undefined
  let maxAttempts = 0
  let rowGone = false
  const deadline = now() + ARRIVE_MS
  while (now() < deadline) {
    await wait(1_000)
    const rows = queueRows(sid)
    for (const r of rows) maxAttempts = Math.max(maxAttempts, r.attempts)
    if (rows.length === 0) rowGone = true
    if (diskAt === undefined && onDisk(needle).user) diskAt = now() - t0
    if (serverAt === undefined && (await serverSees(sid, needle))) serverAt = now() - t0
    if (diskAt !== undefined && serverAt !== undefined) break
  }
  const disk = onDisk(needle)
  const rows = queueRows(sid)
  const meta = await sessionMeta(sid)
  const result = {
    label,
    needle,
    diskUserTurnMs: diskAt,
    diskNonceAnywhere: disk.anywhere,
    diskUserTurnCopies: disk.copies,
    serverSeesMs: serverAt,
    maxAttempts,
    queueRowsNow: rows.map((r) => ({ attempts: r.attempts, text: r.text.slice(0, 40) })),
    rowGoneAtSomePoint: rowGone,
    sessionStatus: (meta as Record<string, unknown> | undefined)?.status,
    phase: (meta as Record<string, unknown> | undefined)?.phase,
  }
  console.log(`[${stamp()}] ${label}: ${JSON.stringify(result)}`)
  return result
}

/**
 * WAIT FOR THE TURN TO END BEFORE DOING ANYTHING ELSE.
 *
 * Send #1 starts a turn, and a claude CLI holds a second prompt in its own
 * composer queue until that turn finishes. Restarting on top of a running turn,
 * or sending #2 into one, would mix "the reattach lost it" with "the agent was
 * busy" — two waits that look identical from outside and only one of which is
 * the subject.
 */
const waitIdle = async (why: string) => {
  const until = now() + 180_000
  while (now() < until) {
    const m = (await sessionMeta(sid)) as Record<string, unknown> | undefined
    if (m?.phase === 'idle') return true
    await wait(2_000)
  }
  console.log(`[${stamp()}] WARNING: still not idle before ${why}`)
  return false
}

const first = await sendAndWatch(1, 'SEND-1 (before any restart)')
if (first.diskUserTurnMs === undefined) {
  console.error(
    '\nPOSITIVE CONTROL FAILED: send #1 never reached the CLI either, so this rig ' +
      'cannot distinguish a reattach bug from a rig that never worked. No verdict printed.',
  )
  console.error(`session ${sid} left running for inspection.`)
  process.exit(2)
}
console.log(`[${stamp()}] positive control OK — send #1 arrived in ${first.diskUserTurnMs}ms`)
await waitIdle('the restart')

if (half !== 'none') {
  console.log(`[${stamp()}] restarting the ${half}…`)
  restart(half)
  await wait(REATTACH_MS)
  await login()
  const meta = await sessionMeta(sid)
  console.log(`[${stamp()}] after restart: ${JSON.stringify(meta)}`)
} else {
  console.log(`[${stamp()}] control arm: no restart`)
}
await waitIdle('send #2')

const second = await sendAndWatch(2, `SEND-2 (after ${half} restart)`)

console.log('\n===== POD-2843 =====')
console.log(`session      ${sid}`)
console.log(`restarted    ${half}`)
console.log(
  `send #1      disk=${first.diskUserTurnMs}ms server=${first.serverSeesMs}ms attempts=${first.maxAttempts}`,
)
console.log(
  `send #2      disk=${second.diskUserTurnMs ?? 'NEVER'} server=${second.serverSeesMs ?? 'NEVER'} attempts=${second.maxAttempts}`,
)
console.log(`send #2 row  ${JSON.stringify(second.queueRowsNow)}`)
console.log(`send #2 copies the CLI actually took: ${second.diskUserTurnCopies}`)
if (second.diskUserTurnMs === undefined && second.serverSeesMs === undefined) {
  console.log('VERDICT      REPRODUCED — the send never reached the CLI')
} else if (second.diskUserTurnMs !== undefined && second.serverSeesMs === undefined) {
  console.log('VERDICT      SPLIT — the CLI took the turn; the SERVER cannot see it')
} else {
  console.log('VERDICT      arrived')
}
console.log(`session ${sid} left running for inspection.`)
