import type { TranscriptItem } from '@podium/protocol'
import { createIssue, moveIssue, searchIssues } from './linear'
import { LlmConfigError, type LlmMessage, type LlmTool, llmClient } from './llm'
import type { SessionRegistry } from './relay'
import type { RepoRegistry } from './repo-registry'
import type { SessionStore, SuperagentMessageRow } from './store'

const MAX_TOOL_ROUNDS = 8
const HISTORY_WINDOW = 40

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
- Worker agents you start run interactively on the user's subscriptions; only YOUR reasoning is
  metered. Prefer delegating real coding work to a worker agent in the right worktree.
- Be concise. Use tools instead of guessing about repos, sessions, or history.
- @-references in the user's message (e.g. "@podium(/home/u/src/podium)") name repos, worktrees,
  or conversations the user picked from a context menu — the parenthesized part is the path/id.
- When you start an agent, tell the user its session name and where it runs.
- Destructive actions (killing sessions) only when clearly asked.`

export interface SuperagentTurn {
  messages: SuperagentMessageRow[]
  backendLabel: string
}

/**
 * The always-there orchestrator. One global thread, persisted in SQLite. The
 * API-backed mode gets the full tool belt; the harness-backed mode (codex
 * subscription) is chat-only — the daemon runs one-shot \`codex exec\`/\`claude -p\`.
 */
export class SuperagentService {
  // Serialized: a second send while a turn runs waits — tools mutate shared state.
  private busy: Promise<void> = Promise.resolve()

  constructor(
    private readonly registry: SessionRegistry,
    private readonly repos: RepoRegistry,
    private readonly store: SessionStore,
  ) {}

  history(): SuperagentMessageRow[] {
    return this.store.loadSuperagentMessages()
  }

  clear(): void {
    this.store.clearSuperagentMessages()
  }

  async send(text: string): Promise<SuperagentTurn> {
    let release: () => void = () => {}
    const prev = this.busy
    this.busy = new Promise((r) => {
      release = r
    })
    await prev
    try {
      return await this.runTurn(text)
    } finally {
      release()
    }
  }

  private async runTurn(text: string): Promise<SuperagentTurn> {
    const settings = this.store.getSettings()
    const backend = settings.superagent
    const newMessages: SuperagentMessageRow[] = []
    const record = (m: Omit<SuperagentMessageRow, 'id' | 'createdAt'>): SuperagentMessageRow => {
      const saved = this.store.appendSuperagentMessage(m)
      newMessages.push(saved)
      return saved
    }
    record({ role: 'user', content: text })

    if (backend.kind === 'harness') {
      const prompt = this.renderHarnessPrompt(text)
      const result = await this.registry.harnessExec({
        agent: backend.harnessAgent,
        model: backend.harnessModel,
        prompt,
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

    const tools = this.tools(settings.integrations.linearApiKey)
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.historyAsLlm(),
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

  private historyAsLlm(): LlmMessage[] {
    const rows = this.store.loadSuperagentMessages(HISTORY_WINDOW)
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

  /** Harness mode is one-shot: fold recent history into a single prompt. */
  private renderHarnessPrompt(latest: string): string {
    const rows = this.store
      .loadSuperagentMessages(12)
      .filter((r) => r.role === 'user' || r.role === 'assistant')
    const history = rows
      .slice(0, -1)
      .map((r) => `${r.role === 'user' ? 'User' : 'You'}: ${r.content}`)
      .join('\n\n')
    return `${SYSTEM_PROMPT}\n\n(You are running without tools in this mode — answer from reasoning; suggest concrete next steps the user can click in Podium.)\n\n${history ? `Conversation so far:\n${history}\n\n` : ''}User: ${latest}`
  }

  private tools(linearKey: string): { spec: LlmTool; run: (args: Args) => Promise<string> }[] {
    const registry = this.registry
    const repos = this.repos
    const tools: { spec: LlmTool; run: (args: Args) => Promise<string> }[] = [
      {
        spec: {
          name: 'list_sessions',
          description:
            'List all agent/shell sessions: id, name, kind, cwd, status, agent phase, last activity.',
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
            'Start a new interactive agent (or shell) session in a directory. Runs on the user subscription.',
          parameters: {
            type: 'object',
            properties: {
              agentKind: { type: 'string', enum: ['claude-code', 'codex', 'grok', 'shell'] },
              cwd: { type: 'string', description: 'absolute worktree/repo path' },
              name: { type: 'string', description: 'optional display name' },
              firstMessage: {
                type: 'string',
                description: 'optional prompt typed into the agent once it starts',
              },
            },
            required: ['agentKind', 'cwd'],
          },
        },
        run: async (args) => {
          const agentKind = str(args.agentKind)
          const cwd = str(args.cwd)
          if (!cwd || !isAgentKind(agentKind)) return 'invalid agentKind/cwd'
          const { sessionId } = registry.createSession({ agentKind, cwd })
          if (str(args.name)) registry.renameSession({ sessionId, name: str(args.name) ?? '' })
          const first = str(args.firstMessage)
          if (first) {
            // Deliver once the CLI is actually up; drops itself if the spawn fails.
            registry.sendTextWhenReady(sessionId, first)
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
          name: 'read_transcript',
          description: "Read the tail of a session's structured transcript (live sessions).",
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
          const items = registry.transcriptFor(str(args.sessionId) ?? '').slice(-lastN)
          if (items.length === 0) return '(no transcript buffered for this session)'
          return items.map(renderTranscriptItem).join('\n')
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
function isAgentKind(v: unknown): v is 'claude-code' | 'codex' | 'grok' | 'shell' {
  return v === 'claude-code' || v === 'codex' || v === 'grok' || v === 'shell'
}

function renderTranscriptItem(item: TranscriptItem): string {
  if (item.role === 'tool') {
    if (item.toolName) return `[tool ${item.toolName}] ${item.toolInput ?? ''}`
    return `[result] ${(item.toolResult ?? '').slice(0, 300)}`
  }
  return `${item.role}: ${item.text.slice(0, 600)}`
}
