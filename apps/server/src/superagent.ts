import { type TranscriptItem, WorkState } from '@podium/protocol'
import { createIssue, moveIssue, searchIssues } from './linear'
import { LlmConfigError, type LlmMessage, type LlmTool, llmClient } from './llm'
import type { SessionRegistry } from './relay'
import type { RepoRegistry } from './repo-registry'
import type { SessionStore, SuperagentMessageRow, SuperagentThreadRow } from './store'

const MAX_TOOL_ROUNDS = 8
const HISTORY_WINDOW = 40
/** MCP server name the harness agent sees Podium's tools under (→ tool ids
 *  `mcp__podium__<tool>`). Header carries the access token to the in-process route. */
export const MCP_SERVER_NAME = 'podium'
export const MCP_TOKEN_HEADER = 'x-podium-mcp-token'
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

/**
 * Make a windowed message list valid for both provider adapters. Slicing the
 * persisted thread at a fixed row count can cut through a tool round, leaving an
 * orphan `tool` message at the front (its `tool_calls` fell out of the window)
 * or a trailing assistant whose tool results never arrived (a crash mid-turn).
 * OpenAI and Anthropic both 400 on either, so:
 *   - drop leading `tool` messages until the first message is user/assistant;
 *   - drop a trailing tool-calling assistant whose calls aren't all answered by
 *     following `tool` messages.
 * Complete rounds in the middle are always well-formed (runTurn writes them
 * atomically), so this only ever trims the two boundaries.
 */
export function sanitizeToolPairing(msgs: LlmMessage[]): LlmMessage[] {
  let start = 0
  while (start < msgs.length && msgs[start]?.role === 'tool') start++
  let out = msgs.slice(start)
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m?.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const answered = new Set(
        out.slice(i + 1).flatMap((x) => (x.role === 'tool' ? [x.toolCallId] : [])),
      )
      if (m.toolCalls.some((c) => !answered.has(c.id))) out = out.slice(0, i)
      break // the last tool-calling assistant is the only one that can dangle
    }
  }
  return out
}

const SYSTEM_PROMPT = `You are Podium's superagent — the orchestrator with cross-project context.
You manage real coding-agent sessions (Claude Code, Codex, Grok CLIs in PTYs), worktrees, and tickets
for a developer. You can start/steer/stop agents, inspect their transcripts, run constrained git
operations, search past conversations, and work Linear tickets.

Ground rules:
- Weigh each request: do small, well-scoped work YOURSELF with your tools — answer questions,
  inspect repos/sessions/history (git, read_session_transcript, search_conversations), run quick
  git queries, triage tickets. Don't spawn a worker agent for something you can finish in a tool
  call or two; that's slower and noisier than just doing it.
- Delegate to a worker agent only when the task is genuinely substantial: multi-file code changes,
  anything that needs to iterate/build/test, or long-running work. Worker agents run interactively
  on the user's subscriptions (only YOUR reasoning is metered), so they're the right tool for real
  coding — not a reflex for every request. When you do delegate, start it in the right worktree.
- Be concise. Use tools instead of guessing about repos, sessions, or history.
- @-references in the user's message (e.g. "@podium(/home/u/src/podium)") name repos, worktrees,
  or conversations the user picked from a context menu — the parenthesized part is the path/id.
- When you start an agent, tell the user its session name and where it runs.
- Destructive actions (killing sessions) only when clearly asked.`

export interface SuperagentTurn {
  messages: SuperagentMessageRow[]
  backendLabel: string
}

// ---- /btw seeding ------------------------------------------------------------

export interface BtwSessionInfo {
  sessionId: string
  name?: string
  agentKind?: string
  cwd?: string
}

/** One transcript item as a marked, length-bounded line (id + ts for awareness). */
function lineForItem(it: TranscriptItem): string {
  const stamp = `${it.ts ?? '?'} · ${it.id}`
  if (it.role === 'tool') {
    if (it.toolName) return `[${stamp}] ⚙ ${it.toolName} ${it.toolInput ?? ''}`.trim()
    return `[${stamp}] result: ${(it.toolResult ?? '').slice(0, 300)}`
  }
  return `[${stamp}] ${it.role}: ${it.text.slice(0, 600)}`
}

