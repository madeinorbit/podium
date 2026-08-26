/**
 * ONE FAULT SESSION, WATCHED — the diagnostic behind POD-2811's two readings.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2811/fault-watch.ts
 *
 * WHY THIS EXISTS BESIDE POD-2777's PROBE RATHER THAN INSTEAD OF IT. That probe
 * scores a cell; this answers "what does the operator SEE, second by second".
 * They disagreed on the terminal arm and the disagreement was the finding: the
 * probe read an assistant answer on the fault session and scored BLOCKED — but
 * the words it read were the PREVIOUS probe's nonce, from a different session
 * that was still alive in the same directory. A cell cannot say that. This can.
 *
 * NOTHING ELSE RUNS. The rig's provider-error probe leaves probe 1's session
 * alive in the same cwd while it drives the fault, and opencode's own store is
 * keyed by directory. So this drives the fault ALONE, and prints every opencode
 * session in that directory afterwards, with message counts — the reading and
 * the thing that could have contaminated it, side by side.
 *
 * THE CONTROL IS UNCHANGED IN PURPOSE. POD-2777's rule is that an error arm
 * proves nothing unless this harness could answer a normal question on this arm.
 * That control is probe 1 of the rig's own run on the SAME arm and the SAME
 * commit, minutes before; this script prints which run it is relying on rather
 * than re-deriving it, because a control quietly re-taken is a control nobody
 * can check.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { AGENT_KIND, BASE, Chat, DRIVE_BASE, REPO, login, mutate, now, sessionRow, wait } from '../pod-2777/rig'

const ARM = process.env.P2811_ARM ?? 'unknown'
const MODEL = process.env.P2811_MODEL ?? 'opencode/laguna-s-2.1-free'
const HARNESS = process.env.P2811_HARNESS ?? 'opencode'
const WATCH_MS = Number(process.env.P2811_WATCH_MS ?? 190_000)
const TICK_MS = Number(process.env.P2811_TICK_MS ?? 2_000)
const OUT = `${DRIVE_BASE}/pod-2811`

const log = (s: string) => console.log(s)

/** The rig's own reply verdict on this arm, read from ITS results file rather
 *  than re-measured. A control taken by a different process at a different
 *  minute is a different control, and saying which one is relied on is the
 *  whole difference between a control and a claim. */
function controlFromRig(): { fired: boolean; detail: string } {
  const path = `${DRIVE_BASE}/results/${HARNESS}.${ARM}.json`
  if (!existsSync(path)) return { fired: false, detail: `no rig results at ${path}` }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      pin?: { short?: string }
      results?: { id: string; verdict: string; summary: string }[]
    }
    const reply = (doc.results ?? []).find((p) => p.id === 'reply')
    if (!reply) return { fired: false, detail: `no reply probe in ${path}` }
    return {
      fired: reply.verdict === 'PASS',
      detail: `POD-2777 rig, ${HARNESS}/${ARM}, pin ${doc.pin?.short ?? '?'}: reply=${reply.verdict} — ${reply.summary}`,
    }
  } catch (e) {
    return { fired: false, detail: `unreadable rig results: ${String(e)}` }
  }
}

/** Every opencode session in the drive repo, newest first. The fault session's
 *  own row AND anything that could have been mistaken for it. */
function opencodeSessions(): string[] {
  const db = `${process.env.PODIUM_STATE_DIR}/agent-home/.local/share/opencode/opencode.db`
  if (!existsSync(db)) return [`(no opencode db at ${db})`]
  const sql = `SELECT s.id || '  ' || COALESCE(json_extract(s.model,'$.id'),'(no model)')
       || '  created=' || datetime(s.time_created/1000,'unixepoch','localtime')
       || '  updated=' || datetime(s.time_updated/1000,'unixepoch','localtime')
       || '  messages=' || (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id)
       || '  assistant=' || (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data,'$.role')='assistant')
     FROM session s WHERE s.directory = '${REPO}' ORDER BY s.time_updated DESC LIMIT 8;`
  // stderr IS part of the reading. A query that failed and a directory with no
  // sessions produce the same empty stdout, and printing "(no sessions)" for the
  // first is the rig lying about what it could not read.
  const p = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' })
  const out = (p.stdout ?? '').trim()
  const err = (p.stderr ?? '').trim()
  if (err) return [`(sqlite3 failed: ${err.split('\n')[0]})`]
  if (p.status !== 0) return [`(sqlite3 exited ${p.status})`]
  return out ? out.split('\n') : ['(no sessions in this directory)']
}

