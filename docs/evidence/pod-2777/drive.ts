/**
 * POD-1761's ACCEPTANCE DRIVE — one harness, one arm, nine probes.
 *
 *   bash docs/evidence/pod-2777/drive-up.sh
 *   . docs/evidence/pod-2777/drive-env.sh
 *   bun docs/evidence/pod-2777/drive.ts codex|grok|opencode|claude
 *
 * The matrix runner (`drive-all.sh`) calls this once per (harness, arm) and
 * `report.ts` puts the arms side by side. Results land as JSON under
 * $PODIUM_DRIVE_BASE/results/ so the table is built from what ran, never from
 * what a human retyped.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT MAKE THIS REAL
 * ---------------------------------------------------------------------------
 *
 * 1. A POSITIVE CONTROL IN EVERY MEASUREMENT. Each probe declares a signal that
 *    must arrive whether or not its behaviour works, and `score()` turns a
 *    missing control into REFUSED rather than into a FAIL or a PASS. A zero
 *    from a dead rig and a zero from a broken feature are different findings and
 *    this drive will not print them in the same words. Two drives on this epic
 *    have already shipped without that and were believed.
 *
 * 2. AN A/B AGAINST THE TERMINAL DRIVER. "Better" is a comparison. Every
 *    harness that can run both ways runs both, same rig, same probes, same
 *    prompts, and the report puts the columns next to each other. A green
 *    headless column on its own does not answer the operator's question.
 *
 * 3. THE PIN IS VERIFIED BEFORE EVERY RUN — server, daemon AND web bundle.
 *    This process shells out to drive-verify.sh and REFUSES TO RUN on a
 *    mismatch, rather than leaving that to a human's discipline. The daemon is
 *    where the agent drivers live and it loads them at ITS process start, so a
 *    repinned checkout under a running bun process changes nothing at all.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  BASE,
  Chat,
  DRIVE_BASE,
  type ProbeResult,
  AGENT_KIND,
  primeTerminalTui,
  REPO,
  settle,
  type SessionRow,
  login,
  mutate,
  nonce,
  now,
  score,
  sessionRow,
  until,
  untilText,
  wait,
} from './rig'
import {
  type Ctx,
  type Probe,
  attach,
  interaction,
  interrupt,
  modelSwitch,
  providerError,
  reply,
  resumeAfterKill,
  stop,
  streaming,
} from './probes'

const harness = (process.argv[2] ?? 'opencode') as 'codex' | 'grok' | 'opencode' | 'claude'
const PIN = process.env.P2777_PIN ?? 'HEAD'
const SPAWN_RUNTIME_CONTRACT = process.env.P3103_RUNTIME_CONTRACT?.trim() || undefined
/** How long the streaming turn runs before the chat is opened into it. 8.5s is
 *  the delay POD-2745's codex drive used and POD-2773 kept; unchanged here so
 *  the numbers stay comparable across three drives. */
const JOIN_MS = Number(process.env.P2777_JOIN_MS ?? 8_500)
const STREAM_SAMPLE_MS = Number(process.env.P2777_STREAM_MS ?? 25_000)
const READY_MS = Number(process.env.P2777_READY_MS ?? 25_000)

/**
 * RE-DRIVE ONE CELL, rather than an hour of matrix, when a probe changes.
 *
 *   P2777_ONLY=resume,attach bun drive.ts codex
 *
 * The results file is MERGED, not replaced: the named probes are re-run and
 * overwrite their own entries, every other entry is kept with the pin it was
 * taken under. That matters — a table built from probes taken at different
 * commits must say so per cell rather than inherit the newest run's pin, which
 * would be exactly the stale-rig lie this rig exists to prevent.
 *
 * DEPENDENCIES ARE HONOURED. `attach` and `provider-error` take probe 1's
 * verdict as their positive control, so asking for either implicitly re-runs
 * `reply` — a control cannot be inherited from an older run on a session that no
 * longer exists.
 */