/**
 * Items the btw thread hasn't seen yet. Slices after the watermark item id; if
 * that id has fallen out of the transcript (rolled to a fresh file) or there's no
 * watermark, returns everything so the agent re-seeds rather than silently lose
 * context.
 */
export function transcriptDelta(
  items: TranscriptItem[],
  watermark: { itemId?: string },
): TranscriptItem[] {
  if (!watermark.itemId) return items
  const idx = items.findIndex((i) => i.id === watermark.itemId)
  if (idx === -1) return items
  return items.slice(idx + 1)
}

/**
 * A deterministic, zero-LLM recap of a transcript — turn counts, a tool-usage
 * histogram, and recently-touched files. Inspired by Hermes' build_recap (itself
 * after Claude Code's /recap): cheap, instant grounding so the agent (and the
 * orientation turn) start from facts instead of re-deriving them.
 */
export function buildBtwRecap(items: TranscriptItem[]): string {
  const users = items.filter((i) => i.role === 'user' && i.text.trim()).length
  const assistants = items.filter((i) => i.role === 'assistant' && i.text.trim()).length
  const toolItems = items.filter((i) => i.role === 'tool' && i.toolName)
  const hist = new Map<string, number>()
  for (const it of toolItems) {
    const name = it.toolName as string
    hist.set(name, (hist.get(name) ?? 0) + 1)
  }
  const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  // Files touched (best-effort): toolInput is a one-line preview, not structured
  // args, so pull the first path-like token from file-editing tools, newest first.
  const fileTools = new Set([
    'Edit',
    'Write',
    'Read',
    'MultiEdit',
    'NotebookEdit',
    'str_replace_based_edit_tool',
  ])
  const seen = new Set<string>()
  const files: string[] = []
  for (let i = toolItems.length - 1; i >= 0; i--) {
    const it = toolItems[i]
    if (!it || !fileTools.has(it.toolName as string)) continue
    const m = (it.toolInput ?? '').match(/[\w./@~-]*\.[A-Za-z]\w*/)
    const p = m?.[0]
    if (p && !seen.has(p)) {
      seen.add(p)
      files.push(p)
    }
  }
  const lines = [
    `Recap: ${users} user / ${assistants} assistant turns, ${toolItems.length} tool calls`,
  ]
  if (ranked.length > 0) {
    const top = ranked
      .slice(0, 6)
      .map(([n, c]) => `${n}×${c}`)
      .join(', ')
    const extra = ranked.length - 6
    lines.push(`Tools: ${top}${extra > 0 ? ` (+${extra} more)` : ''}`)
  }
  if (files.length > 0) {
    const extra = files.length - 5
    lines.push(`Files: ${files.slice(0, 5).join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`)
  }
  return lines.join('\n')
}

/**
 * The opening context for a new btw thread: a deterministic recap, an optional
 * summary, every user message verbatim (cheap + high-signal), and a recent
 * full-detail tail. Each line carries the item id + timestamp so the agent knows
 * how caught-up it is across re-opens. Budget-capped, trimming the tail
 * (oldest-first) before the user messages.
 */
