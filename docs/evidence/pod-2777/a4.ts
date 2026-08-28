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
 * A4a's ORDER IS PART OF ITS CONTROL.
 * ---------------------------------------------------------------------------
 * First send the chat turn and enumerate its structured ask. Only then attach
 * the native view and prove that exact ask is visible there before answering.
 * A native attach takes a driver lease; attaching first can park the chat turn
 * and turn the probe's own ordering into a zero-item result.
 *
 * ---------------------------------------------------------------------------
 * A4b's CONTROL IS THE FIRST ANSWER SUCCEEDING.
 * ---------------------------------------------------------------------------
 * "The second answer is a typed error" is trivially satisfiable by a product
 * that errors on EVERY answer, including the first. So the first answer must be
 * observed to succeed, resolve the ask, AND run the command exactly once before
 * the second is sent; if it did not, there is no second-answer case to test and
 * the probe refuses.
 *
 * And "not a double action" is checked, not assumed: a typed error whose side
 * effect happened anyway is the failure this row exists to catch, so the probe
 * records whether the tool ran once or twice.
 *
 * ---------------------------------------------------------------------------
 * CODEX AND GROK SESSION CWD IS A NEVER-APPROVED DUMMY GIT REPO.
 * ---------------------------------------------------------------------------
 * A write outside the session cwd is necessary but not sufficient on Codex.
 * This harness also auto-reviews tools when the session cwd is already in
 * `~/.codex/config.toml` as a trusted project — `/tmp/pod-2777/repo` is one —
 * so the product is never handed an ask. This probe therefore creates a unique
 * dummy Git repository under $HOME, outside every previously approved root
 * and outside /tmp, and uses THAT as `sessions.create` cwd. Grok has an
 * equivalent trusted-folder store, so it uses the same dummy-repo control.
 * Other harnesses keep the shared scratch repo: they do not have this trust
 * list.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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

function inside(path: string, root: string): boolean {
  const resolved = resolve(path)
  const base = resolve(root)
  return resolved === base || resolved.startsWith(base + sep)
}

function readTrustedProjectRoots(): string[] {
  const files = [
    `${process.env.HOME}/.codex/config.toml`,
    `${process.env.HOME}/.grok/trusted_folders.toml`,
    process.env.P2777_STATE_ROOT
      ? `${process.env.P2777_STATE_ROOT}/agent-home/.codex/config.toml`
      : '',
    process.env.P2777_STATE_ROOT
      ? `${process.env.P2777_STATE_ROOT}/agent-home/.grok/trusted_folders.toml`
      : '',
  ].filter(Boolean)
  const roots = new Set<string>()
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const re of [/\[projects\."([^"]+)"\]/g, /\[folders\."([^"]+)"\]/g]) {
      let match: RegExpExecArray | null
      while ((match = re.exec(text))) roots.add(match[1])
    }
  }
  return [...roots]
}

function isolatedCodexReviewer(): string {
  const file = process.env.P2777_STATE_ROOT
    ? `${process.env.P2777_STATE_ROOT}/agent-home/.codex/config.toml`
    : ''
  if (!file || !existsSync(file)) return '(no isolated config)'
  const text = readFileSync(file, 'utf8')
  const match = text.match(/^\s*approvals_reviewer\s*=\s*"([^"]+)"/m)
  return match?.[1] ?? '(unset)'
}

/**
 * Fresh unique Git cwd that Codex or Grok has never trusted. Refuses rather than
 * measuring if the path lands under a previously approved root, /tmp, or the
 * product checkout — those are the conditions that previously produced a
 * BLOCKED "this harness approved its own tool call" for the wrong reason.
 */
