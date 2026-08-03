/**
 * DRAFT SYNC BETWEEN THE PTY AND CHAT (POD-408 move; #17/#62/#53, POD-859).
 *
 * One shared draft per session, two directions:
 *   native → chat  a 150ms sampler scrapes the CLI's own composer box and
 *                  publishes what it finds;
 *   chat → native  a one-shot flush injects the shared draft into that box when
 *                  the panel enters native mode.
 *
 * This used to live as ~130 lines inside `AgentPanel`'s `onMounted` callback,
 * where its two closures (`scheduleSample`, `rearm`) were published out through
 * refs and the only way to exercise any of it was to mount the whole panel with
 * a mocked xterm. It is the same code, in a factory: everything it needs from
 * React arrives as a getter, so no version of it can accidentally re-read a
 * stale render's value, and none of it depends on the DOM beyond the focus
 * predicate its caller supplies.
 *
 * The ARBITRATION owns when `rearm()` is called (`use-panel-surface`'s
 * chat → native edge). This module owns what happens then.
 */
import { composerDriverFor } from '@podium/composer'
import type { AgentKind } from '@podium/model'
import type { MountedSession } from '@podium/terminal-client'

/** How often the sampler and the bounded flush poll tick. */
const TICK_MS = 150
/** Poll ceiling for the one-shot flush — an idle composer emits no frames, so
 *  the flush cannot rely on `onFrame` alone; it must also stop. */
const FLUSH_POLL_ATTEMPTS = 40

export interface DraftSync {
  /** Debounced native→chat sample; also the flush's frame-driven trigger. */
  scheduleSample: () => void
  /** Reset the one-shot flush guard and restart the bounded poll — called on
   *  every chat → native entry, not only at mount. */
  rearm: () => void
  /** Stop every timer this holds. */
  dispose: () => void
}

