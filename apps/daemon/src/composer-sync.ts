/**
 * Daemon-side ComposerSync engine (POD-859, Draft Sync v2 — phase 2, READ-ONLY).
 *
 * The daemon owns the PTY, so it can keep its own headless VT screen per flagged
 * live session, scrape the native composer through the harness ComposerDriver, and
 * publish native edits upstream — with zero browsers attached (mobile included).
 *
 * READ-ONLY here: scrape → publish only. No injection, no clearing, no lease
 * arbitration — that is phase 4. The engine, lease, and state machine are all
 * harness-agnostic; every harness-specific choice lives behind the ComposerDriver
 * (from @podium/composer).
 *
 * See docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md §2, §5.
 */

import { type ComposerDriver, composerDriverFor } from '@podium/composer'
import type { AgentKind } from '@podium/protocol'
import { Terminal } from '@xterm/headless'

/** Coalesce a burst of PTY frames into a single scrape (~one animation frame). */
const SCRAPE_COALESCE_MS = 60

/** A minimal headless VT screen: feed it PTY bytes, read the rendered lines. */
export interface ScreenReader {
  write(data: Uint8Array | string): void
  resize(cols: number, rows: number): void
  /** The rendered screen, one string per row. With `dropDim`, dim cells are blanked
   *  (matching the browser's `screenText({ dropDim })` so extraction carries over). */
  lines(dropDim: boolean): string[]
  /** Resolve once all queued writes are parsed into the buffer (the emulator parses
   *  writes asynchronously). The engine's coalesced scrape fires well after the
   *  emulator's own flush, so it doesn't need this — but a synchronous reader does. */
  flush(): Promise<void>
  dispose(): void
}

/** Read a headless Terminal's active buffer into lines — the daemon-side twin of
 *  TerminalView.screenText(), so the extractors behave identically. */
function readLines(term: Terminal, dropDim: boolean): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i += 1) {
    const line = buf.getLine(i)
    if (!dropDim || !line) {
      out.push(line?.translateToString(true) ?? '')
      continue
    }
    let row = ''
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)
      if (!cell) continue
      if (cell.getWidth() === 0) continue // spacer half of a wide glyph
      const chars = cell.getChars() || ' '
      row += cell.isDim() ? ' '.repeat(chars.length) : chars
    }
    out.push(row.replace(/\s+$/, ''))
  }
  return out
}

export function createHeadlessScreen(cols: number, rows: number): ScreenReader {
  // scrollback: 0 keeps the buffer bounded to the visible screen — the composer is
  // always on screen, so history would only add per-scrape cost.
  const term = new Terminal({
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    allowProposedApi: true,
    scrollback: 0,
  })
  return {
    write: (data) => term.write(data as string),
    resize: (c, r) => term.resize(Math.max(1, c), Math.max(1, r)),
    lines: (dropDim) => readLines(term, dropDim),
    // An empty write's callback fires after all previously-queued writes are parsed.
    flush: () => new Promise<void>((resolve) => term.write('', () => resolve())),
    dispose: () => term.dispose(),
  }
}

export type NativeDraftPublisher = (sessionId: string, text: string) => void

/** Draft-sync telemetry counters (design §7). Mutated in place by each session. */
export interface ComposerSyncStats {
  /** WRITE bursts sent to a native composer. */
  injections: number
  /** Injections whose verify failed (persistent mismatch after the budget). */
  verifyFailures: number
  /** Sessions that self-demoted to read-only after repeated mismatches. */
  demotions: number
  /** Native draft edits published upstream (read-only scrape + mismatch republish). */
  nativePublishes: number
}

export function newComposerSyncStats(): ComposerSyncStats {
  return { injections: 0, verifyFailures: 0, demotions: 0, nativePublishes: 0 }
}

/** After a client→PTY input byte, treat the native side as "hot" (the user is
 *  typing) for this long and defer injection so we never fight them. */
const NATIVE_HOT_MS = 400
const DEFAULT_MAX_MISMATCH = 3
const DEFAULT_VERIFY_BUDGET = 3
const DEFAULT_BACKOFF_BASE = 2

