/**
 * TIER-A ROW A9 — kill session.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a9.ts codex
 *
 * Pass criterion, from docs/plans/pod-1761-release-ledger.md:
 *   "process tree gone (check the process table, not the UI);
 *    no orphan servers after 5 min"
 *
 * ---------------------------------------------------------------------------
 * THE ROW SAYS "NOT THE UI", SO THE UI IS NOT ASKED.
 * ---------------------------------------------------------------------------
 * Every number here comes from /proc. The session row's own opinion is READ and
 * PRINTED — because a disagreement between the row and the process table is
 * itself the finding — but it is never what decides the verdict.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL IS THE PROCESS TREE EXISTING BEFORE THE KILL.
 * ---------------------------------------------------------------------------
 * "No processes after the kill" is trivially true of a session that never
 * started any — and on this rig that is a live possibility, not a hypothetical:
 * POD-2853 makes a terminal-arm session exit at spawn, so its process count is
 * zero before anyone kills anything. A run that cannot name the processes it
 * expects to see die reports REFUSED.
 *
 * Processes are attributed by /proc/<pid>/environ, matching the rig's INSTANCE
 * and the session id — never by pattern-matching a command line. Other
 * instances on this box run identically-named binaries, and a `pkill -f codex`
 * would take the operator's own sessions down while reporting a clean sweep.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { AGENT_KIND, Chat, REPO, login, mutate, nonce, now, sessionRow, until, wait } from './rig'

const harness = (process.argv[2] ?? 'codex') as string
/**
 * WHICH VERB, AND WHY IT IS A PARAMETER.
 *
 * The row is called "kill session", and `sessions.kill` is the operator's kill
 * (`command-plane.ts:599`). The first run of this probe drove `sessions.stop`
 * instead and reported PASS — the process tree WAS gone, so the observation was
 * true, but the row it answered was a different one: stop came back
 * `status=hibernated stopReason=parent`, which is a park, not a kill. A park
 * that tidies its processes says nothing about whether a kill does.
 *
 * Both are worth having, so the verb is a parameter and the report names which
 * one produced each number rather than letting "the tree was gone" stand
 * unattributed.
 */
const verb = (process.argv[3] ?? 'kill') as 'kill' | 'stop'
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
/** The row says five minutes. Overridable for a smoke run, and the value used
 *  is printed, so a shortened wait can never be read as the full one. */
const ORPHAN_WAIT_MS = Number(process.env.P2777_ORPHAN_MS ?? 5 * 60_000)
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p2777'

const log = (s: string) => console.log(s)

interface Proc {
  pid: number
  cmd: string
  rssKb: number
  why: string
}

function environOf(pid: number): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=')
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1)
    }
  } catch {
    // gone, or not ours to read
  }
  return out
}

/**
 * Every process this rig owns, and why it is attributed to it.
 *
 * Two independent attributions, both from the environment rather than the
 * command line: the instance id the product itself exports, and the session id
 * where a child carries one. The daemon and server are excluded by pid — they
 * are the rig, not the session, and killing a session must not touch them.
 */
function rigProcesses(sid?: string, excludePids: number[] = []): Proc[] {
  const found: Proc[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid || excludePids.includes(pid)) continue
    const env = environOf(pid)
    if (Object.keys(env).length === 0) continue
    const reasons: string[] = []
    if (env.PODIUM_INSTANCE === INSTANCE) reasons.push('PODIUM_INSTANCE')
    if (sid && Object.values(env).some((v) => v.includes(sid))) reasons.push('session id in env')
    if (reasons.length === 0) continue
    let cmd = ''
    let rssKb = 0
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      const st = readFileSync(`/proc/${pid}/status`, 'utf8')
      rssKb = Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0)
    } catch {
      // exited between readdir and read
    }
    found.push({ pid, cmd: cmd.slice(0, 90), rssKb, why: reasons.join('+') })
  }
  return found
}

await login()
log('='.repeat(78))
log(`A9  kill session — is the process tree really gone?   harness=${harness}  verb=sessions.${verb}`)
log('='.repeat(78))

const daemonPid = Number(
  readFileSync(`${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'}/daemon.pid`, 'utf8').trim(),
)
const serverPid = Number(
  readFileSync(`${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'}/server.pid`, 'utf8').trim(),
)
const infra = [daemonPid, serverPid]
log(`rig infrastructure (excluded, and checked alive at the end): server ${serverPid}, daemon ${daemonPid}`)

const baseline = rigProcesses(undefined, infra)
log(`baseline           ${baseline.length} rig process(es) before this session exists`)

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`sessions.create FAILED: ${JSON.stringify(created).slice(0, 800)}`)
  process.exit(5)
}
log(`session ${sid} created`)
await wait(READY_MS)

