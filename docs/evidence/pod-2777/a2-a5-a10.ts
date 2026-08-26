/**
 * TIER-A ROWS A2b, A5 and A10 — boot status, the transcript, driver identity.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a2-a5-a10.ts codex
 *
 * Pass criteria, from docs/plans/pod-1761-release-ledger.md:
 *   A2b  "a fresh idle session shows idle, not `working` or blank"
 *   A5   "turns render with tool calls paired to results; reload shows same history"
 *   A10  "session reports server family; PODIUM_RUNTIME_DRIVER=generic-pty demotes it"
 *
 * Three rows in one file because they share a session and none of them needs a
 * terminal — which on this rig is the difference between drivable and blocked.
 */
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  nonce,
  now,
  sessionRow,
  settle,
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const log = (s: string) => console.log(s)

const EXPECTED_SERVER: Record<string, string> = {
  codex: 'codex-app-server',
  grok: 'grok-acp',
  opencode: 'opencode-server',
}

await login()
log('='.repeat(78))
log(`A2b / A5 / A10   harness=${harness}`)
log('='.repeat(78))

// ===========================================================================
// A2b — status at boot
// ===========================================================================
// Sampled FROM THE MOMENT OF CREATION, not once at the end. "A fresh idle
// session shows idle" is a claim about the whole window between existing and
// being used, and a single late sample cannot see a session that spent its
// first ten seconds reporting `working` before settling. Every distinct phase
// observed is recorded, so a transient wrong answer is visible rather than
// averaged away.
log('')
log('A2b  status at boot')
log('-'.repeat(78))

const created = await mutate('sessions.create', { cwd: REPO, agentKind })
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  log(`  sessions.create FAILED: ${JSON.stringify(created).slice(0, 600)}`)
  process.exit(5)
}
log(`  session ${sid}`)

const phases: { atMs: number; phase: string; status: string; driver: string }[] = []
const t0 = now()
const bootDeadline = t0 + READY_MS + 30_000
while (now() < bootDeadline) {
  const r = await sessionRow(sid)
  const phase = r?.agentState?.phase ?? '(blank)'
  const status = r?.status ?? '(no row)'
  const driver = r?.driverId ?? '(none)'
  const last = phases.at(-1)
  if (!last || last.phase !== phase || last.status !== status || last.driver !== driver) {
    phases.push({ atMs: now() - t0, phase, status, driver })
  }
  if (driver !== '(none)' && phase === 'idle' && now() - t0 > READY_MS) break
  await wait(500)
}
log('  phase timeline (only changes are printed):')
for (const p of phases) {
  log(`    t+${String(p.atMs).padStart(6)}ms  status=${p.status.padEnd(11)} phase=${p.phase.padEnd(9)} driver=${p.driver}`)
}

const rowBoot = await sessionRow(sid)
if (rowBoot?.status === 'exited') {
  log(`  SESSION EXITED   spawnFailure: ${(rowBoot as Record<string, unknown>).spawnFailure ?? '(none)'}`)
  log('  REFUSED — a session that never booted cannot be shown to report its boot status.')
  process.exit(3)
}

// CONTROL: the session must reach a bound, live state at all. "It said idle"
// from a session that never started is not the row's subject.
const bootControl = Boolean(rowBoot?.driverId) && rowBoot?.status !== 'exited'
log(`  CONTROL          the session bound a driver and is live: ${bootControl}`)

const everWorkedBeforeUse = phases.some((p) => p.phase === 'working')
const everBlank = phases.some((p) => p.phase === '(blank)' && p.driver !== '(none)')
const endsIdle = (rowBoot?.agentState?.phase ?? '') === 'idle'
const a2b = !bootControl
  ? 'REFUSED'
  : endsIdle && !everWorkedBeforeUse && !everBlank
    ? 'PASS'
    : 'FAIL'
log('')
log(`  A2b ${a2b}`)
log(`      settles on idle:                       ${endsIdle}`)
log(`      ever reported 'working' before any use: ${everWorkedBeforeUse}${everWorkedBeforeUse ? '  <- the row forbids this' : ''}`)
log(`      ever blank after a driver was bound:    ${everBlank}${everBlank ? '  <- the row forbids this' : ''}`)

// ===========================================================================
// A10 — driver identity
// ===========================================================================
log('')
log('A10  driver identity')
log('-'.repeat(78))
const wantServer = EXPECTED_SERVER[harness]
const family = rowBoot?.driverFamily ?? '(none)'
const driverId = rowBoot?.driverId ?? '(none)'
log(`  reports          driverId=${driverId}  driverFamily=${family}`)
log(`  expected here    ${wantServer ?? '(this harness has no server driver)'} / family 'server'`)
const identityOk = wantServer ? driverId === wantServer && family === 'server' : family === 'terminal'
log(`  half 1 (reports server family): ${identityOk ? 'PASS' : 'FAIL'}`)
log('')
log('  half 2 (PODIUM_RUNTIME_DRIVER=generic-pty demotes it): PARTIAL — measured,')
log('  but not to the row\'s full wording, and the reason is POD-2853.')
log('  On this rig the terminal arm was driven (drive-up.sh with P2777_DRIVER=')
log('  generic-pty; drive-verify.sh read generic-pty back out of the RUNNING')
log("  daemon's /proc/<pid>/environ, so the arm is the daemon's, not a script's")
log('  intention). Under it the session did NOT bind a server driver — it took')
log('  the abduco path and died there:')
log('      status=exited  exitCode=-1  driverId=(none)')
log('      spawnFailure="…/bin/abduco exited 1: create-session: File name too long"')
log('      label=podium-p2777-2591ded6-bfe5-42d7-965b-80d99fd9916f')
log('  The escape hatch DID demote — abduco is the terminal path and a server')
log('  driver would never have touched it. What cannot be read is the demoted')
log("  session's reported driver identity, because the session does not survive")
log('  long enough to report one. PASS on "demotes", unread on "and reports it".')