/** Injection wiring (phase 4). Absent = read-only (phase 2): setTarget is a no-op
 *  and the engine only scrapes/publishes. */
export interface InjectionConfig {
  /** Write a byte sequence to the session's PTY (clear+type as ONE burst). */
  writePty: (bytes: string) => void
  /** Called when the session self-demotes to read-only after repeated mismatches. */
  onDemote?: () => void
  /** Consecutive verify mismatches before self-demotion. */
  maxMismatch?: number
  /** Frames to wait for an injection echo before ruling a verify a mismatch. */
  verifyBudget?: number
  /** Base for the exponential inter-attempt backoff, in frames. */
  backoffBase?: number
}

/**
 * Composer sync for ONE session (Draft Sync v2, POD-859). Read-only when no
 * InjectionConfig is given (phase 2): scrape native → publish. With injection
 * (phase 4) it also drives chat-originated targets INTO the native composer via the
 * doubling-killer state machine:
 *
 *   IDLE → precheck (scrape stable across 2 frames, composer injectable, native not
 *   hot) → WRITE clearSequence+typeSequence as ONE burst → VERIFY (match/placeholder
 *   → done; persistent mismatch → republish the scraped native truth, back off
 *   exponentially, retry; after K mismatches self-demote to read-only).
 *
 * The injected echo is never re-published (the change comparator is seeded with the
 * expected text), and a null scrape never clobbers the draft.
 */
export class SessionComposerSync {
  private lastPublished: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  // Injection state.
  private readonly writePty: InjectionConfig['writePty'] | undefined
  private readonly onDemote: (() => void) | undefined
  private readonly maxMismatch: number
  private readonly verifyBudget: number
  private readonly backoffBase: number
  private target: string | null = null
  private injecting = false
  private expected: string | null = null
  private prevScrape: string | null = null
  private mismatch = 0
  private demoted = false
  private backoffSkip = 0
  private verifyFrames = 0
  private nativeHotUntil = 0
  // The composer is the live input ONLY while the agent is idle. During a turn
  // (working) or an overlay (needs_user), the lowest `›`/box the extractor finds can
  // be a SUBMITTED transcript prompt, not the composer — injecting would Ctrl-C the
  // running turn and read-only scraping would republish a stale prompt as the draft
  // (reviewer blocker 2). Default true so read-only mode + unit tests behave as
  // before; the daemon drives it from the agent-state tracker (phase === 'idle').
  private agentIdle = true

  constructor(
    private readonly sessionId: string,
    private readonly driver: ComposerDriver,
    private readonly screen: ScreenReader,
    private readonly publish: NativeDraftPublisher,
    inject?: InjectionConfig,
    private readonly stats?: ComposerSyncStats,
  ) {
    this.writePty = inject?.writePty
    this.onDemote = inject?.onDemote
    this.maxMismatch = inject?.maxMismatch ?? DEFAULT_MAX_MISMATCH
    this.verifyBudget = inject?.verifyBudget ?? DEFAULT_VERIFY_BUDGET
    this.backoffBase = inject?.backoffBase ?? DEFAULT_BACKOFF_BASE
  }

  /** Feed a PTY output frame and schedule a coalesced scrape. */
  onData(data: Uint8Array | string): void {
    this.screen.write(data)
    this.scheduleScrape()
  }

