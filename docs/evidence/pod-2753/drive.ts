/**
 * The POD-2753 test drive: kill the Claude SDK host on a live instance and watch
 * what survives.
 *
 *   bun docs/evidence/pod-2753/drive.ts
 *
 * Run against the `p2753` instance from drive-up.sh. It re-runs drive-verify.sh's
 * central check itself and refuses to measure anything if the control fails.
 *
 * WHAT IT ASSERTS, in the order it earns the right to assert them:
 *
 *   CONTROL   A Claude turn completes normally through the child host. NOTHING
 *             below is reported unless this passes. A dying rig has produced
 *             false negatives on this epic four times, and each would have been
 *             caught by insisting the path was alive BEFORE believing a
 *             measurement taken on it.
 *
 *   TOPOLOGY  While a turn runs, an OS process whose argv names
 *             claude-sdk-host.ts exists AND its parent is the daemon. This is
 *             the claim of the whole change, read off the process table rather
 *             than off the source tree.
 *
 *   KILL      That child is SIGKILLed mid-turn — the shape an OOM kill takes.
 *             Then: the daemon is alive, the instance still serves, the killed
 *             turn tells its human something true instead of hanging, and the
 *             daemon can still run Claude.
 *
 * ON THE ONE CLAIM THIS SCRIPT DOES NOT MAKE. "A concurrent sibling session is
 * unaffected" needs two live turns at once, and this instance cannot cheaply
 * provide them: only the `global` superagent thread exists without a real
 * session behind it, and one live turn per thread is enforced. That claim is
 * proven in claude-sdk-client.test.ts, which runs two real child processes,
 * kills one mid-turn and requires the other to finish. What the rig adds is
 * everything a unit test cannot fake: a real daemon, the real SDK, a real
 * process tree and a real kill.
 *
 * OBSERVABLES, and why these and not the obvious ones. A SUCCESSFUL turn writes
 * its reply to the harness transcript, not to a row — `superagent.history` stays
 * empty and is NOT a success signal (an earlier version of this script read that
 * emptiness as failure). A FAILED turn is different: the server classifies it and
 * appends a visible assistant message to the thread. So success is read from the
 * thread's own watermark advancing, and failure from the message that appears.
 */

import { readdirSync, readFileSync } from 'node:fs'

const ORIGIN = `http://${process.env.PODIUM_HOST ?? '127.0.0.1'}:${process.env.PODIUM_PORT ?? '19817'}`
const PASSWORD = 'p2753'
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2753'
const TURN_FAILED_MARKER = 'the headless harness turn failed'

let cookie = ''

