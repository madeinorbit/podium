/**
 * F1 — WHAT ONE SESSION IS DOING. The presentation vocabulary every slice
 * speaks (POD-330).
 *
 * MEMBERSHIP INVARIANT, and it is what makes this a module rather than a bag of
 * helpers: **one session in — optionally with its own issue, for the rules that
 * need to know whether the owning work is finished — and one presentation value
 * out.** No collections, no cross-entity state, no ordering, no lists. A symbol
 * that needs to see OTHER sessions, or to rank/group/filter them, does not
 * belong here; it belongs to the slice that owns that question.
 *
 * That invariant is also what makes the split safe: this module imports only
 * `@podium/model` and `../focus`, never a slice, so it cannot participate in an
 * import cycle. Every slice depends on it and it depends on none of them.
 *
 * Platform-neutral — nothing here may touch the DOM (window/document/
 * localStorage). Mobile consumes exactly these.
 */
import {
  type AgentKind,
  type IssueWire,
  type SessionMeta,
} from '@podium/model'
import { attentionGroup } from '../focus'

// ---------------------------------------------------------------------------
// Agent identity vocabulary — which agent this is, as opposed to what it is
// doing. Static tables, no state.
// ---------------------------------------------------------------------------

const PANEL_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

export function panelLabel(agentKind: AgentKind): string {
  return PANEL_LABELS[agentKind]
}

/**
 * Harnesses that produce a structured transcript — so the chat view, the
 * chat↔live switcher, and the BTW button are offered immediately on spawn,
 * before the first transcript frame arrives. The server's observed
 * `transcriptAvailable` flag still wins when present; this is the fallback.
 */
export function defaultChatCapable(agentKind: AgentKind): boolean {
  return DEFAULT_CHAT_CAPABLE[agentKind]
}

const DEFAULT_CHAT_CAPABLE: Record<AgentKind, boolean> = {
  'claude-code': true,
  codex: true,
  grok: true,
  opencode: true,
  cursor: true,
  shell: false,
}

// The agent's `/color` identity accent (Claude's named colours) → a vivid,
// theme-independent hex, shown as the tab/sidebar accent line. This is *identity*
// (which agent), distinct from the status dot (what it's doing). Unknown/absent
// → undefined (no accent).
const AGENT_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
  orange: '#f97316',
  pink: '#ec4899',
  cyan: '#06b6d4',
}

export function agentColorHex(name: string | undefined): string | undefined {
  return name ? AGENT_COLOR_HEX[name.toLowerCase()] : undefined
}

// ---------------------------------------------------------------------------
// Runtime state → badge / dot / activity row.
// ---------------------------------------------------------------------------

export interface AgentBadge {
  label: string
  tone: 'working' | 'idle' | 'attention' | 'error' | 'muted'
  showContinue: boolean
}

/** Map harness-observed runtime state to the little badge on a session row.
 *  Null = nothing to show (uninstrumented agent kinds stay clean). */
export function agentBadge(meta: SessionMeta, issue?: IssueWire): AgentBadge | null {
  // An offer is an explicit pending decision even when the turn that produced
  // it has already classified as idle/done. Keep every status surface (session
  // dot, sidebar meta, chat activity) amber until that offer is cleared —
  // except on a finished issue, where the close retired the decision (POD-290).
  const issueFinished =
    issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  if (meta.offer && !issueFinished) {
    return { label: 'waiting on decision', tone: 'attention', showContinue: false }
  }
  const s = meta.agentState
  if (!s || s.phase === 'unknown') return null
  switch (s.phase) {
    case 'working':
      return { label: 'working', tone: 'working', showContinue: false }
    case 'compacting':
      return { label: 'compacting', tone: 'working', showContinue: false }
    case 'idle': {
      switch (s.idle?.kind) {
        case 'question':
          return { label: 'needs answer', tone: 'attention', showContinue: false }
        case 'approval':
          return { label: 'plan ready', tone: 'attention', showContinue: false }
        case 'open_todos':
          return { label: 'todos open', tone: 'attention', showContinue: false }
        case 'interrupted':
          return { label: 'interrupted', tone: 'idle', showContinue: false }
        default:
          return { label: 'idle', tone: 'idle', showContinue: false }
      }
    }
    case 'needs_user':
      return {
        label: s.need?.kind === 'question' ? 'needs answer' : 'needs permission',
        tone: 'attention',
        showContinue: false,
      }
    case 'errored':
      return {
        label: `error: ${s.error?.class ?? 'unknown'}`,
        tone: 'error',
        showContinue: s.error?.retryable ?? false,
      }
    case 'ended':
      return { label: 'ended', tone: 'muted', showContinue: false }
  }
}

