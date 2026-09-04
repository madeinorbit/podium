/**
 * POD-2777 — the shared rig the nine probes run on.
 *
 * Split from drive.ts so a probe reads as the experiment it is rather than as
 * plumbing, and so the ONE rule this drive exists to enforce lives in exactly
 * one place: `Probe.control` is not optional, and `score()` refuses a probe
 * whose control did not fire.
 */

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'REFUSED'

export interface ProbeOutcome {
  verdict: Verdict
  /** One line the table can carry. */
  summary: string
  /** Lines printed under the row; the evidence a reader checks the verdict against. */
  evidence: string[]
  /** Machine-readable, so arms can be diffed without re-reading prose. */
  data?: Record<string, unknown>
}

/**
 * THE POSITIVE CONTROL, AND WHY IT IS A REQUIRED FIELD RATHER THAN A HABIT.
 *
 * A dying rig produces a perfect false negative: no frames, no error, and a
 * clean-looking zero that reads as "the feature does not work". It has happened
 * on this epic twice, and both times the number was believed. So every probe
 * declares a signal that MUST arrive whether or not the behaviour under test
 * works, and `score()` below turns a missing control into REFUSED — never into
 * a FAIL, and never into a PASS.
 *
 * The two must be genuinely independent, which in practice means the control
 * shares the socket, the session and the subscription with the measurement, and
 * shares nothing else. The commonest shape here is OUR OWN SENT MESSAGE landing
 * as a durable transcript item: it is written by the transcript tailer whatever
 * the agent does next, so it separates "the agent did not answer" from "nothing
 * in this rig is alive".
 */
export interface ControlReading {
  fired: boolean
  /** What was watched, in words a reader can check. */
  what: string
  /** What arrived, or did not. */
  detail: string
}

export interface ProbeResult extends ProbeOutcome {
  id: string
  title: string
  /** The driver-capability-catalogue row this probe drives. */
  catalogRow: string
  control: ControlReading
  ms: number
}

/**
 * Turn a measured outcome into a scored one.
 *
 * A probe never returns its own verdict past this gate: if the control did not
 * fire the verdict becomes REFUSED whatever the probe thought, because a
 * measurement taken on a rig that cannot be shown to be alive is not a
 * measurement. This is the function the whole drive is built to protect.
 */
export function score(outcome: ProbeOutcome, control: ControlReading): ProbeOutcome {
  if (control.fired) return outcome
  return {
    verdict: 'REFUSED',
    summary: 'control did not fire — refusing to report this measurement',
    evidence: [
      `CONTROL WATCHED   ${control.what}`,
      `CONTROL SAW       ${control.detail}`,
      'The signal that must arrive whether or not this behaviour works did not',
      'arrive, so a result here cannot be told apart from a dead rig. The',
      "probe's own reading was: " + `${outcome.verdict} — ${outcome.summary}`,
      'REFUSING to report it, including as a failure.',
      // THE PROBE'S OWN EVIDENCE IS KEPT, not discarded. A refusal that throws
      // the diagnostic away tells you only that something was withheld; these
      // lines are how you find out WHY — the last TUI screen, the frame types
      // seen, what the send returned. Withholding the VERDICT is the point;
      // withholding the evidence just makes the refusal useless.
      ...(outcome.evidence.length > 0
        ? ['', '--- what the probe saw anyway (diagnostic, not a result) ---', ...outcome.evidence]
        : []),
    ],
    data: { ...(outcome.data ?? {}), refusedProbeVerdict: outcome.verdict },
  }
}

// ---------------------------------------------------------------------------
// the instance
// ---------------------------------------------------------------------------

export const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
export const PORT = process.env.PODIUM_PORT ?? '19847'
export const BASE = `http://${HOST}:${PORT}`
export const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2777'
export const DRIVE_BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2777'
export const REPO = process.env.PODIUM_PROBE_REPO ?? `${DRIVE_BASE}/repo`

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

