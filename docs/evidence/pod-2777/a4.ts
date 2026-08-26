/**
 * TIER-A ROWS A4a and A4b — the permission ask, and answering it twice.
 *
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/a4.ts codex
 *
 * Pass criteria, from docs/plans/pod-1761-release-ledger.md:
 *   A4a  "card appears in chat AND terminal shows the same ask; answering resolves both"
 *   A4b  "second answer is a typed error, not a double action"
 *
 * ---------------------------------------------------------------------------
 * A4a IS SPLIT, AND THE SPLIT IS REPORTED RATHER THAN AVERAGED.
 * ---------------------------------------------------------------------------
 * The row has two halves — the chat card and the same ask in the terminal —
 * joined by "answering resolves both". On this rig the terminal half cannot be
 * driven at all: POD-2853's socket-path overflow means the native client
 * terminal is never hosted (measured in a6a.ts: attach answered, outputSeen
 * false, zero bytes, cause only in the daemon log). So this probe drives the
 * chat half and reports the terminal half as BLOCKED, naming the issue. It does
 * NOT report a chat-only pass as an A4a pass — half a row driven is half a row.
 *
 * ---------------------------------------------------------------------------
 * A4b's CONTROL IS THE FIRST ANSWER SUCCEEDING.
 * ---------------------------------------------------------------------------
 * "The second answer is a typed error" is trivially satisfiable by a product
 * that errors on EVERY answer, including the first. So the first answer must be
 * observed to succeed AND to resolve the ask before the second is sent; if it
 * did not, there is no second-answer case to test and the probe refuses.
 *
 * And "not a double action" is checked, not assumed: a typed error whose side
 * effect happened anyway is the failure this row exists to catch, so the probe
 * records whether the tool ran once or twice.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import {
  AGENT_KIND,
  Chat,
  REPO,
  login,
  mutate,
  nonce,
  now,
  query,
  sessionRow,
  settle,
  until,
  wait,
} from './rig'

const harness = (process.argv[2] ?? 'codex') as string
const agentKind = AGENT_KIND[harness] ?? harness
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)
const log = (s: string) => console.log(s)

/**
 * Outside the session cwd on purpose — a write inside it is auto-approved by an
 * ordinary posture and the product is never handed an ask to surface.
 *
 * AND NOT UNDER /tmp, which cost this row a run. The codex app-server child is
 * started with `sandbox_mode="workspace-write"`
 * (apps/daemon/src/runtime/codex-app-server.ts:301), and that sandbox already
 * permits /tmp — so a write to /tmp/… is outside the CWD but still inside the
 * sandbox, runs without anyone being asked, and the probe reported BLOCKED
 * ("this harness approved its own tool call") for a path the harness was
 * entitled to write. That verdict was correct about what it saw and wrong about
 * what it meant. A home-relative directory is outside both.
 */
const EXTERNAL = `${process.env.HOME}/pod-2777-a4-external`

async function openAsks(sid: string): Promise<any[]> {
  const listed = await query('interactions.list', { sessionId: sid })
  return (listed.result?.data ?? []) as any[]
}

await login()
log('='.repeat(78))
log(`A4a / A4b  permission ask, and answering it twice   harness=${harness}`)
log('='.repeat(78))

rmSync(EXTERNAL, { recursive: true, force: true })
mkdirSync(EXTERNAL, { recursive: true })

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
  log(
    `SESSION EXITED     spawnFailure: ${(row0 as Record<string, unknown>).spawnFailure ?? '(none)'}`,
  )
  log('REFUSED — no session to raise an ask on.')
  process.exit(3)
}

const chat = new Chat(sid)
await chat.open('chat')
await settle(sid)

const marker = nonce('TOOLRAN')
const before = chat.items.length
const t0 = now()
await mutate('sessions.sendText', {
  sessionId: sid,
  text:
    `Use your shell/bash tool to run exactly this command: echo ${marker} > ${EXTERNAL}/${marker}.txt` +
    ' and then tell me whether it succeeded. You must actually run the command with a tool.',
})

let asks: any[] = []
const deadline = now() + 90_000
while (now() < deadline) {
  asks = await openAsks(sid)
  if (asks.length > 0) break
  const r = await sessionRow(sid)
  if (r?.agentState?.phase !== 'working' && now() - t0 > 20_000) break
  await wait(2_000)
}