  private scheduleScrape(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.scrape()
    }, SCRAPE_COALESCE_MS)
    this.timer.unref?.()
  }

  onResize(cols: number, rows: number): void {
    this.screen.resize(cols, rows)
  }

  /** The daemon saw a client→PTY input byte: the user is typing natively, so defer
   *  injection for a short window (design §3, the input-byte tap). */
  onInputByte(): void {
    this.nativeHotUntil = Date.now() + NATIVE_HOT_MS
  }

  /** Report whether the agent is idle (its composer is the live input). Off while a
   *  turn streams or an overlay is up — the engine then neither injects nor
   *  publishes (reviewer blocker 2). Driven by the daemon's agent-state tracker. */
  setIdle(idle: boolean): void {
    const wasIdle = this.agentIdle
    this.agentIdle = idle
    // On becoming idle, an idle TUI paints nothing, so nothing would drive a
    // draft settled during work — or a deferred injection — until the next PTY
    // frame. Kick the coalesced scrape now (reviewer re-review A).
    if (idle && !wasIdle) this.scheduleScrape()
  }

  /** Set (or clear, with null) the chat-originated text to drive into native. No-op
   *  in read-only mode. Re-arms the state machine so it retries from the new target. */
  setTarget(text: string | null): void {
    if (!this.writePty || this.demoted) return
    this.target = text
    this.injecting = false
    this.expected = null
    this.backoffSkip = 0
    this.mismatch = 0
  }

  /** Seed the change comparator so a known value (a catchup baseline, or the
   *  engine's own inject echo) is not re-published as a native edit. */
  seed(text: string): void {
    this.lastPublished = text
  }

  get isDemoted(): boolean {
    return this.demoted
  }

  private isNativeHot(): boolean {
    return Date.now() < this.nativeHotUntil
  }

  scrape(): void {
    // The composer is only trustworthy when the agent is idle. While a turn streams
    // or an overlay is up, neither scrape (a `›` may be a transcript prompt) nor
    // inject (would interrupt the turn) — but keep the emulator fed via onData.
    if (!this.agentIdle) return

    const lines = this.screen.lines(this.driver.dimStripped)
    const scrape = this.driver.extract(lines)

    // Injection mode: while a chat target is pending, the FSM owns this frame and
    // we do NOT publish the (stale) native truth — we are driving native TO the
    // target. The FSM republishes the real native text itself on a mismatch.
    if (this.writePty && !this.demoted && this.target !== null) {
      if (this.injecting) this.runVerify(lines, scrape)
      else if (this.runPrecheck(lines, scrape) === 'waiting' && this.agentIdle) {
        // Multi-frame precheck (stability / backoff) toward a WRITE — an idle TUI
        // won't send more frames, so self-drive it (reviewer re-review A). Bounded:
        // 'waiting' resolves to 'wrote' once stable / after the backoff elapses.
        this.scheduleScrape()
      }
      return
    }

    // Read-only: publish a changed native draft (never on a null scrape).
    if (scrape === null || scrape === this.lastPublished) return
    this.lastPublished = scrape
    if (this.stats) this.stats.nativePublishes += 1
    this.publish(this.sessionId, scrape)
  }

  /** Returns 'wrote' when it injected, 'waiting' when progressing toward a WRITE
   *  across further frames (stability / backoff), 'blocked' when there's nothing to
   *  do until a real PTY frame. The caller self-drives only 'waiting' while idle. */
  private runPrecheck(lines: string[], scrape: string | null): 'wrote' | 'waiting' | 'blocked' {
    if (this.backoffSkip > 0) {
      this.backoffSkip -= 1
      this.prevScrape = scrape
      return 'waiting'
    }
    // Native already shows the target — nothing to inject.
    if (scrape !== null && scrape === this.target) {
      this.target = null
      this.prevScrape = scrape
      return 'blocked'
    }
    // Can't inject now: no clean composer, not injectable (streaming/overlay), or
    // the user is actively typing in native.
    if (scrape === null || !this.driver.injectable(lines) || this.isNativeHot()) {
      this.prevScrape = scrape
      return 'blocked'
    }
    // PRECHECK stability: require two consecutive identical scrapes before writing.
    if (scrape !== this.prevScrape) {
      this.prevScrape = scrape
      return 'waiting'
    }
    // WRITE: clear the whole composer, then type the target — as ONE burst. Codex's
    // clearSequence is null on an empty composer (Ctrl-C would arm quit), so skip it.
    const clear = this.driver.clearSequence(scrape) ?? ''
    const target = this.target as string
    this.writePty?.(clear + this.driver.typeSequence(target))
    if (this.stats) this.stats.injections += 1
    this.expected = target
    this.lastPublished = target // seed: the injection echo is never republished
    this.injecting = true
    this.verifyFrames = 0
    return 'wrote'
  }

  private runVerify(lines: string[], scrape: string | null): void {
    this.verifyFrames += 1
    const v = this.driver.verify(lines, this.expected as string)
    if (v === 'match' || v === 'placeholder') {
      this.injecting = false
      this.target = null
      this.expected = null
      this.mismatch = 0
      this.prevScrape = scrape
      if (scrape !== null) this.lastPublished = scrape
      return
    }
    // Give the echo a few frames to render before ruling it a mismatch.
    if (this.verifyFrames < this.verifyBudget) return
    this.injecting = false
    this.expected = null
    this.mismatch += 1
    if (this.stats) this.stats.verifyFailures += 1
    this.prevScrape = scrape
    // Never retry blind: republish the scraped native truth so the doc matches
    // reality, then back off before another attempt.
    if (scrape !== null && scrape !== this.lastPublished) {
      this.lastPublished = scrape
      if (this.stats) this.stats.nativePublishes += 1
      this.publish(this.sessionId, scrape)
    }
    if (this.mismatch >= this.maxMismatch) {
      this.demoted = true
      this.target = null
      if (this.stats) this.stats.demotions += 1
      this.onDemote?.()
      return
    }
    this.backoffSkip = this.backoffBase << (this.mismatch - 1)
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.screen.dispose()
  }
}

