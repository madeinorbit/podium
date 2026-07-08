/**
 * The superagent's orchestrator tool belt (modules/superagent): the tool specs +
 * implementations shared by the MCP surface (mcpToolSpecs/callMcpTool) and the
 * harness allowlist, plus the concierge confirmed-gate wrapping.
 */
import { isAgentKind, WorkState } from '@podium/protocol'
import type { TranscriptItem } from '@podium/protocol'
import { createIssue, moveIssue, searchIssues } from '../../linear'
import type { LlmTool } from '../../llm'
import type { McpToolProvider } from '../../mcp-route'
import type { RegistryModules } from '../../relay'
import { searchAll } from '../../search'
import type { SessionStore } from '../../store'

/** MCP server name the harness agent sees Podium's tools under (→ tool ids
 *  `mcp__podium__<tool>`). Header carries the access token to the in-process route. */
export const MCP_SERVER_NAME = 'podium'
export const MCP_TOKEN_HEADER = 'x-podium-mcp-token'
/** Per-invocation thread identity (issue #67): an opaque token the mcp-config
 *  carries so the HTTP MCP route can resolve which superagent thread the harness
 *  agent runs for — never the raw threadId, so callers can't claim one. */
export const MCP_THREAD_HEADER = 'x-podium-mcp-thread'
/** Read-only built-in tools the harness orchestrator may use headlessly without a
 *  permission prompt (alongside the Podium MCP tools). */
const HARNESS_BUILTIN_ALLOWED = ['Read', 'Grep', 'Glob']

/** The harness agent's `--allowedTools` belt: the read-only builtins plus every
 *  Podium MCP tool. Prefer the full composite tool set (superagent ⊕ issue) the
 *  server advertised; fall back to the superagent's own tools when unknown. */
export function harnessAllowedTools(
  allToolNames: string[] | undefined,
  ownToolNames: string[],
): string[] {
  return [
    ...HARNESS_BUILTIN_ALLOWED,
    ...(allToolNames ?? ownToolNames).map((name) => `mcp__${MCP_SERVER_NAME}__${name}`),
  ]
}

/** Tools that spawn (or lead directly to spawning) an agent session. On concierge
 *  threads these carry a belt-and-braces `confirmed` arg: the system prompt tells
 *  the model to set it only after the user explicitly said "go" IN this
 *  conversation, and the tool refuses without it. The real rule is prompt-level
 *  (interactive-only, no auto-dispatch); this is a cheap code-level backstop. */
export const START_CAPABLE_TOOLS = new Set([
  'start_agent',
  'issue_start',
  'issue_add_session',
  'issue_add_shell',
])
export const NOT_CONFIRMED_MSG =
  'not confirmed — ask the user first. Session-starting tools on this thread require ' +
  '{"confirmed": true}, which you may pass only after the user explicitly told you to ' +
  'start in THIS conversation.'
/** issue_create is always allowed (filing issues is safe), EXCEPT with start:true,
 *  which spawns a session — that path takes the same confirmed gate. */
const CREATE_WITH_START_TOOL = 'issue_create'

export type Args = Record<string, unknown>

export interface SuperagentTool {
  spec: LlmTool
  run: (args: Args) => Promise<string>
}

export interface SuperagentToolDeps {
  modules: RegistryModules
  repos: { list(): string[] }
  store: SessionStore
  /** How often wait_for_session re-checks the event log. */
  waitPollMs: number
  /** Issue-tracker tools (issue-mcp's IssueToolProvider) bridged into the belt. */
  issueTools?: McpToolProvider | undefined
}

/**
 * Build the orchestrator tool belt. `threadId` (when known) sharpens session
 * provenance to 'superagent:<threadId>' and attaches the concierge
 * confirmed-gate; identity-less callers fail closed on start-capable tools.
 */