async function trpc(path: string, input: unknown, kind: 'query' | 'mutation'): Promise<unknown> {
  // A no-input query must send NO `input` param. Serializing `undefined` yields
  // the literal string "undefined", which the server then fails to parse as JSON.
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`
  const url = kind === 'query' ? `${ORIGIN}/trpc/${path}${query}` : `${ORIGIN}/trpc/${path}`
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', cookie },
    ...(kind === 'mutation' ? { body: JSON.stringify(input) } : {}),
  })
  const body = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
  if (body.error) throw new Error(`${path}: ${body.error.message ?? 'trpc error'}`)
  return body.result?.data
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const daemonPid = (): number => Number(readFileSync(`${BASE}/daemon.pid`, 'utf8').trim())

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The daemon's SDK host children, by cmdline AND parentage.
 *
 * BOTH conditions, because the first alone is wrong: an earlier version shelled
 * out to `pgrep -f claude-sdk-host`, which matched the driving shell's own
 * command line (it contains the string) and reported a live host for the entire
 * run, including when none existed. Requiring the process to be a child of THIS
 * daemon makes the match mean what the assertion says it means.
 */
function hostPids(daemon: number): number[] {
  const out: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    let cmdline: string
    let stat: string
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
      continue // exited between readdir and read
    }
    if (!cmdline.includes('claude-sdk-host.ts')) continue
    // /proc/<pid>/stat field 4 is ppid; the comm field can contain spaces and
    // parentheses, so parse after the final ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (ppid === daemon) out.push(pid)
  }
  return out
}

interface Thread {
  id: string
  turnRunning?: boolean
  watermarkItemId?: string | null
  updatedAt?: string
  harnessSessionId?: string | null
}

async function globalThread(): Promise<Thread> {
  const threads = (await trpc('superagent.listThreads', undefined, 'query')) as Thread[]
  const t =
    threads.find((x: Thread & { kind?: string }) => x.kind === 'global' || x.id === 'global') ??
    threads[0]
  if (!t) throw new Error('no global superagent thread')
  return t
}

/**
 * What the assistant actually said, read from the harness's own transcript.
 *
 * THIS IS THE SUCCESS SIGNAL, and finding that out cost two wrong guesses worth
 * recording. `superagent.history` stays EMPTY on success — it holds server-side
 * notices, and a successful reply is written by the harness to its own JSONL,
 * never to a row. `thread.watermarkItemId` does not advance per turn either; it
 * marks how far btw-seeding has consumed the transcript. Both looked like
 * completion signals and neither is one. The transcript is where the human's
 * answer actually lands, so that is what "the turn worked" has to mean.
 */
function assistantText(harnessSessionId: string): string {
  const root = `${process.env.PODIUM_STATE_DIR ?? `${BASE}/state`}/agent-home/.claude/projects`
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (e === `${harnessSessionId}.jsonl`) files.push(`${dir}/${e}`)
      else if (!e.includes('.')) walk(`${dir}/${e}`)
    }
  }
  walk(root)
  let out = ''
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row: { type?: string; message?: { content?: unknown } }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row.type !== 'assistant') continue
      const content = row.message?.content
      if (typeof content === 'string') out += `${content}\n`
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && 'text' in block) {
            out += `${String((block as { text?: unknown }).text ?? '')}\n`
          }
        }
      }
    }
  }
  return out
}

async function history(): Promise<{ role?: string; content?: string }[]> {
  return (await trpc('superagent.history', { threadId: 'global' }, 'query')) as {
    role?: string
    content?: string
  }[]
}

/** Wait for a turn to start and then finish, reporting progress. */
async function awaitTurn(daemon: number, timeoutMs: number): Promise<Thread> {
  const deadline = Date.now() + timeoutMs
  let started = false
  let lastLog = 0
  while (Date.now() < deadline) {
    const t = await globalThread()
    const hosts = hostPids(daemon)
    if (t.turnRunning || hosts.length > 0) started = true
    if (Date.now() - lastLog > 15_000) {
      console.log(
        `      … running=${t.turnRunning} hosts=${hosts.length} watermark=${t.watermarkItemId}`,
      )
      lastLog = Date.now()
    }
    if (started && !t.turnRunning && hosts.length === 0) {
      await sleep(1500)
      return globalThread()
    }
    await sleep(500)
  }
  console.log(`      awaitTurn timed out after ${timeoutMs}ms`)
  return globalThread()
}

const results: string[] = []
const record = (ok: boolean, label: string, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const failures = async (): Promise<string[]> =>
  (await history())
    .filter((m) => (m.content ?? '').includes(TURN_FAILED_MARKER))
    .map((m) => m.content ?? '')

async function send(text: string): Promise<void> {
  await trpc(
    'superagent.sendTurn',
    { threadId: 'global', text, agentKind: 'claude-code' },
    'mutation',
  )
}

async function main(): Promise<void> {
  const login = await fetch(`${ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!cookie) throw new Error('no session cookie from /auth/login — is the instance configured?')

  const dpid = daemonPid()
  if (!alive(dpid)) throw new Error(`daemon pid ${dpid} is not running`)
  console.log(`daemon pid ${dpid}`)

  // ---- CONTROL --------------------------------------------------------------
  console.log('\n[control] one ordinary Claude turn, end to end …')
  const before = await globalThread()
  const failuresBefore = (await failures()).length
  await send('Reply with exactly the word: ALIVE')
  const after = await awaitTurn(dpid, 300_000)
  const said = after.harnessSessionId ? assistantText(after.harnessSessionId) : ''
  const noNewFailure = (await failures()).length === failuresBefore
  const controlOk = /ALIVE/.test(said) && noNewFailure
  void before
  record(
    controlOk,
    'CONTROL a Claude turn completes through the child host',
    controlOk
      ? `the assistant replied "${said.trim().split('\n').pop()}"`
      : 'no reply in the transcript',
  )
  if (!controlOk) {
    console.log('\ncontrol turn did not complete; refusing to report anything else.')
    console.log(JSON.stringify(await history()).slice(0, 2000))
    return
  }

  // ---- TOPOLOGY + KILL ------------------------------------------------------
  console.log('\n[kill] starting a long turn, then killing its host …')
  const beforeKill = await globalThread()
  const failuresBeforeKill = (await failures()).length
  await send('Count slowly from 1 to 60, one number per line, thinking briefly between each one.')

  let victim = 0
  for (let i = 0; i < 600 && victim === 0; i++) {
    const pids = hostPids(dpid)
    if (pids.length > 0) victim = pids[0] as number
    else await sleep(200)
  }
  record(
    victim > 0,
    'TOPOLOGY the SDK runs in an OS child of the daemon',
    victim > 0 ? `host pid ${victim}, parent ${dpid}` : 'no host process ever appeared',
  )
  if (victim === 0) {
    for (const r of results) console.log(r)
    return
  }
  const argv = readFileSync(`/proc/${victim}/cmdline`, 'utf8').split('\0').join(' ').trim()
  console.log(`      host argv: ${argv}`)

  await sleep(5000) // let the turn get properly underway
  console.log(`[kill] SIGKILL ${victim}`)
  process.kill(victim, 'SIGKILL')
  const killedAt = Date.now()

  await sleep(2000)
  record(alive(dpid), 'the daemon survived the kill', `pid ${dpid}`)
  record(
    await fetch(`${ORIGIN}/health`).then(
      (r) => r.ok,
      () => false,
    ),
    'the instance still serves after the kill',
  )

  // NOT awaitTurn here. That helper waits to SEE a turn start before it will
  // believe one ended, and by this point the turn has already ended — the server
  // learns of the failure within a second of the kill. Using it here spun for the
  // full timeout and then reported a settle time of 180s for something that took
  // one, which would have been a true PASS attached to a false number.
  let settled = await globalThread()
  let newFailure: string[] = []
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    settled = await globalThread()
    newFailure = (await failures()).slice(failuresBeforeKill)
    if (!settled.turnRunning && newFailure.length > 0) break
    await sleep(500)
  }
  record(
    !settled.turnRunning,
    'the killed turn ended rather than hanging',
    `${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill`,
  )
  record(newFailure.length > 0, 'the killed turn told its human what happened')
  if (newFailure.length > 0) {
    console.log('\n---- what the human is shown ----')
    for (const f of newFailure) console.log(`  ${f}`)
  }
  void beforeKill

  // ---- RECOVERY -------------------------------------------------------------
  console.log('\n[recovery] a fresh Claude turn after the kill …')
  const failuresBeforeRecovery = (await failures()).length
  await send('Reply with exactly the word: RECOVERED')
  const recovered = await awaitTurn(dpid, 300_000)
  const recoveredText = recovered.harnessSessionId ? assistantText(recovered.harnessSessionId) : ''
  record(
    /RECOVERED/.test(recoveredText) && (await failures()).length === failuresBeforeRecovery,
    'the daemon ran Claude again normally after losing a host',
  )

  console.log('\n================ RESULT ================')
  for (const r of results) console.log(r)
}

await main()
