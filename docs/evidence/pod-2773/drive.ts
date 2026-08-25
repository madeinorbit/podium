/**
 * POD-2773 — does the reply BUILD in a chat opened during a turn already running?
 *
 *   bash docs/evidence/pod-2773/drive-up.sh
 *   bash docs/evidence/pod-2773/drive-verify.sh HEAD
 *   bun  docs/evidence/pod-2773/drive.ts opencode|grok
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING IS THE EXPERIMENT
 * ---------------------------------------------------------------------------
 *
 * The session is started with an initial prompt, so it is busy from its first
 * moment; the chat is opened SEVERAL SECONDS LATER, into a turn already in
 * flight. That is the normal case for anyone who starts a session and then looks
 * at it, and it is exactly the case that used to show nothing at all: reaching
 * the fine watch was a reconnect, a reconnect abandons an in-flight turn, so the
 * upgrade could only land in an idle gap and the turn a viewer walked in on was
 * always the turn that streamed nothing.
 *
 * A drive that opens the chat FIRST and then sends measures the easy ordering
 * and would have passed on the broken build. So the join delay is not a
 * convenience, it is the whole point, and it is reported in the output.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL, AND WHY NOTHING PRINTS WITHOUT IT
 * ---------------------------------------------------------------------------
 *
 * A dying rig produces a perfect false negative: no frames, no error, and a
 * clean-looking zero that reads as "the feature does not work". It has happened
 * on this epic. So this drive samples something that MUST arrive whether or not
 * streaming works — `transcriptDelta`, the durable transcript plane, on the SAME
 * websocket, established by the SAME `transcriptSubscribe`. If the control did
 * not fire, no preview count is printed at all, including zero, and the process
 * exits non-zero.
 *
 * The two are genuinely independent: the durable plane is fed by the transcript
 * tailer and does not care what watch level the driver holds, while the preview
 * plane exists only above a fine watch. They share only the socket and the
 * subscription — which is precisely what a control needs to share.
 *
 * THE SECOND CONTROL IS THE BINDING. An isolated agent home with no credential
 * for the harness does not fail loudly: the server driver declines, the session
 * degrades to a generic PTY, and a PTY declares watchLevels ['coarse'] and so
 * produces exactly zero fragments. That is indistinguishable from a broken
 * feature by frame count alone, so the bound `driverId` is read off the session
 * meta and reported beside every number.
 */

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19837'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2773'
const REPO = `${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2773'}/repo`

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

const harness = (process.argv[2] ?? 'opencode') as 'opencode' | 'grok'
/** How long the turn runs before the chat opens. 8.5s is the delay the codex
 *  drive used, kept identical so the arms are comparable across harnesses. */
const JOIN_DELAY_MS = Number(process.env.P2773_JOIN_MS ?? 8_500)
/** How long to sample after joining. Generous: a refusal to wait is a zero. */
const SAMPLE_MS = Number(process.env.P2773_SAMPLE_MS ?? 90_000)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

// A prompt that produces a LOT of text and needs no tool, so nothing pauses for
// an approval and the reply is long enough that its growth is measurable rather
// than inferred from two samples.
const PROMPT =
  'Count from 1 to 40. Put each number on its own line, and after each number ' +
  'write one short sentence about that number. Do not use any tools. Just write.'

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

const trpc = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { result?: { data?: unknown }; error?: unknown }
}

// --- start a session that is BUSY FROM ITS FIRST MOMENT ---------------------
console.log(`[${harness}] creating a session with an initial prompt…`)
const created = (await trpc('sessions.create', {
  cwd: REPO,
  agentKind: harness,
  initialPrompt: PROMPT,
})) as { result?: { data?: { sessionId?: string } }; error?: unknown }
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
console.log(`[${harness}] session ${sid} started; letting the turn run for ${JOIN_DELAY_MS}ms BEFORE opening the chat`)

const startedAt = now()
await wait(JOIN_DELAY_MS)