export function buildBtwSeed(opts: {
  session: BtwSessionInfo
  summary?: string
  items: TranscriptItem[]
  maxChars?: number
  tailN?: number
}): string {
  const { session, summary, items } = opts
  const maxChars = opts.maxChars ?? 20_000
  const tailN = opts.tailN ?? 20
  const last = items[items.length - 1]
  const users = items.filter((i) => i.role === 'user' && i.text.trim())
  const head =
    `[BTW CONTEXT]\n` +
    `You were opened from a Podium chat session; help continue or reason about it. ` +
    `This is a digest — use read_session_transcript to pull the full transcript, plus ` +
    `search_conversations, start_agent, etc.\n\n` +
    `Session: ${session.name ?? session.sessionId} · ${session.agentKind ?? '?'} · ` +
    `${session.cwd ?? '?'} (id: ${session.sessionId})\n` +
    `Caught up to item ${last?.id ?? '(none)'} at ${last?.ts ?? '?'}.\n` +
    `\n${buildBtwRecap(items)}\n` +
    (summary ? `\nSummary: ${summary}\n` : '')
  const userBlock =
    `\nUser's messages (oldest→newest):\n` +
    users.map((u) => `- [${u.ts ?? '?'}] ${u.text.slice(0, 2000)}`).join('\n')
  // Tail trims oldest-first if the whole seed is over budget.
  let tail = items.slice(-tailN)
  let body = ''
  while (tail.length > 0) {
    body = `\n\nRecent activity (last ${tail.length} items):\n${tail.map(lineForItem).join('\n')}`
    if (head.length + userBlock.length + body.length <= maxChars) break
    tail = tail.slice(Math.ceil(tail.length / 4))
  }
  return (head + userBlock + body).slice(0, maxChars)
}

/** A re-open update: what changed in the origin session since the agent last looked. */
export function buildBtwDelta(opts: {
  prev: { itemId?: string; ts?: string }
  delta: TranscriptItem[]
  now: string
}): string {
  const last = opts.delta[opts.delta.length - 1]
  return (
    `[BTW UPDATE @ ${opts.now}]\n` +
    `Since you last looked (item ${opts.prev.itemId ?? '?'} at ${opts.prev.ts ?? '?'}), ` +
    `the user continued this session. ${opts.delta.length} new items:\n` +
    opts.delta.map(lineForItem).join('\n') +
    `\nNow caught up to item ${last?.id ?? '?'} at ${last?.ts ?? '?'}.`
  )
}

/**
 * The orchestrator with cross-project context. The always-there 'global' thread
 * plus per-session 'btw' threads, persisted in SQLite. The API-backed mode gets
 * the full tool belt; the harness-backed mode (codex subscription) is chat-only —
 * the daemon runs one-shot \`codex exec\`/\`claude -p\`.
 */
export class SuperagentService {
  // Per-thread serialization: a second send on a thread waits for the first (tools
  // mutate shared state), but the global thread and a btw thread don't block each other.
  private readonly busy = new Map<string, Promise<void>>()
  // Where a harness-backed agent reaches Podium's own tools over MCP. Set by the
  // server once it's listening (it knows its own HTTP port + the access token).
  private mcpEndpoint: { url: string; token: string; allToolNames?: string[] } | undefined

  /** How often wait_for_session re-checks the event log. Injectable for tests. */
  private readonly waitPollMs: number

  constructor(
    private readonly registry: SessionRegistry,
    private readonly repos: RepoRegistry,
    private readonly store: SessionStore,
    opts?: { waitPollMs?: number },
  ) {
    this.waitPollMs = opts?.waitPollMs ?? 2000
  }

  /** Point harness agents at the in-process MCP server (Podium's orchestrator
   *  tools). Called by the server after it binds its port. */
  setMcpEndpoint(url: string, token: string, allToolNames?: string[]): void {
    this.mcpEndpoint = { url, token, ...(allToolNames ? { allToolNames } : {}) }
  }

  /** Tool specs exposed over MCP — the same orchestrator tools the API tool-loop
   *  uses, in MCP's `{name, description, inputSchema}` shape. */
  mcpToolSpecs(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.tools(this.store.getSettings().integrations.linearApiKey).map((t) => ({
      name: t.spec.name,
      description: t.spec.description,
      inputSchema: t.spec.parameters,
    }))
  }

  /** Run one MCP tool call, returning its text output. `threadId` (when the caller
   *  knows it) sharpens session provenance to 'superagent:<threadId>'; the HTTP MCP
   *  route has no thread context, so it falls back to the bare 'superagent' tag. */
  async callMcpTool(name: string, args: Record<string, unknown>, threadId?: string): Promise<string> {
    const tool = this.tools(this.store.getSettings().integrations.linearApiKey, threadId).find(
      (t) => t.spec.name === name,
    )
    if (!tool) throw new Error(`unknown tool: ${name}`)
    return tool.run(args as Args)
  }