/**
 * Manages read-only composer sync across sessions. The daemon attaches a session
 * when draft-sync is enabled for it AND its harness has a ComposerDriver, feeds PTY
 * frames + resizes, and detaches on exit.
 */
export interface ComposerEngineConfig {
  /** Write bytes to a session's PTY (enables injection; phase 4). Absent = read-only. */
  writePty?: (sessionId: string, bytes: string) => void
  /** A session self-demoted to read-only (repeated verify mismatch). Telemetry hook. */
  onDemote?: (sessionId: string) => void
}

export class ComposerSyncEngine {
  private readonly sessions = new Map<string, SessionComposerSync>()
  private readonly stats = newComposerSyncStats()

  constructor(
    private readonly publish: NativeDraftPublisher,
    private readonly config: ComposerEngineConfig = {},
  ) {}

  /** A snapshot of the draft-sync telemetry counters (design §7). */
  getStats(): ComposerSyncStats {
    return { ...this.stats }
  }

  /** Begin sync for a session. Returns false (no-op) when the harness has no
   *  composer driver. Idempotent per session. */
  attach(sessionId: string, agentKind: AgentKind, cols: number, rows: number): boolean {
    if (this.sessions.has(sessionId)) return true
    const driver = composerDriverFor(agentKind)
    if (!driver) return false
    const screen = createHeadlessScreen(cols, rows)
    const writePty = this.config.writePty
    const inject: InjectionConfig | undefined = writePty
      ? {
          writePty: (bytes) => writePty(sessionId, bytes),
          onDemote: () => this.config.onDemote?.(sessionId),
        }
      : undefined
    this.sessions.set(
      sessionId,
      new SessionComposerSync(sessionId, driver, screen, this.publish, inject, this.stats),
    )
    return true
  }

  onData(sessionId: string, data: Uint8Array | string): void {
    this.sessions.get(sessionId)?.onData(data)
  }

  onResize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.onResize(cols, rows)
  }

  /** A chat-originated draft target to drive into the native composer (phase 4). */
  setTarget(sessionId: string, text: string | null): void {
    this.sessions.get(sessionId)?.setTarget(text)
  }

  /** The daemon saw a client→PTY input byte for this session (input-byte tap). */
  onInputByte(sessionId: string): void {
    this.sessions.get(sessionId)?.onInputByte()
  }

  /** Report a session's agent-idle state (from the daemon's agent-state tracker).
   *  The engine only scrapes/injects while idle (reviewer blocker 2). */
  setIdle(sessionId: string, idle: boolean): void {
    this.sessions.get(sessionId)?.setIdle(idle)
  }

  detach(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.dispose()
    this.sessions.delete(sessionId)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.sessions.clear()
  }
}