// --- join the running turn --------------------------------------------------
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/client`, {
  headers: { cookie },
} as never)
await new Promise((res, rej) => {
  ws.onopen = res as () => void
  ws.onerror = rej as () => void
})
const send = (o: unknown) => ws.send(JSON.stringify(o))

interface PreviewItem {
  kind: 'text' | 'running'
  itemId: string
  text?: string
  item?: unknown
}
interface Sample {
  atMs: number
  turnEpoch: number
  seq: number
  chars: number
  rows: number
  done: boolean
  perItem: Record<string, number>
}

/** Stamped BEFORE the message handler is installed: the handler reads it, and
 *  a frame can arrive on an open socket before the next statement runs. */
let joinedAt = now()

const samples: Sample[] = []
let controlDeltas = 0
let controlItems = 0
let controlFirstAtMs: number | undefined
let driverId: string | undefined
let driverFamily: string | undefined
let sessionStatus: string | undefined
const rawTypes = new Map<string, number>()

const charsOf = (items: PreviewItem[]): { chars: number; perItem: Record<string, number> } => {
  const perItem: Record<string, number> = {}
  let chars = 0
  for (const it of items) {
    // A `running` row is a whole item that exists and has not finished — it has
    // no growing text of its own, so it counts as a row and not as characters.
    const n = it.kind === 'text' ? (it.text ?? '').length : 0
    perItem[it.itemId] = n
    chars += n
  }
  return { chars, perItem }
}

ws.onmessage = (e: MessageEvent) => {
  const m = JSON.parse(String(e.data)) as Record<string, unknown>
  const type = String(m.type ?? '')
  rawTypes.set(type, (rawTypes.get(type) ?? 0) + 1)

  if (type === 'turnPreview' && m.sessionId === sid) {
    const items = (m.items ?? []) as PreviewItem[]
    const { chars, perItem } = charsOf(items)
    samples.push({
      atMs: now() - joinedAt,
      turnEpoch: Number(m.turnEpoch ?? 0),
      seq: Number(m.seq ?? 0),
      chars,
      rows: items.length,
      done: m.done === true,
      perItem,
    })
    return
  }
  if (type === 'transcriptDelta' && m.sessionId === sid) {
    controlDeltas += 1
    controlItems += ((m.items ?? []) as unknown[]).length
    controlFirstAtMs ??= now() - joinedAt
    return
  }
  // Session meta arrives under a few frame names depending on the path; take
  // driverId from whichever carries it, for this session.
  const meta = (m.session ?? m.meta ?? m) as Record<string, unknown> | undefined
  if (meta && meta.sessionId === sid) {
    if (typeof meta.driverId === 'string') driverId = meta.driverId
    if (typeof meta.driverFamily === 'string') driverFamily = meta.driverFamily
    if (typeof meta.status === 'string') sessionStatus = meta.status
  }
  const list = (m.sessions ?? []) as Record<string, unknown>[]
  if (Array.isArray(list)) {
    for (const s of list) {
      if (s?.sessionId !== sid) continue
      if (typeof s.driverId === 'string') driverId = s.driverId
      if (typeof s.driverFamily === 'string') driverFamily = s.driverFamily
      if (typeof s.status === 'string') sessionStatus = s.status
    }
  }
}

joinedAt = now()
send({ type: 'attach', sessionId: sid })
// THE SUBSCRIPTION IS THE TRIGGER. `SessionTerminal.reconcileWatchLevel` keys
// the fine watch off the TRANSCRIPT SUBSCRIBER COUNT, so this one frame both
// asks for the durable control stream and raises the watch level that the
// preview plane needs. One subscription, two planes: that is what makes the
// control share everything with the measurement except the thing under test.
send({ type: 'transcriptSubscribe', sessionId: sid })
console.log(`[${harness}] chat opened ${now() - startedAt}ms into the turn; sampling for up to ${SAMPLE_MS}ms…`)

// Sample until the turn fences or the deadline passes.
const deadline = now() + SAMPLE_MS
while (now() < deadline) {
  await wait(500)
  if (samples.some((s) => s.done)) break
}
send({ type: 'transcriptUnsubscribe', sessionId: sid })
send({ type: 'detach', sessionId: sid })
await wait(300)
ws.close()

// --- the binding, read off the API as well as the socket --------------------
// BACKSTOP, not the source of truth: the socket's session meta is what a
// browser reads, so that is what the report leans on. This only fills a gap,
// and a router that does not expose this shape must not take the drive down
// after the measurement has already been taken.
try {
  const detail = (await trpc('sessions.get', { sessionId: sid })) as {
    result?: { data?: { driverId?: string | null; status?: string } }
  }
  driverId ??= detail.result?.data?.driverId ?? undefined
  sessionStatus ??= detail.result?.data?.status
} catch {
  /* the socket already answered, or nothing can */
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
const line = (s: string) => console.log(s)
line('')
line('='.repeat(72))
line(`HARNESS            ${harness}`)
line(`SESSION            ${sid}`)
line(`ARM                CONTRACT=${process.env.PODIUM_RUNTIME_CONTRACT ?? '(unset)'} STREAMING=${process.env.PODIUM_CHAT_STREAMING ?? '(unset)'}`)
line(`BOUND DRIVER       ${driverId ?? '(unknown)'}${driverFamily ? ` (family ${driverFamily})` : ''}`)
line(`JOINED             ${joinedAt - startedAt}ms into a turn already running`)
line(`SESSION STATUS     ${sessionStatus ?? '(unknown)'}`)
line('-'.repeat(72))

// THE CONTROL GATE. Nothing about the preview plane is printed above this line
// failing, because a rig that is not delivering the durable plane either is a
// rig whose zero means nothing.
line(`CONTROL  transcriptDelta frames=${controlDeltas} items=${controlItems}` +
  (controlFirstAtMs === undefined ? '' : ` first at +${controlFirstAtMs}ms`))
if (controlDeltas === 0) {
  line('')
  line('CONTROL DID NOT FIRE — the durable transcript plane delivered nothing on')
  line('this socket, so this rig cannot distinguish "no preview frames" from "no')
  line('frames at all". REFUSING to report a preview count, including zero.')
  line(`frame types seen: ${[...rawTypes.entries()].map(([t, n]) => `${t}=${n}`).join(' ') || '(none)'}`)
  line('='.repeat(72))
  process.exit(2)
}
line('CONTROL FIRED — the socket is alive and the session is producing durable')
line('transcript items, so a preview count from it is a real measurement.')
line('-'.repeat(72))

const first = samples[0]
const last = samples.at(-1)
line(`PREVIEW  frames=${samples.length}`)
if (samples.length > 0 && first && last) {
  line(`         first  +${first.atMs}ms  epoch=${first.turnEpoch} seq=${first.seq} rows=${first.rows} chars=${first.chars}`)
  line(`         last   +${last.atMs}ms  epoch=${last.turnEpoch} seq=${last.seq} rows=${last.rows} chars=${last.chars}${last.done ? ' done' : ''}`)

  // MONOTONIC, MEASURED PER ROW AND NOT ON THE TOTAL. Every frame carries the
  // WHOLE preview, and a row is RETIRED the moment the durable item carrying
  // its identity lands on the transcript plane — so the total legitimately
  // drops at a retirement and a naive check on the total would call a correct
  // stream non-monotonic. The claim worth making is per-row: no row's text ever
  // shrinks while it is on screen.
  const seenPerItem = new Map<string, number>()
  const shrinks: string[] = []
  for (const s of samples) {
    for (const [id, n] of Object.entries(s.perItem)) {
      const prev = seenPerItem.get(id)
      if (prev !== undefined && n < prev) shrinks.push(`${id} ${prev}->${n} at +${s.atMs}ms`)
      seenPerItem.set(id, n)
    }
  }
  const grew = samples.filter((s, i) => i > 0 && s.chars > (samples[i - 1]?.chars ?? 0)).length
  line(`         growth: ${grew}/${Math.max(0, samples.length - 1)} transitions increased the visible character count`)
  line(`         monotonic per row: ${shrinks.length === 0 ? 'YES — no row ever shrank' : `NO — ${shrinks.length} shrink(s): ${shrinks.slice(0, 3).join('; ')}`}`)
  line(`         distinct rows seen: ${seenPerItem.size}`)

  // The shape of the build, sampled so a reader can see it rather than take the
  // summary's word for it.
  const step = Math.max(1, Math.floor(samples.length / 10))
  line('         series (ms, chars):')
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i]
    if (s) line(`           +${String(s.atMs).padStart(6)}ms  ${String(s.chars).padStart(6)} chars  ${s.rows} row(s)`)
  }
  if (last && samples.indexOf(last) % step !== 0) {
    line(`           +${String(last.atMs).padStart(6)}ms  ${String(last.chars).padStart(6)} chars  ${last.rows} row(s)`)
  }
} else {
  line('         NO PREVIEW FRAMES. The control fired, so the socket and the')
  line('         session are alive — this zero is about the preview plane.')
  line(`         frame types seen: ${[...rawTypes.entries()].map(([t, n]) => `${t}=${n}`).join(' ')}`)
}
line('='.repeat(72))

// Machine-readable, so the two arms can be diffed without re-reading prose.
console.log(
  `JSON ${JSON.stringify({
    harness,
    sessionId: sid,
    contract: process.env.PODIUM_RUNTIME_CONTRACT,
    streaming: process.env.PODIUM_CHAT_STREAMING,
    driverId: driverId ?? null,
    joinedAtMs: joinedAt - startedAt,
    controlDeltas,
    controlItems,
    previewFrames: samples.length,
    firstChars: first?.chars ?? null,
    lastChars: last?.chars ?? null,
    done: last?.done ?? false,
  })}`,
)
