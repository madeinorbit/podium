/**
 * Notification sound cues [POD-78]: a short synthesized cue when an agent's
 * runtime state crosses into something the human should hear about — finished
 * a turn, asked a question, wants an approval, or errored.
 *
 * Sourced from the pool's addressed session phase changes
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

import type { SessionId, SessionMeta } from '@podium/model'
import { reaction } from 'mobx'
import { hasDomWindow } from '../platform-globals'
import type { UiState } from '../replica/contract'
import { SOUND_OWNER_KEY, SOUNDS_ENABLED_KEY } from '../ui-state'
import { play, prewarmAudio, type SoundName } from './cuelume'

export { SOUNDS_ENABLED_KEY, SOUND_OWNER_KEY }

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
export function audibleCondition(s: NotificationSession): NotificationCue | null {
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
      default:
        // 'interrupted' (the human did it), 'open_todos' (the turn ended, the
        // list didn't — ordinary, and nothing to page a human over: POD-415)
        // and bare idle all stay silent.
        return null
    }
  }
  return null
}

export type NotificationSession = Pick<SessionMeta, 'agentState' | 'agentKind' | 'headless' | 'archived'>

/** Borrowed before/after rows for one addressed phase change, never a session list. */
export interface SessionPhaseChange {
  sessionId: SessionId
  previous?: NotificationSession
  current?: NotificationSession
}

export interface NotificationSounderDeps {
  phases: () => readonly SessionPhaseChange[]
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

/** One runtime-owned sound service; one reaction, with no per-session cache. */
export function createNotificationSounds(options: NotificationSounderDeps) {
  const deps = {
    windowFocused: () => typeof document === 'undefined' || document.hasFocus(),
    playCue: (cue: NotificationCue) => play(CUE_SOUNDS[cue]),
    now: () => Date.now(),
    readOwner: () => options.ui.get(SOUND_OWNER_KEY),
    writeOwner: (id: string) => options.ui.set(SOUND_OWNER_KEY, id),
    ...options,
  }
  const windowId = Math.random().toString(36).slice(2)
  let lastPlayedAt = -Infinity
  let pending: NotificationCue | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let stopReaction: (() => void) | undefined
  let stopDom: (() => void) | undefined

  const enabled = () => deps.ui.get(SOUNDS_ENABLED_KEY) !== 'false'
  const suppressed = (sessionId: SessionId) => {
    if (!enabled()) return true
    if (deps.windowFocused() && deps.visibleSessionIds().includes(sessionId)) return true
    const owner = deps.readOwner()
    return owner !== null && owner !== windowId
  }
  function request(cue: NotificationCue): void {
    const now = deps.now()
    if (now - lastPlayedAt >= THROTTLE_MS) {
      lastPlayedAt = now
      deps.playCue(cue)
      return
    }
    if (pending === null || CUE_PRIORITY[cue] > CUE_PRIORITY[pending]) pending = cue
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        const flushed = pending
        pending = null
        if (flushed && enabled()) {
          lastPlayedAt = deps.now()
          deps.playCue(flushed)
        }
      }, lastPlayedAt + THROTTLE_MS - now)
    }
  }
  return {
    start(): void {
      if (stopReaction) return
      // No fireImmediately: attaching or restarting never replays a prior edge.
      stopReaction = reaction(deps.phases, (changes) => {
        for (const change of changes) {
          if (!change.previous || !change.current) continue
          const next = audibleCondition(change.current)
          if (next === null || next === audibleCondition(change.previous)) continue
          if (!suppressed(change.sessionId)) request(next)
        }
      }, { name: 'notification sounds' })
      // React Native has a window but no DOM; phase observation still works.
      if (!hasDomWindow()) return
      const prewarm = () => prewarmAudio()
      const claim = () => deps.writeOwner(windowId)
      window.addEventListener('pointerdown', prewarm, { passive: true })
      window.addEventListener('keydown', prewarm)
      window.addEventListener('focus', claim)
      if (deps.windowFocused()) claim()
      stopDom = () => {
        window.removeEventListener('pointerdown', prewarm)
        window.removeEventListener('keydown', prewarm)
        window.removeEventListener('focus', claim)
      }
    },
    stop(): void {
      stopReaction?.()
      stopReaction = undefined
      stopDom?.()
      stopDom = undefined
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushTimer = null
      pending = null
      lastPlayedAt = -Infinity
    },
  }
}
