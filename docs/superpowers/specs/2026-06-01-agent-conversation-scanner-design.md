# Agent Conversation Scanner Design

- **Date:** 2026-06-01
- **Status:** Approved design, updated with product goals
- **Scope:** A metadata-first local conversation scanner for Codex and Claude Code,
  implemented in `@podium/agent-bridge` and extensible to future agents.

---

## 1. Goal

Build a Node library API that discovers locally stored coding-agent conversations from
known agent data directories and caller-provided agent data directories.

The scanner should initially support Codex and Claude Code. It should be structured so
future agents can be added by registering another provider rather than rewriting the
scanner.

The scanner returns conversation metadata first. Full conversation content is loaded only
when a caller explicitly asks for it.

## Product Goals This Enables

This library is the local discovery foundation for a broader conversation index. It
should preserve enough native metadata and relationships for later layers to build:

- a unified history of all agent sessions across Codex, Claude Code, and future agents,
- recognizable titles for browsing old sessions,
- generated topic summaries and work-status summaries,
- grouping by goal, project, code area, touched files, or task intent,
- hybrid full-text and semantic search,
- read-only transcript viewing without starting an agent,
- resume affordances for conversations that the native agent can resume,
- future cross-agent restart or handoff flows.

The finder library does not generate summaries, embeddings, or groupings itself. It
should expose enough metadata, source references, and lazy transcript loading for an
indexing layer to do that work later.

## 2. Non-goals

- No broad hard-disk crawl.
- No indexing or full-text search.
- No server persistence.
- No generated summaries or embeddings.
- No UI.
- No agent process or PTY lifecycle changes.
- No writes to agent data directories.

## 3. Placement

The implementation lives in `packages/agent-bridge`, under a discovery-oriented module.
This matches `ARCHITECTURE.md`, which assigns harness, recent-conversation, project, and
worktree discovery to `@podium/agent-bridge`, with `apps/daemon` orchestrating it.

`@podium/agent-bridge` remains the public library boundary. `apps/daemon` can call the
scanner later, but the scanner itself must not depend on daemon code.

## 4. Public API

The scanner exposes a metadata-first API:

```ts
type AgentKind = 'codex' | 'claude-code'

type ScanAgentConversationsOptions = {
  agents?: AgentKind[]
  includeDefaults?: boolean
  extraRoots?: Partial<Record<AgentKind, string[]>>
}

type AgentConversationSummary = {
  id: string
  agentKind: AgentKind
  title?: string
  titleSource?: 'native' | 'filename' | 'path' | 'heuristic'
  projectPath?: string
  parentConversationId?: string
  statusHint?: 'unknown' | 'active' | 'completed' | 'blocked' | 'archived'
  createdAt?: Date
  updatedAt?: Date
  messageCount?: number
  git?: {
    branch?: string
    sha?: string
    originUrl?: string
  }
  resume?: {
    kind: string
    value: string
  }
  source: {
    providerId: string
    root: string
    path: string
    relatedPaths?: string[]
  }
}

type AgentConversationMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  content: string
  createdAt?: Date
  raw?: unknown
}

type AgentConversation = AgentConversationSummary & {
  messages: AgentConversationMessage[]
  raw?: unknown
}

type AgentConversationDiagnostic = {
  severity: 'warning' | 'error'
  providerId?: string
  root?: string
  path?: string
  message: string
  cause?: unknown
}

type ScanAgentConversationsResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}

async function scanAgentConversations(
  options?: ScanAgentConversationsOptions,
): Promise<ScanAgentConversationsResult>

async function loadAgentConversation(
  summary: AgentConversationSummary,
): Promise<AgentConversation>
```

Defaults:

- `includeDefaults` defaults to `true`.
- `agents` defaults to all built-in providers.
- `extraRoots` is additive. It does not replace defaults unless `includeDefaults` is
  explicitly `false`.

Fields such as `titleSource`, `statusHint`, `git`, `resume`, and `source.relatedPaths`
are best-effort. Providers should populate them when native agent metadata exposes them
cheaply, and omit them otherwise.

## 5. Provider Model

Each agent is implemented as a provider:

```ts
interface ConversationProvider {
  id: string
  agentKind: AgentKind
  defaultRoots(context: ConversationProviderContext): string[]
  scanRoot(root: string): Promise<ProviderScanResult>
  loadConversation(summary: AgentConversationSummary): Promise<AgentConversation>
}

type ConversationProviderContext = {
  homeDir: string
}

type ProviderScanResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}
```

Provider responsibilities:

