import type { SessionId } from '@podium/model'
import { execFile } from 'node:child_process'
import { hookEventName, hookString } from './hook-payload'

/**
 * Per-session git attribution capture [POD-98] — the daemon half of "did THIS
 * task commit?". The hook ingest sees every PreToolUse/PostToolUse; this module
 * brackets each Bash call with `rev-parse HEAD` and reports the delta's shas as
 * commits attributed to that session. The bracket is sound in a session-owned
 * worktree, but only advisory in a shared checkout: another session can advance
 * HEAD between its reads because Git's index lock serializes commits, not the
 * surrounding reads. The server therefore ignores this commit ledger for
 * shared-checkout counts and uses issue markers from commit history there.
 * Edit-tool file paths are reported as the session's touched set (feeds
 * gitState.dirtyOwn).
 *
 * All git calls are read-only ref lookups (no index, no lock) and run OFF the
 * hook response path — capture can never delay the agent.
 *
 * LATE ATTRIBUTION (POD-4308 C17): the bracket's reads are asynchronous. A slow
 * post-tool rev-parse/rev-list can resolve after the turn completed, after the
 * next turn started, or after the session's cwd moved. The result is still
 * attributed to its originating session via the contract's workspace
 * git-activity event, which the server admits lifecycle-independently (see
 * runtime-event-gate's workspace fence): auxiliary workspace events cannot be
 * discarded merely because a turn ended, are never relabelled as next-turn
 * work, and never reopen a closed turn. Ordering within a session is preserved
 * by the per-session chain; across turns the event carries the session's
 * identity, not a turn's, so the board attributes to the session's issue.
 *
 * GENERATION FENCE: a session cleared/rebound while reads are pending must not
 * attribute an old result to the replacement process reusing the same session
 * ID. clearSession bumps the session's generation; queued steps capture the
 * generation at enqueue time and drop the send when it no longer matches.
 * Edit-tool touched paths are synchronous (they never await rev-list) and send
 * immediately, so they need no fence — but their dedup set is still dropped on
 * clear so a replacement starts clean.
 */

export interface SessionGitActivityOut {
  type: 'sessionGitActivity'
  sessionId: SessionId
  commits?: string[]
  touched?: string[]
}

export interface GitCapture {
  onHookPayload(sessionId: SessionId, fields: Record<string, unknown> | null): void
  clearSession(sessionId: SessionId): void
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools whose shell access can create commits — bracket these with HEAD reads.
 * BashOutput only polls an already-running command and cannot create a commit
 * itself, so bracketing it pays two Git processes without adding attribution. */
const SHELL_TOOLS = new Set(['Bash'])

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5_000 }, (err, stdout) => {
      const out = stdout?.trim()
      resolve(!err && out ? out : null)
    })
  })
}