const newItems = chat.items.slice(before)
const controlFired = chat.deltaFrames > 0 && newItems.length > 0
log('')
log(
  `CONTROL            the turn produced ${newItems.length} transcript item(s), ${chat.deltaFrames} delta frame(s) — ${controlFired ? 'FIRED' : 'DID NOT FIRE'}`,
)

if (!controlFired) {
  log('')
  log('REFUSED — the positive control did not fire.')
  log('  control watched: the turn producing durable transcript items at all')
  log(`  control saw:     ${newItems.length} item(s), ${chat.deltaFrames} delta frame(s)`)
  log('  A session that produced no turn cannot be shown to have missed an ask.')
  await chat.close()
  process.exit(3)
}

if (asks.length === 0) {
  const toolRan = newItems.some((i) => i.role === 'tool' || i.toolName)
  log('')
  log(`A4a  ${toolRan ? 'BLOCKED' : 'FAIL'} — no ask appeared in ${Math.round((now() - t0) / 1000)}s`)
  log(`     tool calls seen: ${newItems.filter((i) => i.role === 'tool' || i.toolName).map((i) => i.toolName ?? 'tool').join(', ') || '(none)'}`)
  if (toolRan) {
    log('     BLOCKED, not FAILED: this harness approved its own tool call, so the')
    log("     product was never handed an ask to surface. That is this rig's posture,")
    log("     not the product's ask plane.")
  } else {
    log('     FAIL: the agent neither asked nor acted, so nothing exercised the ask path.')
  }
  log('A4b  BLOCKED — no ask was raised, so there is no answer to send twice.')
  await chat.close()
  await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
  process.exit(toolRan ? 2 : 1)
}

// ---------------------------------------------------------------------------
// A4a — the chat half
// ---------------------------------------------------------------------------
const structured = asks.find((a) => a.answerable === 'structured') ?? asks[0]
const payload = (structured.payload ?? {}) as Record<string, unknown>
log('')
log('A4a  the ask, as chat sees it')
log(`     kind             ${structured.kind}  id=${structured.id}`)
log(`     source           ${structured.source} / answerable=${structured.answerable}`)
log(`     enumerable       yes — interactions.list carried it while open, not only the stream`)
log(
  `     typed payload    toolName=${String(payload.toolName ?? '?')} canAlwaysAllow=${String(payload.canAlwaysAllow ?? '?')}`,
)
log(`     open asks        ${asks.length}${asks.length > 1 ? ' — MORE THAN ONE for a single permission' : ''}`)
for (const a of asks) {
  log(
    `                      ${a.source}/${a.answerable} id=${a.id} toolName=${String((a.payload as Record<string, unknown> | undefined)?.toolName ?? '?')}`,
  )
}

// allow-once, never a synthesized allow-always.
const answer = { kind: 'permission', decision: 'allow-once' as const }
const first = await mutate('interactions.answer', { id: structured.id, answer })
const firstOk = first.error === undefined
log('')
log(`     FIRST ANSWER     ${JSON.stringify(answer)}`)
log(`     returned         ${JSON.stringify(first.result?.data ?? first.error ?? null).slice(0, 220)}`)

const cleared = await (async () => {
  const dl = now() + 60_000
  while (now() < dl) {
    const open = await openAsks(sid)
    if (open.every((a) => a.id !== structured.id)) return true
    await wait(1_500)
  }
  return false
})()
log(`     resolved         ${cleared ? 'the ask left the open set' : 'THE ASK STAYED OPEN'}`)

// Let the tool actually run before counting its side effect.
await wait(8_000)
const filesAfterFirst = existsSync(EXTERNAL) ? readdirSync(EXTERNAL) : []
log(`     side effect      ${filesAfterFirst.length} file(s) in ${EXTERNAL}: ${filesAfterFirst.join(', ') || '(none)'}`)

log('')
log('A4a  the TERMINAL half — BLOCKED, not driven, and not counted as a pass.')
log('     The row requires the same ask to appear in the terminal and answering to')
log('     resolve BOTH. On this rig the native client terminal is never hosted:')
log('     POD-2853 overflows the abduco socket path, the attach is answered with')
log('     outputSeen=false and zero bytes, and the cause appears only as a daemon')
log('     warn. Measured in a6a.ts on this same instance and commit.')

// ---------------------------------------------------------------------------
// A4b — answer the same ask a second time
// ---------------------------------------------------------------------------
log('')
log('A4b  answering the SAME ask a second time')