/**
 * THE HARNESS NAME AN OPERATOR TYPES vs THE `AgentKind` THE WIRE TAKES.
 * `claude` is `claude-code` on the wire; the other three are spelled the same.
 * Kept as a map rather than a special case at each call site, because a session
 * created with an unparseable agentKind fails at create and would read as "the
 * harness could not start" — a false negative wearing the right clothes.
 */
export const AGENT_KIND: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const now = () => Date.now()
export const nonce = (tag: string) =>
  `${tag}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

let cookie = ''
export async function login(): Promise<void> {
  const hostSession = process.env.PODIUM_SESSION_TOKEN?.trim()
  if (hostSession) {
    cookie = `podium_session=${hostSession}`
    return
  }
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
}

export async function mutate(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as any
}

/** tRPC QUERIES ARE GET with the input in the query string: posting to one
 *  answers METHOD_NOT_SUPPORTED, which is a 405 and not the data. */
export async function query(path: string, input: unknown = {}): Promise<any> {
  const res = await fetch(
    `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    { headers: { cookie } },
  )
  return (await res.json()) as any
}

export interface SessionRow {
  sessionId: string
  agentKind?: string
  cwd?: string
  driverId?: string | null
  requestedDriverId?: string | null
  driverFamily?: string | null
  status?: string
  model?: string | null
  effort?: string | null
  requestedModel?: string | null
  requestedEffort?: string | null
  observedModel?: string | null
  observedEffort?: string | null
  configureFields?: string[]
  machineId?: string
  /** The durable conversation pointer. Read across a park/resume so a row that
   *  was re-pointed at another thread cannot pass for the same conversation. */
  conversationId?: string | null
  conversationPodiumId?: string | null
  resume?: { kind?: string; value?: string } | null
  agentState?: { phase?: string; error?: { class?: string; detail?: string } }
}

export async function sessionRow(sid: string): Promise<SessionRow | undefined> {
  const body = await query('sessions.list', {})
  return (body.result?.data ?? []).find((s: SessionRow) => s.sessionId === sid)
}

// ---------------------------------------------------------------------------
// one session, one socket
// ---------------------------------------------------------------------------

export interface TranscriptItemLite {
  id: string
  role: string
  text: string
  event?: string
  toolName?: string
  /**
   * A TOOL CALL AND ITS RESULT ARE ONE ITEM, NOT TWO.
   *
   * These three fields were missing from this type, and their absence produced a
   * false FAIL on row A5. The row asks whether "tool calls are paired to
   * results", and the probe looked for a FOLLOWING item with role
   * `tool_result` — a shape this transcript does not use. The real shape carries
   * the call and its output on the SAME item:
   *
   *   { id: 'exec-6712…', role: 'tool', text: '', toolName: 'Bash',
   *     toolInput: "/bin/bash -lc 'echo SHAPE-0DN8QS'",
   *     toolResult: 'SHAPE-0DN8QS\n',
   *     toolUseId: 'exec-6712…', toolPaths: ['/tmp/pod-2777/repo'] }
   *
   * `text` is empty on such an item, so a pairing check written against `text`
   * reports every tool call unpaired. Declared here rather than cast at the one
   * call site, so the next probe reads the shape off the type instead of
   * guessing it again.
   */
  toolInput?: string
  toolResult?: string
  toolUseId?: string
  toolPaths?: string[]
  tags?: { kind: string; label?: string }[]
}

/**
 * A session with its chat open — the same two frames the browser sends.
 *
 * THE SUBSCRIPTION IS THE TRIGGER. `SessionTerminal.reconcileWatchLevel` keys
 * the fine watch off the TRANSCRIPT SUBSCRIBER COUNT, so `transcriptSubscribe`
 * both asks for the durable control stream and raises the watch level the
 * preview plane needs. One subscription, two planes: that is what makes the
 * control share everything with the measurement except the thing under test.
 */