export function createGitCapture(opts: {
  send: (msg: SessionGitActivityOut) => void
  run?: (args: string[], cwd: string) => Promise<string | null>
}): GitCapture {
  const run = opts.run ?? runGit
  // HEAD at the session's last PreToolUse(shell) — the bracket's opening side.
  const preHead = new Map<string, Promise<string | null>>()
  // Per-session ordering: hook posts are async; a serial chain keeps each
  // session's pre→post pairs matched even when git lookups resolve late.
  const chains = new Map<string, Promise<void>>()
  // Already-reported touched paths, so edit churn doesn't re-send every save.
  const touchedSent = new Map<string, Set<string>>()
  // Sessions whose baseline registration was already sent.
  const registered = new Set<string>()
  // Generation fence against clear/rebind with pending reads: bumped on
  // clearSession, captured at enqueue, checked before send. An old result for
  // a rebound session ID is dropped rather than attributed to its replacement.
  const generations = new Map<string, number>()
  const generationOf = (sessionId: SessionId): number => generations.get(sessionId) ?? 0

  const enqueue = (sessionId: SessionId, step: () => Promise<void>): void => {
    const tail = chains.get(sessionId) ?? Promise.resolve()
    const gen = generationOf(sessionId)
    const next = tail
      .then(async () => {
        // Fence A — queued-step drop: a clear/rebind that lands while this
        // step is still queued behind the chain tail must not start it. This
        // is the ONLY pre-start fence; the per-step pre-run checks that used
        // to sit as the first line inside register/post steps were removed as
        // unreachable duplicates — step() is invoked synchronously in this
        // same microtask with a generation captured synchronously at the same
        // enqueue, so no clearSession can interleave between this check and
        // those inner checks (same value in, same value out; when this check
        // fails the step body never runs). Intermediate fences below are
        // pinned by run-call counts (they save stale git reads), the terminal
        // fences by absence of send.
        if (generationOf(sessionId) !== gen) return
        await step()
      })
      .catch(() => {})
    chains.set(sessionId, next)
  }

  const register = (sessionId: SessionId, cwd: string): void => {
    if (registered.has(sessionId)) return
    registered.add(sessionId)
    const gen = generationOf(sessionId)
    enqueue(sessionId, async () => {
      // (Pre-start duplicate removed: fence A above already covers the
      // queued window; see its comment.)
      // Only register sessions that actually sit in a git checkout: the empty
      // message flips the issue's probes out of fallback mode, which would be
      // a lie for a session git can't see.
      const head = await run(['rev-parse', 'HEAD'], cwd)
      // Fence C — register post-read drop: clear/rebind during the rev-parse.
      if (generationOf(sessionId) !== gen) return
      if (head !== null) opts.send({ type: 'sessionGitActivity', sessionId })
    })
  }

  return {
    onHookPayload(sessionId, fields) {
      if (!fields) return
      // Claude/Codex send snake_case; Grok Build native hooks use camelCase.
      // Read both so Grok's Bash calls get the same commit attribution. [spec:SP-79c5]
      const event = hookEventName(fields)
      const cwd = typeof fields.cwd === 'string' && fields.cwd !== '' ? fields.cwd : null
      if (event === undefined || cwd === null) return
      const toolName = hookString(fields, 'tool_name', 'toolName') ?? ''

      if (event === 'SessionStart') {
        register(sessionId, cwd)
        return
      }
      if (event === 'PreToolUse' && SHELL_TOOLS.has(toolName)) {
        register(sessionId, cwd)
        preHead.set(sessionId, run(['rev-parse', 'HEAD'], cwd))
        return
      }
      if (event === 'PostToolUse' && SHELL_TOOLS.has(toolName)) {
        const opened = preHead.get(sessionId)
        if (!opened) return
        preHead.delete(sessionId)
        const gen = generationOf(sessionId)
        enqueue(sessionId, async () => {
          // (Pre-start duplicate removed here too: fence A covers the queued
          // window, and this step issues no git read before its first await
          // on `opened`, so only the post-await fence below can save work.)
          const before = await opened
          // Fence E — post pre-read drop: clear/rebind while waiting on the
          // pre-tool HEAD (no post rev-parse must be issued for stale `before`).
          if (generationOf(sessionId) !== gen) return
          if (before === null) return
          const after = await run(['rev-parse', 'HEAD'], cwd)
          // Fence F — post post-read drop: clear/rebind during the post
          // rev-parse (no rev-list must be issued mixing stale `before`).
          if (generationOf(sessionId) !== gen) return
          if (after === null || after === before) return
          // Oldest-first sha list of what this call produced. A rebase/amend
          // rewrites history (before no longer reachable) — rev-list fails and
          // we fall back to reporting just the new head.
          const list = await run(['rev-list', '--reverse', `${before}..${after}`], cwd)
          // Fence G — post list-read drop: clear/rebind during rev-list (the
          // stale sha list must never be sent to the replacement).
          if (generationOf(sessionId) !== gen) return
          const commits = list !== null ? list.split('\n').filter(Boolean) : [after]
          if (commits.length > 0) opts.send({ type: 'sessionGitActivity', sessionId, commits })
        })
        return
      }
      if (event === 'PostToolUse' && EDIT_TOOLS.has(toolName)) {
        register(sessionId, cwd)
        const input = fields.tool_input as Record<string, unknown> | null | undefined
        const filePath =
          typeof input?.file_path === 'string'
            ? input.file_path
            : typeof input?.notebook_path === 'string'
              ? input.notebook_path
              : null
        if (filePath === null) return
        const sent = touchedSent.get(sessionId) ?? new Set<string>()
        if (sent.has(filePath)) return
        sent.add(filePath)
        touchedSent.set(sessionId, sent)
        opts.send({ type: 'sessionGitActivity', sessionId, touched: [filePath] })
      }
    },
    clearSession(sessionId) {
      preHead.delete(sessionId)
      chains.delete(sessionId)
      touchedSent.delete(sessionId)
      registered.delete(sessionId)
      // Bump, don't just drop: queued callbacks captured the prior generation
      // and will see the mismatch before they send. Deleting the chain alone
      // would leave an already-running step's send intact.
      generations.set(sessionId, generationOf(sessionId) + 1)
    },
  }
}
