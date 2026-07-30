/**
 * Notification sound cues [POD-78]: a short synthesized cue when an agent's
 * runtime state crosses into something the human should hear about — finished
 * a turn, asked a question, wants an approval, or errored.
 *
 * Sourced from `sessionAgentStateChanged` (via the hub's 'sessions' event)
 * rather than the server's `attentionEvent`: the attention broadcast is gated
 * on the web-notification setting and deliberately never fires for a clean
 * "done", while sounds want both. All triage happens client-side here.
 *
 * Policy (per POD-78 discussion):
 *  - a cue fires only on a *transition* observed live — a session first seen
 *    already-blocked stays silent (reload/reconnect must not replay a chorus);
 *  - no cue for the session you are looking at in a focused window — the
 *    screen is the notification there;
 *  - across same-origin windows only the most recently focused one plays
 *    (localStorage election; the desktop shell is a different origin from a
 *    browser tab, which client code cannot dedupe — accepted for v1);
 *  - at most one cue per THROTTLE_MS, coalescing a burst to its
 *    highest-priority cue.
 */

import type { SessionMeta } from '@podium/protocol'
import type { UiState } from '../replica/replica'
import { play, prewarmAudio, type SoundName } from './cuelume'

/** Device-local enable flag (UiState key). Absent = enabled. */
export const SOUNDS_ENABLED_KEY = 'podium.sounds.enabled'

/** Same-origin window election: whichever window focused last owns playback. */
const SOUND_OWNER_KEY = 'podium.sounds.ownerWindow'

const THROTTLE_MS = 2000

export type NotificationCue = 'done' | 'question' | 'approval' | 'error'

/** Higher wins when a throttled burst coalesces. */
const CUE_PRIORITY: Record<NotificationCue, number> = {
  error: 3,
  approval: 2,
  question: 1,
  done: 0,
}

export const CUE_SOUNDS: Record<NotificationCue, SoundName> = {
  done: 'success',
  question: 'chime',
  approval: 'droplet',
  error: 'error',
}

/** A session's audible condition, folded from its runtime state. A cue fires
 *  when this value *changes to* a non-null one — so a question refined while
 *  already blocked, or a re-broadcast of the same state, stays silent. */
export function audibleCondition(s: SessionMeta): NotificationCue | null {
  // Shells have no harness; headless superagent children would ding in swarms.
  if (s.agentKind === 'shell' || s.headless === true || s.archived) return null
  const state = s.agentState
  if (!state) return null
  if (state.phase === 'errored') return 'error'
  if (state.phase === 'needs_user') {
    return state.need?.kind === 'permission' ? 'approval' : 'question'
  }
  if (state.phase === 'idle') {
    switch (state.idle?.kind) {
      case 'done':
        return 'done'
      case 'question':
        return 'question'
      case 'approval':
        return 'approval'
      case 'open_todos':
        return 'question'
      default:
        // 'interrupted' (the human did it) and bare idle stay silent.
        return null
    }
  }
  return null
}

export interface NotificationSounderDeps {
  ui: UiState
  /** Session ids currently on screen in this window (both split panes). */
  visibleSessionIds: () => string[]
  /** Injectable for tests; defaults to the real DOM/localStorage/clock. */
  windowFocused?: () => boolean
  playCue?: (cue: NotificationCue) => void
  now?: () => number
  readOwner?: () => string | null
  writeOwner?: (id: string) => void
}

export class NotificationSounder {
  private readonly deps: Required<NotificationSounderDeps>
  /** Last audible condition per session — null entries matter (armed silent). */
  private readonly conditions = new Map<string, NotificationCue | null>()
  private readonly windowId = Math.random().toString(36).slice(2)
  private lastPlayedAt = -Infinity
  private pending: NotificationCue | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: NotificationSounderDeps) {
    this.deps = {
      windowFocused: () => typeof document === 'undefined' || document.hasFocus(),
      playCue: (cue) => play(CUE_SOUNDS[cue]),
      now: () => Date.now(),
      readOwner: () => {
        try {
          return window.localStorage.getItem(SOUND_OWNER_KEY)
        } catch {
          return null
        }
      },
      writeOwner: (id) => {
        try {
          window.localStorage.setItem(SOUND_OWNER_KEY, id)
        } catch {
          // Private browsing without storage: every window plays; harmless.
        }
      },
      ...deps,
    }
  }

  /** Arm DOM listeners: gesture pre-warm (WKWebView audio unlock) + the
   *  focus-driven window election. Returns the cleanup. */
  attach(): () => void {
    if (typeof window === 'undefined') return () => {}
    const prewarm = (): void => prewarmAudio()
    const claim = (): void => this.deps.writeOwner(this.windowId)
    window.addEventListener('pointerdown', prewarm, { passive: true })
    window.addEventListener('keydown', prewarm)
    window.addEventListener('focus', claim)
    if (this.deps.windowFocused()) claim()
    return () => {
      window.removeEventListener('pointerdown', prewarm)
      window.removeEventListener('keydown', prewarm)
      window.removeEventListener('focus', claim)
      if (this.flushTimer) clearTimeout(this.flushTimer)
    }
  }

  /** Feed every 'sessions' hub emission through here. */
  onSessions(sessions: SessionMeta[]): void {
    for (const s of sessions) {
      const next = audibleCondition(s)
      const known = this.conditions.has(s.sessionId)
      const prev = this.conditions.get(s.sessionId) ?? null
      this.conditions.set(s.sessionId, next)
      // First sight arms silently; only a live transition into an audible
      // condition plays.
      if (!known || next === null || next === prev) continue
      if (this.suppressed(s.sessionId)) continue
      this.request(next)
    }
    // Forget rows that left the list so a session that returns re-arms.
    if (this.conditions.size > sessions.length) {
      const live = new Set(sessions.map((s) => s.sessionId))
      for (const id of this.conditions.keys()) {
        if (!live.has(id)) this.conditions.delete(id)
      }
    }
  }

  private enabled(): boolean {
    return this.deps.ui.get(SOUNDS_ENABLED_KEY) !== 'false'
  }

  private suppressed(sessionId: string): boolean {
    if (!this.enabled()) return true
    // Watching the session in a focused window IS the notification.
    if (this.deps.windowFocused() && this.deps.visibleSessionIds().includes(sessionId)) return true
    // Another same-origin window focused more recently: it plays, we stay quiet.
    const owner = this.deps.readOwner()
    return owner !== null && owner !== this.windowId
  }

  private request(cue: NotificationCue): void {
    const now = this.deps.now()
    if (now - this.lastPlayedAt >= THROTTLE_MS) {
      this.lastPlayedAt = now
      this.deps.playCue(cue)
      return
    }
    if (this.pending === null || CUE_PRIORITY[cue] > CUE_PRIORITY[this.pending]) {
      this.pending = cue
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(
        () => {
          this.flushTimer = null
          const flushed = this.pending
          this.pending = null
          // Re-check the toggle at flush time; focus/visibility were already
          // judged when the transition was observed.
          if (flushed && this.enabled()) {
            this.lastPlayedAt = this.deps.now()
            this.deps.playCue(flushed)
          }
        },
        this.lastPlayedAt + THROTTLE_MS - now,
      )
    }
  }
}
