# Agent Conversation Scanner Design

- **Date:** 2026-06-01
- **Status:** Approved design, pending written-spec review
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

## 2. Non-goals

- No broad hard-disk crawl.
- No indexing or full-text search.
- No server persistence.
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
  projectPath?: string
  createdAt?: Date
  updatedAt?: Date
  messageCount?: number
  source: {
    providerId: string
    root: string
    path: string
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
  severity: "warning" | "error"
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
- scanning returns summaries without full messages,
- loading returns normalized messages,
- provider selection limits results to requested agents.

## 12. Success Criteria

- `@podium/agent-bridge` exports the scanner API and related types.
- Codex and Claude Code providers can discover fixture conversations from their data
  roots.
- Scanning returns metadata summaries and diagnostics.
- Full message content is loaded only through the explicit load API.
- The package typechecks.
- Focused Vitest coverage passes.