const ONLY = new Set((process.env.P2777_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean))
const DEPENDS: Record<string, string[]> = { attach: ['reply'], 'provider-error': ['reply'] }
for (const id of [...ONLY]) for (const dep of DEPENDS[id] ?? []) ONLY.add(dep)

/**
 * AN UNKNOWN PROBE NAME IS AN ERROR, NOT AN EMPTY SELECTION.
 *
 * This cost a cell. `P2777_ONLY=streaming,interrupt,resume` ran two probes: the
 * streaming one is called `stream`, `streaming` matched nothing, and the runner
 * said NOTHING — it printed a results table with two rows and exited 0. A drive
 * that silently omits what you asked for is a drive whose coverage you cannot
 * read off its own output, and I nearly recorded row A2a as driven on the
 * strength of a run that never touched it.
 *
 * The known set is DERIVED from the probes themselves rather than typed out
 * here, so a probe renamed or added cannot drift away from this check.
 */
const KNOWN = new Set([
  reply.id,
  streaming(0, false, 'unknown').id,
  interrupt.id,
  stop.id,
  resumeAfterKill('', undefined as never, '', false).id,
  attach.id,
  interaction.id,
  modelSwitch.id,
  providerError(harness).id,
  'headed-switch',
])
const unknown = [...ONLY].filter((id) => !KNOWN.has(id))
if (unknown.length > 0) {
  console.error(`P2777_ONLY names ${unknown.length} probe(s) that do not exist: ${unknown.join(', ')}`)
  console.error(`known probes: ${[...KNOWN].sort().join(', ')}`)
  console.error('')
  console.error('Refusing to run. A selection that silently matches nothing produces a')
  console.error('results table missing the very cell you asked for, and exits 0 while doing it.')
  process.exit(6)
}

const wanted = (id: string) => ONLY.size === 0 || ONLY.has(id)

const log = (s: string) => console.log(s)

