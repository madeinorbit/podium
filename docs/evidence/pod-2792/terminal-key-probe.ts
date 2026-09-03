/**
 * WHAT ACTUALLY CANCELS A TERMINAL opencode TURN — four keys, one turn, one
 * measurement each.
 *
 *   bun docs/evidence/pod-2792/terminal-key-probe.ts
 *
 * POD-2777's drive measured the terminal arm and found the stop does not land:
 * `{ok:true}` and +72 KB of PTY output after the call. That says the OUTCOME is
 * wrong; it does not say WHY, and the two candidate whys need different fixes.
 * Either the bytes never reach the PTY (a delivery bug, ours), or they reach it
 * and the TUI does not act on them (the wrong key, or the right key in a shape
 * this TUI cannot read — also ours, but a different line of code).
 *
 * So this sends four things at the SAME running turn and measures each the same
 * way:
 *
 *   1. `sessions.interrupt` — the product's own path, end to end
 *   2. a raw `\x1b` typed as client terminal input — the same BYTE by a
 *      different route, which separates "our interrupt path is broken" from
 *      "this key does nothing here"
 *   3. `\x1b\x1b` — a second Escape after the first, for a parser that holds a
 *      lone ESC waiting to see whether a CSI sequence follows it
 *   4. `\x03` — Ctrl-C, the key the manifest gives codex
 *
 * THE CONTROL is POD-2777's, in the form that arm publishes: the PTY's own
 * output bytes growing before each round. It is re-established BEFORE EVERY
 * ROUND, not once at the start — a key that landed would end the turn, and every
 * later round would then be interrupting nothing and passing for it.
 *
 * AND EVERY ROUND STARTS ITS OWN TURN, which a first version did not, and the
 * omission produced a result I nearly believed: rounds 2 and 4 read as STOPPED
 * while 1 and 3 read as still generating, and the difference looked like the
 * product's path being broken where a plain keypress was not. It was not that.
 * A TUI REDRAW IS ALSO OUTPUT BYTES — cancelling a turn repaints a long
 * transcript, tens of KB of it — so a round that inherited the previous round's
 * session could fire its control on the repaint of an already-finished turn and
 * then "stop" something that had already stopped. That is the exact trap the
 * control exists to prevent, reached through the one signal that arm publishes.
 * So: settle, send, and require growth in TWO consecutive samples before any key
 * is sent.
 *
 * THE COUNTER IS CUMULATIVE AND THAT IS LOAD-BEARING (POD-1761's warning). A
 * ring buffer over the visible screen makes CONTINUING output read as STOPPED,
 * because a wrap produces a negative delta and "did not grow" is satisfied by
 * it. `Chat.screenBytes` sums every frame's length and never shrinks; a round
 * that reports "stopped" here means no bytes arrived, not that a buffer wrapped.
 */
import { AGENT_KIND, Chat, login, mutate, now, primeTerminalTui, REPO, sessionRow, settle, wait } from './rig.js'

const harness = process.argv[2] ?? 'opencode'
const WATCH_MS = Number(process.env.P2792_WATCH_MS ?? 12_000)

await login()
const created = await mutate('sessions.create', { cwd: REPO, agentKind: AGENT_KIND[harness] ?? harness })
const sid = created.result?.data?.sessionId as string
console.log('==============================================================================')
console.log(`TERMINAL KEY PROBE  harness=${harness}  arm=terminal`)
console.log('==============================================================================')
console.log(`session ${sid}`)
await wait(25_000)
const row0 = await sessionRow(sid)
console.log(`BOUND DRIVER        ${row0?.driverId} (family ${row0?.driverFamily})`)
if (row0?.driverFamily !== 'terminal') {
  console.log('REFUSING — this probe is about the PTY path and this session did not bind it.')
  process.exit(4)
}

const chat = new Chat(sid)
await chat.open()
const primed = await primeTerminalTui(chat, sid)
console.log(`TUI PRIMING         ${primed.length > 0 ? primed.join('; ') : 'nothing to clear'}`)
await settle(sid)

const LONG =
  'Count from 1 to 400. Put each number on its own line, and after each number write ' +
  'one full sentence about it. Do not use any tools. Do not summarise. Write every line.'

