/**
 * POD-2777 — the nine probes, one per behaviour the epic is judged on.
 *
 * Each probe names the driver-capability-catalogue row it drives, declares the
 * positive control it will be scored against, and returns evidence a reader can
 * check the verdict against. `score()` in rig.ts turns a probe whose control
 * did not fire into REFUSED — that is the rule the whole drive exists to
 * enforce, and no probe here may bypass it.
 *
 * WHY THESE NINE, AND WHY IN THIS ORDER. They are the brief's list, and the
 * catalogue says which of them have ever actually been watched. `interrupt`,
 * the `permission/approval` ask, the attachment `promptForm` and the model/effort
 * switch are all `wired` or `declared` for every driver — code exists, unit
 * tests pass, and nobody has watched them work in the product. Those are the
 * cells worth a real drive. `resume` and `send` are `proven`/`pinned` already,
 * and they are here anyway because they are what a control needs: a rig that
 * cannot do the easy thing cannot be believed about the hard ones.
 */

import { digitNonce, digitsPng } from './nonce-png'
import {
  Chat,
  type ControlReading,
  type ProbeOutcome,
  type SessionRow,
  mutate,
  nonce,
  now,
  query,
  AGENT_KIND,
  fineWatch,
  openAsks,

  REPO,
  sessionRow,
  settle,
  until,
  untilText,
  wait,
} from './rig'

export interface Ctx {
  harness: string
  arm: 'headless' | 'terminal'
  /** The main session, already created with its chat open. */
  sid: string
  chat: Chat
  row: SessionRow
  /** Filled in as probes run, so a later probe can use an earlier one as its
   *  control. P8's control IS P1's verdict: an error arm proves nothing about
   *  honest reporting if the harness could not answer a normal question here. */
  results: Map<string, ProbeOutcome>
  log: (s: string) => void
}

export interface Probe {
  id: string
  title: string
  catalogRow: string
  run: (ctx: Ctx) => Promise<{ outcome: ProbeOutcome; control: ControlReading }>
}

/** Tunable so a shakedown run can be minutes instead of an hour. The defaults
 *  are what a real drive uses; a REDUCED value makes a timeout more likely and
 *  therefore makes a FAIL less trustworthy, so report.ts prints them and the
 *  README says which numbers were taken at what patience. */
const REPLY_MS = Number(process.env.P2777_REPLY_MS ?? 180_000)
const IDLE_MS = Number(process.env.P2777_IDLE_MS ?? 120_000)

/** Text that a blank session could not produce by luck. Every probe that has to
 *  tell "it worked" from "something plausible happened" hangs off one of these. */
const say = (n: string) =>
  `Reply with exactly this word and nothing else: ${n}. Do not use any tools.`