- Know the agent's default data directories.
- Decide which files under an agent data directory are conversation files.
- Parse enough data during scan to produce summaries.
- Preserve native titles, previews, archive/status flags, parent/child relationships,
  resume references, and git/project metadata when available.
- Parse full content during load.
- Return diagnostics for malformed or unreadable files without failing the whole scan.

Scanner responsibilities:

- Select providers.
- Resolve default roots plus extra roots.
- Skip missing roots without diagnostics.
- Run provider scans.
- Deduplicate results.
- Sort results in a stable, useful order.
- Expose diagnostics without throwing for partial failures.

## Native Sources

Codex v1 sources:

- `~/.codex/sessions/**/*.jsonl` is the transcript source.
- `~/.codex/state_*.sqlite` is an optional metadata index. When present, use it to
  enrich summaries with native title, preview/status hints, cwd, git metadata, token
  counts, parent/child thread edges, and the JSONL transcript path.
- `~/.codex/history.jsonl` is prompt/input history, not a transcript source. It can be
  considered later as a recent-input or title signal.
- `~/.codex/logs_*.sqlite`, `goals_*.sqlite`, and `memories_*.sqlite` are derived or
  auxiliary stores. They are not required for v1 transcript discovery.

Claude Code v1 sources:

- `~/.claude/projects/*/*.jsonl` is the top-level transcript source.
- `~/.claude/projects/*/<session>/subagents/*.jsonl` should be discovered as child
  conversations when present, with `parentConversationId` set to the owning session.
- `~/.claude/tasks/*/*.json` is task-board state, not a transcript source. It can be
  used later to enrich work status, task subject/description, and dependency metadata.

## 6. Roots and Disk Access

The v1 scanner never performs a broad disk crawl.

Built-in defaults:

- Codex provider: `~/.codex`
- Claude Code provider: `~/.claude`

Callers can pass additional agent data directories:

```ts
await scanAgentConversations({
  extraRoots: {
    codex: ['/mnt/backup/.codex'],
    'claude-code': ['/Volumes/archive/.claude'],
  },
})
```

Additional directories are treated as agent data roots for the relevant provider, not as
generic filesystem crawl roots.

Root handling rules:

- Expand `~` against the supplied context home directory or `process.env.HOME`.
- Canonicalize real paths when possible.
- Ignore missing directories without emitting diagnostics.
- Report permission or parse failures as diagnostics.
- Do not write to any scanned directory.

## 7. Loading Model

Scanning reads only enough data to build `AgentConversationSummary` records. It should
avoid loading complete message content when a cheaper metadata parse is available.

Full content is loaded through `loadAgentConversation(summary)`. The summary carries the
provider and source path needed to route the load call to the correct provider.

If the source file disappears, becomes unreadable, or no longer parses, `loadAgentConversation`
throws a typed load error instead of returning partial content.

This design keeps discovery fast and limits accidental exposure of private message
content.

## 8. Diagnostics

Partial failures should not abort the whole scan. The result includes diagnostics such as:

- root cannot be read,
- candidate file cannot be parsed,
- provider does not recognize the file format.

Diagnostics include provider ID, root or file path, severity, and a short message.

## 9. Deduping and Ordering

The scanner deduplicates by provider ID plus canonical source file path. If canonical path
resolution fails, it falls back to the absolute normalized path.

Default ordering is newest first:

1. `updatedAt` descending when present,
2. `createdAt` descending when present,
3. source path ascending for deterministic output.

## 10. Extensibility

Future agents should be added by defining a new `ConversationProvider` and registering it
with the scanner.

The public API should also allow advanced callers to pass custom providers later, but v1
does not need to expose provider registration unless it falls out naturally from the
implementation. The key v1 requirement is that built-in Codex and Claude Code support use
the same provider abstraction.

## 11. Testing

Tests use fixture directories, never the real home directory.

Required coverage:

- default roots are used when `includeDefaults` is omitted,
- defaults can be disabled,
- extra roots are additive,
- missing roots do not fail the scan,
- malformed files produce diagnostics,
- duplicate roots or symlinked paths dedupe results,
- Codex SQLite metadata enriches JSONL summaries when present,
- Claude Code subagent JSONL files are linked to parent conversations,
- scanning returns summaries without full messages,
- loading returns normalized messages,
- provider selection limits results to requested agents.

## 12. Success Criteria

- `@podium/agent-bridge` exports the scanner API and related types.
- Codex and Claude Code providers can discover fixture conversations from their data
  roots.
- Scanning returns metadata summaries and diagnostics.
- Native metadata enriches summaries where available without making those metadata stores
  mandatory.
- Full message content is loaded only through the explicit load API.
- The package typechecks.
- Focused Vitest coverage passes.