// ---------------------------------------------------------------------------
// LEG 3 OF THE DISCIPLINE: the pin, before anything else happens.
// ---------------------------------------------------------------------------
// Shelled out rather than reimplemented, so there is exactly one definition of
// "this instance is the commit under test" and the runner cannot drift from the
// script an operator would run by hand.
const verify = spawnSync('bash', [`${import.meta.dir}/drive-verify.sh`, PIN], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (verify.status !== 0) {
  console.error(verify.stdout ?? '')
  console.error(verify.stderr ?? '')
  console.error('')
  console.error('PIN CHECK FAILED — refusing to drive. A measurement taken against a rig')
  console.error('that is not the commit under test is worse than no measurement, because')
  console.error('it will be believed. Bring the instance up with drive-up.sh and re-run.')
  process.exit(4)
}
log(verify.stdout.trim())
const pin = JSON.parse(
  (verify.stdout.split('\n').find((l) => l.startsWith('PINJSON ')) ?? 'PINJSON {}').slice(8),
) as Record<string, unknown>

const arm: 'headless' | 'terminal' =
  SPAWN_RUNTIME_CONTRACT !== undefined || pin.driver === 'generic-pty'
    ? 'terminal' : 'headless'

/** Which driver this arm is entitled to bind. An isolated agent home missing a
 *  credential does not fail loudly — the server driver declines, the session
 *  degrades to a generic PTY, and every headless probe then measures the
 *  terminal path while reporting the headless column. That is the exact false
 *  negative POD-2773's rig hit twice, so a wrong binding refuses the whole run. */
/**
 * WHAT THE ARM IS ENTITLED TO BIND.
 *
 * The headless arm names an exact server driver per harness. The terminal arm
 * names a FAMILY, not an id, and that distinction cost the most important column
 * in the matrix: claude's terminal driver is `claude-pty`, not `generic-pty`, so
 * a hardcoded `generic-pty` refused all nine claude cells on both arms. The
 * refusals were correct — the session did not bind what the arm claimed — but
 * what the arm claimed was wrong, and a guard cannot tell my mistake from the
 * product's.
 *
 * CLAUDE HAS NO HEADLESS DRIVER, so on the headless arm it legitimately binds a
 * terminal-family driver too. That is allowed and RECORDED rather than refused:
 * claude runs ONE path, and the headless arm simply confirms the policy does not
 * move it.
 */
const EXPECTED_SERVER: Record<string, string> = {
  codex: 'codex-app-server',
  grok: 'grok-acp',
  opencode: 'opencode-server',
}
const wantServer = EXPECTED_SERVER[harness]
const wantDriver = arm === 'terminal' || !wantServer ? 'a terminal-family driver' : wantServer

log('')
log('='.repeat(78))
log(`ACCEPTANCE DRIVE   harness=${harness}  arm=${arm}  expecting driver '${wantDriver}'`)
log(`PIN                ${pin.want} (web bundle ${pin.webSourceSha}, server pid ${pin.serverPid}, daemon pid ${pin.daemonPid})`)
log('='.repeat(78))

await login()

let primedOuter: string[] = []
const results: ProbeResult[] = []
const outcomes = new Map<string, { verdict: string }>()

async function runProbe(p: Probe, ctx: Ctx): Promise<void> {
  const t0 = now()
  log('')
  log(`── ${p.id} — ${p.title}`)
  let res: ProbeResult
  try {
    const { outcome, control } = await p.run(ctx)
    const scored = score(outcome, control)
    res = { id: p.id, title: p.title, catalogRow: p.catalogRow, control, ms: now() - t0, ...scored }
  } catch (err) {
    res = {
      id: p.id,
      title: p.title,
      catalogRow: p.catalogRow,
      control: { fired: false, what: 'the probe running to completion', detail: String(err) },
      ms: now() - t0,
      verdict: 'REFUSED',
      summary: `the probe threw: ${String(err).slice(0, 160)}`,
      evidence: [`THREW             ${String(err).slice(0, 400)}`],
      data: {},
    }
  }
  results.push(res)
  ctx.results.set(p.id, res)
  outcomes.set(p.id, res)
  log(`   ${res.verdict}  ${res.summary}`)
  log(`   control: ${res.control.fired ? 'FIRED' : 'DID NOT FIRE'} — ${res.control.detail}`)
  for (const line of res.evidence) log(`   ${line}`)
}

/** Every probe refused, with one reason. Used when the arm itself is invalid —
 *  a wrong binding makes all nine numbers measurements of something else. */
function refuseAll(reasonWhat: string, reasonDetail: string): void {
  // ALL NINE, not the seven that happen to be constructible without arguments:
  // a refused arm must show a refused cell for every behaviour, or the table
  // silently reads as "we did not try that one" where it means "we refused to
  // believe any of it".
  const all: Probe[] = [
    reply,
    streaming(0, false, 'unknown'),
    interrupt,
    stop,
    resumeAfterKill('', undefined as never, '', false),
    attach,
    interaction,
    providerError(harness),
    modelSwitch,
  ]
  for (const p of all) {
    results.push({
      id: p.id,
      title: p.title,
      catalogRow: p.catalogRow,
      control: { fired: false, what: reasonWhat, detail: reasonDetail },
      ms: 0,
      verdict: 'REFUSED',
      summary: 'the arm did not bind the driver it claims — nothing here measures what it says',
      evidence: [`REFUSED           ${reasonDetail}`],
      data: {},
    })
  }
}

// ---------------------------------------------------------------------------
// the main session: reply, attach, interaction, model — then stream+interrupt,
// then stop (which ends it).
// ---------------------------------------------------------------------------
const agentKind = AGENT_KIND[harness] ?? harness
const createStartedAt = now()
const created = await mutate('sessions.create', {
  cwd: REPO,
  agentKind,
  ...(SPAWN_RUNTIME_CONTRACT ? { runtimeContract: SPAWN_RUNTIME_CONTRACT } : {}),
})
const sid = created.result?.data?.sessionId as string | undefined
if (!sid) {
  console.error(`sessions.create failed: ${JSON.stringify(created).slice(0, 400)}`)
  process.exit(5)
}
log(`session ${sid} created; giving the harness ${READY_MS}ms to come up`)
await wait(READY_MS)

/**
 * WAIT FOR THE BINDING, DO NOT SAMPLE IT ONCE.
 *
 * A driver id is not published the instant a session exists. Reading it once at
 * READY_MS reported `(unknown)` for claude and refused all nine of its cells —
 * the most important column in this matrix — because claude binds lazily: the
 * catalogue records that the terminal family mints its ref at the FIRST TURN,
 * and claude fires no SessionStart at interactive boot at all.
 *
 * So the binding is WAITED for, and only a binding that never arrives refuses.
 */
const bound = await until(sid, (r) => Boolean(r?.driverId), 90_000, 1_000)
if (!bound.ok) log(`no driver bound after ${Math.round(bound.ms / 1000)}s`)
const row0 = bound.row ?? (await sessionRow(sid))
const boundDriver = row0?.driverId ?? '(unknown)'
log(`BOUND DRIVER       ${boundDriver} (family ${row0?.driverFamily ?? '?'})`)

const boundFamily = row0?.driverFamily ?? '?'
const bindingOk = SPAWN_RUNTIME_CONTRACT
  ? boundDriver === SPAWN_RUNTIME_CONTRACT && boundFamily === 'terminal'
  : arm === 'terminal' || !wantServer
    ? boundFamily === 'terminal'
    : boundDriver === wantServer
if (!bindingOk) {
  log('')
  log(`WRONG BINDING — this arm asked for ${wantDriver} and the session bound '${boundDriver}' (family ${boundFamily}).`)
  log('A headless arm that quietly degraded to a PTY measures the terminal path and')
  log('reports it in the headless column. REFUSING every probe in this run.')
  refuseAll(
    `the session binding the driver this arm claims (${wantDriver})`,
    `bound '${boundDriver}' (family ${boundFamily}) instead — a missing credential in the isolated agent home, or an arm claiming a driver this harness does not use`,
  )
} else {
  if (!wantServer && arm === 'headless') {
    log('')
    log(`NOTE: ${harness} has no headless driver. It bound '${boundDriver}' (family ${boundFamily})`)
    log('on the headless arm too — this harness runs ONE path and the driver preference')
    log('does not move it. Its column is the terminal path.')
  }

  const chat = new Chat(sid)
  await chat.open()

  /**
   * PRIME THE TUI BEFORE MEASURING ANYTHING — terminal arm only.
   *
   * A PTY session opens on whatever first-run dialog its harness shows, and a
   * rig that starts sending immediately types its prompt INTO that dialog: no
   * turn runs, the transcript plane stays empty, and every probe refuses for
   * want of a control. codex/terminal did exactly that on this rig's first pass
   * — eight of nine cells refused with `0 transcriptDelta frames`. The refusals
   * were right, and the arm had simply never been allowed to start.
   */
  let primed: string[] = []
  if (arm === 'terminal') {
    primed = await primeTerminalTui(chat, sid)
    primedOuter = primed
    log(`TUI PRIMING        ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
    await settle(sid)
  }

  const ctx: Ctx = { harness, arm, sid, chat, row: row0 as SessionRow, results: new Map(), log }
  const headedSwitch: Probe = {
    id: 'headed-switch', title: 'headed Chat and Native switching',
    catalogRow: 'A6b Chat-CLI switch both directions twice',
    run: async (probeCtx) => {
      const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs: number) => {
        const started = now()
        while (now() - started < timeoutMs) {
          if (await check()) return { ok: true, ms: now() - started }
          await wait(250)
        }
        return { ok: await check(), ms: now() - started }
      }
      probeCtx.chat.mode('native')
      const firstBytes = await waitFor(() => probeCtx.chat.screenBytes > 0, 30_000)
      const bytesAtReady = probeCtx.chat.screenBytes
      const replyPassed = probeCtx.results.get('reply')?.verdict === 'PASS'
      const cliBefore = nonce('CLI-BEFORE')
      probeCtx.chat.send({ type: 'input', sessionId: probeCtx.sid, data: Buffer.from(cliBefore).toString('base64'), inputOrigin: 'human' })
      const echoBefore = await waitFor(() => probeCtx.chat.screenTail(8_000).includes(cliBefore), 20_000)
      const control = { fired: firstBytes.ok && replyPassed && echoBefore.ok, what: 'native terminal bytes, a completed chat reply, and raw CLI echo before switching', detail: `firstBytes=${firstBytes.ok} bytes=${bytesAtReady} reply=${replyPassed} cliEcho=${echoBefore.ok}` }
      const screenBefore = probeCtx.chat.screen
      const bytesBefore = probeCtx.chat.screenBytes
      const rowBefore = await sessionRow(probeCtx.sid)
      const observations: Record<string, unknown>[] = []
      for (const mode of ['chat', 'native', 'chat', 'native'] as const) {
        probeCtx.chat.mode(mode)
        await wait(mode === 'native' ? 2_500 : 1_500)
        observations.push({ mode, bytes: probeCtx.chat.screenBytes, driverId: (await sessionRow(probeCtx.sid))?.driverId })
      }
      probeCtx.chat.mode('chat')
      const second = nonce('SECOND')
      const send = await mutate('sessions.sendText', { sessionId: probeCtx.sid, text: `Reply with exactly this word and nothing else: ${second}. Do not use any tools.` })
      const working = await waitFor(async () => (await sessionRow(probeCtx.sid))?.agentState?.phase === 'working', 15_000)
      const secondReply = await waitFor(async () => probeCtx.chat.assistantText().includes(second) && (await sessionRow(probeCtx.sid))?.agentState?.phase === 'idle', 180_000)
      probeCtx.chat.mode('native')
      await wait(2_500)
      const cliAfter = nonce('CLI-AFTER')
      probeCtx.chat.send({ type: 'input', sessionId: probeCtx.sid, data: Buffer.from(cliAfter).toString('base64'), inputOrigin: 'human' })
      const echoAfter = await waitFor(() => probeCtx.chat.screenTail(8_000).includes(cliAfter), 20_000)
      const rowAfter = await sessionRow(probeCtx.sid)
      const bytesAfter = probeCtx.chat.screenBytes
      const count = (text: string, needle: string) => text.split(needle).length - 1
      const firstNeedle = probeCtx.chat.items.find((item) => item.role === 'assistant')?.text ?? ''
      const beforeCount = firstNeedle ? count(screenBefore, firstNeedle) : 0
      const afterCount = firstNeedle ? count(probeCtx.chat.screen, firstNeedle) : 0
      const identityStable = rowBefore?.driverId === 'generic-pty' && rowAfter?.driverId === 'generic-pty' && rowAfter?.driverFamily === 'terminal'
      const bytesGrew = bytesAfter > bytesBefore
      const corePassed = control.fired && identityStable && working.ok && secondReply.ok && echoAfter.ok && bytesGrew
      return { control, outcome: {
        verdict: corePassed ? 'PARTIAL' : 'FAIL',
        summary: corePassed ? 'four headed switches preserved generic-pty identity, both inputs, transcript sync, and terminal growth; scrollback corruption remains unmeasured' : 'a headed switch, identity, input, transcript, or byte-growth clause failed',
        evidence: [
          `CREATE TO BIND    ${READY_MS + bound.ms}ms`,
          `FIRST NATIVE BYTE ${firstBytes.ms}ms after native view; bytes=${bytesAtReady}`,
          `INPUT READY       primed=${primed.join('; ') || 'none'}`,
          `IDENTITY          before=${rowBefore?.driverId}/${rowBefore?.driverFamily} after=${rowAfter?.driverId}/${rowAfter?.driverFamily}`,
          `SWITCHES          ${JSON.stringify(observations)}`,
          `SECOND SEND       ${JSON.stringify(send.result?.data ?? send.error ?? null)} working=${working.ok} reply+idle=${secondReply.ok} ${secondReply.ms}ms`,
          `TERMINAL BYTES    before=${bytesBefore} after=${bytesAfter} delta=${bytesAfter - bytesBefore}`,
          `CLI ECHO          before=${echoBefore.ok} after=${echoAfter.ok}`,
          `SCROLLBACK        UNMEASURED: raw PTY redraw count before=${beforeCount} after=${afterCount}; redraw frames are not xterm buffer rows`,
        ],
        data: { creationToBindMs: READY_MS + bound.ms, firstNativeBytesWaitMs: firstBytes.ms, bytesAtReady, bytesBefore, bytesAfter, observations, workingMs: working.ms, secondReplyMs: secondReply.ms, identityStable, scrollbackMeasured: false },
      } }
    },
  }


  // SETTLE BETWEEN PROBES. A send into a busy session is QUEUED, not delivered,
  // and a probe that then waits for an answer is waiting for a turn that has not
  // started. That is how the shakedown produced its one invented failure.
  if (wanted('reply')) {
    await runProbe(reply, ctx)
    await settle(sid)
  }
  if (wanted('attach')) {
    await runProbe(attach, ctx)
    await settle(sid)
  }
  if (wanted('interaction')) {
    await runProbe(interaction, ctx)
    await settle(sid)
  }
  if (wanted('model-switch')) {
    await runProbe(modelSwitch, ctx)
    await settle(sid)
  }

  // --- streaming + interrupt, on ONE long turn joined LATE ------------------
  //
  // The chat is CLOSED and reopened for this, deliberately. The case worth
  // driving is a viewer arriving into a turn already in flight — the ordering
  if (wanted('headed-switch')) {
    await runProbe(headedSwitch, ctx)
    await settle(sid)
  }
  // that used to show nothing at all, and the one a drive that subscribes first
  // would pass on a broken build. Reusing the socket that has been attached
  // since before the turn started would measure the easy ordering instead.
  await chat.close()
  if (wanted('stream') || wanted('interrupt') || wanted('stop')) {
  // LONG ENOUGH THAT THE JOIN LANDS INSIDE IT. The turn must still be running
  // 8.5s later or there is nothing to watch: opencode answered a 60-line version
  // inside the join delay, and the probe measured a fence and called it a dead
  // preview plane. 150 lines with a sentence each is minutes of generation on
  // every harness here.
  const longPrompt =
    'Count from 1 to 150. Put each number on its own line, and after each number ' +
    'write one full sentence about that number — a fact, a property, anything. ' +
    'Do not use any tools. Do not summarise. Write every single line.'
  const startedAt = now()
  await mutate('sessions.sendText', { sessionId: sid, text: longPrompt })
  log('')
  log(`letting the turn run ${JOIN_MS}ms BEFORE opening the chat (the hard ordering)`)
  await wait(JOIN_MS)

  const late = new Chat(sid)
  await late.open()
  const joinedMs = now() - startedAt
  // READ THE PHASE AT THE MOMENT OF JOINING. A turn that finished inside the
  // join delay leaves nothing to stream, and the difference between that and a
  // broken preview plane is invisible in the frame count alone.
  const joinRow = await sessionRow(sid)
  const phaseAtJoin = joinRow?.agentState?.phase ?? 'unknown'
  const wasRunningAtJoin = phaseAtJoin === 'working'
  const streamCtx: Ctx = { ...ctx, chat: late, results: ctx.results }
  await wait(STREAM_SAMPLE_MS)
  if (wanted('stream')) await runProbe(streaming(joinedMs, wasRunningAtJoin, phaseAtJoin), streamCtx)

  // The interrupt probe establishes its own running turn (see probes.ts): the
  // shared streaming turn finishes inside the join delay on fast harnesses, and
  // a cell POD-2792 depends on must not be hostage to another probe's timing.
  if (wanted('interrupt')) await runProbe(interrupt, streamCtx)

  if (wanted('stop')) await runProbe(stop, streamCtx)
  await late.close()
  }

  // --- resume after a kill, on its own session -----------------------------
  const secret = nonce('REMEMBER')
  const r2 = wanted('resume')
    ? await mutate('sessions.create', { cwd: REPO, agentKind })
    : { result: undefined }
  const sid2 = r2.result?.data?.sessionId as string | undefined
  if (sid2) {
    await wait(READY_MS)
    await settle(sid2)
    const chat2 = new Chat(sid2)
    await chat2.open()
    await mutate('sessions.sendText', {
      sessionId: sid2,
      text: `Remember this word: ${secret}. Reply with just that word to confirm. Do not use any tools.`,
    })
    const confirmed = await untilText(chat2, (t) => t.includes(secret), 180_000)
    await runProbe(resumeAfterKill(sid2, chat2, secret, confirmed.ok), { ...ctx, sid: sid2, chat: chat2 })
    await chat2.close()
    await mutate('sessions.kill', { sessionId: sid2 }).catch(() => {})
  }

  // --- provider error, on its own session ----------------------------------
  if (wanted('provider-error')) await runProbe(providerError(harness), ctx)
}

// ---------------------------------------------------------------------------
// REPORT — this arm alone. report.ts puts the arms side by side.
// ---------------------------------------------------------------------------
log('')
log('='.repeat(78))
log(`RESULT  ${harness} / ${arm} / driver=${boundDriver}`)
log('='.repeat(78))
const pad = (s: string, n: number) => s.padEnd(n)
log(`${pad('probe', 16)}${pad('verdict', 10)}${pad('control', 10)}summary`)
log('-'.repeat(78))
for (const r of results) {
  log(`${pad(r.id, 16)}${pad(r.verdict, 10)}${pad(r.control.fired ? 'fired' : 'MISSING', 10)}${r.summary}`)
}
log('='.repeat(78))

const stamped = results.map((r) => ({ ...r, pin: pin.short, at: new Date().toISOString() }))
mkdirSync(`${DRIVE_BASE}/results`, { recursive: true })
const path = `${DRIVE_BASE}/results/${harness}.${arm}.json`

// MERGE, so a targeted re-drive replaces its own cells and leaves the rest
// carrying the pin they were actually taken under.
let merged = stamped
if (ONLY.size > 0 && existsSync(path)) {
  const prior = JSON.parse(readFileSync(path, 'utf8')) as { results?: (typeof stamped)[number][] }
  const fresh = new Set(stamped.map((r) => r.id))
  merged = [...(prior.results ?? []).filter((r) => !fresh.has(r.id)), ...stamped]
}
const out = {
  harness,
  arm,
  driverId: boundDriver,
  driverFamily: row0?.driverFamily ?? null,
  pin,
  at: new Date().toISOString(),
  partial: ONLY.size > 0 ? [...ONLY] : undefined,
  tuiPriming: arm === 'terminal' ? primedOuter : undefined,
  results: merged,
}
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)
log(`written ${path}`)

// A run in which nothing was scored is not a pass. Exit non-zero so a matrix
// runner cannot mistake a refused arm for a completed one.
const scored = results.filter((r) => r.verdict === 'PASS' || r.verdict === 'FAIL').length
process.exit(scored === 0 ? 6 : 0)