export interface ChatActivity {
  label: string
  tone: AgentBadge['tone']
}

/**
 * The activity row shown pinned to the bottom of the chat view, or null for
 * nothing. Reuses `agentBadge` for instrumented agents; falls back to the PTY
 * `busy` signal for uninstrumented kinds; and shows an optimistic "Sending…"
 * immediately after a submit (`justSent`) before the first `working` event lands.
 *
 * A parked process (hibernated/exited) cannot be working, however fresh the
 * preserved `working` phase — the header already says so, and the activity row
 * must not contradict it. Last-state *attention* labels are kept: a parked
 * "needs answer" is still true and worth surfacing. [spec:SP-8b0e]
 */
export function chatActivity(
  meta: SessionMeta | undefined,
  justSent: boolean,
): ChatActivity | null {
  if (!meta) return null
  const parked = meta.status === 'hibernated' || meta.status === 'exited'
  const badge = agentBadge(meta)
  if (badge?.tone === 'working' && !parked) {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  if (!meta.agentState && meta.busy && !parked) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}

// Four semantic status colours, identical across every surface (sidebar, tabs,
// work lists and chat) so a colour means the same thing everywhere:
//   working   → green   (agent running / shell command running)
//   attention → yellow  (needs you: question / approval / permission)
//   error     → red
//   ready     → blue    (idle-and-waiting, a fresh agent, or a shell at its prompt)
//   neutral   → grey    (exited carries no live colour)
export type DotTone = 'working' | 'attention' | 'error' | 'ready' | 'neutral'

/**
 * The status-dot tone for a session row/tab/card — the single source of truth
 * for agent colour, shared by every mode so the semantics never drift.
 *
 * Hibernated sessions KEEP their last *attention-worthy* status colour: the
 * server preserves `agentState` across a hibernate (the kill is the expected
 * result, so `onExit` leaves the phase intact), so a hibernated agent that
 * "needs input" still reads yellow. Hibernation is conveyed only by the
 * grayed/italic `.dot.parked` row, not by draining the dot to grey. The one
 * exception is `working`: a parked process cannot be working, however fresh
 * its preserved phase, so a hibernated "working" session reads ready (blue)
 * — matching `attentionGroup`, which already treats it as idle. [spec:SP-8b0e]
 */
export function sessionDotTone(s: SessionMeta): DotTone {
  // Exited (process gone, phase cleared server-side): no live status colour.
  if (s.status === 'exited') return 'neutral'
  // Booting / brief reconnect: not working yet → blue.
  if (s.status === 'starting' || s.status === 'reconnecting') return 'ready'
  const badge = agentBadge(s)
  if (badge) {
    switch (badge.tone) {
      case 'working':
        return s.status === 'hibernated' ? 'ready' : 'working'
      case 'attention':
        return 'attention'
      case 'error':
        return 'error'
      case 'idle': // finished a turn, nothing pending → ready for your next message
        return 'ready'
      case 'muted': // ended
        return 'neutral'
    }
  }
  // Uninstrumented live session: a shell is "working" (green) only while a command
  // runs; otherwise it — and a fresh agent that hasn't started a turn — is blue.
  if (s.agentKind === 'shell') return s.busy ? 'working' : 'ready'
  return 'ready'
}

/**
 * Is the session actively doing work right now? The single predicate behind the
 * close/archive guard (#115) — kept in lock-step with the green status dot
 * (`sessionDotTone === 'working'`), so "still working" in a confirm prompt means
 * exactly what the green dot does: an instrumented agent in its `working` /
 * `compacting` phase, or an uninstrumented shell with a command running (`busy`).
 */
export function isSessionWorking(s: SessionMeta): boolean {
  return sessionDotTone(s) === 'working'
}

// ---------------------------------------------------------------------------
// Motion grammar.
// ---------------------------------------------------------------------------

/**
 * The four phases of the redesign's motion grammar (.design/specs/motion.md):
 * only `working` moves (braille spinner + counting timer); `waiting` is amber
 * stillness after a one-shot flash ("needs you"); `done` is a still ✓; `queued`
 * is dimmed stillness for everything not yet (or no longer) in play.
 */
export type MotionPhase = 'queued' | 'working' | 'waiting' | 'done'

/**
 * Collapse harness phase + shell busyness + liveness into the motion phase.
 * Kept in lock-step with the existing grammar: `waiting` is exactly
 * `attentionGroup === 'needsYou'` (offer/question/permission/error/open todos —
 * hibernated sessions keep their last phase, so a parked "needs input" still
 * reads amber), and `working` is exactly `isSessionWorking` (the green-dot
 * predicate). A finished run (`idle.kind === 'done'` or `ended`) is `done`;
 * starting/exited/uninstrumented-quiet sessions fall through to `queued`.
 */
export function motionPhase(s: SessionMeta, issue?: IssueWire): MotionPhase {
  const state = s.agentState
  // Offers outlive the turn that created them, so attention must win over the
  // transcript's terminal idle/done verdict — unless the owning issue is already
  // finished. Closing retires offers server-side (POD-290); this guard also
  // drops historical stale offers so a closed row cannot keep demanding a
  // decision. Open review work still counts.
  if (attentionGroup(s) === 'needsYou') {
    const finished = issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
    if (!(finished && s.offer && !hasNonOfferNeedsYou(s))) return 'waiting'
  }
  if (state?.phase === 'ended' || (state?.phase === 'idle' && state.idle?.kind === 'done')) {
    return 'done'
  }
  if (isSessionWorking(s)) return 'working'
  return 'queued'
}

/** True when attention would still be needsYou even without a standing offer —
 *  questions, permissions, errors, open todos. Used so a finished issue only
 *  ignores offer-driven attention, not a real live need. */
function hasNonOfferNeedsYou(s: SessionMeta): boolean {
  if (!s.offer) return attentionGroup(s) === 'needsYou'
  const withoutOffer = { ...s, offer: undefined }
  return attentionGroup(withoutOffer) === 'needsYou'
}

/** Canonical timer inputs derived from one session's persisted runtime state.
 *  `baseMs` feeds a live working counter; `totalMs` feeds the stopped ∑ stamp.
 *  Both stay absent for legacy sessions that do not carry cumulative timing data. */
export interface MotionTiming {
  phase: MotionPhase
  sinceMs: number
  baseMs?: number
  totalMs?: number
}

export function motionTiming(s: SessionMeta): MotionTiming {
  const phase = motionPhase(s)
  const sinceMs = Date.parse(s.agentState?.since ?? s.lastActiveAt)
  const total = s.agentState?.workingMsTotal
  if (total === undefined) return { phase, sinceMs }
  if (phase === 'working') return { phase, sinceMs, baseMs: total }
  if (phase === 'done') return { phase, sinceMs, totalMs: total }
  return { phase, sinceMs }
}

/**
 * Compact clock for the motion timer/∑ stamps: `6:30`, `0:07`, `72:15` —
 * minutes never roll into hours (matches the handoff's `m:ss` format).
 * `formatElapsed` remains the format for non-motion surfaces.
 */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Per-session labels and lifecycle facts.
// ---------------------------------------------------------------------------

/** True while a session is still a blank vessel: no user-set name, and its
 *  terminal title is only boot noise — empty, the harness's own name ("Claude
 *  Code", "codex"), or the cwd basename (codex seeds the title with the
 *  directory). Nothing has been asked of it yet, so surfaces label it as a new
 *  session instead of parroting the harness name. */
export function isUnstartedSession(s: SessionMeta): boolean {
  if (s.name?.trim()) return false
  const title = s.title
    .replace(/^[\p{So}\p{Sk}·•\s]+/u, '')
    .trim()
    .toLowerCase()
  if (!title) return true
  const boot = [panelLabel(s.agentKind).toLowerCase(), s.agentKind, 'claude code']
  const cwdBase = s.cwd.split('/').filter(Boolean).at(-1)?.toLowerCase()
  return boot.includes(title) || title === cwdBase
}

/** A consumed child: its work is done (exited) — nothing left to watch. */
export function isConsumedChild(s: SessionMeta): boolean {
  return s.status === 'exited'
}

/** Live native (in-process Task) subagent count on a session, or 0 if absent. */
export function nativeSubagentCountOf(s: SessionMeta): number {
  return s.agentState?.nativeSubagentCount ?? 0
}

/** True when the session currently has one or more native subagents running. */
export function sessionHasNativeSubagents(s: SessionMeta): boolean {
  return nativeSubagentCountOf(s) > 0
}

/**
 * Sidebar label for a nested native-subagent indicator under a parent session
 * (count-only — named per-subagent identity is a separate deferred stream).
 */
export function nativeSubagentLabel(count: number): string {
  if (count <= 0) return ''
  return count === 1 ? '1 subagent' : `${count} subagents`
}

/**
 * Human-facing issue linkage for a session row: prefer the permanent birth
 * `displayRef` (e.g. `POD-13-A`), then the attached issue's human display ref.
 * Internal issue IDs are never suitable for display, so return null when
 * neither human-facing ref is available.
 */
export function sessionIssueLinkage(
  s: SessionMeta,
  attachedIssueDisplayRef?: string,
): string | null {
  const ref = s.displayRef?.trim()
  if (ref) return ref
  const issueRef = s.issueId ? attachedIssueDisplayRef?.trim() : undefined
  return issueRef || null
}

/** The recovery action offered for a session whose process has exited. */
export type ExitedAction = 'restart' | 'resume' | 'remove'

/** Copy + recovery action for an exited session, shared by the inline
 *  `ExitedBanner` and the full-pane `ExitedPane` so the two never drift.
 *
 *  Orthogonal to the exit cause, a missing worktree (an orphaned session whose
 *  directory was removed out from under it) forces `remove`: the conversation
 *  can't be resumed in place — Claude buckets transcripts by their original cwd,
 *  and a shell can't restart in a directory that's gone. The header's
 *  copy-resume-command stays available for resuming by hand elsewhere. */
export function exitedRecovery(opts: {
  exitCode: number | undefined
  spawnFailure?: string
  isShell: boolean
  resumable: boolean
  worktreeMissing: boolean
  /** Pretty worktree path, woven into the notice when the worktree is missing. */
  worktreePath?: string
}): { detail: string; action: ExitedAction } {
  const what = opts.isShell ? 'shell' : 'agent process'
  // Exit code 0 can still be an external kill of the durable host (the PTY
  // reports the attach client's exit, not the agent's) — stay neutral about why.
  const cause =
    opts.exitCode === undefined || opts.exitCode === 0
      ? `The ${what} is no longer running.`
      : opts.exitCode === -1
        ? opts.spawnFailure
          ? `The ${what} failed to start: ${opts.spawnFailure}`
          : `The ${what} failed to start.`
        : `The ${what} exited with code ${opts.exitCode}.`
  if (opts.worktreeMissing) {
    const where = opts.worktreePath ? ` (${opts.worktreePath})` : ''
    return {
      detail: `${cause} Its worktree${where} no longer exists, so it can't be resumed here.`,
      action: 'remove',
    }
  }
  return { detail: cause, action: opts.isShell ? 'restart' : opts.resumable ? 'resume' : 'remove' }
}

/**
 * The native CLI command that resumes this session's conversation, for #119
 * (show + copy). Mirrors the canonical builder in
 * `@podium/harness`'s `agentLaunchCommand` (the single place the daemon
 * actually spawns resumes) — the web app doesn't depend on agent-bridge, so the
 * per-CLI resume flag is replicated here. Keyed off the harness-supplied
 * `ResumeRef.kind` (set by each discovery provider) rather than `agentKind`, so
 * the command always matches the ref the daemon would replay. Null when no
 * resume ref is known (shells, not-yet-resumable sessions).
 */
export function resumeCommand(s: SessionMeta): string | null {
  const ref = s.resume
  if (!ref) return null
  const id = shellQuote(ref.value)
  switch (ref.kind) {
    case 'claude-session':
      return ['claude', '--resume', id].join(' ')
    case 'codex-thread':
      return `codex resume ${id}`
    case 'grok-session':
      return `grok --resume ${id}`
    case 'opencode-session':
      return `opencode --session ${id}`
    case 'cursor-chat':
      // Cursor's CLI binary is `agent` (Cursor Agent) — see resolveCursorBin.
      return `agent --resume ${id}`
    default:
      // Unknown ref kind — fall back to the agent kind's flag so a future
      // provider still produces a usable command rather than nothing.
      return `${s.agentKind} --resume ${id}`
  }
}

/** Single-quote a resume id for shell safety only when it isn't a bare token
 *  (uuids / thread ids are bare; quote anything with a shell metacharacter). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
