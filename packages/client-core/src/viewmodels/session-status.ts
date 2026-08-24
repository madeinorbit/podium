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
  idleVerdictFinishedTurn,
  type SessionMeta,
} from '@podium/model'
import { attentionGroup } from '../focus'
import { errorPhrase } from './error-phrase'

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
        // Quiet but visible, like 'interrupted' below: the turn ended, the list
        // did not. With a fleet running that is ordinary, so it names itself on
        // the row and stops there — no amber, no sound, no needs-you (POD-415).
        case 'open_todos':
          return { label: 'todos open', tone: 'idle', showContinue: false }
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
        // The WORDS, not the class token (POD-1601). This badge used to print
        // `error: max_output_tokens` — a log line wearing a row's clothes, in
        // the one place the operator reads fastest. Same table the task-level
        // rollups use, so a row and the task above it never disagree.
        label: errorPhrase(s.error?.class, 'lower'),
        tone: 'error',
        showContinue: s.error?.retryable ?? false,
      }
    case 'ended':
      return { label: 'ended', tone: 'muted', showContinue: false }
  }
}

/**
 * How long an optimistic "Sending" claim may stand with NO word from the daemon
 * about the turn it belongs to.
 *
 * It lives beside {@link chatActivity} because it is half of that function's
 * contract, not a detail of either client. `chatActivity` ranks `justSent` above
 * every verdict the previous turn left behind, and that is only honest while the
 * claim is still the newest thing anyone knows — so each caller must end its own
 * window as soon as `agentState.since` moves, and use this purely as a backstop
 * for a session that reports nothing at all. Web and mobile both got that wrong
 * independently before it was written down here (POD-1595).
 */
export const OPTIMISTIC_SEND_CEILING_MS = 30_000

export interface ChatActivity {
  label: string
  tone: AgentBadge['tone']
  /** Optimistic transport state before the runtime reports real computation. */
  transient?: 'just-sent'
}

/**
 * A parked session with a message waiting on it — the window between "you sent
 * into a hibernated agent" and "the resumed CLI typed it".
 *
 * DERIVED FROM THE SERVER'S OWN FIELDS, deliberately. `queuedMessageCount` is
 * the durable inbox depth and `status` is the lifecycle, so this answer is the
 * same on every client, survives a reload, and — the thing POD-762 is actually
 * about — is still true when you come back from three issues away. A flag set
 * by the composer that just sent would be none of those.
 *
 * `justSent` only covers the optimistic gap before the send's own meta update
 * lands, and only while the session is still parked.
 */
export function sessionWaking(meta: SessionMeta | undefined, justSent = false): boolean {
  if (!meta) return false
  const queued = (meta.queuedMessageCount ?? 0) > 0
  if (meta.status === 'hibernated' || meta.status === 'exited') return queued || justSent
  // Resurrection has begun: the process is coming up and the queue drains once
  // the PTY binds. Nothing local is needed to know that.
  if (meta.status === 'starting') return queued
  return false
}