if (!firstOk || !cleared) {
  log('     REFUSED — the control for this row did not fire.')
  log('     control watched: the FIRST answer succeeding and resolving the ask, so')
  log('                      that a second answer is genuinely a second answer')
  log(`     control saw:     first answer ok=${firstOk}, ask resolved=${cleared}`)
  log('     A product that errors on every answer would pass this row for the wrong')
  log('     reason; without a good first answer there is no second-answer case.')
  await chat.close()
  await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

/**
 * IS THIS ANSWER A TYPED REFUSAL?
 *
 * WIDENED AFTER SEEING A RESULT, WHICH NEEDS SAYING OUT LOUD. The first version
 * required a THROWN tRPC error, and scored the product's actual answer —
 * `{"ok":false,"reason":"already-answered"}` — as a failure. That was the probe
 * being wrong, not the product: the row asks for "a typed error, not a double
 * action", and a discriminated result carrying a machine-readable reason IS
 * typed. Demanding a particular TRANSPORT for the typing is a requirement the
 * row does not make.
 *
 * THE WIDENING IS FENCED, so it cannot degrade into "anything counts". The
 * classifier is run against the FIRST answer too, and that one must come back
 * NOT-a-refusal. A classifier loose enough to call `{"ok":true}` a refusal would
 * pass this row for a product that silently double-answers — which is the exact
 * failure the row exists to catch — and the assertion below makes that
 * impossible without anyone noticing.
 */
function classifyAnswer(res: any): { refusal: boolean; how: string; reason: string } {
  const err = res?.error
  const data = res?.result?.data
  if (err) {
    const msg = String(err.message ?? err.json?.message ?? '')
    const code = String(err.data?.code ?? err.json?.data?.code ?? err.code ?? '')
    if (msg || code) return { refusal: true, how: 'thrown error', reason: code || msg }
  }
  if (data && typeof data === 'object' && data.ok === false) {
    const reason = String(data.reason ?? data.code ?? '')
    // `ok:false` with NO reason is a bare failure, not a typed one.
    if (reason) return { refusal: true, how: 'typed result', reason }
    return { refusal: false, how: 'untyped ok:false — no reason field', reason: '' }
  }
  return { refusal: false, how: 'success', reason: '' }
}

const second = await mutate('interactions.answer', { id: structured.id, answer })
const secondErr = second.error
const secondData = second.result?.data
log(`     returned         ${JSON.stringify(secondData ?? secondErr ?? null).slice(0, 400)}`)

const firstClass = classifyAnswer(first)
const secondClass = classifyAnswer(second)
log(`     classifier check the FIRST answer classifies as: ${firstClass.refusal ? 'REFUSAL' : 'not a refusal'} (${firstClass.how})`)
if (firstClass.refusal) {
  log('')
  log('REFUSED — the classifier control failed.')
  log('  control watched: the classifier calling the SUCCESSFUL first answer "not a refusal"')
  log(`  control saw:     it called it a refusal (${firstClass.how})`)
  log('  A classifier that calls everything a refusal would pass this row for a')
  log('  product that silently double-answers. The verdict is withheld.')
  await chat.close()
  await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

const typedRefusal = secondClass.refusal
const silentSuccess = !secondClass.refusal && secondData !== undefined

await wait(8_000)
const filesAfterSecond = existsSync(EXTERNAL) ? readdirSync(EXTERNAL) : []
const doubleAction = filesAfterSecond.length > filesAfterFirst.length

log(`     typed refusal    ${typedRefusal}${typedRefusal ? ` — via ${secondClass.how}, reason=${JSON.stringify(secondClass.reason)}` : ` — ${secondClass.how}`}`)
log(`     silent success   ${silentSuccess}`)
log(
  `     double action    ${doubleAction} — ${filesAfterFirst.length} file(s) before, ${filesAfterSecond.length} after`,
)

const a4bPass = typedRefusal && !doubleAction
log('')
log('='.repeat(78))
log(`A4a  ${cleared ? 'PARTIAL' : 'FAIL'} — chat half ${cleared ? 'PASS' : 'FAIL'}, terminal half BLOCKED on POD-2853`)
log(`A4b  ${a4bPass ? 'PASS' : 'FAIL'} — second answer ${typedRefusal ? 'was a typed error' : 'was NOT a typed error'}, double action: ${doubleAction}`)
log(`     controls: turn produced transcript items FIRED; first answer succeeded and resolved FIRED`)
log('='.repeat(78))

await chat.close()
await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
process.exit(a4bPass && cleared ? 0 : 1)