/**
 * Wait until the PTY is visibly producing — TWO consecutive seconds of it.
 *
 * One sample is not enough on this signal. A repaint is a burst; generation is
 * sustained. Requiring the second sample is what separates them, and it is why
 * the threshold is per-sample rather than cumulative.
 */
async function inFlight(budgetMs = 120_000): Promise<string | undefined> {
  let prev = chat.screenBytes
  let run = 0
  let first = 0
  const deadline = now() + budgetMs
  while (now() < deadline) {
    await wait(1_000)
    const nowBytes = chat.screenBytes
    const grew = nowBytes - prev
    prev = nowBytes
    if (grew > 1_000) {
      if (run === 0) first = grew
      run += 1
      if (run >= 2)
        return `PTY output growing for 2 consecutive seconds (+${first} then +${grew} bytes, ${nowBytes} cumulative)`
    } else run = 0
  }
  return undefined
}

type Round = { name: string; send: () => Promise<string> }
/** A/B, ALTERNATING. Two trials of each, interleaved rather than blocked, so a
 *  drift in the box between the first half and the second cannot masquerade as a
 *  difference between the two paths. */
const rounds: Round[] = [
  {
    name: "sessions.interrupt (the product's own path)",
    send: async () => {
      const res = await mutate('sessions.interrupt', { sessionId: sid })
      return JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 160)
    },
  },
  {
    name: 'a raw ESC typed as client terminal input',
    send: async () => {
      chat.send({ type: 'input', sessionId: sid, data: Buffer.from('\x1b').toString('base64'), inputOrigin: 'human' })
      return 'client input frame: 1 byte (0x1b)'
    },
  },
  {
    name: 'ESC ESC — a second Escape behind the first',
    send: async () => {
      chat.send({ type: 'input', sessionId: sid, data: Buffer.from('\x1b\x1b').toString('base64'), inputOrigin: 'human' })
      return 'client input frame: 2 bytes (0x1b 0x1b)'
    },
  },
  {
    name: 'Ctrl-C — the key the manifest gives codex',
    send: async () => {
      chat.send({ type: 'input', sessionId: sid, data: Buffer.from('\x03').toString('base64'), inputOrigin: 'human' })
      return 'client input frame: 1 byte (0x03)'
    },
  },
  {
    name: "sessions.interrupt again — the A/B's second trial",
    send: async () => {
      const res = await mutate('sessions.interrupt', { sessionId: sid })
      return JSON.stringify(res.result?.data ?? res.error ?? null).slice(0, 160)
    },
  },
  {
    name: 'a raw ESC again — the A/B\'s second trial',
    send: async () => {
      chat.send({ type: 'input', sessionId: sid, data: Buffer.from('\x1b').toString('base64'), inputOrigin: 'human' })
      return 'client input frame: 1 byte (0x1b)'
    },
  },
]

for (const round of rounds) {
  console.log('')
  console.log(`── ${round.name}`)
  // ALWAYS A FRESH TURN. Never inherit the previous round's — see the header.
  await settle(sid)
  await mutate('sessions.sendText', { sessionId: sid, text: LONG })
  const control = await inFlight()
  if (!control) {
    console.log('   REFUSED — no running turn to interrupt; this round measures nothing.')
    continue
  }
  console.log(`   control: FIRED — ${control}`)
  const at = chat.screenBytes
  const sent = await round.send()
  console.log(`   SENT              ${sent}`)
  const marks: string[] = []
  for (let i = 1; i <= WATCH_MS / 2_000; i++) {
    await wait(2_000)
    marks.push(`+${i * 2}s ${chat.screenBytes - at}`)
  }
  const grew = chat.screenBytes - at
  const row = await sessionRow(sid)
  console.log(`   PTY BYTES AFTER   ${marks.join('  ')}   (cumulative counter, never shrinks)`)
  console.log(`   PHASE             ${row?.agentState?.phase}`)
  console.log(
    `   READING           ${grew > 2_000 ? `the turn KEPT GENERATING — ${grew} bytes after the key` : grew === 0 ? 'output STOPPED DEAD — nothing arrived after the key' : `output nearly stopped — ${grew} bytes, likely the tail already in flight`}`,
  )
}

console.log('')
console.log(`SCREEN TAIL         ${JSON.stringify(chat.screenTail(300))}`)
await chat.close()
await mutate('sessions.kill', { sessionId: sid })