  private async withLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(threadId) ?? Promise.resolve()
    let release: () => void = () => {}
    this.busy.set(
      threadId,
      new Promise<void>((r) => {
        release = r
      }),
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  history(threadId = 'global'): SuperagentMessageRow[] {
    return this.store.loadSuperagentMessages(threadId)
  }

  clear(threadId = 'global'): void {
    if (threadId === 'global') this.store.clearSuperagentMessages('global')
    else this.store.archiveSuperagentThread(threadId)
  }

  listThreads(): SuperagentThreadRow[] {
    return this.store.listSuperagentThreads()
  }

  async send(threadId: string, text: string): Promise<SuperagentTurn> {
    return this.withLock(threadId, () => {
      const newMessages: SuperagentMessageRow[] = [
        this.store.appendSuperagentMessage(threadId, { role: 'user', content: text }),
      ]
      return this.generate(threadId, text, newMessages)
    })
  }

  /**
   * Open (or re-open) a btw thread for a chat session. New: seed it from the
   * session's transcript (live or disk) and run one orientation turn. Re-open: if
   * the source session advanced past the watermark, inject a marked delta so the
   * agent knows what changed since it last looked (no turn — it lands in context
   * for the user's next message).
   */
  async startBtw({
    sessionId,
  }: {
    sessionId: string
  }): Promise<{ threadId: string; isNew: boolean }> {
    const threadId = `btw_${sessionId}`
    const existing = this.store.getSuperagentThread(threadId)
    const info = this.registry.listSessions().find((s) => s.sessionId === sessionId)
    const session: BtwSessionInfo = {
      sessionId,
      name: info?.name ?? info?.title,
      agentKind: info?.agentKind,
      cwd: info?.cwd,
    }
    // Latest window off disk (no anchor + 'before' = the newest items). The seed is
    // char-budgeted, so a large recent window is plenty.
    const { items } = await this.registry.readTranscript({
      sessionId,
      direction: 'before',
      limit: 2000,
    })
    const last = items[items.length - 1]

    if (existing?.kind !== 'btw') {
      this.store.upsertSuperagentThread({
        id: threadId,
        kind: 'btw',
        originSessionId: sessionId,
        title: `btw · ${session.name ?? sessionId}`,
      })
      const seed = buildBtwSeed({ session, items })
      await this.withLock(threadId, async () => {
        this.store.appendSuperagentMessage(threadId, { role: 'user', content: seed })
        this.store.setThreadWatermark(threadId, last?.id ?? '', last?.ts)
        await this.generate(threadId, seed, [])
      })
      return { threadId, isNew: true }
    }

    const delta = transcriptDelta(items, { itemId: existing.watermarkItemId })
    if (delta.length > 0) {
      const update = buildBtwDelta({
        prev: { itemId: existing.watermarkItemId, ts: existing.watermarkTs },
        delta,
        now: new Date().toISOString(),
      })
      await this.withLock(threadId, async () => {
        this.store.appendSuperagentMessage(threadId, { role: 'user', content: update })
        this.store.setThreadWatermark(
          threadId,
          last?.id ?? existing.watermarkItemId ?? '',
          last?.ts,
        )
      })
    }
    return { threadId, isNew: false }
  }

  /**
   * Run the backend over the thread's current history (the latest user message is
   * already persisted) and record the assistant/tool turns. Returns this turn's
   * new messages.
   */
  private async generate(
    threadId: string,
    latestText: string,
    newMessages: SuperagentMessageRow[],
  ): Promise<SuperagentTurn> {
    const settings = this.store.getSettings()
    const backend = settings.superagent
    const record = (m: Omit<SuperagentMessageRow, 'id' | 'createdAt'>): SuperagentMessageRow => {
      const saved = this.store.appendSuperagentMessage(threadId, m)
      newMessages.push(saved)
      return saved
    }

    if (backend.kind === 'harness') {
      // Full harness: run the real agent CLI with its own tool belt + Podium's
      // orchestrator tools over MCP, injecting our system prompt (natively via
      // --append-system-prompt for Claude, else prepended). The conversation so far
      // is folded into the prompt, the same way the API path re-sends history.
      const prompt = this.renderHarnessPrompt(threadId, latestText)
      // MCP tool access is wired for Claude (the only harness with --mcp-config).
      const mcp =
        backend.harnessAgent === 'claude-code' && this.mcpEndpoint
          ? {
              mcpConfig: JSON.stringify({
                mcpServers: {
                  [MCP_SERVER_NAME]: {
                    type: 'http',
                    url: this.mcpEndpoint.url,
                    headers: { [MCP_TOKEN_HEADER]: this.mcpEndpoint.token },
                  },
                },
              }),
              allowedTools: harnessAllowedTools(
                this.mcpEndpoint.allToolNames,
                this.mcpToolSpecs().map((t) => t.name),
              ),
            }
          : undefined
      const result = await this.registry.harnessExec({
        agent: backend.harnessAgent,
        model: backend.harnessModel,
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        ...(mcp ?? {}),
      })
      record({
        role: 'assistant',
        content: result.ok
          ? result.output
          : `The ${backend.harnessAgent} harness run failed: ${result.output}`,
      })
      return { messages: newMessages, backendLabel: `${backend.harnessAgent} (subscription)` }
    }

    let client: ReturnType<typeof llmClient>
    try {
      client = llmClient(backend, settings.apiKeys)
    } catch (err) {
      record({
        role: 'assistant',
        content:
          err instanceof LlmConfigError
            ? `I can't run yet: ${err.message}`
            : `Backend error: ${err instanceof Error ? err.message : String(err)}`,
      })
      return { messages: newMessages, backendLabel: 'unconfigured' }
    }

    const tools = this.tools(settings.integrations.linearApiKey, threadId)
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.historyAsLlm(threadId),
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response: Awaited<ReturnType<typeof client.complete>>
      try {
        response = await client.complete(
          messages,
          tools.map((t) => t.spec),
        )
      } catch (err) {
        record({
          role: 'assistant',
          content: `Provider call failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return { messages: newMessages, backendLabel: client.label }
      }
      if (response.toolCalls.length === 0) {
        record({ role: 'assistant', content: response.text || '(empty reply)' })
        return { messages: newMessages, backendLabel: client.label }
      }
      const saved = record({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      })
      messages.push({
        role: 'assistant',
        content: saved.content,
        toolCalls: response.toolCalls,
      })
      for (const call of response.toolCalls) {
        const tool = tools.find((t) => t.spec.name === call.name)
        let output: string
        if (!tool) {
          output = `unknown tool: ${call.name}`
        } else {
          try {
            output = await tool.run(parseArgs(call.arguments))
          } catch (err) {
            output = `tool failed: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        output = output.length > 8000 ? `${output.slice(0, 8000)}…` : output
        record({ role: 'tool', content: output, toolCallId: call.id, toolName: call.name })
        messages.push({ role: 'tool', content: output, toolCallId: call.id, name: call.name })
      }
    }
    record({
      role: 'assistant',
      content: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer — ask me to continue if needed.`,
    })
    return { messages: newMessages, backendLabel: client.label }
  }

  private historyAsLlm(threadId: string): LlmMessage[] {
    const rows = this.store.loadSuperagentMessages(threadId, HISTORY_WINDOW)
    const out: LlmMessage[] = []
    for (const r of rows) {
      if (r.role === 'user') out.push({ role: 'user', content: r.content })
      else if (r.role === 'assistant')
        out.push({
          role: 'assistant',
          content: r.content,
          ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}),
        })
      else if (r.role === 'tool' && r.toolCallId)
        out.push({
          role: 'tool',
          content: r.content,
          toolCallId: r.toolCallId,
          name: r.toolName ?? 'tool',
        })
    }
    return sanitizeToolPairing(out)
  }

  /** Harness mode folds the recent conversation into one prompt per turn (the
   *  system prompt is injected separately, via harnessExec). The agent runs with
   *  its real tools, so this is the conversation transcript, not a tools-disabled
   *  fallback. */
  private renderHarnessPrompt(threadId: string, latest: string): string {
    const rows = this.store
      .loadSuperagentMessages(threadId, 12)
      .filter((r) => r.role === 'user' || r.role === 'assistant')
    const history = rows
      .slice(0, -1)
      .map((r) => `${r.role === 'user' ? 'User' : 'You'}: ${r.content}`)
      .join('\n\n')
    return `${history ? `Conversation so far:\n${history}\n\n` : ''}User: ${latest}`
  }

  private tools(
    linearKey: string,
    threadId?: string,
  ): { spec: LlmTool; run: (args: Args) => Promise<string> }[] {
    const registry = this.registry
    const repos = this.repos
    const store = this.store
    const waitPollMs = this.waitPollMs
    // Session provenance (issue #60): thread-scoped when the executing thread is known.
    const spawnedBy = threadId ? `superagent:${threadId}` : 'superagent'
    const getSession = (id: string) => registry.listSessions().find((s) => s.sessionId === id)
    const tools: { spec: LlmTool; run: (args: Args) => Promise<string> }[] = [
      {
        spec: {
          name: 'list_sessions',
          description:
            'List all agent/shell sessions: id, name, kind, cwd, status, agent phase, ' +
            'last activity, provenance (spawnedBy), snooze state.',
          parameters: { type: 'object', properties: {} },
        },
        run: async () =>
          JSON.stringify(
            registry.listSessions().map((s) => ({
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
            })),
          ),
      },
      {
        spec: {
          name: 'list_repos',
          description: 'List registered repositories with their worktrees and branches.',
          parameters: { type: 'object', properties: {} },
        },
        run: async () => {
          const r = await registry.scanRepos(repos.list(), { includeHome: false, maxDepth: 0 })
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
            const issue = registry.issues.get(issueRef)
            if (!issue) return `unknown issue: ${issueRef}`
            if (issue.worktreePath) {
              cwd = issue.worktreePath // spawn alongside the issue's work
            } else {
              // Not started yet — issues.start owns the whole flow (worktree, branch,
              // agent spawn with the description as first prompt, provenance issue:<id>).
              const started = await registry.issues.start(issue.id, agentKind)
              const spawned = registry
                .listSessions()
                .find((s) => s.cwd === started.worktreePath && s.status !== 'exited')
              return JSON.stringify({
                ...(spawned ? { sessionId: spawned.sessionId } : {}),
                cwd: started.worktreePath,
                agentKind,
                ...(spawned
                  ? {}
                  : { note: 'issue started; its session is still registering — list_sessions to find it' }),
              })
            }
          }
          // Reached only on the direct-cwd path (a started issue rewrote cwd above;
          // an unstarted one returned). cwd is required exactly when issueId is absent.
          if (!cwd) return 'pass cwd or issueId (with issueId the cwd is derived from the issue)'
          const title = str(args.title)
          const { sessionId } = registry.createSession({
            agentKind,
            cwd,
            ...(title ? { title } : {}),
            spawnedBy,
          })
          if (str(args.name)) registry.renameSession({ sessionId, name: str(args.name) ?? '' })
          const first = str(args.firstMessage)
          if (first) {
            // Durable queued send: delivers once the CLI settles, survives a failed
            // spawn attempt AND a server restart (unlike the old in-memory timer).
            registry.queueText({ sessionId, text: first })
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
          const r = registry.sendText({
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
          if (!getSession(sessionId)) return 'unknown session'
          // The live prompt's options live in the transcript: the LAST
          // AskUserQuestion call carries them as structured toolInputJson (the same
          // source the chat card renders from).
          const { items } = await registry.readTranscript({
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
          for (const qq of questions) {
            const labels = (qq.options ?? []).map((o) => o.label ?? '')
            const idx = matchAnswerToOptions(answer, labels)
            if (idx.length === 0) {
              return `could not match ${JSON.stringify(answer)} to the options: ${labels
                .map((l, i) => `${i + 1}) ${l}`)
                .join(', ')}`
            }
            choices.push({ optionIndices: qq.multiSelect ? idx : idx.slice(0, 1) })
          }
          const r = registry.answerAskUserQuestion({ sessionId, choices })
          return r.ok ? JSON.stringify({ answered: true, choices }) : 'failed: session not running'
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
          const r = registry.resumeAndSend({
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
          const r = registry.continueSession({ sessionId })
          return r.ok
            ? 'sent continue'
            : 'failed: session must be running and in the errored phase'
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
          const r = registry.hibernateSession({ sessionId: str(args.sessionId) ?? '' })
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
          registry.setSnooze({ sessionId, until: value })
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
          registry.clearSnooze(sessionId)
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
          registry.renameSession({
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
          registry.setWorkState({ sessionId, workState: parsed.data })
          return JSON.stringify({ workState: parsed.data })
        },
      },
      {
        spec: {
          name: 'wait_for_session',
          description:
            "Block until a session's agent phase changes (e.g. finishes working), up to " +
            'timeoutSeconds (default 60, max 120). Returns the new phase, or a timeout note.',
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
          // Watch the durable event log from "now": session.phase rows are appended
          // on every real phase transition (subject = sessionId), so polling the
          // cursor catches the change even across a busy log. Never throws.
          const since = store.maxEventId()
          const deadline = Date.now() + timeoutS * 1000
          while (Date.now() < deadline) {
            const evs = store
              .listEventsSince(since, { kinds: ['session.phase'] })
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
          registry.killSession({ sessionId: str(args.sessionId) ?? '' })
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
          const { items } = await registry.readTranscript({
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
            registry.searchConversations({
              query: str(args.query) ?? '',
              ...(str(args.projectPath) ? { projectPath: str(args.projectPath) } : {}),
              limit: 15,
            }),
          ),
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
          const r = await registry.repoOp(op, str(args.cwd) ?? '')
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
          const r = await registry.repoOp('worktreeAdd', repoPath, { path, branch })
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
    return tools
  }
}

type Args = Record<string, unknown>

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

/**
 * Map a free-text answer to 1-based option indices for one AskUserQuestion:
 * bare number(s) win ("2", "1,3"), then a case-insensitive exact label match,
 * then a UNIQUE case-insensitive substring match. Empty result = no match.
 */
export function matchAnswerToOptions(answer: string, labels: string[]): number[] {
  const t = answer.trim()
  if (/^\d+(\s*,\s*\d+)*$/.test(t)) {
    const idx = t.split(',').map((s) => Number.parseInt(s.trim(), 10))
    return idx.every((n) => n >= 1 && n <= labels.length) ? idx : []
  }
  const lower = t.toLowerCase()
  const exact = labels.findIndex((l) => l.trim().toLowerCase() === lower)
  if (exact !== -1) return [exact + 1]
  const subs = labels.flatMap((l, i) => (l.toLowerCase().includes(lower) ? [i + 1] : []))
  return subs.length === 1 ? subs : []
}

function parseArgs(raw: string): Args {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Args) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function isAgentKind(
  v: unknown,
): v is 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor' | 'shell' {
  return (
    v === 'claude-code' ||
    v === 'codex' ||
    v === 'grok' ||
    v === 'opencode' ||
    v === 'cursor' ||
    v === 'shell'
  )
}

function renderTranscriptItem(item: TranscriptItem): string {
  if (item.role === 'tool') {
    if (item.toolName) return `[tool ${item.toolName}] ${item.toolInput ?? ''}`
    return `[result] ${(item.toolResult ?? '').slice(0, 300)}`
  }
  return `${item.role}: ${item.text.slice(0, 600)}`
}