/**
 * The activity row shown pinned to the bottom of the chat view, or null for
 * nothing. Reuses `agentBadge` for instrumented agents; falls back to the PTY
 * `busy` signal for uninstrumented kinds; and shows an optimistic, still
 * "Sending" state immediately after a submit (`justSent`) before the first
 * `working` event lands.
 *
 * A parked process (hibernated/exited) cannot be working, however fresh the
 * preserved `working` phase — the header already says so, and the activity row
 * must not contradict it. Last-state *attention* labels are kept: a parked
 * "needs answer" is still true and worth surfacing. [spec:SP-8b0e]
 *
 * WAKING WINS OVER EVERY PRESERVED LABEL (POD-762). Once a message is waiting on
 * a parked agent, the one thing the operator needs to know is that it is coming
 * up and their text goes in when it does. A stale "needs answer" from before the
 * hibernate is true but it is not the answer to the question they just asked by
 * pressing Enter, and it reads as "nothing happened".
 *
 * AND SO DOES SENDING (POD-1595). The same reasoning was applied to exactly one
 * branch and then not to the rest. `justSent` used to be the LAST test in this
 * function, under every verdict `agentBadge` produces — so a send into a session
 * carrying an offer, a question, a plan, an error or an open todo list showed
 * the operator, underneath the prompt they had just pressed Enter on, the state
 * of the turn BEFORE it. "Waiting on your decision" is not a description of a
 * message in flight, and it did not budge until the daemon's first observation
 * of the new turn arrived, which for a prompt carrying large attachments is ten
 * or fifteen seconds later. The feed read as though nothing had happened.
 *
 * Every one of those verdicts is a statement about the PREVIOUS turn, and
 * pressing Enter is what answers them — so the send now outranks them all. What
 * still outranks the send is anything describing work happening NOW: a `working`
 * badge, and the PTY's own `busy` for uninstrumented kinds. Both are live
 * observations rather than a turn's parting verdict, so neither can be the stale
 * claim this is about. Freshness is the caller's job: `justSent` stays true only
 * while the daemon has said nothing about the new turn (see `useChatSend`), so
 * an ask raised three seconds into the turn still reaches the tail at once.
 *
 * NOTE THE SHAPE OF THE PTY BRANCH. It is asked TWICE rather than hoisted, and
 * that is deliberate: `busy` outranks the optimistic send, but it does NOT
 * outrank an attention badge, and it never did. Hoisting it to the top of the
 * list to get the first of those would have bought the second by accident — an
 * uninstrumented session with an offer and a live PTY would have read "Working…"
 * and dropped the offer line entirely, with no send anywhere in sight.
 */