export class Chat {
  readonly items: TranscriptItemLite[] = []
  readonly previews: {
    atMs: number
    chars: number
    rows: number
    seq: number
    epoch: number
    done: boolean
    perItem: Record<string, number>
  }[] = []
  readonly frameTypes = new Map<string, number>()
  /** The TERMINAL's own bytes. On a PTY arm the transcript plane can be empty
   *  while the screen is full — of a modal nobody cleared. Capturing it turns a
   *  refusal from "nothing happened" into a diagnosis. */
  screen = ''
  /**
   * TOTAL PTY bytes ever received — monotonic, and separate from `screen` for a
   * reason that cost a wrong verdict. `screen` is a ring: it truncates past
   * 200KB so a long turn cannot exhaust memory. Measuring "did output stop" as a
   * DIFFERENCE IN `screen.length` therefore reads NEGATIVE once truncation
   * starts, and a negative delta satisfies "did not grow" — so a turn that was
   * still streaming scored as one that had stopped. This counter never shrinks,
   * so a difference in it means what it says.
   */
  screenBytes = 0
  deltaFrames = 0
  /**
   * The server's OWN answer to the attach, kept whole.
   *
   * `outputSeen` on this frame is the durable output counter the catalogue
   * (driver-capability-catalog.md:278) names as the signal without which
   * "attached but silent" cannot be told from "lost the replay window". A probe
   * that counts only the bytes IT saw is reimplementing a worse version of a
   * number the product already computes and sends — and would report a terminal
   * that has genuinely never printed and a terminal whose replay window aged out
   * in exactly the same words.
   */
  attached?: Record<string, unknown>
  /**
   * Every frame that mentions a queue position, kept whole.
   *
   * Row A1b asks for "queued WITH POSITION". `sessions.sendText` narrows its
   * return to four pinned keys (`command-plane.ts:459`) and position is not one
   * of them — but the product does compute one (`runtime-gateway.ts:49`, 1-based
   * and read off the real queue depth) and does emit it on the message-receipt
   * path. So before concluding a chat caller cannot see a position, every frame
   * on the chat socket is searched for one. Concluding an absence from the ONE
   * surface I happened to read would be exactly the "grep | head lies" mistake.
   */
  readonly positionFrames: Record<string, unknown>[] = []
  firstDeltaAtMs?: number
  openedAt = 0
  private ws?: WebSocket

  constructor(readonly sid: string) {}