function makeNeverApprovedDummyRepo(): string {
  const trusted = readTrustedProjectRoots()
  const forbidden = [
    ...trusted,
    '/tmp',
    '/var/tmp',
    `${process.env.HOME}/src/podium`,
    `${process.env.HOME}/.codex`,
    '/home/mgw/src/podium',
  ]
  const stamp = `${Date.now()}-${nonce('CWD').toLowerCase()}`
  const tree = `${process.env.HOME}/pod-3027-a4-never-approved-${stamp}`
  const cwd = join(tree, 'repo')
  const hit = forbidden.find((root) => inside(cwd, root))
  if (hit) {
    log(`REFUSED — dummy cwd ${cwd} is under previously approved/forbidden root ${hit}`)
    log(`  trusted projects: ${trusted.join(', ') || '(none listed)'}`)
    process.exit(3)
  }
  mkdirSync(cwd, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
  writeFileSync(
    join(cwd, 'README.md'),
    'Harmless dummy Git repository for the Codex/Grok A4 first-approval measurement. No product code.\n',
  )
  execFileSync('git', ['add', 'README.md'], { cwd })
  execFileSync(
    'git',
    ['-c', 'user.email=pod-3027@localhost', '-c', 'user.name=pod-3027', 'commit', '-qm', 'dummy repo'],
    { cwd },
  )
  log(`SESSION CWD        never-approved dummy git repo ${cwd}`)
  log(`                   avoided trusted projects: ${trusted.join(', ') || '(none listed)'}`)
  if (harness === 'codex') log(`                   isolated approvals_reviewer=${isolatedCodexReviewer()}`)
  if (harness === 'grok') log(`                   isolated permission_mode=${isolatedGrokPermissionMode()}`)
  return cwd
}

async function openAsks(sid: string): Promise<any[]> {
  const listed = await query('interactions.list', { sessionId: sid })
  return (listed.result?.data ?? []) as any[]
}

const ESC2 = String.fromCharCode(27)
const stripTerm = (x: string) =>
  x
    .replace(new RegExp(`${ESC2}\\][^\u0007]*(?:\u0007|${ESC2}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC2}\\[[0-9;?]*[a-zA-Z]`, 'g'), '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e\n]/g, '')

/**
 * THE ASKING POSTURE BELONGS TO THIS ROW, NOT TO THE RIG.
 *
 * A4 needs a permission ask to exist before the product can be judged on
 * surfacing it, and opencode only raises one under `permission.bash = ask`.
 * That posture used to be seeded rig-wide by drive-up.sh, and it silently broke
 * every OTHER opencode cell that touches a tool: the call blocks at
 * phase=needs_user awaiting an approval nobody answers, no toolResult is ever
 * attached, and no assistant text arrives. Row A5 scored a FAIL on opencode
 * because of it — a red that was entirely this rig's doing.
 *
 * So it is set here, for the duration of this probe, and restored in a finally
 * block whatever happens.
 */
const OC_CFG = `${process.env.P2777_STATE_ROOT}/agent-home/.config/opencode/opencode.jsonc`
let cfgBefore: string | undefined
function setAskingPosture(): void {
  if (harness !== 'opencode') return
  cfgBefore = existsSync(OC_CFG) ? readFileSync(OC_CFG, 'utf8') : undefined
  writeFileSync(
    OC_CFG,
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": {\n    "bash": "ask"\n  }\n}\n',
    { mode: 0o600 },
  )
}
function restorePosture(): void {
  if (harness !== 'opencode' || cfgBefore === undefined) return
  writeFileSync(OC_CFG, cfgBefore, { mode: 0o600 })
}

/**
 * Grok's ACP equivalent of Codex's `approvals_reviewer=auto_review` is the
 * native `[ui] permission_mode = "always-approve"` setting. The daemon already
 * sends ACP `session/set_mode=default`, but Grok's persistent always-approve
 * posture can still prevent the permission request from being raised. Change
 * only the named instance's isolated GROK_HOME config for this probe, then
 * restore the exact previous bytes (or absence) on process exit.
 */
const GROK_CFG = process.env.P2777_STATE_ROOT
  ? `${process.env.P2777_STATE_ROOT}/agent-home/.grok/config.toml`
  : undefined
let grokCfgBefore: string | undefined
let grokCfgChanged = false

function isolatedGrokPermissionMode(text?: string): string {
  const source = text ?? (GROK_CFG && existsSync(GROK_CFG) ? readFileSync(GROK_CFG, 'utf8') : '')
  const match = /^\s*permission_mode\s*=\s*["']([^"']+)["']/m.exec(source)
  return match?.[1] ?? (source ? '(unset)' : '(missing config)')
}

function configWithGrokAskMode(source: string): string {
  const mode = /^([ \t]*permission_mode[ \t]*=[ \t]*)(["'][^"']*["'])(.*)$/m.exec(source)
  if (mode) return source.replace(mode[0], `${mode[1]}"ask"${mode[3]}`)
  const uiHeader = /^[ \t]*\[ui\][ \t]*(?:#.*)?\r?\n/m.exec(source)
  if (uiHeader) return source.replace(uiHeader[0], `${uiHeader[0]}permission_mode = "ask"\n`)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const suffix = source.length > 0 && !source.endsWith(eol) ? eol : ''
  return `${source}${suffix}[ui]${eol}permission_mode = "ask"${eol}`
}

function setGrokAskingPosture(): void {
  if (harness !== 'grok') return
  if (!GROK_CFG || !process.env.P2777_STATE_ROOT) {
    log('GROK POSTURE      REFUSED — no isolated P2777_STATE_ROOT')
    process.exit(3)
  }
  const operatorCfg = `${process.env.HOME}/.grok/config.toml`
  if (resolve(GROK_CFG) === resolve(operatorCfg)) {
    log(`GROK POSTURE      REFUSED — isolated config resolves to operator config ${operatorCfg}`)
    process.exit(3)
  }
  grokCfgBefore = existsSync(GROK_CFG) ? readFileSync(GROK_CFG, 'utf8') : undefined
  const beforeMode = isolatedGrokPermissionMode(grokCfgBefore)
  const after = configWithGrokAskMode(grokCfgBefore ?? '')
  if (after === (grokCfgBefore ?? '')) {
    log(`GROK POSTURE      isolated permission_mode=${beforeMode} already set`)
    return
  }
  grokCfgChanged = true
  mkdirSync(`${process.env.P2777_STATE_ROOT}/agent-home/.grok`, { recursive: true, mode: 0o700 })
  writeFileSync(GROK_CFG, after, { mode: 0o600 })
  log(`GROK POSTURE      isolated permission_mode=${beforeMode} → ask for this probe only`)
  log('                   operator ~/.grok/config.toml was not touched; restore is armed on exit')
}

function restoreGrokAskingPosture(): void {
  if (!grokCfgChanged || !GROK_CFG) return
  try {
    if (grokCfgBefore === undefined) rmSync(GROK_CFG, { force: true })
    else writeFileSync(GROK_CFG, grokCfgBefore, { mode: 0o600 })
    const restored = existsSync(GROK_CFG) ? readFileSync(GROK_CFG, 'utf8') : undefined
    if (restored !== grokCfgBefore) {
      log('GROK POSTURE      RESTORE FAILED — isolated config bytes changed on exit')
      process.exitCode = 6
      return
    }
    log(`GROK POSTURE      restored isolated config (${grokCfgBefore === undefined ? 'absent' : 'exact bytes'})`)
  } catch (error) {
    log(`GROK POSTURE      RESTORE FAILED — ${String(error)}`)
    process.exitCode = 6
  }
}
/**
 * auto_review is the operator's guardian. Copied into the isolated home it
 * answers Codex permissions itself, so Podium never sees a structured ask —
 * even in a never-approved dummy cwd. Measured 2026-08-28 11:57 CEST: dummy
 * cwd outside every trusted project, control FIRED, Bash ran, interactions.list
 * empty. Same shape as a rig-wide opencode asking posture: this row needs it,
 * every other row is contaminated by it. Set here, restore on every exit.
 */
const CODEX_CFG = `${process.env.P2777_STATE_ROOT}/agent-home/.codex/config.toml`
let codexCfgBefore: string | undefined
function setCodexUserReviewer(): void {
  if (harness !== 'codex') return
  if (!existsSync(CODEX_CFG)) {
    log('CODEX POSTURE      no isolated config.toml — cannot switch reviewer to user')
    return
  }
  codexCfgBefore = readFileSync(CODEX_CFG, 'utf8')
  if (!/^\s*approvals_reviewer\s*=\s*"auto_review"/m.test(codexCfgBefore)) {
    log(`CODEX POSTURE      isolated approvals_reviewer=${isolatedCodexReviewer()} (not auto_review); left as-is`)
    return
  }
  writeFileSync(
    CODEX_CFG,
    codexCfgBefore.replace(/^\s*approvals_reviewer\s*=\s*"auto_review"/m, 'approvals_reviewer = "user"'),
    { mode: 0o600 },
  )
  log('CODEX POSTURE      isolated approvals_reviewer=user for this probe only; restored on exit')
  log('                   (auto_review auto-answers, so Podium never receives the ask)')
}
function restoreCodexReviewer(): void {
  if (harness !== 'codex' || codexCfgBefore === undefined) return
  writeFileSync(CODEX_CFG, codexCfgBefore, { mode: 0o600 })
}

await login()
log('='.repeat(78))
log(`A4a / A4b  permission ask, and answering it twice   harness=${harness}`)
log('='.repeat(78))
process.on('exit', () => {
  restorePosture()
  restoreCodexReviewer()
  restoreGrokAskingPosture()
})
setAskingPosture()
if (harness === 'opencode') {
  log('posture            permission.bash=ask set for this probe only; restored on exit')
  log('                   (a rig-wide asking posture blocks every other tool cell)')
}
setCodexUserReviewer()
setGrokAskingPosture()

rmSync(EXTERNAL, { recursive: true, force: true })
mkdirSync(EXTERNAL, { recursive: true })

const sessionCwd = harness === 'codex' || harness === 'grok' ? makeNeverApprovedDummyRepo() : REPO
if (harness !== 'codex' && harness !== 'grok') log(`SESSION CWD        shared scratch repo ${sessionCwd}`)

const created = await mutate('sessions.create', { cwd: sessionCwd, agentKind })
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
const actionFile = `${EXTERNAL}/${marker}.txt`
const actionCount = () => {
  if (!existsSync(actionFile)) return 0
  return readFileSync(actionFile, 'utf8')
    .split('\n')
    .filter((line) => line === marker).length
}
const before = chat.items.length
const t0 = now()
await mutate('sessions.sendText', {
  sessionId: sid,
  text:
    `Use your shell/bash tool to run exactly this command: printf '%s\\n' ${marker} >> ${actionFile}` +
    ' and then tell me whether it succeeded. You must actually run the command with a tool.',
})

let asks: any[] = []
const deadline = now() + 90_000
while (now() < deadline) {
  asks = await openAsks(sid)
  if (asks.some((a) => a.answerable === 'structured')) break
  const r = await sessionRow(sid)
  if (r?.agentState?.phase !== 'working' && now() - t0 > 20_000) break
  await wait(2_000)
}

const newItems = chat.items.slice(before)
const controlFired = chat.deltaFrames > 0 && newItems.length > 0
const structured = asks.find((a) => a.answerable === 'structured')
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

if (!structured) {
  const toolRan = newItems.some((i) => i.role === 'tool' || i.toolName)
  log('')
  log(`A4a  ${toolRan ? 'BLOCKED' : 'FAIL'} — no enumerable structured ask appeared in ${Math.round((now() - t0) / 1000)}s`)
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

/**
 * Attach the native viewer only after the chat turn and its structured ask are
 * durable. A native attach takes the driver lease; taking it before sendText
 * parks Grok's chat turn behind the viewer and makes the positive control
 * measure the probe's ordering instead of the permission path.
 *
 * The ordering is explicit for every driver. Codex and opencode do not need the
 * workaround, but attaching after enumeration preserves their established chat
 * arm while exercising the same two-viewer state the criterion requires.
 */
const term = new Chat(sid)
await term.open('native')

let termScreenAtAsk = ''
const termDeadline = now() + 30_000
while (now() < termDeadline) {
  termScreenAtAsk = stripTerm(term.screen)
  const tail = termScreenAtAsk.slice(-2_500)
  if (/permission|approve|allow|grant|\[y\/n\]|yes\/no/i.test(tail) && tail.includes(marker)) {
    break
  }
  await wait(1_000)
}

const termTailAtAsk = termScreenAtAsk.slice(-2_500)
const askWordOnScreen = /permission|approve|allow|grant|\[y\/n\]|yes\/no/i.test(termTailAtAsk)
const markerOnScreen = termTailAtAsk.includes(marker)
const termShowsAsk = askWordOnScreen && markerOnScreen
const toolOnScreen = String(payload.toolName ?? '')
const toolNameOnScreen =
  toolOnScreen.length > 0 && termTailAtAsk.toLowerCase().includes(toolOnScreen.toLowerCase())

log('')
log('A4a  the TERMINAL half — attached after the structured ask was enumerable')
log(`     terminal bytes   ${term.screenBytes} (outputSeen=${term.attached?.outputSeen})`)
log(`     same ask visible before answering: ${termShowsAsk}`)
log(`       permission wording present: ${askWordOnScreen}`)
log(`       unique command marker '${marker}' present: ${markerOnScreen}`)
log(`       tool name '${toolOnScreen}' present (supporting only): ${toolNameOnScreen}`)
if (!termShowsAsk) {
  log('     terminal tail (control codes stripped):')
  for (const line of termTailAtAsk.trim().split('\n').filter((x) => x.trim()).slice(-6)) {
    log(`       | ${line.slice(0, 96)}`)
  }
}

// allow-once, never a synthesized allow-always.
const answer = { kind: 'permission', decision: 'allow-once' as const }
const termBytesAtAnswer = term.screenBytes
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

// Let the tool actually run before counting its non-idempotent side effect.
const firstActionDeadline = now() + 30_000
while (actionCount() < 1 && now() < firstActionDeadline) await wait(1_000)
const actionsAfterFirst = actionCount()
const filesAfterFirst = existsSync(EXTERNAL) ? readdirSync(EXTERNAL) : []
log(`     side effect      ${actionsAfterFirst} execution(s); ${filesAfterFirst.join(', ') || '(no file)'}`)

// "answering resolves BOTH" — the chat side is `cleared` above; this is the
// terminal side. Measured as the screen CHANGING after the answer: a terminal
// still showing the same ask has not been resolved.
await wait(8_000)
const termMoved = term.screenBytes > termBytesAtAnswer
const termTailAfterAnswer = stripTerm(term.screen).slice(-2_500)
const termStillAsks =
  /permission|approve|allow|grant|\[y\/n\]|yes\/no/i.test(termTailAfterAnswer) &&
  termTailAfterAnswer.includes(marker)
log(`     terminal after answering: +${term.screenBytes - termBytesAtAnswer} byte(s), same ask still prompting: ${termStillAsks}`)
const resolvedBoth = cleared && termShowsAsk && termMoved && !termStillAsks

// ---------------------------------------------------------------------------
// A4b — answer the same ask a second time
// ---------------------------------------------------------------------------
log('')
log('A4b  answering the SAME ask a second time')

if (!firstOk || !cleared || actionsAfterFirst !== 1) {
  log('     REFUSED — the control for this row did not fire.')
  log('     control watched: the FIRST answer succeeding, resolving the ask, and')
  log('                      running the command exactly once, so a second answer')
  log('                      is genuinely a second answer')
  log(`     control saw:     first answer ok=${firstOk}, ask resolved=${cleared}, actions=${actionsAfterFirst}`)
  log('     A product that errors on every answer would pass this row for the wrong')
  log('     reason; without a good first answer there is no second-answer case.')
  await chat.close()
  await term.close()
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
  await term.close()
  await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
  process.exit(3)
}

const typedRefusal = secondClass.refusal
const silentSuccess = !secondClass.refusal && secondData !== undefined

await wait(8_000)
const actionsAfterSecond = actionCount()
const doubleAction = actionsAfterSecond > actionsAfterFirst

log(`     typed refusal    ${typedRefusal}${typedRefusal ? ` — via ${secondClass.how}, reason=${JSON.stringify(secondClass.reason)}` : ` — ${secondClass.how}`}`)
log(`     silent success   ${silentSuccess}`)
log(
  `     double action    ${doubleAction} — ${actionsAfterFirst} execution(s) before, ${actionsAfterSecond} after`,
)

const a4bPass = typedRefusal && !doubleAction
log('')
log('='.repeat(78))
const a4aPass = cleared && termShowsAsk && resolvedBoth
log(`A4a  ${a4aPass ? 'PASS' : cleared ? 'PARTIAL' : 'FAIL'} — chat half ${cleared ? 'PASS' : 'FAIL'}, terminal half ${termShowsAsk ? (resolvedBoth ? 'PASS' : 'shows the ask but did not resolve') : 'did NOT show the ask'}`)
log(`A4b  ${a4bPass ? 'PASS' : 'FAIL'} — second answer ${typedRefusal ? 'was a typed error' : 'was NOT a typed error'}, double action: ${doubleAction}`)
log(`     controls: turn + structured ask FIRED; first answer succeeded, resolved, and acted once FIRED`)
log('='.repeat(78))

await chat.close()
await term.close()
await mutate('sessions.stop', { sessionId: sid }).catch(() => {})
process.exit(a4bPass && a4aPass ? 0 : 1)