export function buildSuperagentTools(
  deps: SuperagentToolDeps,
  linearKey: string,
  threadId?: string,
  opts?: { issueBelt?: boolean },
): SuperagentTool[] {
  const { modules, repos, store, waitPollMs } = deps
  const sessions = modules.sessions
  const issues = modules.issues
  const rpc = modules.rpc
  // Session provenance (issue #60): thread-scoped when the executing thread is known.
  const spawnedBy = threadId ? `superagent:${threadId}` : 'superagent'
  const getSession = (id: string) => sessions.listSessions().find((s) => s.sessionId === id)
  const tools: SuperagentTool[] = [
    {
      spec: {
        name: 'list_sessions',
        description:
          'List all agent/shell sessions: id, name, kind, cwd, status, agent phase, ' +
          'last activity, provenance (spawnedBy), snooze state, and the tracker issue ' +
          'the session works in (boundIssue: {seq, title}), when its cwd is inside an ' +
          'issue worktree.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () =>
        JSON.stringify(
          sessions.listSessions().map((s) => {
            // Reverse of issue_show's session list (issue #72): session cwd →
            // bound issue, via the same worktree-containment rule as authz scope.
            const issueId = issues.issueForCwd(s.cwd)
            const issue = issueId ? issues.get(issueId) : null
            return {
              sessionId: s.sessionId,
              name: s.name ?? s.title,
              kind: s.agentKind,
              cwd: s.cwd,
              status: s.status,
              phase: s.agentState?.phase ?? 'unknown',
              archived: s.archived,
              lastActiveAt: s.lastActiveAt,
              // Provenance + snooze (issue #62): who created it, and whether it's
              // parked out of the attention flow (null = until next message).
              spawnedBy: s.spawnedBy,
              snoozedUntil: s.snoozedUntil,
              ...(issue ? { boundIssue: { seq: issue.seq, title: issue.title } } : {}),
            }
          }),
        ),
    },
    {
      spec: {
        name: 'list_repos',
        description: 'List registered repositories with their worktrees and branches.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => {
        const r = await rpc.scanRepos(repos.list(), { includeHome: false, maxDepth: 0 })
        return JSON.stringify(
          r.repositories.map((repo) => ({
            path: repo.path,
            branch: repo.branch,
            worktrees: repo.worktrees.map((w) => ({ path: w.path, branch: w.branch })),
          })),
        )
      },
    },
    {
      spec: {
        name: 'start_agent',
        description:
          'Start a new interactive agent (or shell) session in a directory. Runs on the ' +
          'user subscription. Pass cwd OR issueId (with issueId the cwd is derived from ' +
          'the issue and need not be given).',
        parameters: {
          type: 'object',
          properties: {
            agentKind: {
              type: 'string',
              enum: ['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell'],
            },
            cwd: {
              type: 'string',
              description: 'absolute worktree/repo path (omit when issueId is given)',
            },
            name: { type: 'string', description: 'optional display name' },
            title: { type: 'string', description: 'optional session title (shown in the UI)' },
            issueId: {
              type: 'string',
              description:
                'optional issue ref (id or display seq); replaces cwd. Started issue: ' +
                'spawn in its worktree. Unstarted: start the issue (worktree + agent) instead.',
            },
            firstMessage: {
              type: 'string',
              description: 'optional prompt typed into the agent once it starts',
            },
          },
          required: ['agentKind'],
        },
      },
      run: async (args) => {
        const agentKind = str(args.agentKind)
        let cwd = str(args.cwd)
        const issueRef = str(args.issueId)
        if (!isAgentKind(agentKind)) return 'invalid agentKind'
        if (issueRef) {
          const issue = issues.get(issueRef)
          if (!issue) return `unknown issue: ${issueRef}`
          if (issue.worktreePath) {
            cwd = issue.worktreePath // spawn alongside the issue's work
          } else {
            // Not started yet — issues.start owns the whole flow (worktree, branch,
            // agent spawn with the description as first prompt, provenance issue:<id>).
            const started = await issues.start(issue.id, agentKind)
            const spawned = sessions
              .listSessions()
              .find((s) => s.cwd === started.worktreePath && s.status !== 'exited')
            return JSON.stringify({
              ...(spawned ? { sessionId: spawned.sessionId } : {}),
              cwd: started.worktreePath,
              agentKind,
              ...(spawned
                ? {}
                : {
                    note: 'issue started; its session is still registering — list_sessions to find it',
                  }),
            })
          }
        }
        // Reached only on the direct-cwd path (a started issue rewrote cwd above;
        // an unstarted one returned). cwd is required exactly when issueId is absent.
        if (!cwd) return 'pass cwd or issueId (with issueId the cwd is derived from the issue)'
        const title = str(args.title)
        const { sessionId } = sessions.createSession({
          agentKind,
          cwd,
          ...(title ? { title } : {}),
          spawnedBy,
        })
        if (str(args.name)) sessions.renameSession({ sessionId, name: str(args.name) ?? '' })
        const first = str(args.firstMessage)
        if (first) {
          // Durable queued send: delivers once the CLI settles, survives a failed
          // spawn attempt AND a server restart (unlike the old in-memory timer).
          sessions.queueText({ sessionId, text: first })
        }
        return JSON.stringify({ sessionId, cwd, agentKind })
      },
    },
    {
      spec: {
        name: 'send_to_agent',
        description: 'Type a message into a running session, as if the user typed it.',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' }, text: { type: 'string' } },
          required: ['sessionId', 'text'],
        },
      },
      run: async (args) => {
        const r = sessions.sendText({
          sessionId: str(args.sessionId) ?? '',
          text: str(args.text) ?? '',
        })
        return r.ok ? 'sent' : 'failed: session not running'
      },
    },
    {
      spec: {
        name: 'answer_question',
        description:
          'Answer a pending AskUserQuestion prompt on a session. Pass the chosen option ' +
          'by its label or its 1-based number ("2", or "1,3" for multi-select).',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            answer: {
              type: 'string',
              description: 'option label, or 1-based option number(s) like "2" or "1,3"',
            },
          },
          required: ['sessionId', 'answer'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        const answer = str(args.answer) ?? ''
        const session = getSession(sessionId)
        if (!session) return 'unknown session'
        // Gate on a LIVE pending menu before touching the PTY: the claude-code
        // classifier resolves an unresolved AskUserQuestion as needs_user with
        // need.kind 'question' (agent-bridge ask_user_tool label) — the ONLY
        // shape a real on-screen menu produces. idle+idle.kind 'question' is a
        // textual question (no menu; digits would land as message text), and a
        // working agent must never get stray digits/Enter mid-turn from a stale
        // menu still sitting in the transcript tail.
        const state = session.agentState
        if (!(state?.phase === 'needs_user' && state.need?.kind === 'question')) {
          return `no pending question (phase=${state?.phase ?? 'unknown'})`
        }
        // The live prompt's options live in the transcript: the LAST
        // AskUserQuestion call carries them as structured toolInputJson (the same
        // source the chat card renders from).
        const { items } = await rpc.readTranscript({
          sessionId,
          direction: 'before',
          limit: 50,
        })
        const q = [...items]
          .reverse()
          .find((i) => i.role === 'tool' && i.toolName === 'AskUserQuestion' && i.toolInputJson)
        if (!q) return 'no pending AskUserQuestion found in the transcript tail'
        let questions: Array<{
          question?: string
          multiSelect?: boolean
          options?: Array<{ label?: string }>
        }> = []
        try {
          const parsed = JSON.parse(q.toolInputJson ?? '{}') as { questions?: unknown }
          if (Array.isArray(parsed?.questions)) questions = parsed.questions
        } catch {}
        if (questions.length === 0) return 'pending question has no parseable options'
        // One choice entry per question (the registry types digits into the
        // native menu). The single answer text is resolved against each
        // question's options — the dominant case is a single question.
        const choices: { optionIndices: number[] }[] = []
        const notes: string[] = []
        for (const qq of questions) {
          const labels = (qq.options ?? []).map((o) => o.label ?? '')
          const idx = matchAnswerToOptions(answer, labels)
          if (idx.length === 0) {
            return `could not match ${JSON.stringify(answer)} to the options: ${labels
              .map((l, i) => `${i + 1}) ${l}`)
              .join(', ')}`
          }
          // The native menu takes single digits — the relay silently drops
          // indices outside 1-9, so fail loudly here instead of reporting a
          // success that never reached the agent.
          const over = idx.find((n) => n > 9)
          if (over !== undefined) {
            return `option ${over} is beyond the native menu's 1-9 range — answer by label instead`
          }
          if (!qq.multiSelect && idx.length > 1) {
            notes.push(`single-select — used first of ${idx.join(',')}`)
          }
          choices.push({ optionIndices: qq.multiSelect ? idx : idx.slice(0, 1) })
        }
        const r = sessions.answerAskUserQuestion({ sessionId, choices })
        if (!r.ok) return 'failed: session not running'
        return JSON.stringify({
          answered: true,
          choices,
          ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        })
      },
    },
    {
      spec: {
        name: 'resume_and_send',
        description:
          'Deliver a message to a session even if it is parked (hibernated/exited): ' +
          'wakes it when needed and types the text once the CLI is ready.',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' }, text: { type: 'string' } },
          required: ['sessionId', 'text'],
        },
      },
      run: async (args) => {
        const r = sessions.resumeAndSend({
          sessionId: str(args.sessionId) ?? '',
          text: str(args.text) ?? '',
        })
        return r.ok
          ? 'sent (queued for delivery if the session is still waking)'
          : `failed: ${r.reason ?? 'unknown'}`
      },
    },
    {
      spec: {
        name: 'continue_session',
        description:
          "Nudge an errored agent to retry (types 'continue' into it). Only works on a " +
          'running session whose phase is errored.',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        if (!getSession(sessionId)) return 'unknown session'
        const r = sessions.continueSession({ sessionId })
        return r.ok ? 'sent continue' : 'failed: session must be running and in the errored phase'
      },
    },
    {
      spec: {
        name: 'hibernate_session',
        description:
          'Gracefully park a live session: kill its process but keep the row, transcript, ' +
          'and resume ref so it can be woken later (vs kill_session, which removes it).',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        const r = sessions.hibernateSession({ sessionId: str(args.sessionId) ?? '' })
        return r.ok ? 'hibernated' : `failed: ${r.reason ?? 'unknown'}`
      },
    },
    {
      spec: {
        name: 'snooze_session',
        description:
          "Snooze a session out of the NEEDS ATTENTION list. until: 'next-message' " +
          '(until it next speaks) or an ISO timestamp.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            until: {
              type: 'string',
              description: "'next-message' or an ISO 8601 timestamp",
            },
          },
          required: ['sessionId', 'until'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        const until = str(args.until) ?? ''
        if (!getSession(sessionId)) return 'unknown session'
        // null = until next message (SessionMeta.snoozedUntil semantics).
        const value = until === 'next-message' ? null : until
        if (value !== null && Number.isNaN(Date.parse(value))) {
          return `invalid until: pass 'next-message' or an ISO timestamp, got ${JSON.stringify(until)}`
        }
        sessions.setSnooze({ sessionId, until: value })
        return JSON.stringify({ snoozedUntil: value })
      },
    },
    {
      spec: {
        name: 'clear_snooze',
        description: 'Clear a snooze, returning the session to the normal attention flow.',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        if (!getSession(sessionId)) return 'unknown session'
        sessions.clearSnooze(sessionId)
        return 'snooze cleared'
      },
    },
    {
      spec: {
        name: 'rename_session',
        description: 'Set the user-facing name of a session (empty string clears it).',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' }, name: { type: 'string' } },
          required: ['sessionId', 'name'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        if (!getSession(sessionId)) return 'unknown session'
        sessions.renameSession({
          sessionId,
          name: typeof args.name === 'string' ? args.name : '',
        })
        return 'renamed'
      },
    },
    {
      spec: {
        name: 'set_work_state',
        description:
          "Set a session's kanban work state: planning | implementing | testing | done | icebox.",
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            workState: { type: 'string', enum: [...WorkState.options] },
          },
          required: ['sessionId', 'workState'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        const parsed = WorkState.safeParse(args.workState)
        if (!parsed.success) {
          return `invalid workState: expected one of ${WorkState.options.join(' | ')}`
        }
        if (!getSession(sessionId)) return 'unknown session'
        sessions.setWorkState({ sessionId, workState: parsed.data })
        return JSON.stringify({ workState: parsed.data })
      },
    },
    {
      spec: {
        name: 'wait_for_session',
        description:
          "Block until a session's agent phase changes (e.g. finishes working), up to " +
          'timeoutSeconds (default 60, max 120). Returns the new phase, or a timeout note. ' +
          'If the session is already settled (idle/needs_user/errored/ended) it returns ' +
          'that phase immediately. Waiting blocks this thread for up to timeoutSeconds — ' +
          'prefer short timeouts and re-check rather than one long wait.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            timeoutSeconds: {
              type: 'number',
              description: 'default 60, max 120',
            },
          },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        const sessionId = str(args.sessionId) ?? ''
        if (!getSession(sessionId)) return 'unknown session'
        const timeoutS = Math.min(120, Math.max(0, num(args.timeoutSeconds) ?? 60))
        // Already settled? Answer from the current state without waiting — the
        // event log only carries TRANSITIONS, so an agent that finished before
        // this call would otherwise sit out the full timeout.
        const cur = getSession(sessionId)?.agentState
        if (
          cur &&
          (cur.phase === 'idle' ||
            cur.phase === 'needs_user' ||
            cur.phase === 'errored' ||
            cur.phase === 'ended')
        ) {
          return JSON.stringify({
            phase: cur.phase,
            ...(cur.idle?.kind ? { verdict: cur.idle.kind } : {}),
          })
        }
        // Watch the durable event log from "now": session.phase rows are appended
        // on every real phase transition (subject = sessionId), so polling the
        // cursor catches the change even across a busy log. Never throws.
        const since = store.events.maxEventId()
        const deadline = Date.now() + timeoutS * 1000
        while (Date.now() < deadline) {
          const evs = store
            .events.listEventsSince(since, { kinds: ['session.phase'] })
            .filter((e) => e.subject === sessionId)
          const last = evs[evs.length - 1]
          if (last) {
            const p = last.payload as { phase?: string; verdict?: string }
            return JSON.stringify({
              phase: p.phase ?? 'unknown',
              ...(p.verdict ? { verdict: p.verdict } : {}),
            })
          }
          await sleep(Math.min(waitPollMs, Math.max(0, deadline - Date.now())))
        }
        const phase = getSession(sessionId)?.agentState?.phase ?? 'unknown'
        return `timeout after ${timeoutS}s (session still ${phase})`
      },
    },
    {
      spec: {
        name: 'kill_session',
        description: 'Stop a session and remove it. Destructive — only on explicit user ask.',
        parameters: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        sessions.killSession({ sessionId: str(args.sessionId) ?? '' })
        return 'killed'
      },
    },
    {
      spec: {
        name: 'read_session_transcript',
        description:
          "Read the tail of a session's structured transcript. Works for live, " +
          'hibernated, and exited sessions (reads disk when not live).',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            lastN: { type: 'number', description: 'items from the end, default 30, max 100' },
          },
          required: ['sessionId'],
        },
      },
      run: async (args) => {
        const lastN = Math.min(100, Math.max(1, num(args.lastN) ?? 30))
        // The latest window off disk; 'before' with no anchor returns the newest items.
        const { items } = await rpc.readTranscript({
          sessionId: str(args.sessionId) ?? '',
          direction: 'before',
          limit: lastN,
        })
        const tail = items.slice(-lastN)
        if (tail.length === 0) return '(no transcript found for this session)'
        return tail.map(renderTranscriptItem).join('\n')
      },
    },
    {
      spec: {
        name: 'search_conversations',
        description: 'Keyword search over all indexed past conversations.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            projectPath: { type: 'string', description: 'optional repo/worktree filter' },
          },
          required: ['query'],
        },
      },
      run: async (args) =>
        JSON.stringify(
          modules.conversations.searchConversations({
            query: str(args.query) ?? '',
            ...(str(args.projectPath) ? { projectPath: str(args.projectPath) } : {}),
            limit: 15,
          }),
        ),
    },
    {
      spec: {
        name: 'search_all',
        description:
          'Omni-search across everything Podium knows: sessions, issues (+comments), ' +
          'past conversations, transcript full-text, settings. One ranked, typed result ' +
          'list — the same search the UI omni-search uses. Use it to ground new work in ' +
          'prior work before filing or starting anything.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            kinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['session', 'issue', 'conversation', 'transcript', 'setting'],
              },
              description: 'optional filter to these result kinds',
            },
            limit: { type: 'number', description: 'max results, default 20, max 50' },
          },
          required: ['query'],
        },
      },
      run: async (args) => {
        const query = str(args.query)
        if (!query) return 'missing query'
        const limit = Math.min(50, Math.max(1, num(args.limit) ?? 20))
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((k): k is string => typeof k === 'string')
          : undefined
        // A kind filter drops hits AFTER ranking, so over-fetch to keep the
        // filtered list full (searchAll caps its own limit at 100).
        const raw = searchAll(
          store,
          { listSessions: () => sessions.listSessions(), issues },
          {
            text: query,
            limit: kinds && kinds.length > 0 ? 100 : limit,
          },
        )
        const results = (
          kinds && kinds.length > 0 ? raw.filter((r) => kinds.includes(r.kind)) : raw
        ).slice(0, limit)
        if (results.length === 0) return '(no results)'
        const lines = results.map((r) => {
          // Issues read by display seq (what users and issue_* tools speak).
          const seq = r.kind === 'issue' ? issues.get(r.id)?.seq : undefined
          const ref = seq !== undefined ? `#${seq}` : r.id
          return `[${r.kind}] ${r.title}${r.snippet ? ` — ${r.snippet}` : ''} (${ref})`
        })
        return `${lines.join('\n')}\n\n${JSON.stringify(results)}`
      },
    },
    {
      spec: {
        name: 'git',
        description: 'Run a constrained git op in a directory: status | log | branches.',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['status', 'log', 'branches'] },
            cwd: { type: 'string' },
          },
          required: ['op', 'cwd'],
        },
      },
      run: async (args) => {
        const op = str(args.op)
        if (op !== 'status' && op !== 'log' && op !== 'branches') return 'invalid op'
        const r = await rpc.repoOp(op, str(args.cwd) ?? '')
        return r.ok ? r.output || '(clean)' : `failed: ${r.output}`
      },
    },
    {
      spec: {
        name: 'create_worktree',
        description:
          'Create a new git worktree (new branch) next to the repo, ready for an agent.',
        parameters: {
          type: 'object',
          properties: {
            repoPath: { type: 'string' },
            branch: { type: 'string', description: 'new branch name, e.g. feat/login' },
          },
          required: ['repoPath', 'branch'],
        },
      },
      run: async (args) => {
        const repoPath = str(args.repoPath)
        const branch = str(args.branch)
        if (!repoPath || !branch) return 'missing repoPath/branch'
        const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
        const path = `${repoPath}-${safe}`
        const r = await rpc.repoOp('worktreeAdd', repoPath, { path, branch })
        return r.ok ? JSON.stringify({ worktreePath: path, branch }) : `failed: ${r.output}`
      },
    },
  ]
  if (linearKey) {
    tools.push(
      {
        spec: {
          name: 'linear_search',
          description: 'Search Linear issues by text.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
        run: async (args) => JSON.stringify(await searchIssues(linearKey, str(args.query) ?? '')),
      },
      {
        spec: {
          name: 'linear_create',
          description: 'Create a Linear issue on a team (by team key, e.g. ENG).',
          parameters: {
            type: 'object',
            properties: {
              teamKey: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['teamKey', 'title'],
          },
        },
        run: async (args) =>
          JSON.stringify(
            await createIssue(linearKey, {
              teamKey: str(args.teamKey) ?? '',
              title: str(args.title) ?? '',
              ...(str(args.description) ? { description: str(args.description) } : {}),
            }),
          ),
      },
      {
        spec: {
          name: 'linear_move',
          description: 'Move a Linear issue (by identifier, e.g. ENG-123) to a workflow state.',
          parameters: {
            type: 'object',
            properties: { issueId: { type: 'string' }, stateName: { type: 'string' } },
            required: ['issueId', 'stateName'],
          },
        },
        run: async (args) =>
          JSON.stringify(
            await moveIssue(linearKey, {
              issueId: str(args.issueId) ?? '',
              stateName: str(args.stateName) ?? '',
            }),
          ),
      },
    )
  }
  // Issue tracker tools bridged from the MCP provider (issue #64): execution goes
  // through the same callMcpTool path as the MCP surface, so behavior is
  // identical. Skipped for mcpToolSpecs when the composite MCP provider already
  // advertises them.
  if (opts?.issueBelt && deps.issueTools) {
    const issueProvider = deps.issueTools
    for (const spec of issueProvider.mcpToolSpecs()) {
      tools.push({
        spec: {
          name: spec.name,
          description: spec.description,
          parameters: spec.inputSchema as Record<string, unknown>,
        },
        run: (args) => issueProvider.callMcpTool(spec.name, args),
      })
    }
  }
  // Belt-and-braces on concierge threads: session-spawning tools require an
  // explicit confirmed:true (the prompt-level interactive-only rule is the real
  // gate; this backstop makes a stray model call fail closed instead of
  // spawning). `confirmed` is stripped before the underlying tool runs.
  // IDENTITY-LESS callers get the gate too (issue #67): when threadId is unknown
  // (an MCP call whose thread token is absent/unresolvable) we can't tell a
  // global thread from a concierge one, so spawn-capable tools fail closed
  // rather than open — the caller must pass confirmed:true explicitly. This is a
  // deliberate behavior change for thread-blind MCP callers; every legitimate
  // harness invocation now carries a thread token, so only strays are affected.
  // Non-spawning tools are untouched.
  if (threadId === undefined || threadId.startsWith('concierge_')) {
    for (const t of tools) {
      const isCreate = t.spec.name === CREATE_WITH_START_TOOL
      if (!START_CAPABLE_TOOLS.has(t.spec.name) && !isCreate) continue
      const inner = t.run
      const params = t.spec.parameters as {
        properties?: Record<string, unknown>
      }
      params.properties = {
        ...(params.properties ?? {}),
        confirmed: {
          type: 'boolean',
          description: isCreate
            ? 'REQUIRED true when start=true — pass only after the user explicitly confirmed starting in this conversation.'
            : 'REQUIRED true — pass only after the user explicitly confirmed starting in this conversation.',
        },
      }
      t.run = async (args) => {
        // Refuse BEFORE any mutation: an unconfirmed create --start files nothing.
        const needsConfirm = isCreate ? args.start === true : true
        if (needsConfirm && args.confirmed !== true) return NOT_CONFIRMED_MSG
        const { confirmed: _confirmed, ...rest } = args
        return inner(rest)
      }
    }
  }
  return tools
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

/**
 * Map a free-text answer to 1-based option indices for one AskUserQuestion:
 * bare number(s) win ("2", "1,3" — repeats deduped), then a case-insensitive
 * exact label match, then a UNIQUE case-insensitive substring match.
 * Empty result = no match.
 */
export function matchAnswerToOptions(answer: string, labels: string[]): number[] {
  const t = answer.trim()
  if (/^\d+(\s*,\s*\d+)*$/.test(t)) {
    const idx = [...new Set(t.split(',').map((s) => Number.parseInt(s.trim(), 10)))]
    return idx.every((n) => n >= 1 && n <= labels.length) ? idx : []
  }
  const lower = t.toLowerCase()
  const exact = labels.findIndex((l) => l.trim().toLowerCase() === lower)
  if (exact !== -1) return [exact + 1]
  const subs = labels.flatMap((l, i) => (l.toLowerCase().includes(lower) ? [i + 1] : []))
  return subs.length === 1 ? subs : []
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
// isAgentKind moved to @podium/protocol (#158) — the one wire-kind guard.

function renderTranscriptItem(item: TranscriptItem): string {
  if (item.role === 'tool') {
    if (item.toolName) return `[tool ${item.toolName}] ${item.toolInput ?? ''}`
    return `[result] ${(item.toolResult ?? '').slice(0, 300)}`
  }
  return `${item.role}: ${item.text.slice(0, 600)}`
}