  /**
   * @param mode  If given, ALSO declare this session visible+focused in that
   *   view — the `viewState` frame the browser sends and this rig did not.
   *
   * WHY THIS EXISTS, AND WHY IT DEFAULTS TO OMITTED.
   *
   * `attach` + `transcriptSubscribe` are what a browser sends to start
   * receiving, but they are not everything it sends. `viewState`
   * (`client-control.ts:215`) carries `visible`, `focused` and per-session
   * `modes`, and the server keys `reconcileActiveRenderer` and
   * `reconcileGeometry` off it — so a client that never sends one is attached
   * but is not, as far as the server is concerned, LOOKING at anything.
   *
   * Measuring the native view without it would ask the product for a terminal
   * nobody said they had open, and then report the silence as a product
   * defect. That is a rig bug wearing a finding's clothes, and this drive has
   * already caught two of its relatives.
   *
   * DEFAULT IS OMITTED so the nine chat-plane probes keep sending exactly the
   * frames they sent when their results were recorded; adding a frame to all of
   * them would silently make old and new numbers incomparable. The row that
   * needs the native view asks for it explicitly.
   */
  async open(mode?: 'native' | 'chat'): Promise<void> {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/client`, {
      headers: { cookie },
    } as never)
    await new Promise((res, rej) => {
      ws.onopen = res as () => void
      ws.onerror = rej as () => void
    })
    this.ws = ws
    // Stamped BEFORE the handler is installed: a frame can arrive on an open
    // socket before the next statement runs.
    this.openedAt = now()
    ws.onmessage = (e: MessageEvent) => this.onFrame(String(e.data))
    this.openedAt = now()
    this.send({ type: 'attach', sessionId: this.sid })
    this.send({ type: 'transcriptSubscribe', sessionId: this.sid })
    if (mode) {
      this.send({
        type: 'viewState',
        visible: [this.sid],
        focused: this.sid,
        modes: { [this.sid]: mode },
      })
    }
  }
  mode(mode: 'chat' | 'native'): void {
    this.send({ type: 'viewState', visible: [this.sid], focused: this.sid, modes: { [this.sid]: mode } })
    if (mode === 'native') this.send({ type: 'attach', sessionId: this.sid })
  }


  private onFrame(raw: string): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(m.type ?? '')
    this.frameTypes.set(type, (this.frameTypes.get(type) ?? 0) + 1)
    if (/"(position|queuePosition|queueDepth)"\s*:/.test(raw)) this.positionFrames.push(m)

    if (type === 'transcriptDelta' && m.sessionId === this.sid) {
      this.deltaFrames += 1
      this.firstDeltaAtMs ??= now() - this.openedAt
      // `reset` replaces the buffer: the tailer switched files, which is what a
      // resume into a fresh transcript looks like. Honouring it keeps a
      // post-resume read from carrying pre-kill items it no longer owns.
      if (m.reset === true) this.items.length = 0
      /**
       * ITEMS ARE UPSERTED BY ID, NOT APPENDED — and appending was wrong.
       *
       * A transcript item can be re-sent as it is refined. opencode streams a
       * tool call twice under ONE id: first `toolInput: "{}"`, then
       * `toolInput: "echo SHAPE-…"`. Appending both made one tool call read as
       * TWO, which is how row A5 on opencode reported "2 call(s)" and scored
       * itself FAIL for a pairing that had never been broken — and it would
       * silently inflate every item count this rig takes, on every cell.
       *
       * The later copy wins: it is the same item, further along. Order is kept
       * by replacing in place rather than moving the item to the end, so a
       * refinement cannot reorder a transcript.
       */
      for (const it of (m.items ?? []) as TranscriptItemLite[]) {
        const at = this.items.findIndex((prev) => prev.id === it.id)
        if (at >= 0) this.items[at] = it
        else this.items.push(it)
      }
      return
    }
    if (type === 'attached' && m.sessionId === this.sid) {
      this.attached = m
      /**
       * A NON-RESUMED ATTACH MEANS "REBUILD YOUR SCREEN", NOT "APPEND TO IT".
       *
       * The server replays its whole output log after every `attached`
       * (terminal.ts:268). This buffer only ever appended, so each re-attach
       * CONCATENATED another full copy — and row A6b, whose subject is
       * scrollback corruption across view switches, read marker counts of
       * 2 → 6 → 6 → 10 and line counts of 20 → 34 → 34 → 48. That looks exactly
       * like POD-2761 ("the new interface paints into the old one's
       * scrollback") and I was one step from filing it as a regression. It was
       * this class doing the duplicating.
       *
       * A real client renders frames into a terminal emulator; a replay rebuilds
       * the screen rather than being pasted onto the end of it. `resumed` is the
       * server's own word for which of the two this is — it is true only when
       * the client asked to catch up from a cursor and the log could serve it.
       *
       * The transcript side has always honoured this (`m.reset === true` clears
       * `items`). The terminal side never did, and the asymmetry is what hid it:
       * one plane was accounted correctly and the other silently accumulated.
       */
      if (m.resumed !== true) {
        this.screen = ''
      }
      return
    }
    if (type === 'outputFrame' && m.sessionId === this.sid && typeof m.data === 'string') {
      const bytes = Buffer.from(m.data, 'base64').toString('binary')
      this.screenBytes += bytes.length
      this.screen += bytes
      if (this.screen.length > 200_000) this.screen = this.screen.slice(-100_000)
      return
    }
    if (type === 'turnPreview' && m.sessionId === this.sid) {
      const rows = (m.items ?? []) as { kind: string; itemId: string; text?: string }[]
      const perItem: Record<string, number> = {}
      let chars = 0
      for (const r of rows) {
        // A `running` row is a whole item that exists and has not finished — it
        // has no growing text of its own, so it counts as a row, not characters.
        const n = r.kind === 'text' ? (r.text ?? '').length : 0
        perItem[r.itemId] = n
        chars += n
      }
      this.previews.push({
        atMs: now() - this.openedAt,
        chars,
        rows: rows.length,
        seq: Number(m.seq ?? 0),
        epoch: Number(m.turnEpoch ?? 0),
        done: m.done === true,
        perItem,
      })
    }
  }

  send(o: unknown): void {
    this.ws?.send(JSON.stringify(o))
  }

  /** Everything the assistant has said on the durable plane, joined. */
  assistantText(): string {
    return this.items
      .filter((i) => i.role === 'assistant')
      .map((i) => i.text ?? '')
      .join('\n')
  }

  userText(): string {
    return this.items
      .filter((i) => i.role === 'user')
      .map((i) => i.text ?? '')
      .join('\n')
  }

  /** The tail of the terminal screen, control codes stripped, for evidence. */
  screenTail(n = 300): string {
    // eslint-disable-next-line no-control-regex
    const plain = this.screen
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/[^\x20-\x7e\n]/g, '')
    return plain
      .replace(/\n{2,}/g, '\n')
      .trim()
      .slice(-n)
  }

  frameSummary(): string {
    return (
      [...this.frameTypes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(' ') || '(none)'
    )
  }

  async close(): Promise<void> {
    this.send({ type: 'transcriptUnsubscribe', sessionId: this.sid })
    this.send({ type: 'detach', sessionId: this.sid })
    await wait(250)
    this.ws?.close()
  }
}

// ---------------------------------------------------------------------------
// pending asks — answering the ones that are in the way
// ---------------------------------------------------------------------------

export interface AskRow {
  id: string
  kind: string
  sessionId: string
  source?: string
  answerable?: string
  status?: string
  payload?: Record<string, unknown>
}

export async function openAsks(sid: string): Promise<AskRow[]> {
  const body = await query('interactions.list', { sessionId: sid })
  return (body.result?.data ?? []) as AskRow[]
}

/**
 * Approve one ask with a decision it actually offers.
 *
 * `allow-always` is REFUSED rather than downgraded when `canAlwaysAllow` is
 * false or the ask is keystroke-emulated, so this always sends `allow-once` —
 * the decision every permission ask offers — instead of synthesizing a
 * persistent grant nobody made. That is the same rule the catalogue records for
 * the drivers, and a rig that broke it would be teaching the product a lie.
 */
export async function approveAsk(a: AskRow): Promise<{ ok: boolean; error?: string }> {
  const answer =
    a.kind === 'permission'
      ? { kind: 'permission', decision: 'allow-once' }
      : { kind: a.kind, decision: 'allow-once' }
  const res = await mutate('interactions.answer', { id: a.id, answer })
  if (res.error) return { ok: false, error: JSON.stringify(res.error).slice(0, 200) }
  return { ok: true }
}

export interface PumpReading {
  answered: number
  refused: { id: string; source?: string; answerable?: string; reason: string }[]
  seen: AskRow[]
  /** Asks raised for the same tool from two different sources at once. */
  duplicatePairs: number
}

/**
 * Clear the asks standing between a probe and its answer.
 *
 * WHY A PROBE ANSWERS AT ALL. The first run of this drive hung here: opencode
 * asked to read outside its cwd (the attachment staging dir IS outside the
 * repo), the probe waited blindly for a reply that could not come, and 180s of
 * timeout would have been reported as "the file was never read". A person at
 * the keyboard clicks Allow; a drive that does not is measuring its own
 * impatience. The interaction probe deliberately does NOT pump — there the ask
 * is the measurement.
 */
export async function pumpAsks(sid: string): Promise<PumpReading> {
  const seen = await openAsks(sid)
  const refused: PumpReading['refused'] = []
  let answered = 0
  for (const a of seen) {
    const r = await approveAsk(a)
    if (r.ok) answered += 1
    else
      refused.push({ id: a.id, source: a.source, answerable: a.answerable, reason: r.error ?? '?' })
  }
  // The duplicate shape this drive found: ONE permission surfacing twice, once
  // `source: 'protocol'` / `answerable: 'structured'` and once
  // `source: 'screen-classifier'` / `answerable: 'keystroke-emulated'`.
  const bySource = new Map<string, number>()
  for (const a of seen) bySource.set(a.source ?? '?', (bySource.get(a.source ?? '?') ?? 0) + 1)
  const duplicatePairs = Math.min(
    bySource.get('protocol') ?? 0,
    bySource.get('screen-classifier') ?? 0,
  )
  return { answered, refused, seen, duplicatePairs }
}

/**
 * Clear the first-run modal a fresh TUI opens on, exactly as a person would.
 *
 * REUSED FROM POD-2761, WHICH NAMED THE FAILURE: the daemon installs codex hooks
 * into the isolated CODEX_HOME, and a home that has never seen them opens the
 * TUI on "Hooks need review — 6 hooks are new or changed" instead of on the
 * conversation. A person clears it once and never sees it again. A fresh rig
 * hits it on every first client, and then MEASURES THE MODAL: the prompt is
 * typed into a dialog, no turn ever runs, the transcript plane stays empty, and
 * every probe downstream refuses for want of a control.
 *
 * That is precisely what the terminal arm did on its first pass — codex/terminal
 * refused eight of nine probes with `0 transcriptDelta frames`. The refusals
 * were correct; the rig had simply never let the session start.
 *
 * Returns what it cleared, so the report can say the priming happened rather
 * than leaving a reader to wonder whether the arm was primed at all.
 */
export async function primeTerminalTui(chat: Chat, sid: string): Promise<string[]> {
  const cleared: string[] = []
  const press = async (keys: string, label: string) => {
    chat.send({
      type: 'input',
      sessionId: sid,
      // BASE64, NOT 'binary'. The input frame carries base64 — it is the same
      // encoding `outputFrame` is DECODED from a few lines above, and getting it
      // wrong is silent: the frame is well-formed, the server accepts it, and the
      // keystroke simply never reaches the TUI. Every modal this primer "cleared"
      // for hours was still on screen afterwards, which is why `t` and then `Esc`
      // both appeared to do nothing three rounds running.
      data: Buffer.from(keys).toString('base64'),
      inputOrigin: 'human',
    })
    cleared.push(label)
    await wait(2_000)
  }
  // Give the TUI time to paint whatever it opens on.
  await wait(10_000)
  for (let round = 0; round < 3; round++) {
    const screen = chat.screenTail(4_000)
    if (/Press t to trust all|Hooks need review/i.test(screen)) {
      // THE MODAL TELLS YOU THE KEY, AND IT HAS CHANGED. POD-2761's rig answered
      // codex's hooks prompt with "2, Enter"; this codex (0.149.1) renders
      // "Press t to trust all; enter to review hooks; esc to close" — so "2" is
      // swallowed and "enter" opens the REVIEW rather than dismissing anything.
      // The primer pressed 2/Enter three times, reported success, and left the
      // session sitting on the dialog: nine cells refused for want of a
      // transcript that could never arrive. Read the affordance off the screen
      // rather than replaying a key that worked on an older build.
      // `t` FIRST, AND FOR EITHER SPELLING. The dialog's header ("Hooks need
      // review") and its key hint ("Press t to trust all") do not always land in
      // the same screen sample, and keying off the header alone replayed the old
      // build's `2, Enter` — which this codex swallows, leaving the dialog up and
      // every content probe refusing. Press what the current build accepts, then
      // Esc as a fallback for a dialog that is showing something else entirely.
      await press('t', 'codex hooks: pressed t (trust all)')
      if (/Press t to trust all|Hooks need review/i.test(chat.screenTail(4_000))) {
        await press('\u001b', 'codex hooks: Esc (t did not clear it)')
      }
    } else if (/Set it up[\s\S]{0,40}Not now|1\.\s*Set it up|Setupautomodeforyourenvironment|1\.Setitup/i.test(screen)) {
      // claude's first-run onboarding: "Telling it which repos you trust ...
      // 1. Set it up  2. Not now  3. Don't show again". A fresh agent home opens
      // on it, and a rig that types its prompt into that dialog measures the
      // dialog. Answer 2 (Not now), exactly as a person skipping setup would.
      await press('2', 'claude onboarding: chose 2 (Not now)')
      await press('\r', 'claude onboarding: Enter')
    } else if (/trust the files|Do you trust|yes, proceed|Yes, proceed|trustthisfolder|itrustthisfolder/i.test(screen)) {
      await press('\r', 'trust-this-folder: Enter')
    } else if (/press enter to continue|\[Enter\]/i.test(screen)) {
      await press('\r', 'press-enter-to-continue')
    } else {
      break
    }
    await wait(3_000)
  }
  return cleared
}

/** Poll `sessions.list` until `pred` holds or the deadline passes. */
export async function until(
  sid: string,
  pred: (row: SessionRow | undefined) => boolean,
  ms: number,
  everyMs = 1_000,
): Promise<{ ok: boolean; row?: SessionRow; ms: number }> {
  const t0 = now()
  const deadline = t0 + ms
  let row: SessionRow | undefined
  while (now() < deadline) {
    row = await sessionRow(sid)
    if (pred(row)) return { ok: true, row, ms: now() - t0 }
    await wait(everyMs)
  }
  return { ok: false, row, ms: now() - t0 }
}

/**
 * Wait for the session to stop working before sending it something new.
 *
 * NOT POLITENESS — a correctness fix the shakedown forced. `sessions.sendText`
 * into a busy session answers `{ok:true, queued:true, disposition:'queued'}`,
 * which is the product behaving exactly as the catalogue's pinned row says it
 * should ("QUEUED carries a durable position rather than a shrug"). The rig then
 * spent its whole patience window waiting for an answer to a turn that had not
 * started, and reported "the file was staged and sent, but its contents never
 * came back" — a FAIL invented entirely by the drive's own impatience. A probe
 * measuring one behaviour must not be racing the previous probe's turn.
 */
export async function settle(sid: string, ms = 180_000) {
  return until(sid, (r) => r === undefined || r.agentState?.phase !== 'working', ms, 1_000)
}

/**
 * Did the DAEMON take the fine watch for this session?
 *
 * `fine watch acquired` is written by the daemon at the moment the driver's fine
 * refcount moves — a different process from the one sampling — so it is the line
 * that separates the three explanations a zero has: the viewer never subscribed,
 * the driver never upgraded past coarse, or the fragments were produced and
 * dropped. Only the third survives this line being present.
 *
 * Read out of the log rather than inferred, and reported beside the frame count
 * rather than left for a human to grep afterwards.
 */
export async function fineWatch(
  sid: string,
): Promise<{ acquired: boolean; released: boolean } | undefined> {
  try {
    const text = await Bun.file(`${DRIVE_BASE}/logs/daemon.log`).text()
    const lines = text.split('\n').filter((l) => l.includes(sid))
    return {
      acquired: lines.some((l) => l.includes('fine watch acquired')),
      released: lines.some((l) => l.includes('fine watch released')),
    }
  } catch {
    return undefined
  }
}

/** Wait for text matching `pred` to land on the durable transcript. */
export async function untilText(
  chat: Chat,
  pred: (text: string) => boolean,
  ms: number,
  /** Answer permission asks raised while waiting. Off for the interaction
   *  probe, where the ask IS the measurement; on everywhere else, because a
   *  probe that lets an approval dialog time out is measuring its own
   *  impatience and reporting it as a broken feature. */
  opts: { pumpFor?: string } = {},
): Promise<{ ok: boolean; ms: number; asksAnswered: number; asksRefused: number }> {
  const t0 = now()
  const deadline = t0 + ms
  let asksAnswered = 0
  let asksRefused = 0
  let sincePump = 0
  while (now() < deadline) {
    if (pred(chat.assistantText())) return { ok: true, ms: now() - t0, asksAnswered, asksRefused }
    await wait(500)
    sincePump += 500
    if (opts.pumpFor && sincePump >= 3_000) {
      sincePump = 0
      const row = await sessionRow(opts.pumpFor)
      if (row?.agentState?.phase === 'needs_user') {
        const pumped = await pumpAsks(opts.pumpFor)
        asksAnswered += pumped.answered
        asksRefused += pumped.refused.length
      }
    }
  }
  return { ok: false, ms: now() - t0, asksAnswered, asksRefused }
}