// ===========================================================================
// A5 — transcript
// ===========================================================================
log('')
log('A5  transcript — tool calls paired to results, and a reload shows the same history')
log('-'.repeat(78))

let chat = new Chat(sid)
await chat.open('chat')
await settle(sid)

const word = nonce('TRANSCRIPT')
await mutate('sessions.sendText', {
  sessionId: sid,
  text:
    `Use your shell/bash tool to run exactly: echo ${word}. ` +
    `Then reply with the word ${word} on its own line. You must actually run the command with a tool.`,
})

const done = await (async () => {
  const dl = now() + 180_000
  while (now() < dl) {
    if (chat.assistantText().includes(word)) return true
    await wait(2_000)
  }
  return false
})()
log(`  turn completed   ${done}`)

const toolItems = chat.items.filter((i) => i.role === 'tool' || i.toolName)
log(`  CONTROL          ${chat.items.length} transcript item(s), ${toolItems.length} tool item(s), ${chat.deltaFrames} delta frame(s)`)

if (toolItems.length === 0) {
  log('')
  log('  A5 REFUSED — the positive control did not fire.')
  log('  control watched: the turn producing at least one TOOL item, since the row')
  log('                   is about tool calls being paired to their results')
  log(`  control saw:     ${chat.items.length} item(s), none of them a tool call`)
  log('  A transcript with no tool call cannot show tool calls paired to results.')
} else {
  /**
   * PAIRING, AGAINST THE SHAPE THE TRANSCRIPT ACTUALLY USES.
   *
   * CORRECTED AFTER A FALSE FAIL OF MY OWN MAKING. The first version looked for
   * a FOLLOWING item with role `tool_result`, found none, and reported A5 FAIL —
   * "tool calls paired to results: false". The product was fine; the shape is
   * one item carrying BOTH halves (`toolInput` + `toolResult` + `toolUseId`,
   * with `text` empty). I dumped the raw items rather than trusting the verdict,
   * which is the only reason this is not in the report as a product defect.
   *
   * `toolUseId` is also checked, because it is the identity that makes the
   * pairing a pairing rather than an adjacency: a result that arrived on an item
   * with no id to tie it to a call would satisfy "a result is present" while
   * pairing nothing.
   */
  const paired: { name: string; hasResult: boolean; hasId: boolean; result: string }[] = []
  for (const it of chat.items) {
    if (!(it.role === 'tool' || it.toolName)) continue
    paired.push({
      name: it.toolName ?? it.role,
      hasResult: typeof it.toolResult === 'string' && it.toolResult.length > 0,
      hasId: typeof it.toolUseId === 'string' && it.toolUseId.length > 0,
      result: (it.toolResult ?? '').replace(/\n/g, '\\n').slice(0, 60),
    })
  }
  for (const p of paired) {
    log(`    tool ${p.name.padEnd(14)} toolUseId: ${p.hasId}  result: ${p.hasResult}  ${JSON.stringify(p.result)}`)
  }
  const allPaired = paired.every((p) => p.hasResult && p.hasId)

  // RELOAD: drop the socket and open a new one, then compare the history the
  // server serves a fresh client against what this one was streamed live.
  const liveIds = chat.items.map((i) => i.id)
  const liveText = chat.assistantText()
  await chat.close()
  await wait(3_000)
  chat = new Chat(sid)
  await chat.open('chat')
  await wait(15_000)
  const reloadIds = chat.items.map((i) => i.id)
  const reloadText = chat.assistantText()
  const missing = liveIds.filter((id) => !reloadIds.includes(id))
  const sameNonce = reloadText.includes(word)
  log('')
  log(`  reload           live had ${liveIds.length} item(s); a fresh socket was served ${reloadIds.length}`)
  log(`                   ${missing.length} live item(s) missing after reload`)
  log(`                   the turn's nonce is still in the reloaded history: ${sameNonce}`)
  const reloadToolItems = chat.items.filter((i) => i.role === 'tool' || i.toolName)
  log(`                   tool items after reload: ${reloadToolItems.length} (live: ${toolItems.length})`)

  const a5 = allPaired && missing.length === 0 && sameNonce ? 'PASS' : 'FAIL'
  log('')
  log(`  A5 ${a5}`)
  log(`      tool calls paired to results: ${allPaired} (${paired.length} call(s))`)
  log(`      reload shows the same history: ${missing.length === 0 && sameNonce}`)
  log(`      control FIRED — the turn produced ${toolItems.length} tool item(s)`)
}

await chat.close()
await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
log('')
log('='.repeat(78))
log('done')
log('='.repeat(78))