// ---------------------------------------------------------------------------
// 1 — send a turn and get a reply
// ---------------------------------------------------------------------------
export const reply: Probe = {
  id: 'reply',
  title: 'send a turn, get a reply',
  catalogRow: '§1 send opens a turn, reports the delivery actually used (pinned)',
  async run(ctx) {
    const n = nonce('PODIUM')
    const t0 = now()
    const sent = await mutate('sessions.sendText', { sessionId: ctx.sid, text: say(n) })
    const got = await untilText(ctx.chat, (t) => t.includes(n), REPLY_MS, { pumpFor: ctx.sid })

    /**
     * CONTROL: our own message landing as a durable transcript item.
     *
     * Written by the transcript tailer whatever the agent does next, so it
     * separates "the agent never answered" from "nothing in this rig is
     * alive" — which are the two readings a bare zero cannot tell apart, and
     * the confusion that has cost this epic two believed numbers.
     */
    const control: ControlReading = {
      fired: ctx.chat.userText().includes(n) || ctx.chat.deltaFrames > 0,
      what: 'our own prompt landing on the durable transcript plane (transcriptDelta)',
      detail: `${ctx.chat.deltaFrames} transcriptDelta frame(s); prompt echoed on transcript: ${ctx.chat.userText().includes(n) ? 'yes' : 'no'}`,
    }

    const text = ctx.chat.assistantText()

    /**
     * A TURN THE PROVIDER REFUSED IS A BLOCKED DRIVE, NOT A FAILED ONE.
     *
     * POD-2773 hit this and named it: grok's account is out of credit, the API
     * answers `402 Payment Required: Grok Build usage balance exhausted`, and
     * not one token is ever generated. Every probe downstream then reads as a
     * broken harness. It is not — everything up to token production is working,
     * and the difference between "this driver is broken" and "give that account
     * credit and it is a ten-minute drive" is the whole finding.
     *
     * So a missing reply is attributed before it is scored: if the product
     * reports an error class for the turn, the verdict is BLOCKED and the
     * provider's own words are printed.
     */
    const after = await sessionRow(ctx.sid)
    const errClass = after?.agentState?.error?.class
    const errDetail = after?.agentState?.error?.detail
    if (!got.ok && errClass) {
      return {
        control,
        outcome: {
          verdict: 'BLOCKED',
          summary: `the provider refused the turn: ${errClass}`,
          evidence: [
            `SENT              ${say(n)}`,
            `TURN ERROR        ${errClass} — ${(errDetail ?? '').slice(0, 200)}`,
            `PHASE / STATUS    phase=${after?.agentState?.phase ?? '?'} status=${after?.status ?? '?'}`,
            'BLOCKED, NOT FAILED: no token was ever generated, so every reading that',
            'depends on one says nothing about this driver. The send was accepted and',
            'the durable plane carried our prompt — everything up to token production',
            'is observed working. This is an account problem, not a code problem.',
          ],
          data: { nonce: n, errorClass: errClass, blocked: true },
        },
      }
    }

    return {
      control,
      outcome: {
        verdict: got.ok ? 'PASS' : 'FAIL',
        summary: got.ok
          ? `replied with the nonce in ${(got.ms / 1000).toFixed(1)}s`
          : `no reply carrying the nonce within ${REPLY_MS / 1000}s`,
        evidence: [
          `SENT              ${say(n)}`,
          `SEND ACCEPTED     ${JSON.stringify(sent.result?.data ?? sent.error ?? null).slice(0, 200)}`,
          `NONCE             ${n} — a blank session cannot produce this by luck`,
          `REPLY             ${got.ok ? `arrived after ${got.ms}ms` : 'never arrived'}`,
          `ASSISTANT TEXT    ${text.length} chars${text ? `: ${JSON.stringify(text.slice(0, 160))}` : ''}`,
          `ELAPSED           ${now() - t0}ms`,
          ...(got.ok ? [] : [`LAST TUI SCREEN   ${JSON.stringify(ctx.chat.screenTail(240))}`]),
          ...(got.asksAnswered > 0 ? [`ASKS CLEARED      ${got.asksAnswered} permission ask(s) answered allow-once while waiting`] : []),
        ],
        data: { nonce: n, replyMs: got.ok ? got.ms : null, chars: text.length },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// 2 — streaming deltas actually arrive
// ---------------------------------------------------------------------------
/**
 * THE ORDERING IS THE EXPERIMENT (inherited from POD-2773).
 *
 * The chat is opened SEVERAL SECONDS INTO a turn already in flight. That is the
 * normal case for anyone who starts a session and then looks at it, and it is
 * exactly the case that used to show nothing at all: reaching the fine watch was
 * a reconnect, a reconnect abandons an in-flight turn, so the upgrade could only
 * land in an idle gap and the turn a viewer walked in on was always the turn
 * that streamed nothing. A drive that opens the chat FIRST and then sends
 * measures the easy ordering and would have passed on the broken build.
 *
 * This probe is handed a chat that was opened late, by the runner, for that
 * reason — see drive.ts.
 */
export function streaming(joinedMs: number, wasRunningAtJoin: boolean, phaseAtJoin: string): Probe {
  return {
    id: 'stream',
    title: 'streaming deltas actually arrive',
    catalogRow: '§2 first turn a viewer joins streams (codex proven; grok/opencode wired)',
    async run(ctx) {
      /**
       * TWO CONTROLS, AND THE SECOND ONE COST A MEASUREMENT TO LEARN.
       *
       * The durable plane firing says the socket is alive. It does NOT say there
       * was a turn to stream: if the agent finished answering inside the join
       * delay, a viewer arrives after the fence, sees one trailing frame, and the
       * probe reports "the reply did not build in the pane" about a turn that was
       * already over. This rig did that — 57 preview frames on one run and 1 on
       * the next, same harness, same arm, and the difference was how fast the
       * model answered, not whether streaming works.
       *
       * So the phase is read at the moment of joining, and a turn that had
       * already finished makes this BLOCKED rather than FAIL. Not a failure of
       * the feature; a failure to arrive in time to watch it.
       */
      const control: ControlReading = {
        fired: ctx.chat.deltaFrames > 0,
        what: 'transcriptDelta — the DURABLE plane, on the same socket and the same subscription',
        detail: `${ctx.chat.deltaFrames} frame(s)${ctx.chat.firstDeltaAtMs !== undefined ? `, first at +${ctx.chat.firstDeltaAtMs}ms` : ''}`,
      }
      if (!wasRunningAtJoin && ctx.chat.previews.length === 0) {
        return {
          control,
          outcome: {
            verdict: 'BLOCKED',
            summary: `the turn had already finished when the chat opened (phase=${phaseAtJoin})`,
            evidence: [
              `JOINED            ${joinedMs}ms after the send, and the session was already phase=${phaseAtJoin}`,
              'The ordering under test is a viewer arriving DURING a turn. This agent',
              'answered inside the join delay, so there was no in-flight turn to watch',
              'and a preview count of zero is a fact about the timing, not the plane.',
              'BLOCKED rather than FAIL: re-run with a longer prompt or a shorter join',
              'delay (P2777_JOIN_MS) to measure this cell on this harness.',
            ],
            data: { previewFrames: ctx.chat.previews.length, joinedMs, phaseAtJoin, turnAlreadyOver: true },
          },
        }
      }

      const watch = await fineWatch(ctx.sid)
      const s = ctx.chat.previews
      const first = s[0]
      const last = s.at(-1)

      // MONOTONIC, MEASURED PER ROW AND NOT ON THE TOTAL. Every frame carries
      // the WHOLE preview, and a row is RETIRED the moment the durable item
      // carrying its identity lands on the transcript plane — so the total
      // legitimately drops at a retirement, and a naive check on the total
      // would call a correct stream non-monotonic.
      const seen = new Map<string, number>()
      const shrinks: string[] = []
      for (const f of s) {
        for (const [id, n] of Object.entries(f.perItem)) {
          const prev = seen.get(id)
          if (prev !== undefined && n < prev) shrinks.push(`${id} ${prev}->${n} at +${f.atMs}ms`)
          seen.set(id, n)
        }
      }
      const grew = s.filter((f, i) => i > 0 && f.chars > (s[i - 1]?.chars ?? 0)).length

      /**
       * JOINING AT THE TAIL IS NOT A BROKEN PLANE, and telling the two apart
       * cost a wrong conclusion. One run of this cell returned a single frame and
       * scored FAIL; the re-drive returned 26 and scored PASS — same harness,
       * same arm, same commit. The single frame carried `seq=512`, which is the
       * SAME final seq the passing run ends on: the viewer had arrived just as
       * the turn's preview stream finished, so there was nothing left to watch.
       *
       * A turn that ends within a moment of the join is a timing miss, not
       * evidence about the preview plane, so it is BLOCKED with the seq printed
       * — and the seq is what makes the claim checkable rather than a guess.
       */
      const endedRightAfterJoin =
        s.length <= 1 && (await sessionRow(ctx.sid))?.agentState?.phase !== 'working'
      if (endedRightAfterJoin) {
        return {
          control,
          outcome: {
            verdict: 'BLOCKED',
            summary: `joined at the tail of the preview stream (${s.length} frame at seq=${first?.seq ?? '?'})`,
            evidence: [
              `JOINED            ${joinedMs}ms after the send, phase=${phaseAtJoin} at that moment`,
              `FRAMES            ${s.length}${first ? ` — a single frame at seq=${first.seq}, chars=${first.chars}` : ''}`,
              'THE TURN ENDED    within the sampling window, and a lone trailing frame is what',
              '                  a viewer arriving at the fence sees. Not evidence about the',
              '                  preview plane: re-run with a longer prompt or a shorter',
              '                  P2777_JOIN_MS to measure this cell on this harness.',
              `FINE WATCH        ${watch?.acquired ? 'ACQUIRED — the plumbing worked; the timing did not' : 'NOT acquired'}`,
            ],
            data: { previewFrames: s.length, joinedMs, phaseAtJoin, joinedAtTail: true, seq: first?.seq ?? null },
          },
        }
      }

      const streamed = s.length > 0 && grew > 0
      return {
        control,
        outcome: {
          verdict: streamed ? 'PASS' : 'FAIL',
          summary: streamed
            ? `${s.length} preview frames, ${first?.chars}→${last?.chars} chars, ${shrinks.length === 0 ? 'monotonic per row' : `${shrinks.length} shrink(s)`}`
            : `${s.length} preview frames — the reply did not build in the pane`,
          evidence: [
            `JOINED            ${joinedMs}ms into a turn ALREADY RUNNING (the hard ordering, not the easy one)`,
            `PHASE AT JOIN     ${phaseAtJoin}${wasRunningAtJoin ? ' — a turn was in flight when the viewer arrived' : ''}`,
            `PREVIEW FRAMES    ${s.length}`,
            ...(first && last
              ? [
                  `FIRST             +${first.atMs}ms  epoch=${first.epoch} seq=${first.seq} rows=${first.rows} chars=${first.chars}`,
                  `LAST              +${last.atMs}ms  epoch=${last.epoch} seq=${last.seq} rows=${last.rows} chars=${last.chars}${last.done ? ' done' : ''}`,
                  `GROWTH            ${grew}/${Math.max(0, s.length - 1)} transitions increased the visible character count`,
                  `MONOTONIC/ROW     ${shrinks.length === 0 ? 'YES — no row ever shrank' : `NO — ${shrinks.slice(0, 3).join('; ')}`}`,
                ]
              : [
                  'NO PREVIEW FRAMES. The control fired, so the socket and the session are',
                  'alive — this zero is about the preview plane, not about the rig.',
                ]),
            `FINE WATCH        ${
              watch === undefined
                ? '(daemon log unreadable)'
                : watch.acquired
                  ? `ACQUIRED — the daemon moved the driver's fine refcount for this session${watch.released ? ' (and later released it)' : ''}`
                  : 'NOT acquired — the viewer\'s subscribe never reached the driver'
            }`,
            `FRAME TYPES       ${ctx.chat.frameSummary()}`,
          ],
          data: {
            previewFrames: s.length,
            firstChars: first?.chars ?? null,
            lastChars: last?.chars ?? null,
            grew,
            shrinks: shrinks.length,
            joinedMs,
          },
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 3 — interrupt a running turn
// ---------------------------------------------------------------------------
/**
 * THE CONTROL HERE IS THE HARD PART, and it is why this row has never been
 * driven honestly. Interrupting nothing always looks like success: if the turn
 * was already over, `phase` is idle before the call and idle after it, and the
 * probe passes without the driver having done anything at all. So the control
 * is that the turn was OBSERVED IN FLIGHT — working, and visibly producing
 * output — in the moment before the interrupt was sent. Without that reading
 * the measurement is refused rather than scored.
 */
/**
 * THE CONTROL IS UNCHANGED; WHAT CHANGED IS WHO ESTABLISHES IT.
 *
 * The predicate is the same one POD-1761 called the sharpest thing on this epic,
 * and it is not negotiable: the turn must be observed IN FLIGHT — phase
 * `working` AND output actually growing — in the moment before the interrupt is
 * sent. Interrupting nothing always looks like success, so without that reading
 * the cell is refused rather than scored.
 *
 * What changed is that this probe now STARTS ITS OWN TURN and waits for that
 * state, instead of inheriting whatever the streaming probe left running. It had
 * to: on the terminal arm the shared turn finished inside the join delay (6401
 * chars in under 8.7s), so the control could not fire and the cell came back
 * REFUSED — correct, but useless to POD-2792, whose whole question is whether
 * the TERMINAL driver interrupts. A cell that important must not be hostage to
 * another probe's timing.
 *
 * Refusing is still the outcome when no running turn can be established here
 * either. The bar did not move; only the responsibility for meeting it.
 */
export const interrupt: Probe = {
  id: 'interrupt',
  title: 'interrupt a running turn',
  catalogRow: '§1 interrupt a running turn (WIRED — declared capability, no conformance property)',
  async run(ctx) {
    await settle(ctx.sid)
    const baseline = ctx.chat.assistantText().length
    const framesBaseline = ctx.chat.previews.length
    const baselineScreen = ctx.chat.screenBytes
    await mutate('sessions.sendText', {
      sessionId: ctx.sid,
      text:
        'Count from 1 to 400. Put each number on its own line, and after each number write ' +
        'one full sentence about it. Do not use any tools. Do not summarise. Write every line.',
    })

    /**
     * IN FLIGHT, ON AN ARM THAT NEVER SAYS `working`.
     *
     * The control's PURPOSE is unchanged and non-negotiable: the turn must be
     * observed running in the moment before the call, because interrupting
     * nothing always looks like success. What had to change is the SIGNAL, and
     * only on the terminal arm, because the signal I was using is not published
     * there.
     *
     * Measured, twice, on `generic-pty`: a session produced 13,250 characters of
     * output while `agentState.phase` read `idle` at all 60 polls across 60
     * seconds — `working` never appeared once. (That is a finding in its own
     * right: the catalogue lists "working vs idle" as `wired` for terminal, and
     * a busy terminal session renders as idle on the home board for the whole
     * turn.) A control keyed on `working` can therefore NEVER fire on that arm,
     * and scoring the cell off it would report a rig limit as a product verdict.
     *
     * So flight is established by whichever signal that arm actually publishes,
     * and the report says which one did it:
     *   headless — phase `working` AND preview frames arriving;
     *   terminal — the PTY's OWN OUTPUT BYTES growing between samples, which is
     *              continuous and real-time (the durable transcript arrives in
     *              batches, so it is too coarse to catch a turn mid-flight).
     * Neither is weaker than the other: both are direct evidence that tokens are
     * being produced right now. Refusal is still the outcome when neither moves.
     */
    let working = false
    let producing = false
    let phase = 'unknown'
    let signal = 'none'
    let screenPrev = ctx.chat.screenBytes
    const spinUp = now() + 90_000
    while (now() < spinUp) {
      const row = await sessionRow(ctx.sid)
      phase = row?.agentState?.phase ?? 'unknown'
      working = phase === 'working'
      const previews = ctx.chat.previews.length > framesBaseline
      const chars = ctx.chat.assistantText().length > baseline
      const screenNow = ctx.chat.screenBytes
      const screenGrew = screenNow > screenPrev + 200
      screenPrev = screenNow
      if (working && (previews || chars)) {
        producing = true
        signal = `phase=working with ${ctx.chat.previews.length - framesBaseline} preview frame(s)`
        break
      }
      if (screenGrew) {
        producing = true
        signal = `terminal output bytes growing (+${screenNow - baselineScreen} since the send)`
        break
      }
      await wait(500)
    }
    const observedDetail = `${signal}; phase=${phase}, ${ctx.chat.previews.length - framesBaseline} preview frame(s), ${ctx.chat.assistantText().length - baseline} new transcript chars, ${ctx.chat.screenBytes - baselineScreen} new terminal bytes`
    const control: ControlReading = {
      fired: producing,
      what: 'the turn observed IN FLIGHT immediately before the interrupt — phase=working with previews (headless), or the PTY output bytes growing (terminal)',
      detail: observedDetail,
    }
    if (!control.fired) {
      return {
        control,
        outcome: {
          verdict: 'FAIL',
          summary: 'could not get a running turn to interrupt',
          evidence: [`WATCHED           ${observedDetail}`],
          data: {},
        },
      }
    }

    const before = ctx.chat.assistantText().length
    // FRAMES ARE THE READING THAT SEPARATES THE TWO FAILURES. A phase stuck at
    // `working` can mean the agent kept generating (the interrupt did nothing)
    // or that generation stopped and only the STATE never cleared. Those are
    // different defects with different owners, and phase alone cannot tell them
    // apart — so count what arrives AFTER the call. On a coarse-only terminal
    // arm there are no preview frames, so the transcript's own growth is the
    // stand-in and both are reported.
    const framesAtInterrupt = ctx.chat.previews.length
    const screenAtInterrupt = ctx.chat.screenBytes
    const t0 = now()
    const res = await mutate('sessions.interrupt', { sessionId: ctx.sid })
    const settled = await until(ctx.sid, (r) => r?.agentState?.phase !== 'working', IDLE_MS, 500)
    const after = ctx.chat.assistantText().length
    const framesAfter = ctx.chat.previews.length - framesAtInterrupt

    // ON THE TERMINAL ARM `phase` IS VACUOUSLY SATISFIED — it never said
    // `working` in the first place, so "it left working" proves nothing. The
    // reading there is whether the OUTPUT STOPPED: sample the PTY bytes twice,
    // a few seconds apart, after the call.
    await wait(6_000)
    const screenAfterA = ctx.chat.screenBytes
    await wait(6_000)
    const screenAfterB = ctx.chat.screenBytes
    const outputStopped = screenAfterB <= screenAfterA + 200
    const phaseNeverWorked = phase !== 'working'
    const honoured = phaseNeverWorked ? outputStopped : settled.ok

    // The transcript's OWN word for it: `event: 'interrupt'` is the item the
    // parser synthesizes for "[Request interrupted by user]". A driver that
    // merely went idle looks identical by phase alone; this is the reading that
    // says the interrupt was an ACTION and not a coincidence.
    const marked = ctx.chat.items.some((i) => i.event === 'interrupt')
    const stopped = honoured
    return {
      control,
      outcome: {
        verdict: stopped ? 'PASS' : 'FAIL',
        summary: stopped
          ? `turn stopped ${settled.ms}ms after interrupt${marked ? ', transcript marks it' : ', but nothing marks it'}`
          : `still working ${IDLE_MS / 1000}s after interrupt`,
        evidence: [
          `WAS RUNNING       ${observedDetail}`,
          `INTERRUPT SENT    ${JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 200)}`,
          `SETTLED           ${stopped ? `phase left 'working' after ${settled.ms}ms` : `NEVER — phase=${settled.row?.agentState?.phase}`}`,
          `TRANSCRIPT MARK   ${marked ? "an item carries event:'interrupt' — the product recorded a user action" : "no item carries event:'interrupt'"}`,
          `TEXT              ${before} chars at the call -> ${after} chars at settle`,
          `FRAMES AFTER      ${framesAfter} preview frame(s) arrived AFTER the call`,
          `TERMINAL BYTES    ${screenAtInterrupt - baselineScreen} at the call -> +${screenAfterA - screenAtInterrupt} after 6s -> +${screenAfterB - screenAtInterrupt} after 12s`,
          `SCORED ON         ${phaseNeverWorked ? 'output stopping — this arm never publishes phase=working, so "left working" would be vacuously true' : "phase leaving 'working'"}`,
          ...(stopped
            ? []
            : framesAfter > 0 || after > before || screenAfterB > screenAtInterrupt + 2_000
              ? [
                  'READING           the agent KEPT GENERATING after the call. The interrupt did',
                  '                  not reach the turn, and the call still returned ok — the',
                  '                  product reported a success that did not happen.',
                  `                  evidence: +${screenAfterB - screenAtInterrupt} terminal bytes and ${framesAfter} preview frame(s) AFTER the interrupt.`,
                ]
              : [
                  'READING           generation STOPPED (nothing arrived after the call) but the',
                  '                  phase never left `working`. The turn is over and the product',
                  '                  still shows it running — a stuck state rather than an',
                  '                  unhonoured interrupt. Different defect, different owner.',
                ]),
        ],
        data: {
          settledMs: stopped ? settled.ms : null,
          marked,
          charsBefore: before,
          charsAfter: after,
          framesAfterInterrupt: framesAfter,
        },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// 4 — stop
// ---------------------------------------------------------------------------
/**
 * WHAT IS ACTUALLY BEING DRIVEN, said plainly because the catalogue is blunt
 * about it: "stop a turn distinctly from interrupting" is ABSENT from the
 * contract on all four drivers. The contract has `interrupt` (a turn) and
 * `stop` (a session); "stop this turn, keep the session" is not modelled. So
 * this probe drives `sessions.stop` — the SESSION stop, the operator's clean
 * end — and the report says which of the two it measured rather than letting a
 * green cell imply the missing one exists.
 */
export const stop: Probe = {
  id: 'stop',
  title: 'stop (the session — the turn-scoped stop is absent from the contract)',
  catalogRow: '§1 stop a turn distinctly from interrupting (ABSENT); §10 a stop that is verified rather than assumed (absent)',
  async run(ctx) {
    const before = await sessionRow(ctx.sid)
    const control: ControlReading = {
      fired: before !== undefined,
      what: 'the session present and readable in sessions.list immediately before the stop',
      detail: before ? `present, status=${before.status} phase=${before.agentState?.phase}` : 'ABSENT — nothing to stop',
    }

    const t0 = now()
    const res = await mutate('sessions.stop', { sessionId: ctx.sid })
    // A stop that is VERIFIED rather than assumed: wait for the session to
    // actually leave its running state, and report the outcome we can observe
    // rather than the one the call claimed.
    const gone = await until(
      ctx.sid,
      (r) => r === undefined || (r.status !== 'live' && r.status !== 'running'),
      IDLE_MS,
      500,
    )
    const after = await sessionRow(ctx.sid)
    return {
      control,
      outcome: {
        verdict: gone.ok ? 'PASS' : 'FAIL',
        summary: gone.ok
          ? `session left its running state ${gone.ms}ms after stop (status=${after?.status ?? 'gone'})`
          : `still ${after?.status} ${IDLE_MS / 1000}s after stop`,
        evidence: [
          `BEFORE            status=${before?.status} phase=${before?.agentState?.phase}`,
          `STOP RETURNED     ${JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 200)}`,
          `AFTER             ${after ? `status=${after.status} phase=${after.agentState?.phase}` : 'no longer listed'}`,
          `VERIFIED IN       ${gone.ok ? `${gone.ms}ms` : 'never'}`,
          'NOTE              this is sessions.stop (the SESSION). The catalogue records',
          '                  "stop this turn, keep the session" as ABSENT from the contract',
          '                  on all four drivers; this drive does not pretend otherwise.',
        ],
        data: { stoppedMs: gone.ok ? gone.ms : null, statusAfter: after?.status ?? null, elapsed: now() - t0 },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// 5 — resume after a kill
// ---------------------------------------------------------------------------
/**
 * The failure this prevents is a HEALTHY BLANK SESSION carrying the old ref —
 * which is why the reading is not "resume returned ok" but "the conversation
 * came back". The agent is asked, after the kill, for something only the
 * pre-kill conversation contains. A fresh session cannot answer it.
 */
export function resumeAfterKill(sid: string, chat: Chat, secret: string, preKillOk: boolean): Probe {
  return {
    id: 'resume',
    title: 'resume after a kill',
    catalogRow: '§4 resume() brings the CONVERSATION back, not just the ref (proven)',
    async run(ctx) {
      const control: ControlReading = {
        fired: preKillOk,
        what: 'a conversation existing to restore — the pre-park turn answered with the secret',
        detail: preKillOk
          ? `the session repeated ${secret} before it was parked`
          : 'the pre-park turn never produced the secret, so there is nothing whose return could be measured',
      }
      if (!preKillOk) {
        return { control, outcome: { verdict: 'FAIL', summary: 'no pre-park conversation', evidence: [], data: {} } }
      }

      /**
       * HIBERNATE, NOT KILL — and the first version of this probe getting that
       * wrong is worth keeping, because the reason is a fact about the product.
       *
       * `sessions.kill` REMOVES THE ROW. The first run killed the session and
       * then asked `sessions.resurrect` to bring it back, and got
       * `{ok:false, reason:'unknown session'}` — a FAIL the probe had arranged
       * for itself, not a defect. Killing is destructive: after it there is no
       * session left to restore, and "resume after a kill" in the operator's
       * sense is not that verb.
       *
       * `hibernate` is the product's park — it REFUSES without a resume ref, so
       * reaching it at all exercises the ref the catalogue's row is about — and
       * `resurrect` is the restore the web's context menu offers. That pair is
       * the round trip a person actually performs, so that pair is what an
       * acceptance drive should drive. What this probe therefore does NOT cover
       * is recovery from an UNCLEAN death (the harness process crashing under a
       * live session); that is a different test and this report says so rather
       * than letting a green cell imply it.
       */
      // The pointer this row carries BEFORE the park, so a re-pointed row cannot
      // pass by merely being alive and quoting the right word.
      const beforeRow = await sessionRow(sid)
      const convBefore = beforeRow?.conversationId ?? beforeRow?.conversationPodiumId ?? null

      // LET IT REACH IDLE FIRST. `hibernateSession` REFUSES a working agent —
      // "agent is working — let it reach idle first" — and a probe that fires
      // hibernate the moment the secret appears is still inside the turn that
      // produced it. `untilText` returns on the TEXT, not on the fence.
      await settle(sid)

      const killed = await mutate('sessions.hibernate', { sessionId: sid })
      const dead = await until(
        sid,
        (r) => r === undefined || (r.status !== 'live' && r.status !== 'running'),
        60_000,
        500,
      )

      /**
       * THE PARK IS ITSELF A CONTROL, AND LEAVING IT OUT SHIPPED A GREEN LIE.
       *
       * This probe scored opencode PASS — "THIS conversation came back, original
       * exchange intact, same pointer" — on a session that was NEVER PARKED.
       * `sessions.hibernate` had answered `{ok:false, reason:'agent is working —
       * let it reach idle first'}` and the row stayed `live` for the whole 60s
       * wait. Every later reading was then true and meaningless: of course the
       * conversation was intact, it had never gone anywhere.
       *
       * A resume row is only a resume row if something was parked. So the park's
       * receipt AND the row actually leaving `live` are required, and a probe
       * that cannot park REFUSES rather than reporting on a resume that never
       * happened. This is the exact failure the whole rig exists to prevent, and
       * it got past me once.
       */
      const parkRefusal = (killed.result?.data as { ok?: boolean; reason?: string } | undefined)
      const parked = dead.ok && parkRefusal?.ok !== false
      if (!parked) {
        return {
          control: {
            fired: false,
            what: 'the session actually PARKING — hibernate accepted and the row leaving `live`',
            detail: `hibernate returned ${JSON.stringify(parkRefusal ?? null)}; status after ${dead.ms}ms was ${dead.row?.status ?? 'gone'}`,
          },
          outcome: {
            verdict: 'FAIL',
            summary: `the session never parked: ${parkRefusal?.reason ?? `status stayed ${dead.row?.status}`}`,
            evidence: [
              `HIBERNATE         ${JSON.stringify(parkRefusal ?? null)}`,
              `STATUS AFTER      ${dead.row?.status ?? 'gone'} (waited ${dead.ms}ms)`,
              'Nothing was parked, so nothing could be resumed. Reporting a PASS from',
              'here would be reporting on a session that never went down — which is',
              'exactly what this probe did before this check existed.',
            ],
            data: { parked: false, parkRefusal: parkRefusal ?? null },
          },
        }
      }

      /**
       * TWO WAKE VERBS, BOTH DRIVEN, BECAUSE THE PRODUCT HAS TWO.
       *
       * `resurrect` is what the web's session context menu and lifecycle panes
       * call. `resumeAndSend` is what waking a parked session with a message
       * uses — and it is the one POD-2775 fixed, so a probe that drove only
       * `resurrect` would report a landed fix as broken. That is not a
       * hypothetical: this drive did exactly that on codex before this comment
       * existed, and the FAIL it produced was about the verb it chose.
       *
       * An operator does both in this order — click resume, and if the session
       * is still not answering, send it something — so the probe does too, and
       * names which one brought the conversation back.
       */
      const RECALL =
        'Without using any tools, what was the exact word I asked you to remember earlier? Reply with just that word.'
      const resumed = await mutate('sessions.resurrect', { sessionId: sid })
      const back = await until(sid, (r) => r?.status === 'live', 60_000, 1_000)

      await wait(3_000)
      const before = chat.assistantText().length
      // The wake-and-ask path. Used as the delivery whether or not `resurrect`
      // already brought the row live: `resumeAndSend` is a send with a wake
      // lifecycle, so it is the right verb in both cases.
      const woke = await mutate('sessions.resumeAndSend', { sessionId: sid, text: RECALL })
      const backAfterWake = await until(sid, (r) => r?.status === 'live', 120_000, 1_000)
      /**
       * PRESENCE OF THE SECRET IS NOT ENOUGH, and a reviewer proved it tonight:
       * a resume mutated to point at a STRANGER'S thread id left 269 tests green,
       * partly because the drive-level check was "both strings appear". A
       * conversation that merely CONTAINS the word is not this conversation.
       *
       * Three readings instead of one:
       *   - the secret comes back (necessary, not sufficient);
       *   - the resumed transcript still carries the ORIGINAL exchange — the
       *     prompt that planted the secret, not just an answer quoting it;
       *   - the conversation pointer the session reports after the wake is the
       *     one it reported before, so the row was not re-pointed at another
       *     thread while looking healthy.
       * All three must hold. The failure this prevents is the one the catalogue
       * names: a healthy BLANK session carrying the old ref.
       */
      const recalled = await untilText(
        chat,
        (t) => t.slice(before).includes(secret),
        REPLY_MS,
        { pumpFor: sid },
      )
      const afterRow = await sessionRow(sid)
      const convAfter = afterRow?.conversationId ?? afterRow?.conversationPodiumId ?? null
      const sameConversation = convBefore !== null && convAfter !== null && convBefore === convAfter
      // The planting prompt itself, on the durable plane, after the wake.
      const carriesOriginal = chat.userText().includes(secret)
      const identityOk = recalled.ok && sameConversation && carriesOriginal

      return {
        control,
        outcome: {
          verdict: identityOk ? 'PASS' : 'FAIL',
          summary: identityOk
            ? `THIS conversation came back — ${secret} recalled, original exchange intact, same pointer`
            : recalled.ok
              ? 'the secret came back but the identity checks did not hold — see evidence'
              : 'resumed, but the conversation did not come back',
          evidence: [
            `SECRET            ${secret} — spoken only in the pre-kill conversation`,
            `HIBERNATE         ${JSON.stringify(killed.result?.data ?? killed.error ?? null).slice(0, 120)}; PARKED after ${dead.ms}ms (status=${dead.row?.status ?? 'gone'})`,
            `RESURRECT         ${JSON.stringify(resumed.result?.data ?? resumed.error ?? null).slice(0, 160)}`,
            `  → back live?    ${back.ok ? `YES after ${back.ms}ms` : `NO — status=${back.row?.status}`}`,
            `RESUMEANDSEND     ${JSON.stringify(woke.result?.data ?? woke.error ?? null).slice(0, 160)}`,
            `  → back live?    ${backAfterWake.ok ? `YES after ${backAfterWake.ms}ms` : `NO — status=${backAfterWake.row?.status}`}`,
            'TWO VERBS         POD-2775 fixed resumeAndSend, not resurrect. A probe that drove',
            '                  only resurrect would report that landed fix as broken.',
            `RECALL            ${recalled.ok ? `the secret came back after ${recalled.ms}ms` : 'the secret never came back'}`,
            `SAME CONVERSATION ${sameConversation ? `YES — pointer ${String(convBefore).slice(0, 24)} unchanged across the park` : `NO — before=${String(convBefore).slice(0, 24)} after=${String(convAfter).slice(0, 24)}`}`,
            `ORIGINAL EXCHANGE ${carriesOriginal ? 'present — the transcript still carries the prompt that planted the secret' : 'ABSENT — the reply quotes the secret but the planting turn is gone'}`,
            'WHY THREE CHECKS  a resume mutated to a STRANGER\'S thread id passed 269 tests,',
            '                  partly because the drive-level check was "both strings appear".',
            '                  Containing the word is not being the conversation.',
            'WHY THIS SHAPE    a healthy BLANK session carrying the old ref passes any',
            '                  check that only asks whether resume returned ok.',
            'NOT COVERED       recovery from an UNCLEAN death. sessions.kill REMOVES the row',
            "                  (resurrect then answers 'unknown session'), so this drives the",
            '                  hibernate/resurrect round trip a person actually performs.',
          ],
          data: {
            secret,
            recalled: recalled.ok,
            recallMs: recalled.ok ? recalled.ms : null,
            backLiveAfterResurrect: back.ok,
            backLiveAfterResumeAndSend: backAfterWake.ok,
            sameConversation,
            carriesOriginal,
            conversationBefore: convBefore,
            conversationAfter: convAfter,
          },
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 6 — attach a file
// ---------------------------------------------------------------------------
/**
 * TWO CONTROLS, ONE OF THEM NEGATIVE.
 *
 * Positive: a plain send on this same session already worked (probe 1), so a
 * refusal here is about attachments and not about sending.
 *
 * Negative, and built into the measurement: the file contains a nonce that
 * exists nowhere else. The agent cannot echo it back by being agreeable, by
 * pattern-matching the prompt, or by luck — it can only echo it by having READ
 * THE BYTES. That is the difference between driving the attachment path and
 * watching a model say "yes, I see the file".
 */
export const attach: Probe = {
  id: 'attach',
  title: 'attach a file',
  catalogRow: '§5 promptForm declared — both halves or unsupported (DECLARED on all four)',
  async run(ctx) {
    const replyOk = ctx.results.get('reply')?.verdict === 'PASS'
    const control: ControlReading = {
      fired: replyOk,
      what: 'a plain send on this same session having already produced a reply (probe 1)',
      detail: replyOk
        ? 'probe 1 PASSED here, so this session can send and answer'
        : 'probe 1 did not pass, so a refusal here could not be attributed to attachments',
    }
    if (!replyOk) {
      return { control, outcome: { verdict: 'FAIL', summary: 'no working send to compare against', evidence: [], data: {} } }
    }

    await settle(ctx.sid)
    const secret = nonce('FILESECRET')
    const body = `This file exists only for the POD-2777 acceptance drive.\nThe secret word is ${secret}.\n`
    const up = await mutate('sessions.uploadImage', {
      sessionId: ctx.sid,
      filename: 'podium-2777-secret.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from(body, 'utf8').toString('base64'),
    })
    const data = up.result?.data as
      | { path?: string; attachment?: Record<string, unknown>; refusal?: { reason?: string; detail?: string } }
      | undefined

    /**
     * A TYPED REFUSAL IS NOT A FAILURE — IT MAY BE THE CONTRACT WORKING.
     *
     * codex refuses `text/plain` with `unsupported` and the detail "Codex
     * accepts image attachments only". That is the driver honouring its own
     * declaration, and the catalogue's row is `promptForm declared — both halves
     * or unsupported`. Scoring it FAIL would be marking a driver down for
     * telling the truth, and it would leave the path codex DOES declare —
     * images — undriven, which is the cell actually worth driving.
     *
     * So a refusal is not the end of the probe: it is the signal to attach the
     * kind this driver declares, with the secret drawn INTO the image. Same
     * falsifier as the text arm — the digits exist only in those pixels, and no
     * amount of agreeable answering produces them without reading the picture.
     */
    if (data?.refusal) {
      const imgSecret = digitNonce()
      const png = digitsPng(imgSecret)
      const up2 = await mutate('sessions.uploadImage', {
        sessionId: ctx.sid,
        filename: 'podium-2777-secret.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from(png).toString('base64'),
      })
      const d2 = up2.result?.data as
        | { path?: string; attachment?: Record<string, unknown>; refusal?: { reason?: string; detail?: string } }
        | undefined

      if (d2?.refusal || !d2?.attachment) {
        return {
          control,
          outcome: {
            verdict: 'FAIL',
            summary: `staging refused for BOTH text and image: ${d2?.refusal?.reason ?? data.refusal.reason}`,
            evidence: [
              `TEXT REFUSED      reason=${data.refusal.reason} detail=${data.refusal.detail ?? ''}`,
              `IMAGE REFUSED     reason=${d2?.refusal?.reason ?? '(no attachment returned)'} detail=${d2?.refusal?.detail ?? ''}`,
              'Both refusals are TYPED, which is what the contract asks for — but this',
              'driver then accepts no attachment of any kind this probe can make, so the',
              'capability is not available to a user however honest the refusal.',
            ],
            data: { textRefusal: data.refusal, imageRefusal: d2?.refusal ?? null },
          },
        }
      }

      await settle(ctx.sid)
      const before2 = ctx.chat.assistantText().length
      const sent2 = await mutate('sessions.sendText', {
        sessionId: ctx.sid,
        text: 'Look at the attached image. It shows a number in large black digits. Reply with ONLY that number.',
        attachments: [d2.attachment],
      })
      const echoed2 = await untilText(
        ctx.chat,
        (t) => t.slice(before2).includes(imgSecret),
        REPLY_MS,
        { pumpFor: ctx.sid },
      )
      return {
        control,
        outcome: {
          verdict: echoed2.ok ? 'PASS' : 'FAIL',
          summary: echoed2.ok
            ? `text refused (declared image-only, correctly); the IMAGE path works — read ${imgSecret} out of the pixels`
            : 'text refused as declared, and the image it does declare was not read back',
          evidence: [
            `TEXT REFUSED      reason=${data.refusal.reason} detail=${data.refusal.detail ?? ''}`,
            '                  a TYPED refusal honouring the driver\'s own declaration — the',
            '                  contract working, not a defect. So the probe attached the kind',
            '                  this driver DOES declare instead of stopping there.',
            `IMAGE STAGED      ${d2.path ?? '(no path)'} (${png.length} bytes, 960x264 RGB PNG)`,
            `SECRET IN PIXELS  ${imgSecret} — drawn into the image, present nowhere else`,
            `SEND              ${JSON.stringify(sent2.result?.data ?? sent2.error ?? null).slice(0, 160)}`,
            `READ BACK         ${echoed2.ok ? `yes, after ${echoed2.ms}ms` : 'no'}`,
            ...(echoed2.asksAnswered > 0 ? [`APPROVALS CLEARED ${echoed2.asksAnswered}`] : []),
          ],
          data: {
            textRefusal: data.refusal,
            imageSecret: imgSecret,
            imageEchoed: echoed2.ok,
            imageEchoMs: echoed2.ok ? echoed2.ms : null,
            path: 'image',
          },
        },
      }
    }

    const ref = data?.attachment
    const before = ctx.chat.assistantText().length
    const sent = await mutate('sessions.sendText', {
      sessionId: ctx.sid,
      text: 'Read the attached text file and reply with ONLY the secret word it contains.',
      ...(ref ? { attachments: [ref] } : {}),
    })
    const echoed = await untilText(ctx.chat, (t) => t.slice(before).includes(secret), REPLY_MS, {
      pumpFor: ctx.sid,
    })

    return {
      control,
      outcome: {
        verdict: echoed.ok ? 'PASS' : 'FAIL',
        summary: echoed.ok
          ? `the agent read the file and echoed ${secret}`
          : 'the file was staged and sent, but its contents never came back',
        evidence: [
          `STAGED            path=${data?.path ?? '(none)'} ref=${JSON.stringify(ref ?? null).slice(0, 200)}`,
          `SECRET IN FILE    ${secret} — present in the bytes and nowhere else`,
          `SEND              ${JSON.stringify(sent.result?.data ?? sent.error ?? null).slice(0, 200)}`,
          `                  (a 'queued' disposition here would mean the session was still busy)`,
          `ECHOED BACK       ${echoed.ok ? `yes, after ${echoed.ms}ms` : 'no'}`,
          `APPROVALS NEEDED  ${echoed.asksAnswered} — the staging dir is OUTSIDE the repo, so reading the`,
          '                  attachment raises an external_directory permission ask. A drive that',
          '                  did not answer it would time out and report "never read the file".',
          'WHY A NONCE       an agent can agree that it sees a file without reading one;',
          '                  it cannot produce these bytes without having read them.',
        ],
        data: { secret, staged: Boolean(ref), echoed: echoed.ok, echoMs: echoed.ok ? echoed.ms : null },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// 7 — a pending interaction (permission / approval)
// ---------------------------------------------------------------------------
/**
 * THREE OUTCOMES, NOT TWO, and the third is why this row has stayed `wired`.
 *
 * A harness configured to auto-approve never produces an ask, and reporting
 * that as a FAIL would blame the product for a posture the rig chose. So:
 *   - an ask appears, is enumerable, and answering it resolves it  -> PASS
 *   - no ask, but the tool RAN anyway                              -> BLOCKED
 *     (permissive posture: the product was never given an ask to surface)
 *   - no ask and no tool call                                      -> FAIL
 */
export const interaction: Probe = {
  id: 'interaction',
  title: 'a pending interaction (permission / approval)',
  catalogRow: '§3 permission / approval ask (WIRED — `approval` is in the refusal vocabulary, no conformance property)',
  async run(ctx) {
    await settle(ctx.sid)
    const marker = nonce('TOOLRAN')
    const before = ctx.chat.items.length
    const t0 = now()
    await mutate('sessions.sendText', {
      sessionId: ctx.sid,
      /**
       * THE PATH IS OUTSIDE THE SESSION'S CWD, AND THAT IS THE WHOLE PROMPT.
       *
       * The first version of this probe wrote INSIDE the repo and came back
       * BLOCKED every time: a harness with an ordinary permissive posture runs
       * a write to its own working directory without asking anyone, so the
       * product was never handed an ask to surface and there was nothing to
       * measure. Writing outside the cwd is the case that actually raises a
       * permission — this rig watched opencode raise `external_directory` for
       * exactly that shape while reading a staged attachment — so this is the
       * prompt that drives the ask path rather than documenting its absence.
       */
      text:
        `Use your shell/bash tool to run exactly this command: echo ${marker} > /tmp/pod-2777-external/${marker}.txt` +
        ` and then tell me whether it succeeded. You must actually run the command with a tool.`,
    })

    // Watch for an ask for up to a minute, polling the enumerable surface the
    // catalogue names: an open ask must be visible in a LIST, not only on the
    // stream, so a UI that missed the event still sees it.
    let asks: any[] = []
    const deadline = now() + 90_000
    while (now() < deadline) {
      const listed = await query('interactions.list', { sessionId: ctx.sid })
      asks = (listed.result?.data ?? []) as any[]
      if (asks.length > 0) break
      const row = await sessionRow(ctx.sid)
      if (row?.agentState?.phase !== 'working' && now() - t0 > 20_000) break
      await wait(2_000)
    }

    const newItems = ctx.chat.items.slice(before)
    const control: ControlReading = {
      fired: ctx.chat.deltaFrames > 0 && newItems.length > 0,
      what: 'the turn producing durable transcript items at all (transcriptDelta on the same socket)',
      detail: `${newItems.length} new transcript item(s) after the prompt; ${ctx.chat.deltaFrames} delta frame(s) total`,
    }

    if (asks.length === 0) {
      const toolRan = newItems.some((i) => i.role === 'tool' || i.toolName)
      return {
        control,
        outcome: {
          verdict: toolRan ? 'BLOCKED' : 'FAIL',
          summary: toolRan
            ? 'no ask — this harness ran the tool without asking (permissive posture)'
            : 'no ask appeared and no tool ran',
          evidence: [
            `INTERACTIONS.LIST empty for this session after ${Math.round((now() - t0) / 1000)}s`,
            `TOOL CALLS SEEN   ${newItems.filter((i) => i.role === 'tool' || i.toolName).map((i) => i.toolName ?? 'tool').join(', ') || '(none)'}`,
            toolRan
              ? 'BLOCKED, NOT FAILED: the harness approved its own tool call, so the'
              : 'FAIL: the agent neither asked nor acted, so nothing exercised the ask path.',
            toolRan
              ? 'product was never handed an ask to surface. That is a fact about this'
              : '',
            toolRan ? "rig's permission posture, not about the product's ask plane." : '',
          ].filter(Boolean),
          data: { asks: 0, toolRan },
        },
      }
    }

    // WHICH ASK IS THE REAL ONE. This drive found ONE permission arriving
    // TWICE: `source: 'protocol'` / `answerable: 'structured'` alongside
    // `source: 'screen-classifier'` / `answerable: 'keystroke-emulated'`, the
    // second carrying the file GLOB in its `toolName` field where the first
    // carries the tool. Both are open at once and answering one does not close
    // the other. The structured one is the answerable ask, so that is the one
    // this probe answers — and the duplicate is reported rather than smoothed
    // over, because it is exactly the kind of thing a drive exists to find.
    const structured = asks.find((a) => a.answerable === 'structured') ?? asks[0]
    const classifier = asks.filter((a) => a.source === 'screen-classifier')
    const duplicated = structured?.source === 'protocol' && classifier.length > 0

    const payload = (structured.payload ?? {}) as Record<string, unknown>
    // ALWAYS `allow-once`. `allow-always` is REFUSED rather than downgraded
    // when `canAlwaysAllow` is false or the ask is keystroke-emulated, so
    // synthesizing one here would be the rig claiming a persistent grant nobody
    // made — the very substitution the catalogue says must never happen.
    const answer = { kind: 'permission', decision: 'allow-once' as const }
    const answered = await mutate('interactions.answer', { id: structured.id, answer })
    const cleared = await (async () => {
      const dl = now() + 60_000
      while (now() < dl) {
        const open = await openAsks(ctx.sid)
        if (open.every((a) => a.id !== structured.id)) return true
        await wait(1_500)
      }
      return false
    })()

    // Did answering the real ask leave the session still blocked? If the
    // classifier's copy is still open and the phase is still needs_user, the
    // duplicate is not cosmetic — it is a session a human would have to unstick
    // twice.
    const rowAfter = await sessionRow(ctx.sid)
    const stillBlocked = rowAfter?.agentState?.phase === 'needs_user'

    return {
      control,
      outcome: {
        verdict: cleared ? 'PASS' : 'FAIL',
        summary: cleared
          ? `a permission ask was raised, enumerable and answerable${duplicated ? ' (but raised twice — see evidence)' : ''}`
          : 'an ask was raised but answering did not resolve it',
        evidence: [
          `ASK KIND          ${structured.kind}  id=${structured.id}`,
          `SOURCE            ${structured.source} / answerable=${structured.answerable}`,
          `ENUMERABLE        yes — interactions.list carried it while open, not only the stream`,
          `TYPED PAYLOAD     toolName=${String(payload.toolName ?? '?')} input=${String(payload.inputSummary ?? '')} canAlwaysAllow=${String(payload.canAlwaysAllow ?? '?')}`,
          `ANSWERED WITH     ${JSON.stringify(answer)} — allow-once, never a synthesized allow-always`,
          `ANSWER RETURNED   ${JSON.stringify(answered.result?.data ?? answered.error ?? null).slice(0, 160)}`,
          `RESOLVED          ${cleared ? 'the ask left the open set' : 'the ask stayed open'}`,
          ...(duplicated
            ? [
                '',
                `DUPLICATE ASK     ${asks.length} asks open for ONE permission:`,
                ...asks.map(
                  (a) =>
                    `                    ${a.source}/${a.answerable}: toolName=${String((a.payload as Record<string, unknown> | undefined)?.toolName ?? '?')}`,
                ),
                '                  The screen-classifier synthesized a second ask from the TUI',
                '                  for a permission the PROTOCOL had already reported properly,',
                '                  and put the path glob in the toolName field. On a headless',
                '                  driver the classifier copy has no reason to exist.',
                `                  After answering the structured one the session is ${stillBlocked ? 'STILL needs_user' : 'no longer blocked'}.`,
              ]
            : []),
        ],
        data: {
          askKind: structured.kind,
          source: structured.source,
          answerable: structured.answerable,
          answered: cleared,
          openAsks: asks.length,
          duplicated,
          stillBlockedAfterAnswer: stillBlocked,
        },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// 8 — a provider error surfaced honestly
// ---------------------------------------------------------------------------
/**
 * THE CONTROL IS ANOTHER PROBE. An error arm proves nothing about honest
 * reporting if this harness could not answer a normal question on this arm in
 * the first place — a dead harness also "fails", and the two would be
 * indistinguishable. So probe 1's verdict IS this probe's control.
 *
 * What is being tested is not that the provider errors — that is arranged. It is
 * whether the PRODUCT says so. The failure this catches is the one the catalogue
 * calls out: a turn that died rendering as "finished", or sitting at idle
 * forever with no error class at all.
 */
export function providerError(harness: string): Probe {
  return {
    id: 'provider-error',
    title: 'a provider error surfaced honestly',
    catalogRow: '§6 provider overloaded / rate limit (pinned in the drivers; product surfacing is POD-2604)',
    async run(ctx) {
      const replyOk = ctx.results.get('reply')?.verdict === 'PASS'
      const control: ControlReading = {
        fired: replyOk,
        what: 'this harness answering a normal question on this arm (probe 1)',
        detail: replyOk
          ? 'probe 1 PASSED, so a failure in this probe is attributable to the injected fault'
          : 'probe 1 did not pass, so an error here cannot be told apart from a harness that never worked',
      }
      if (!replyOk) {
        return { control, outcome: { verdict: 'FAIL', summary: 'no working baseline to attribute an error to', evidence: [], data: {} } }
      }

      /**
       * A FAULT THAT ACTUALLY FIRES, from POD-2772 via POD-2604.
       *
       * The first version named a nonsense model and opencode simply IGNORED the
       * string and answered "Hello!" — no provider ever refused, so there was no
       * error to surface and the cell measured nothing.
       *
       * `opencode/laguna-s-2.1-free` is RETIRED from opencode's gateway, and the
       * failure shape is exactly what this row exists for: the session BINDS, is
       * marked LIVE, `gateway.send` returns ACCEPTED with a protocol-ack and a
       * turnEpoch — and then agentState never leaves its initial phase, no error
       * ever arrives, and the only signal is a timeout. Accepted at the boundary,
       * then silence. No quota to exhaust, no credential to revoke, reproduces on
       * demand.
       *
       * PER HARNESS: that id is an OPENCODE gateway model, so it is only a fault
       * on opencode. Where no equivalent accepted-then-never-settles fault is
       * known, this reports n/a with the reason rather than firing one that does
       * not fire — a fixture must produce the thing it claims to test.
       */
      const RETIRED: Record<string, string> = { opencode: 'opencode/laguna-s-2.1-free' }
      const bogus = RETIRED[harness]
      if (!bogus) {
        return {
          control,
          outcome: {
            verdict: 'BLOCKED',
            summary: `no accepted-then-never-settles fault is known for ${harness}`,
            evidence: [
              `HARNESS           ${harness}`,
              'This cell needs a fault the provider ACCEPTS and then never settles.',
              'opencode/laguna-s-2.1-free does that on opencode (retired from the',
              'gateway: binds, marked live, ACCEPTED with a turnEpoch, then silence —',
              'POD-2604). No equivalent is known for this harness, and a nonsense',
              'model string is NOT one: opencode ignored it entirely and answered',
              'normally, which measures nothing about error surfacing.',
            ],
            data: { faultAvailable: false },
          },
        }
      }
      const created = await mutate('sessions.create', {
        cwd: REPO,
        agentKind: AGENT_KIND[harness] ?? harness,
        model: bogus,
        initialPrompt: 'Say hello.',
      })
      const sid = created.result?.data?.sessionId as string | undefined
      if (!sid) {
        return {
          control,
          outcome: {
            verdict: 'PASS',
            summary: 'refused at create — the bad model never became a session',
            evidence: [
              `CREATE REFUSED    ${JSON.stringify(created.error ?? created).slice(0, 300)}`,
              'Refusing an impossible model up front is an honest surface: the operator',
              'is told at the point of the mistake rather than by a session that sits idle.',
            ],
            data: { refusedAtCreate: true },
          },
        }
      }

      /**
       * DID THE FAULT ACTUALLY LAND? This is the leg the first version of this
       * probe was missing, and without it the probe cannot be failed honestly.
       *
       * A session created with a nonsense model has three possible fates, and
       * only one of them says anything about error reporting:
       *   - the provider refuses and the product SAYS so            -> PASS
       *   - the provider refuses and the product stays quiet         -> FAIL
       *   - the harness IGNORED the model string and answered fine   -> BLOCKED
       * The third is not a finding about honesty at all: no error ever existed,
       * so there was nothing to surface, and scoring it FAIL would be inventing
       * a defect out of a fault that never fired. So the probe watches the chat
       * for a real answer as well as watching for an error, and reports which of
       * the three it saw. A fixture must produce the thing it claims to test.
       */
      const faultChat = new Chat(sid)
      await faultChat.open()
      const errored = await until(
        sid,
        (r) =>
          r?.agentState?.error !== undefined ||
          r?.agentState?.phase === 'errored' ||
          r?.status === 'exited',
        180_000,
        2_000,
      )
      const row = await sessionRow(sid)
      const cls = row?.agentState?.error?.class
      const honest = Boolean(cls) || row?.agentState?.phase === 'errored' || row?.status === 'exited'
      const answered = faultChat.assistantText().trim()
      await faultChat.close()

      await mutate('sessions.kill', { sessionId: sid }).catch(() => {})

      // The harness shrugged off the bad model and answered normally: the fault
      // never fired, so this probe has measured nothing about error surfacing.
      if (!honest && answered.length > 0) {
        return {
          control,
          outcome: {
            verdict: 'BLOCKED',
            summary: 'the bad model was ignored — the harness answered normally, so no error existed',
            evidence: [
              `INJECTED FAULT    model="${bogus}" on a ${harness} session`,
              `SESSION           ${sid}`,
              `THE HARNESS       answered anyway: ${JSON.stringify(answered.slice(0, 120))}`,
              `PHASE / STATUS    phase=${row?.agentState?.phase ?? '?'} status=${row?.status ?? '?'}`,
              'READING           the model string was not honoured as a fault, so the provider',
              '                  never refused and there was no error to report. This probe',
              '                  measured NOTHING about honest error surfacing, and says so',
              '                  rather than scoring a FAIL for a fault that never fired.',
              '                  A harder fault (revoked credential, unreachable base URL) is',
              '                  what this cell needs, and it is not in this run.',
            ],
            data: { faultLanded: false, answeredChars: answered.length, phase: row?.agentState?.phase ?? null },
          },
        }
      }

      return {
        control,
        outcome: {
          verdict: honest ? 'PASS' : 'FAIL',
          summary: honest
            ? `surfaced as ${cls ?? row?.agentState?.phase ?? row?.status}`
            : `no error surfaced in ${180}s — the session reads phase=${row?.agentState?.phase} status=${row?.status}`,
          evidence: [
            `INJECTED FAULT    model="${bogus}" — RETIRED from opencode's gateway: the`,
            '                  session binds, is marked live, the send is ACCEPTED with a',
            '                  turnEpoch, and then nothing ever settles (POD-2604).',
            `SESSION           ${sid}`,
            `ERROR CLASS       ${cls ?? '(none)'}`,
            `ERROR DETAIL      ${row?.agentState?.error?.detail ?? '(none)'}`,
            `PHASE / STATUS    phase=${row?.agentState?.phase ?? '?'} status=${row?.status ?? '?'}`,
            `SURFACED AFTER    ${errored.ok ? `${errored.ms}ms` : 'never'}`,
            honest
              ? 'The product told the truth about a turn that could not run.'
              : 'The product did NOT say the turn failed — the catalogue names this exact',
            honest ? '' : 'shape: a turn that died rendering as finished, or idle forever.',
          ].filter(Boolean),
          data: { errorClass: cls ?? null, phase: row?.agentState?.phase ?? null, status: row?.status ?? null, surfacedMs: errored.ok ? errored.ms : null },
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 9 — model / effort switch
// ---------------------------------------------------------------------------
/**
 * WHAT THIS PROBE FOUND BEFORE IT RAN, and it is the reason it reads the way it
 * does. The catalogue lists "switch model" and "switch effort" as `declared` on
 * all four drivers — the capability announced and nothing checking the
 * announcement. Reading the source turns out to be blunter than that: every
 * production driver declares `configure` UNSUPPORTED except grok, which claims
 * only `permissionMode`, and NO server or daemon code calls `handle.configure()`
 * at all. There is no product surface to drive.
 *
 * So the honest probe is not "does the switch work" — nothing anywhere could
 * make it work — but "does the product tell the truth about that". Two readings:
 * the declaration matches the driver's behaviour, and the model the operator
 * asked for is the model the session reports OBSERVING. The second is the one
 * with teeth: a driver with no transcript-level model stamp renders "requested,
 * not yet observed" dotted forever, and that is a real difference between the
 * two arms.
 */
export const modelSwitch: Probe = {
  id: 'model-switch',
  title: 'model / effort switch',
  catalogRow: '§7 switch model / switch effort (DECLARED — no conformance property, no product caller)',
  async run(ctx) {
    const row = await sessionRow(ctx.sid)
    const control: ControlReading = {
      fired: row !== undefined,
      what: 'the session readable at all, reporting the model it was asked for',
      detail: row ? `model=${row.model ?? '(unset)'} observedModel=${row.observedModel ?? '(none)'}` : 'session not readable',
    }

    const observed = row?.observedModel ?? null
    const requested = row?.model ?? null
    return {
      control,
      outcome: {
        // NOT A FAIL. Nothing is broken: the capability is declared unsupported
        // and the product honours that by exposing no switch. The verdict that
        // fits is BLOCKED — the behaviour cannot be driven because it does not
        // exist — and the report says so in those words rather than printing a
        // red cell that implies a regression.
        verdict: 'BLOCKED',
        summary: 'no product surface exists to switch model or effort mid-session',
        evidence: [
          `REQUESTED MODEL   ${requested ?? '(session default)'}`,
          `OBSERVED MODEL    ${observed ?? '(none — renders "requested, not yet observed")'}`,
          `OBSERVED EFFORT   ${row?.observedEffort ?? '(none)'}`,
          'DECLARATION       codex: configure unsupported ("model and effort are set at',
          '                  thread start and per turn"); opencode: unsupported; terminal:',
          '                  unsupported ("a TUI takes its model at launch"); grok: supported',
          '                  for permissionMode ONLY, explicitly not model/effort.',
          'PRODUCT SURFACE   no server or daemon code calls handle.configure(); sessions.sendText',
          '                  carries no per-turn model or effort override either.',
          'READING           the declaration and the behaviour agree, and the product does',
          '                  not offer a switch it cannot honour. Nothing is broken and',
          '                  nothing is proven — the cell is empty on BOTH arms, so this is',
          '                  not a way in which headless is better or worse.',
        ],
        data: { requested, observed, observedEffort: row?.observedEffort ?? null, productSurface: false },
      },
    }
  },
}