const main = async (): Promise<void> => {
  await login()
  const control = controlFromRig()

  log('='.repeat(78))
  log(`FAULT WATCH        harness=${HARNESS} arm=${ARM} model="${MODEL}"`)
  log(`CONTROL            ${control.fired ? 'FIRED' : 'DID NOT FIRE'} — ${control.detail}`)
  log('='.repeat(78))

  const created = await mutate('sessions.create', {
    cwd: REPO,
    agentKind: AGENT_KIND[HARNESS] ?? HARNESS,
    model: MODEL,
    initialPrompt: 'Say hello.',
  })
  const sid = created.result?.data?.sessionId as string | undefined
  if (!sid) {
    log(`CREATE REFUSED     ${JSON.stringify(created.error ?? created).slice(0, 400)}`)
    log('An impossible model refused at create is an honest surface — nothing to watch.')
    return
  }
  log(`SESSION            ${sid}`)

  const chat = new Chat(sid)
  await chat.open()

  const t0 = now()
  const series: {
    ms: number
    phase: string
    status: string
    errClass: string
    driver: string
    resume: string
    items: number
    assistantChars: number
    screenBytes: number
  }[] = []
  let firstSignalMs: number | null = null
  let firstSignalWhat = ''

  while (now() - t0 < WATCH_MS) {
    const row = await sessionRow(sid)
    const phase = row?.agentState?.phase ?? '?'
    const errClass = row?.agentState?.error?.class ?? ''
    const status = row?.status ?? '?'
    series.push({
      ms: now() - t0,
      phase,
      status,
      errClass,
      driver: row?.driverId ?? '?',
      resume: row?.resume?.value ?? '',
      items: chat.items.length,
      assistantChars: chat.assistantText().length,
      screenBytes: chat.screenBytes,
    })
    if (firstSignalMs === null && (errClass || phase === 'errored' || status === 'exited')) {
      firstSignalMs = now() - t0
      firstSignalWhat = errClass ? `error class ${errClass}` : phase === 'errored' ? 'phase=errored' : 'status=exited'
    }
    await wait(TICK_MS)
  }

  const row = await sessionRow(sid)
  const assistant = chat.assistantText().trim()
  const user = chat.userText().trim()
  const screen = chat.screenTail(1200)
  const frames = chat.frameSummary()
  await chat.close()
  await mutate('sessions.kill', { sessionId: sid }).catch(() => {})

  log('')
  log(`BOUND DRIVER       ${row?.driverId ?? '?'} (family ${row?.driverFamily ?? '?'})`)
  log(`RESUME VALUE       ${row?.resume?.value ?? '(none)'}   ${row?.resume?.kind ?? ''}`)
  log(`FINAL              phase=${row?.agentState?.phase ?? '?'} status=${row?.status ?? '?'} errorClass=${row?.agentState?.error?.class ?? '(none)'} detail=${row?.agentState?.error?.detail ?? '(none)'}`)
  log(`FIRST SIGNAL       ${firstSignalMs === null ? `NEVER in ${Math.round(WATCH_MS / 1000)}s` : `${firstSignalMs}ms — ${firstSignalWhat}`}`)
  log(`FRAMES             ${frames}`)
  log('')
  log('SERIES (only the ticks where something changed)')
  let prev = ''
  for (const s of series) {
    const key = `${s.phase}|${s.status}|${s.errClass}|${s.items}|${s.assistantChars}|${s.resume}`
    if (key === prev) continue
    prev = key
    log(
      `  +${String(Math.round(s.ms / 1000)).padStart(3)}s  phase=${s.phase.padEnd(9)} status=${s.status.padEnd(10)} err=${(s.errClass || '-').padEnd(14)} items=${String(s.items).padStart(3)} assistantChars=${String(s.assistantChars).padStart(5)} screenBytes=${String(s.screenBytes).padStart(6)}  opencodeSession=${s.resume || '-'}`,
    )
  }
  log('')
  log(`USER TEXT ON THE DURABLE PLANE      ${JSON.stringify(user.slice(0, 200))}`)
  log(`ASSISTANT TEXT ON THE DURABLE PLANE ${JSON.stringify(assistant.slice(0, 300))}`)
  log('')
  log('OPENCODE SESSIONS IN THIS DIRECTORY (newest first) — the reading and what could contaminate it')
  for (const line of opencodeSessions()) log(`  ${line}`)
  log('')
  log('TERMINAL SCREEN TAIL (empty on a headless arm — there is no screen)')
  log(screen ? screen.split('\n').map((l) => `  | ${l}`).join('\n') : '  (no PTY bytes)')

  mkdirSync(OUT, { recursive: true })
  const doc = {
    arm: ARM,
    harness: HARNESS,
    model: MODEL,
    sessionId: sid,
    control,
    driverId: row?.driverId ?? null,
    driverFamily: row?.driverFamily ?? null,
    resumeValue: row?.resume?.value ?? null,
    finalPhase: row?.agentState?.phase ?? null,
    finalStatus: row?.status ?? null,
    finalErrorClass: row?.agentState?.error?.class ?? null,
    finalErrorDetail: row?.agentState?.error?.detail ?? null,
    firstSignalMs,
    firstSignalWhat,
    watchMs: WATCH_MS,
    assistantText: assistant,
    userText: user,
    frames,
    series,
    opencodeSessions: opencodeSessions(),
    screenTail: screen,
  }
  writeFileSync(`${OUT}/${HARNESS}.${ARM}.json`, `${JSON.stringify(doc, null, 2)}\n`)
  log('')
  log(`written ${OUT}/${HARNESS}.${ARM}.json`)
}

await main()
