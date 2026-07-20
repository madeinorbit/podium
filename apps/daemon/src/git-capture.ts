import { execFile } from 'node:child_process'

/**
 * Per-session git attribution capture [POD-98] — the daemon half of "did THIS
 * task commit?". The hook ingest sees every PreToolUse/PostToolUse; this module
 * brackets each Bash call with `rev-parse HEAD` and reports the delta's shas as
 * commits ATTRIBUTED to that session — exact however many sessions share the
 * checkout, because each delta is measured around one session's own call (and
 * git's index lock serializes the commits themselves). Edit-tool file paths are
 * reported as the session's touched set (feeds gitState.dirtyOwn).
 *
 * All git calls are read-only ref lookups (no index, no lock) and run OFF the
 * hook response path — capture can never delay the agent.
 */

export interface SessionGitActivityOut {
  type: 'sessionGitActivity'
  sessionId: string
  commits?: string[]
  touched?: string[]
}

export interface GitCapture {
  onHookPayload(sessionId: string, fields: Record<string, unknown> | null): void
  clearSession(sessionId: string): void
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools whose shell access can create commits — bracket these with HEAD reads. */
const SHELL_TOOLS = new Set(['Bash', 'BashOutput'])

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

  const enqueue = (sessionId: string, step: () => Promise<void>): void => {
    const tail = chains.get(sessionId) ?? Promise.resolve()
    const next = tail.then(step).catch(() => {})
    chains.set(sessionId, next)
  }

  const register = (sessionId: string, cwd: string): void => {
    if (registered.has(sessionId)) return
    registered.add(sessionId)
    enqueue(sessionId, async () => {
      // Only register sessions that actually sit in a git checkout: the empty
      // message flips the issue's probes out of fallback mode, which would be
      // a lie for a session git can't see.
      const head = await run(['rev-parse', 'HEAD'], cwd)
      if (head !== null) opts.send({ type: 'sessionGitActivity', sessionId })
    })
  }

  return {
    onHookPayload(sessionId, fields) {
      if (!fields) return
      const event = fields.hook_event_name
      const cwd = typeof fields.cwd === 'string' && fields.cwd !== '' ? fields.cwd : null
      if (typeof event !== 'string' || cwd === null) return
      const toolName = typeof fields.tool_name === 'string' ? fields.tool_name : ''

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
        enqueue(sessionId, async () => {
          const before = await opened
          if (before === null) return
          const after = await run(['rev-parse', 'HEAD'], cwd)
          if (after === null || after === before) return
          // Oldest-first sha list of what this call produced. A rebase/amend
          // rewrites history (before no longer reachable) — rev-list fails and
          // we fall back to reporting just the new head.
          const list = await run(['rev-list', '--reverse', `${before}..${after}`], cwd)
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
    },
  }
}