const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
const row0 = bound.row ?? (await sessionRow(sid))
log(`BOUND DRIVER       ${row0?.driverId ?? '(none)'} (family ${row0?.driverFamily ?? '?'})`)
if (row0?.status === 'exited') {
  log(`SESSION EXITED     spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`)
}

// Give it a real turn, so the tree includes whatever a working session spawns
// rather than only what boots.
const chat = new Chat(sid)
await chat.open('chat')
const word = nonce('ALIVE')
await mutate('sessions.sendText', {
  sessionId: sid,
  text: `Reply with exactly this word and nothing else: ${word}. Do not use any tools.`,
})
const replied = await (async () => {
  const dl = now() + 90_000
  while (now() < dl) {
    if (chat.assistantText().includes(word)) return true
    await wait(1_000)
  }
  return false
})()
log(`turn before kill   ${replied ? `replied with ${word}` : 'NO REPLY'}`)

// --- the control: what is there to kill? -----------------------------------
const baselinePids = new Set(baseline.map((p) => p.pid))
const before = rigProcesses(sid, infra)
const newForThisSession = before.filter((p) => !baselinePids.has(p.pid))
log('')
log(`CONTROL            ${newForThisSession.length} process(es) appeared for this session:`)
for (const p of newForThisSession) log(`                     pid=${p.pid} rss=${p.rssKb}kB [${p.why}] ${p.cmd}`)

if (newForThisSession.length === 0) {
  log('')
  log('REFUSED — the positive control did not fire.')
  log('  control watched: at least one process appearing that this session owns,')
  log('                   so that "the tree is gone" is a statement about something')
  log(`  control saw:     0 new process(es); session status ${row0?.status ?? '?'}`)
  log(`                   spawnFailure: ${(row0 as Record<string, unknown> | undefined)?.spawnFailure ?? '(none)'}`)
  log('  A session that started no processes cannot demonstrate a clean kill.')
  await chat.close()
  process.exit(3)
}

// --- kill ------------------------------------------------------------------
log('')
log(`KILLING via sessions.${verb} …`)
const killed = await mutate(`sessions.${verb}`, { sessionId: sid })
log(`  returned         ${JSON.stringify(killed.result?.data ?? killed.error ?? null).slice(0, 240)}`)

// Give the teardown a fair chance before counting.
await wait(15_000)
const rowAfter = await sessionRow(sid)
log(`  row says         status=${rowAfter?.status ?? '(row gone)'} stopReason=${(rowAfter as Record<string, unknown> | undefined)?.stopReason ?? '?'}`)

const survivors = rigProcesses(sid, infra).filter((p) =>
  newForThisSession.some((n) => n.pid === p.pid),
)
log(`  process table    ${survivors.length} of ${newForThisSession.length} still alive after 15s`)
for (const p of survivors) log(`                     pid=${p.pid} rss=${p.rssKb}kB ${p.cmd}`)

// --- the five-minute orphan check ------------------------------------------
log('')
log(`ORPHAN WATCH       waiting ${Math.round(ORPHAN_WAIT_MS / 1000)}s (the row says 300s)`)
const deadline = now() + ORPHAN_WAIT_MS
let lastCount = survivors.length
while (now() < deadline) {
  await wait(30_000)
  const still = rigProcesses(sid, infra).filter((p) =>
    newForThisSession.some((n) => n.pid === p.pid),
  )
  if (still.length !== lastCount) {
    log(`  t+${Math.round((ORPHAN_WAIT_MS - (deadline - now())) / 1000)}s: ${still.length} still alive`)
    lastCount = still.length
  }
  if (still.length === 0 && now() > deadline - ORPHAN_WAIT_MS + 60_000) break
}
const orphans = rigProcesses(sid, infra).filter((p) =>
  newForThisSession.some((n) => n.pid === p.pid),
)
log(`  after the wait   ${orphans.length} orphan(s)`)
for (const p of orphans) log(`                     pid=${p.pid} rss=${p.rssKb}kB ${p.cmd}`)

// The rig's own processes must be untouched: a "clean kill" that took the daemon
// with it is not a pass.
const infraAlive = infra.filter((pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
})
log(`  rig intact       ${infraAlive.length}/2 infrastructure process(es) still alive`)

const pass = orphans.length === 0 && infraAlive.length === 2
log('')
log('='.repeat(78))
log(`A9  ${pass ? 'PASS' : 'FAIL'}`)
log(`    ${newForThisSession.length} process(es) belonged to the session; ${orphans.length} survived ${Math.round(ORPHAN_WAIT_MS / 1000)}s after the kill`)
log(`    measured in /proc, attributed by environment, never by command-line pattern`)
log(`    verb driven: sessions.${verb}`)
log(`    the row's own opinion was status=${rowAfter?.status ?? '(gone)'} — recorded, not used as the verdict`)
log(`    control FIRED — the tree existed before the kill`)
log('='.repeat(78))

await chat.close()
process.exit(pass ? 0 : 1)