export function createDraftSync(input: {
  readonly mounted: MountedSession
  readonly agentKind: AgentKind | undefined
  /** True while THIS terminal holds keyboard focus. The directional guard (#53):
   *  a chat composer being typed in another pane/device wins. */
  readonly hasFocus: () => boolean
  /** The latest shared draft for this session. */
  readonly draft: () => string
  /** Draft Sync v2 (POD-859): the session's daemon runs the composer engine, so
   *  it owns scrape AND inject server-side and this client retires both. */
  readonly engineActive: () => boolean
  /** Publish a scraped native draft as the session's shared draft. */
  readonly publish: (draft: string) => void
}): DraftSync {
  const { mounted, agentKind, hasFocus, draft: draftOf, engineActive, publish } = input
  let lastPublished: string | null = null
  let sampleTimer: ReturnType<typeof setTimeout> | null = null

  // Read the native composer's current text via the same scrape both directions
  // share. Returns the typed text, '' for an empty composer, or null when no
  // clean composer box is on screen yet (splash/overlay/menu) — callers must
  // not act on null. Claude draws a box; Codex a single dim-stripped `›` line.
  const composerDriver = agentKind ? composerDriverFor(agentKind) : null
  const scrapeComposer = (): string | null =>
    composerDriver?.extract(
      mounted.view.screenText({ dropDim: composerDriver.dimStripped }).split('\n'),
    ) ?? null

  // native → chat. Best-effort + clobber-safe: only the controlling client
  // publishes (cross-client), and only while THIS terminal holds focus. Publish
  // only on change; a null extraction (slash menu / no composer / other agent)
  // never clobbers; and a freshly-focused EMPTY composer won't publish '' as its
  // first act (which would wipe a draft another device is typing — a real clear
  // still propagates after).
  const sample = (): void => {
    if (engineActive()) return
    if (mounted.connection.state().role !== 'controller') return
    if (!hasFocus()) return
    // Codex's empty composer shows a DIM placeholder suggestion — blank dim cells
    // (screenText dropDim) so it isn't mistaken for typed text; Claude's box needs
    // no such filter.
    const scraped = scrapeComposer()
    if (scraped === null || scraped === lastPublished) return
    if (scraped === '' && lastPublished === null) return
    lastPublished = scraped
    publish(scraped)
  }

  // chat → native (#17/#62): one-shot flush of the shared chat draft into the
  // native composer on entering native mode, so text typed in chat lands in the
  // real PTY prompt. Chat renders ChatView over the (still-mounted) xterm, so
  // realtime key-by-key injection while chat-typing is impossible — the
  // realistic, safe sync point is the mode switch.
  //
  // SAFETY (never clobber text the user typed directly in the native composer):
  //   - only the controller injects, and only while the terminal holds focus
  //     (mirrors the sampler's directional guard #53 so the two never fight);
  //   - we scrape the live composer first and ONLY inject when it is empty (or
  //     already equals what we're about to type — an idempotent retry). A null
  //     scrape (splash/overlay not yet a clean box) or unrelated typed text →
  //     SKIP, and we retry on later frames until the box settles or we bail;
  //   - empty shared draft → nothing to do.
  // ANTI-FEEDBACK ("sent keys + reconcile"): we send Ctrl-U (clear-line, a no-op
  // on an already-empty composer) then the draft, remember it as `lastPublished`,
  // and let the 150ms sampler reconcile — it now sees the scrape return exactly
  // what we injected (=== lastPublished) and stays quiet, so our own injection is
  // never re-published as a "new" draft.
  let flushTried = false
  // Returns true when it actually injected on this tick — the caller then SKIPS
  // the sampler for this tick, because the injected bytes haven't echoed back to
  // the screen yet (the scrape would still read the pre-injection empty composer
  // and, with lastPublished now set to the draft, publish '' — wiping it). The
  // next frame's scrape sees the echo, matches lastPublished, and stays quiet.
  const flushDraftToNative = (): boolean => {
    if (flushTried) return false
    if (engineActive()) return false
    if (mounted.connection.state().role !== 'controller') return false
    if (!hasFocus()) return false
    const want = draftOf()
    // Nothing to push — let the native→chat sampler own this session's draft.
    if (want === '') {
      flushTried = true
      return false
    }
    const current = scrapeComposer()
    // No clean composer box yet (splash/overlay): wait for a later frame.
    if (current === null) return false
    // The composer already holds text the user typed directly in native — never
    // overwrite it. Stand down for this mode-entry (idempotent if it happens to
    // already equal what we'd type).
    if (current !== '' && current !== want) {
      flushTried = true
      return false
    }
    flushTried = true
    // Clear the line (safe no-op when empty) then type the draft. Seed the
    // sampler so the reconcile scrape of our own injection isn't re-published.
    lastPublished = want
    mounted.connection.sendInput('\x15') // Ctrl-U
    mounted.connection.sendInput(want)
    return true
  }

  const scheduleSample = (): void => {
    if (sampleTimer) return
    sampleTimer = setTimeout(() => {
      sampleTimer = null
      if (flushDraftToNative()) return
      sample()
    }, TICK_MS)
  }

  // The flush piggy-backs on onFrame, but an already-idle composer may emit no
  // frames after focus lands (and focus itself arrives a beat after the first
  // frame, via focusWhenReady). Poll a bounded number of times so the one-shot
  // flush still fires on a quiet session; it self-stops once the flush resolves
  // (injected, or skipped because empty/occupied/wrong-agent).
  let flushPoll: ReturnType<typeof setInterval> | null = null
  const startFlushPoll = (): void => {
    if (flushPoll) clearInterval(flushPoll)
    let attempts = 0
    flushPoll = setInterval(() => {
      if (flushTried || attempts++ >= FLUSH_POLL_ATTEMPTS) {
        if (flushPoll) clearInterval(flushPoll)
        flushPoll = null
        return
      }
      if (flushDraftToNative()) {
        if (flushPoll) clearInterval(flushPoll)
        flushPoll = null
      }
    }, TICK_MS)
  }
  startFlushPoll()

  return {
    scheduleSample,
    rearm: () => {
      flushTried = false
      startFlushPoll()
    },
    dispose: () => {
      if (sampleTimer) clearTimeout(sampleTimer)
      if (flushPoll) clearInterval(flushPoll)
      sampleTimer = null
      flushPoll = null
    },
  }
}