export function chatActivity(
  meta: SessionMeta | undefined,
  justSent: boolean,
): ChatActivity | null {
  if (!meta) return null
  if (sessionWaking(meta, justSent)) return { label: 'Waking the agent…', tone: 'working' }
  const parked = meta.status === 'hibernated' || meta.status === 'exited'
  const badge = agentBadge(meta)
  if (badge?.tone === 'working' && !parked) {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  const ptyWorking = !meta.agentState && meta.busy && !parked
  // A live PTY beats the optimistic row — it is an observation of now — but the
  // send still beats everything the last turn left behind.
  if (justSent) {
    return ptyWorking
      ? { label: 'Working…', tone: 'working' }
      : { label: 'Sending', tone: 'idle', transient: 'just-sent' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  // Errors and meaningful passive stops belong at the end of the transcript,
  // too. They used to disappear here even though `agentBadge` had already
  // classified them, leaving the feed to fall back to a generic idle clock.
  // Keep ordinary idle silent; only a stop that explains the turn survives.
  if (badge?.tone === 'error') return { label: badge.label, tone: 'error' }
  if (badge?.tone === 'idle' && (badge.label === 'interrupted' || badge.label === 'todos open')) {
    return { label: badge.label, tone: 'idle' }
  }
  if (ptyWorking) return { label: 'Working…', tone: 'working' }
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
 * THE SESSION STOPPED ON AN ERROR — the one fact every issue-level rollup used
 * to lose (POD-1601).
 *
 * The harness already publishes it: `agentBadge` names the failure, the
 * session dot goes red, `attentionGroup` calls it `needsYou`. But nothing that
 * summarises a TASK asked the question, so an issue whose only agent had died
 * kept wearing the word its stage implied — `In review`, `Standing by` — and the
 * one surface that could have said otherwise was the session row the operator
 * had to unfold to reach.
 *
 * Deliberately NOT gated on `error.retryable`. Retryability answers "will
 * Continue help", which is a question about the CONTROL to offer; whether the
 * run stopped is a question about the STATE, and a fatal error is the one that
 * least deserves to be silent.
 */
export function sessionErrored(s: SessionMeta): boolean {
  return s.agentState?.phase === 'errored'
}

/** Sentence case, or null when this session did not stop on an error. */
export function sessionErrorLabel(s: SessionMeta): string | null {
  const state = s.agentState
  if (state?.phase !== 'errored') return null
  return errorPhrase(state.error?.class, 'sentence')
}

/** The same phrase in the worklist row's lower-case grammar. */
export function sessionErrorLine(s: SessionMeta): string | null {
  const state = s.agentState
  if (state?.phase !== 'errored') return null
  return errorPhrase(state.error?.class, 'lower')
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
 * `attentionGroup === 'needsYou'` (offer/question/permission/error — hibernated
 * sessions keep their last phase, so a parked "needs input" still reads amber),
 * and `working` is exactly `isSessionWorking` (the green-dot predicate). A
 * finished run (`idleVerdictFinishedTurn` or `ended`) is `done` — including a
 * turn that ended with open todos, which finished and merely says so on the row
 * (POD-415); starting/exited/uninstrumented-quiet sessions fall through to
 * `queued`.
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
  if (
    state?.phase === 'ended' ||
    (state?.phase === 'idle' && idleVerdictFinishedTurn(state.idle?.kind))
  ) {
    return 'done'
  }
  if (isSessionWorking(s)) return 'working'
  return 'queued'
}

/**
 * Is this session's needs-you nothing but its standing offer?
 *
 * The offer IS the ask, so whoever else is already counting that same ask can
 * use this to avoid counting it twice — see `rowWaitingCount`, where an agent
 * that moved its issue to `review` AND posted an offer (which the agent prime
 * instructs it to do) otherwise reads as two things needing you.
 */
export function isOfferOnlyAttention(s: SessionMeta): boolean {
  return Boolean(s.offer) && !hasNonOfferNeedsYou(s)
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
export type ExitedAction = 'restart' | 'resume' | 'relaunch' | 'remove'

/** Copy + recovery action for an exited session, shared by the inline
 *  `ExitedBanner` and the full-pane `ExitedPane` so the two never drift.
 *
 *  THE WORKTREE IS A CACHE; THE BRANCH IS THE TRUTH (POD-1704). This used to take
 *  a `worktreeMissing` flag and force `remove` on it, which was wrong twice over.
 *  Wrong in fact: the flag was a CLIENT-SIDE guess — "absent from the last repo
 *  scan" — and a scan that merely timed out came back with the repo root present
 *  and its worktrees empty, so every worktree-backed session got told its
 *  directory was gone while it sat there on disk. Wrong in principle even when
 *  the directory really IS gone: `ensureWorktree` rebuilds it from the preserved
 *  branch before the spawn, which is why `issue stop` is documented as
 *  reversible. A recoverable state was being rendered as a dead end whose only
 *  offered action destroyed the session row.
 *
 *  So existence is not consulted here at all. Resume is always offered to an
 *  agent that left a ref, and a genuine failure to rebuild the workspace is
 *  reported by the daemon that tried it — at the moment of the attempt, with a
 *  real reason, rather than predicted from stale state at render time.
 *
 *  `remove` survives for its one honest case, and POD-2392 made that case much
 *  smaller. "No resume ref" used to be read as "nothing to resume", which
 *  collapsed two opposite situations: an agent that ran and whose ref we never
 *  learned, and an agent that DIED BEFORE IT EVER OPENED A CONVERSATION —
 *  Codex exiting into its own updater, the update failing, the row left with no
 *  way back. The second lost nothing by being started again, and was being
 *  offered deletion as its only exit. `neverBound` is the server's proof of
 *  that second case, so it now gets `relaunch`; `remove` keeps only the first,
 *  where a fresh start really would discard something. */
export function exitedRecovery(opts: {
  exitCode: number | undefined
  spawnFailure?: string
  isShell: boolean
  resumable: boolean
  /** Server PROOF that this launch never opened a conversation
   *  ({@link SessionMeta.neverBound}). Absence is not the opposite claim — it
   *  covers "we cannot vouch for this row" too, which is why it is only ever
   *  read as a reason to offer MORE than removal, never less. */
  neverBound?: boolean
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
  const action: ExitedAction = opts.isShell
    ? 'restart'
    : opts.resumable
      ? 'resume'
      : opts.neverBound
        ? 'relaunch'
        : 'remove'
  return { detail: cause, action }
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
