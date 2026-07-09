# Agent Conversation Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a metadata-first local conversation finder in `@podium/agent-bridge` that discovers Codex and Claude Code sessions, enriches summaries with native metadata where available, and lazy-loads full transcript content on demand.

**Architecture:** Implement provider-based discovery under `packages/agent-bridge/src/discovery`. Providers own agent-specific storage knowledge: Codex reads `sessions/**/*.jsonl` plus optional `state_*.sqlite` metadata; Claude Code reads top-level `projects/*/*.jsonl` conversations plus nested `projects/*/<session>/subagents/*.jsonl` child conversations. The scanner orchestrates providers, resolves default and extra roots, dedupes by canonical source path, sorts newest first, and routes lazy loading through each summary's provider.

**Tech Stack:** TypeScript ESM · Node `fs/promises`, `path`, and optional dynamic `node:sqlite` for Codex metadata · Vitest · Bun task runner. No new package dependency is required.

**Source spec:** `docs/superpowers/specs/2026-06-01-agent-conversation-scanner-design.md`

---

## File Structure

- `packages/agent-bridge/src/discovery/types.ts` — public scanner/provider types, richer metadata fields, and `AgentConversationLoadError`.
- `packages/agent-bridge/src/discovery/jsonl.ts` — JSONL parsing, role normalization, content normalization, and safe record helpers.
- `packages/agent-bridge/src/discovery/paths.ts` — `~` expansion, path existence, canonical paths, sorted file listing, and fixture-safe root handling.
- `packages/agent-bridge/src/discovery/providers/codex-state.ts` — optional Codex `state_*.sqlite` metadata reader for titles, git metadata, archive hints, resume refs, and parent/child edges.
- `packages/agent-bridge/src/discovery/providers/codex.ts` — Codex provider merging JSONL transcript summaries with optional SQLite metadata.
- `packages/agent-bridge/src/discovery/providers/claude-code.ts` — Claude Code provider for top-level project transcripts and nested subagent child transcripts.
- `packages/agent-bridge/src/discovery/scanner.ts` — public scan/load orchestration and built-in provider registration.
- `packages/agent-bridge/src/discovery/index.ts` — discovery module barrel export.
- `packages/agent-bridge/src/index.ts` — package public exports.
- `packages/agent-bridge/src/**/*.test.ts` — focused Vitest tests using temporary fixture directories only.
- `packages/agent-bridge/README.md` — document defaults, extra roots, metadata enrichment, child conversations, diagnostics, and lazy loading.

Conscious v1 scope decisions:

- Codex JSONL is the transcript source. Codex SQLite is metadata enrichment only and must never be required for transcript discovery.
- Codex `history.jsonl`, `logs_*.sqlite`, `goals_*.sqlite`, and `memories_*.sqlite` are not parsed in v1.
- Claude Code top-level project JSONL files are primary conversations. Nested `subagents/*.jsonl` files are child conversations with `parentConversationId`.
- Claude Code `tasks/*/*.json` is not parsed in v1; it remains a later task/status enrichment source.
- The finder does not generate summaries, embeddings, search indexes, or groupings. It exposes enough native metadata and lazy content loading for later index layers.
- Tests use temporary fixture directories and explicit `homeDir`; they never inspect the real user home.

---

## Task 1: Public Types and JSONL Helpers

**Files:**
- Create: `packages/agent-bridge/src/discovery/types.ts`
- Create: `packages/agent-bridge/src/discovery/jsonl.ts`
- Test: `packages/agent-bridge/src/discovery/jsonl.test.ts`

- [ ] **Step 1: Write the failing JSONL helper tests**

Create `packages/agent-bridge/src/discovery/jsonl.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { contentToText, dateField, mapConversationRole, parseJsonLines } from './jsonl.js'

const providerId = 'test-provider'
const path = '/fixtures/session.jsonl'

describe('parseJsonLines', () => {
  test('parses valid JSONL records and reports malformed lines as diagnostics', () => {
    const result = parseJsonLines('{"ok":true}\nnot-json\n{"ok":false}\n', {
      providerId,
      path,
      root: '/fixtures',
    })

    expect(result.records).toEqual([{ ok: true }, { ok: false }])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId,
        path,
        root: '/fixtures',
        message: 'Could not parse JSONL line 2 in /fixtures/session.jsonl',
      }),
    ])
  })
})

describe('mapConversationRole', () => {
  test('normalizes known agent roles into Podium roles', () => {
    expect(mapConversationRole('user')).toBe('user')
    expect(mapConversationRole('assistant')).toBe('assistant')
    expect(mapConversationRole('developer')).toBe('system')
    expect(mapConversationRole('system')).toBe('system')
    expect(mapConversationRole('tool')).toBe('tool')
    expect(mapConversationRole('unknown-role')).toBe('unknown')
    expect(mapConversationRole(undefined)).toBe('unknown')
  })
})

describe('contentToText', () => {
  test('normalizes string, text parts, tool results, and tool uses without serializing inputs', () => {
    expect(contentToText('hello')).toBe('hello')
    expect(
      contentToText([
        { type: 'text', text: 'first' },
        { type: 'tool_result', content: 'tool output' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/secret' } },
        { type: 'thinking', thinking: 'private reasoning' },
      ]),
    ).toBe('first\ntool output\n[tool_use:Read]')
  })
})

describe('dateField', () => {
  test('returns valid Date objects and ignores invalid dates', () => {
    expect(dateField({ timestamp: '2026-06-01T10:00:00.000Z' }, 'timestamp')?.toISOString()).toBe(
      '2026-06-01T10:00:00.000Z',
    )
    expect(dateField({ timestamp: 'not-a-date' }, 'timestamp')).toBeUndefined()
    expect(dateField({ timestamp: 123 }, 'timestamp')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the helper tests and verify they fail because the module does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/jsonl.test.ts
```

Expected: FAIL with an import error for `./jsonl.js`.

- [ ] **Step 3: Add the shared public and provider types**

Create `packages/agent-bridge/src/discovery/types.ts`:

```ts
export type AgentKind = 'codex' | 'claude-code'

export type AgentConversationRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown'

export type AgentConversationTitleSource = 'native' | 'filename' | 'path' | 'heuristic'

export type AgentConversationStatusHint =
  | 'unknown'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'archived'

export type ScanAgentConversationsOptions = {
  agents?: readonly AgentKind[]
  includeDefaults?: boolean
  extraRoots?: Partial<Record<AgentKind, readonly string[]>>
  homeDir?: string
}

export type AgentConversationSource = {
  providerId: string
  root: string
  path: string
  relatedPaths?: string[]
}

export type AgentConversationGitMetadata = {
  branch?: string
  sha?: string
  originUrl?: string
}

export type AgentConversationResumeRef = {
  kind: string
  value: string
}

export type AgentConversationSummary = {
  id: string
  agentKind: AgentKind
  title?: string
  titleSource?: AgentConversationTitleSource
  projectPath?: string
  parentConversationId?: string
  statusHint?: AgentConversationStatusHint
  createdAt?: Date
  updatedAt?: Date
  messageCount?: number
  git?: AgentConversationGitMetadata
  resume?: AgentConversationResumeRef
  source: AgentConversationSource
}

export type AgentConversationMessage = {
  role: AgentConversationRole
  content: string
  createdAt?: Date
  raw?: unknown
}

export type AgentConversation = AgentConversationSummary & {
  messages: AgentConversationMessage[]
  raw?: unknown
}

export type AgentConversationDiagnostic = {
  severity: 'warning' | 'error'
  providerId?: string
  root?: string
  path?: string
  message: string
  cause?: unknown
}

export type ScanAgentConversationsResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}

export type ConversationProviderContext = {
  homeDir: string
}

export type ProviderScanResult = {
  conversations: AgentConversationSummary[]
  diagnostics: AgentConversationDiagnostic[]
}

export interface ConversationProvider {
  id: string
  agentKind: AgentKind
  defaultRoots(context: ConversationProviderContext): readonly string[]
  scanRoot(root: string): Promise<ProviderScanResult>
  loadConversation(summary: AgentConversationSummary): Promise<AgentConversation>
}

export class AgentConversationLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentConversationLoadError'
  }
}
```

- [ ] **Step 4: Add JSONL parsing and normalization helpers**

Create `packages/agent-bridge/src/discovery/jsonl.ts`:

```ts
import type {
  AgentConversationDiagnostic,
  AgentConversationRole,
} from './types.js'

type ParseJsonLinesContext = {
  providerId: string
  path: string
  root?: string
}

export function parseJsonLines(
  text: string,
  context: ParseJsonLinesContext,
): { records: unknown[]; diagnostics: AgentConversationDiagnostic[] } {
  const records: unknown[] = []
  const diagnostics: AgentConversationDiagnostic[] = []
  const lines = text.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    try {
      records.push(JSON.parse(trimmed) as unknown)
    } catch (cause) {
      diagnostics.push({
        severity: 'warning',
        providerId: context.providerId,
        root: context.root,
        path: context.path,
        message: `Could not parse JSONL line ${index + 1} in ${context.path}`,
        cause,
      })
    }
  }

  return { records, diagnostics }
}

export function mapConversationRole(role: unknown): AgentConversationRole {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return role
    case 'developer':
      return 'system'
    default:
      return 'unknown'
  }
}

export function contentToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return contentPartToText(value)

  return value
    .map(contentPartToText)
    .filter((part) => part.length > 0)
    .join('\n')
}

function contentPartToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''

  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return contentToText(value.content)

  if (value.type === 'tool_use' && typeof value.name === 'string') {
    return `[tool_use:${value.name}]`
  }

  return ''
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

export function dateField(value: Record<string, unknown>, key: string): Date | undefined {
  const field = stringField(value, key)
  if (!field) return undefined

  const date = new Date(field)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function dateFromEpochMillis(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function compactText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}
```

- [ ] **Step 5: Run the helper tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/jsonl.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/src/discovery/types.ts packages/agent-bridge/src/discovery/jsonl.ts packages/agent-bridge/src/discovery/jsonl.test.ts
git commit -m "feat(agent-bridge): add conversation discovery types and jsonl helpers"
```

---

## Task 2: Path Utilities and File Discovery

**Files:**
- Create: `packages/agent-bridge/src/discovery/paths.ts`
- Test: `packages/agent-bridge/src/discovery/paths.test.ts`

- [ ] **Step 1: Write the failing path tests**

Create `packages/agent-bridge/src/discovery/paths.test.ts`:

```ts
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { canonicalPath, expandHome, isDirectory, listFilesRecursive, pathExists } from './paths.js'

describe('expandHome', () => {
  test('expands tilde against the supplied home directory', () => {
    expect(expandHome('~/.codex', '/home/tester')).toBe('/home/tester/.codex')
    expect(expandHome('~', '/home/tester')).toBe('/home/tester')
    expect(expandHome('/var/data', '/home/tester')).toBe('/var/data')
  })
})

describe('pathExists and isDirectory', () => {
  test('return false for missing paths', async () => {
    expect(await pathExists('/definitely/not/here')).toBe(false)
    expect(await isDirectory('/definitely/not/here')).toBe(false)
  })
})

describe('canonicalPath', () => {
  test('resolves symlinks when possible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-paths-'))
    const target = join(root, 'target.jsonl')
    const link = join(root, 'link.jsonl')
    await writeFile(target, '{}\n')
    await symlink(target, link)

    expect(await canonicalPath(link)).toBe(await realpath(target))
  })
})

describe('listFilesRecursive', () => {
  test('lists accepted files in deterministic order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-list-'))
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'b.jsonl'), '{}\n')
    await writeFile(join(root, 'a.txt'), 'ignore')
    await writeFile(join(root, 'nested', 'a.jsonl'), '{}\n')

    await expect(listFilesRecursive(root, (file) => file.endsWith('.jsonl'))).resolves.toEqual([
      join(root, 'b.jsonl'),
      join(root, 'nested', 'a.jsonl'),
    ])
  })
})
```

- [ ] **Step 2: Run the path tests and verify they fail because the module does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/paths.test.ts
```

Expected: FAIL with an import error for `./paths.js`.

- [ ] **Step 3: Add path utilities**

Create `packages/agent-bridge/src/discovery/paths.ts`:

```ts
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

export function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/')) return join(homeDir, input.slice(2))
  return input
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

export async function canonicalPath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(path)

  try {
    return await realpath(absolute)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return absolute
    throw error
  }
}

export async function listFilesRecursive(
  root: string,
  accept: (filePath: string) => boolean,
): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && accept(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  await walk(root)
  return files
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
```

- [ ] **Step 4: Run the path tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/paths.ts packages/agent-bridge/src/discovery/paths.test.ts
git commit -m "feat(agent-bridge): add discovery path utilities"
```

---

## Task 3: Codex SQLite Metadata Reader

**Files:**
- Create: `packages/agent-bridge/src/discovery/providers/codex-state.ts`
- Test: `packages/agent-bridge/src/discovery/providers/codex-state.test.ts`

- [ ] **Step 1: Write the failing Codex state tests**

Create `packages/agent-bridge/src/discovery/providers/codex-state.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCodexStateMetadata } from './codex-state.js'

async function createCodexRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-codex-state-'))
  await mkdir(root, { recursive: true })
  return root
}

function createStateDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, archived, git_sha, git_branch, git_origin_url,
      first_user_message, preview, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'thread-1',
    'sessions/2026/06/01/thread-1.jsonl',
    1,
    2,
    'codex',
    'openai',
    '/repo/project',
    'Native Codex Title',
    '{}',
    'on-request',
    1,
    'abc123',
    'main',
    'git@example.com:repo.git',
    'first message',
    'native preview',
    Date.parse('2026-06-01T10:00:00.000Z'),
    Date.parse('2026-06-01T10:05:00.000Z'),
  )
  db.prepare(
    'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
  ).run('parent-thread', 'thread-1', 'completed')
  db.close()
}

describe('readCodexStateMetadata', () => {
  test('reads native thread metadata and parent relationships from state sqlite', async () => {
    const root = await createCodexRoot()
    createStateDb(join(root, 'state_5.sqlite'))

    const result = await readCodexStateMetadata(root)

    expect(result.diagnostics).toEqual([])
    expect(result.byThreadId.get('thread-1')).toEqual(
      expect.objectContaining({
        id: 'thread-1',
        title: 'Native Codex Title',
        rolloutPath: join(root, 'sessions/2026/06/01/thread-1.jsonl'),
        cwd: '/repo/project',
        archived: true,
        parentThreadId: 'parent-thread',
        createdAt: new Date('2026-06-01T10:00:00.000Z'),
        updatedAt: new Date('2026-06-01T10:05:00.000Z'),
        git: {
          branch: 'main',
          sha: 'abc123',
          originUrl: 'git@example.com:repo.git',
        },
      }),
    )
    expect(result.byRolloutPath.get(join(root, 'sessions/2026/06/01/thread-1.jsonl'))?.id).toBe(
      'thread-1',
    )
  })

  test('returns empty metadata when no state database exists', async () => {
    const root = await createCodexRoot()

    const result = await readCodexStateMetadata(root)

    expect(result.byThreadId.size).toBe(0)
    expect(result.byRolloutPath.size).toBe(0)
    expect(result.diagnostics).toEqual([])
  })
})
```

- [ ] **Step 2: Run the Codex state tests and verify they fail because the module does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/codex-state.test.ts
```

Expected: FAIL with an import error for `./codex-state.js`.

- [ ] **Step 3: Add Codex state metadata reader**

Create `packages/agent-bridge/src/discovery/providers/codex-state.ts`:

```ts
import { readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { compactText, dateFromEpochMillis, isRecord } from '../jsonl.js'
import type { AgentConversationDiagnostic, AgentConversationGitMetadata } from '../types.js'

type DatabaseSyncConstructor = new (
  path: string,
  options?: { readOnly?: boolean },
) => {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

export type CodexThreadMetadata = {
  id: string
  rolloutPath?: string
  title?: string
  preview?: string
  cwd?: string
  archived?: boolean
  parentThreadId?: string
  createdAt?: Date
  updatedAt?: Date
  git?: AgentConversationGitMetadata
}

export type CodexStateMetadataResult = {
  byThreadId: Map<string, CodexThreadMetadata>
  byRolloutPath: Map<string, CodexThreadMetadata>
  diagnostics: AgentConversationDiagnostic[]
}

export async function readCodexStateMetadata(root: string): Promise<CodexStateMetadataResult> {
  const diagnostics: AgentConversationDiagnostic[] = []
  const byThreadId = new Map<string, CodexThreadMetadata>()
  const byRolloutPath = new Map<string, CodexThreadMetadata>()
  const statePath = await findLatestStateDatabase(root)

  if (!statePath) return { byThreadId, byRolloutPath, diagnostics }

  let DatabaseSync: DatabaseSyncConstructor
  try {
    ;({ DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: DatabaseSyncConstructor })
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      providerId: 'codex-jsonl',
      root,
      path: statePath,
      message: 'Codex SQLite metadata could not be read because node:sqlite is unavailable',
      cause,
    })
    return { byThreadId, byRolloutPath, diagnostics }
  }

  let db: InstanceType<DatabaseSyncConstructor> | undefined
  try {
    db = new DatabaseSync(statePath, { readOnly: true })
    const threadRows = db.prepare('SELECT * FROM threads').all()
    const edgeRows = tableExists(db, 'thread_spawn_edges')
      ? db.prepare('SELECT * FROM thread_spawn_edges').all()
      : []
    const parentByChild = new Map<string, string>()

    for (const row of edgeRows) {
      if (!isRecord(row)) continue
      const child = stringFromRow(row, 'child_thread_id')
      const parent = stringFromRow(row, 'parent_thread_id')
      if (child && parent) parentByChild.set(child, parent)
    }

    for (const row of threadRows) {
      if (!isRecord(row)) continue
      const id = stringFromRow(row, 'id')
      if (!id) continue

      const rolloutPath = resolveRolloutPath(root, stringFromRow(row, 'rollout_path'))
      const metadata: CodexThreadMetadata = {
        id,
        rolloutPath,
        title: compactText(stringFromRow(row, 'title')),
        preview: compactText(stringFromRow(row, 'preview')),
        cwd: stringFromRow(row, 'cwd'),
        archived: numberFromRow(row, 'archived') === 1,
        parentThreadId: parentByChild.get(id),
        createdAt: dateFromEpochMillis(numberFromRow(row, 'created_at_ms')),
        updatedAt: dateFromEpochMillis(numberFromRow(row, 'updated_at_ms')),
        git: compactGit({
          branch: stringFromRow(row, 'git_branch'),
          sha: stringFromRow(row, 'git_sha'),
          originUrl: stringFromRow(row, 'git_origin_url'),
        }),
      }

      byThreadId.set(id, metadata)
      if (rolloutPath) byRolloutPath.set(rolloutPath, metadata)
    }
  } catch (cause) {
    diagnostics.push({
      severity: 'warning',
      providerId: 'codex-jsonl',
      root,
      path: statePath,
      message: 'Codex SQLite metadata could not be read',
      cause,
    })
  } finally {
    db?.close()
  }

  return { byThreadId, byRolloutPath, diagnostics }
}

async function findLatestStateDatabase(root: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return undefined
  }

  const candidates = entries
    .filter((entry) => /^state_\d+\.sqlite$/.test(entry))
    .sort((left, right) => stateVersion(right) - stateVersion(left))

  const first = candidates[0]
  return first ? join(root, first) : undefined
}

function stateVersion(fileName: string): number {
  return Number(fileName.match(/^state_(\d+)\.sqlite$/)?.[1] ?? 0)
}

function tableExists(db: InstanceType<DatabaseSyncConstructor>, tableName: string): boolean {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`).all()
  return rows.length > 0
}

function resolveRolloutPath(root: string, value: string | undefined): string | undefined {
  if (!value) return undefined
  return isAbsolute(value) ? value : join(root, value)
}

function stringFromRow(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberFromRow(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactGit(git: AgentConversationGitMetadata): AgentConversationGitMetadata | undefined {
  return git.branch || git.sha || git.originUrl ? git : undefined
}
```

- [ ] **Step 4: Run the Codex state tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/codex-state.test.ts
```

Expected: PASS. Node may print an experimental `node:sqlite` warning; the test still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/providers/codex-state.ts packages/agent-bridge/src/discovery/providers/codex-state.test.ts
git commit -m "feat(agent-bridge): read codex state metadata"
```

---

## Task 4: Codex Conversation Provider

**Files:**
- Create: `packages/agent-bridge/src/discovery/providers/codex.ts`
- Test: `packages/agent-bridge/src/discovery/providers/codex.test.ts`

- [ ] **Step 1: Write the failing Codex provider tests**

Create `packages/agent-bridge/src/discovery/providers/codex.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexConversationProvider } from './codex.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-codex-'))
}

async function writeCodexSession(root: string, relativePath: string, id = 'codex-session-1'): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({
        timestamp: '2026-06-01T10:00:00.000Z',
        type: 'session_meta',
        payload: { id, timestamp: '2026-06-01T10:00:00.000Z', cwd: '/repo/from-jsonl' },
      }),
      JSON.stringify({
        timestamp: '2026-06-01T10:01:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build scanner' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-01T10:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'scanner built' }],
        },
      }),
    ].join('\n'),
  )
  return file
}

function createStateDb(root: string): void {
  const db = new DatabaseSync(join(root, 'state_5.sqlite'))
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, archived, git_sha, git_branch, git_origin_url,
      first_user_message, preview, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'codex-session-1',
    'sessions/2026/06/01/session.jsonl',
    1,
    2,
    'codex',
    'openai',
    '/repo/from-sqlite',
    'Native Codex Title',
    '{}',
    'on-request',
    1,
    'abc123',
    'main',
    'git@example.com:repo.git',
    'first message',
    'native preview',
    Date.parse('2026-06-01T09:00:00.000Z'),
    Date.parse('2026-06-01T10:05:00.000Z'),
  )
  db.prepare(
    'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
  ).run('parent-thread', 'codex-session-1', 'completed')
  db.close()
}

describe('createCodexConversationProvider', () => {
  test('uses ~/.codex as the default root', () => {
    const provider = createCodexConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.codex'])
  })

  test('scans Codex session JSONL files and enriches summaries from state sqlite', async () => {
    const root = await createRoot()
    await writeCodexSession(root, 'sessions/2026/06/01/session.jsonl')
    createStateDb(root)

    const result = await createCodexConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: 'codex-session-1',
        agentKind: 'codex',
        title: 'Native Codex Title',
        titleSource: 'native',
        projectPath: '/repo/from-sqlite',
        parentConversationId: 'parent-thread',
        statusHint: 'archived',
        messageCount: 2,
        git: { branch: 'main', sha: 'abc123', originUrl: 'git@example.com:repo.git' },
        resume: { kind: 'codex-thread', value: 'codex-session-1' },
        source: expect.objectContaining({ providerId: 'codex-jsonl', root }),
      }),
    ])
    expect(result.conversations[0]).not.toHaveProperty('messages')
    expect(result.conversations[0]?.createdAt?.toISOString()).toBe('2026-06-01T09:00:00.000Z')
    expect(result.conversations[0]?.updatedAt?.toISOString()).toBe('2026-06-01T10:05:00.000Z')
  })

  test('loads full normalized Codex messages on demand', async () => {
    const root = await createRoot()
    await writeCodexSession(root, 'sessions/2026/06/01/session.jsonl')
    const provider = createCodexConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await provider.loadConversation(summary!)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'build scanner' }),
      expect.objectContaining({ role: 'assistant', content: 'scanner built' }),
    ])
    expect(conversation.raw).toEqual(expect.any(Array))
  })

  test('reports malformed candidate files without failing the whole root', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'sessions/2026/06/01'), { recursive: true })
    await writeFile(join(root, 'sessions/2026/06/01/bad.jsonl'), '{"ok":true}\nnot-json\n')

    const result = await createCodexConversationProvider().scanRoot(root)

    expect(result.conversations).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId: 'codex-jsonl',
        message: expect.stringContaining('Could not parse JSONL line 2'),
      }),
    ])
  })
})
```

- [ ] **Step 2: Run the Codex provider tests and verify they fail because the provider does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/codex.test.ts
```

Expected: FAIL with an import error for `./codex.js`.

- [ ] **Step 3: Add the Codex provider implementation**

Create `packages/agent-bridge/src/discovery/providers/codex.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  contentToText,
  dateField,
  isRecord,
  mapConversationRole,
  parseJsonLines,
  stringField,
} from '../jsonl.js'
import { canonicalPath, listFilesRecursive, pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationProvider,
  ProviderScanResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'
import { readCodexStateMetadata, type CodexThreadMetadata } from './codex-state.js'

export function createCodexConversationProvider(): ConversationProvider {
  return {
    id: 'codex-jsonl',
    agentKind: 'codex',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.codex')],
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const sessionsRoot = join(root, 'sessions')
  const state = await readCodexStateMetadata(root)
  if (!(await pathExists(sessionsRoot))) {
    return { conversations: [], diagnostics: state.diagnostics }
  }

  let files: string[]
  try {
    files = await listFilesRecursive(sessionsRoot, (file) => file.endsWith('.jsonl'))
  } catch (cause) {
    return {
      conversations: [],
      diagnostics: [
        ...state.diagnostics,
        { severity: 'error', providerId: 'codex-jsonl', root, message: 'Codex sessions directory cannot be read', cause },
      ],
    }
  }

  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = [...state.diagnostics]

  for (const file of files) {
    const parsed = await readCodexRecords(file, root)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.diagnostics.length > 0) continue

    const canonical = await canonicalPath(file)
    const metadata = state.byRolloutPath.get(canonical) ?? state.byRolloutPath.get(file)
    const summary = await summarizeCodexRecords(parsed.records, root, canonical, metadata)
    if (summary) conversations.push(summary)
  }

  return { conversations, diagnostics }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  let parsed: { records: unknown[]; diagnostics: AgentConversationDiagnostic[] }
  try {
    parsed = await readCodexRecords(summary.source.path, summary.source.root)
  } catch (cause) {
    throw new AgentConversationLoadError(
      `Could not load Codex conversation from ${summary.source.path}`,
      { cause },
    )
  }

  if (parsed.diagnostics.length > 0) {
    throw new AgentConversationLoadError(`Could not parse Codex conversation ${summary.source.path}`)
  }

  return { ...summary, messages: codexMessages(parsed.records), raw: parsed.records }
}

async function readCodexRecords(file: string, root: string): Promise<{
  records: unknown[]
  diagnostics: AgentConversationDiagnostic[]
}> {
  try {
    const text = await readFile(file, 'utf8')
    return parseJsonLines(text, { providerId: 'codex-jsonl', root, path: file })
  } catch (cause) {
    return {
      records: [],
      diagnostics: [
        { severity: 'warning', providerId: 'codex-jsonl', root, path: file, message: 'Codex session file cannot be read', cause },
      ],
    }
  }
}

async function summarizeCodexRecords(
  records: unknown[],
  root: string,
  file: string,
  metadata: CodexThreadMetadata | undefined,
): Promise<AgentConversationSummary | undefined> {
  const meta = records.map(codexPayload).find((payload) => stringField(payload, 'id'))
  const messages = codexMessages(records)
  if (!meta && !metadata && messages.length === 0) return undefined

  const id = metadata?.id ?? (meta ? stringField(meta, 'id') : undefined) ?? basename(file, '.jsonl')
  const dates = records.map(recordTimestamp).filter((date): date is Date => date !== undefined)

  return {
    id,
    agentKind: 'codex',
    title: metadata?.title ?? fallbackTitle(file),
    titleSource: metadata?.title ? 'native' : 'filename',
    projectPath: metadata?.cwd ?? (meta ? stringField(meta, 'cwd') : undefined),
    parentConversationId: metadata?.parentThreadId,
    statusHint: metadata?.archived ? 'archived' : 'unknown',
    createdAt: metadata?.createdAt ?? dates[0],
    updatedAt: metadata?.updatedAt ?? dates.at(-1),
    messageCount: messages.length,
    git: metadata?.git,
    resume: { kind: 'codex-thread', value: id },
    source: {
      providerId: 'codex-jsonl',
      root,
      path: file,
      relatedPaths: metadata?.rolloutPath && metadata.rolloutPath !== file ? [metadata.rolloutPath] : undefined,
    },
  }
}

function codexMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record)) continue
    const payload = codexPayload(record)
    if (payload.type !== 'message') continue

    messages.push({
      role: mapConversationRole(payload.role),
      content: contentToText(payload.content),
      createdAt: recordTimestamp(record),
      raw: record,
    })
  }

  return messages
}

function codexPayload(record: unknown): Record<string, unknown> {
  if (!isRecord(record)) return {}
  return isRecord(record.payload) ? record.payload : {}
}

function recordTimestamp(record: unknown): Date | undefined {
  if (!isRecord(record)) return undefined
  const timestamp = dateField(record, 'timestamp')
  if (timestamp) return timestamp
  return dateField(codexPayload(record), 'timestamp')
}

function fallbackTitle(file: string): string {
  return basename(file, '.jsonl')
}
```

- [ ] **Step 4: Run the Codex provider tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/codex.test.ts
```

Expected: PASS. Node may print an experimental `node:sqlite` warning; the test still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/providers/codex.ts packages/agent-bridge/src/discovery/providers/codex.test.ts
git commit -m "feat(agent-bridge): add codex conversation provider"
```

---

## Task 5: Claude Code Conversation Provider With Subagents

**Files:**
- Create: `packages/agent-bridge/src/discovery/providers/claude-code.ts`
- Test: `packages/agent-bridge/src/discovery/providers/claude-code.test.ts`

- [ ] **Step 1: Write the failing Claude Code provider tests**

Create `packages/agent-bridge/src/discovery/providers/claude-code.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createClaudeCodeConversationProvider } from './claude-code.js'

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-claude-'))
}

async function writeClaudeSession(root: string, relativePath: string, id = 'claude-session-1'): Promise<string> {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: 'Scanner work', sessionId: id }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-06-01T11:00:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'user', content: 'scan conversations' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-06-01T11:01:00.000Z',
        cwd: '/repo/project',
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: 'found conversations' }] },
      }),
    ].join('\n'),
  )
  return file
}

describe('createClaudeCodeConversationProvider', () => {
  test('uses ~/.claude as the default root', () => {
    const provider = createClaudeCodeConversationProvider()
    expect(provider.defaultRoots({ homeDir: '/home/tester' })).toEqual(['/home/tester/.claude'])
  })

  test('scans top-level project sessions and nested subagents with parent relationships', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/claude-session-1.jsonl')
    await writeClaudeSession(
      root,
      'projects/-repo-project/claude-session-1/subagents/agent-a.jsonl',
      'agent-a',
    )

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result.diagnostics).toEqual([])
    expect(result.conversations).toHaveLength(2)
    const parent = result.conversations.find((conversation) => conversation.id === 'claude-session-1')
    const child = result.conversations.find((conversation) => conversation.id === 'agent-a')

    expect(parent).toEqual(
      expect.objectContaining({
        id: 'claude-session-1',
        agentKind: 'claude-code',
        title: 'Scanner work',
        titleSource: 'native',
        projectPath: '/repo/project',
        messageCount: 2,
        resume: { kind: 'claude-session', value: 'claude-session-1' },
        source: expect.objectContaining({ providerId: 'claude-code-jsonl', root }),
      }),
    )
    expect(child).toEqual(
      expect.objectContaining({
        id: 'agent-a',
        agentKind: 'claude-code',
        parentConversationId: 'claude-session-1',
        titleSource: 'filename',
        source: expect.objectContaining({ providerId: 'claude-code-jsonl', root }),
      }),
    )
  })

  test('loads full normalized Claude Code messages on demand', async () => {
    const root = await createRoot()
    await writeClaudeSession(root, 'projects/-repo-project/claude-session-1.jsonl')
    const provider = createClaudeCodeConversationProvider()
    const scan = await provider.scanRoot(root)
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await provider.loadConversation(summary!)

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'scan conversations' }),
      expect.objectContaining({ role: 'assistant', content: 'found conversations' }),
    ])
    expect(conversation.raw).toEqual(expect.any(Array))
  })

  test('reports malformed project JSONL without failing the whole root', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'projects/-repo-project'), { recursive: true })
    await writeFile(join(root, 'projects/-repo-project/bad.jsonl'), '{"ok":true}\nnot-json\n')

    const result = await createClaudeCodeConversationProvider().scanRoot(root)

    expect(result.conversations).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        providerId: 'claude-code-jsonl',
        message: expect.stringContaining('Could not parse JSONL line 2'),
      }),
    ])
  })
})
```

- [ ] **Step 2: Run the Claude Code provider tests and verify they fail because the provider does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/claude-code.test.ts
```

Expected: FAIL with an import error for `./claude-code.js`.

- [ ] **Step 3: Add the Claude Code provider implementation**

Create `packages/agent-bridge/src/discovery/providers/claude-code.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { contentToText, dateField, isRecord, mapConversationRole, parseJsonLines, stringField } from '../jsonl.js'
import { canonicalPath, pathExists } from '../paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationMessage,
  AgentConversationSummary,
  ConversationProvider,
  ProviderScanResult,
} from '../types.js'
import { AgentConversationLoadError } from '../types.js'

export function createClaudeCodeConversationProvider(): ConversationProvider {
  return {
    id: 'claude-code-jsonl',
    agentKind: 'claude-code',
    defaultRoots: ({ homeDir }) => [join(homeDir, '.claude')],
    scanRoot,
    loadConversation,
  }
}

async function scanRoot(root: string): Promise<ProviderScanResult> {
  const projectsRoot = join(root, 'projects')
  if (!(await pathExists(projectsRoot))) return { conversations: [], diagnostics: [] }

  let files: ClaudeConversationFile[]
  try {
    files = await listClaudeConversationFiles(projectsRoot)
  } catch (cause) {
    return {
      conversations: [],
      diagnostics: [
        { severity: 'error', providerId: 'claude-code-jsonl', root, message: 'Claude Code projects directory cannot be read', cause },
      ],
    }
  }

  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = []

  for (const file of files) {
    const parsed = await readClaudeRecords(file.path, root)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.diagnostics.length > 0) continue

    const summary = await summarizeClaudeRecords(parsed.records, root, file)
    if (summary) conversations.push(summary)
  }

  return { conversations, diagnostics }
}

async function loadConversation(summary: AgentConversationSummary): Promise<AgentConversation> {
  let parsed: { records: unknown[]; diagnostics: AgentConversationDiagnostic[] }
  try {
    parsed = await readClaudeRecords(summary.source.path, summary.source.root)
  } catch (cause) {
    throw new AgentConversationLoadError(
      `Could not load Claude Code conversation from ${summary.source.path}`,
      { cause },
    )
  }

  if (parsed.diagnostics.length > 0) {
    throw new AgentConversationLoadError(`Could not parse Claude Code conversation ${summary.source.path}`)
  }

  return { ...summary, messages: claudeMessages(parsed.records), raw: parsed.records }
}

type ClaudeConversationFile = {
  path: string
  parentConversationId?: string
}

async function listClaudeConversationFiles(projectsRoot: string): Promise<ClaudeConversationFile[]> {
  const files: ClaudeConversationFile[] = []
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true })

  for (const projectDir of projectDirs.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!projectDir.isDirectory()) continue
    const projectPath = join(projectsRoot, projectDir.name)
    const entries = await readdir(projectPath, { withFileTypes: true })

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(projectPath, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path: fullPath })
      }
      if (entry.isDirectory()) {
        const subagentsDir = join(fullPath, 'subagents')
        if (!(await pathExists(subagentsDir))) continue
        const subagentEntries = await readdir(subagentsDir, { withFileTypes: true })
        for (const subagent of subagentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (subagent.isFile() && subagent.name.endsWith('.jsonl')) {
            files.push({ path: join(subagentsDir, subagent.name), parentConversationId: entry.name })
          }
        }
      }
    }
  }

  return files
}

async function readClaudeRecords(file: string, root: string): Promise<{
  records: unknown[]
  diagnostics: AgentConversationDiagnostic[]
}> {
  try {
    const text = await readFile(file, 'utf8')
    return parseJsonLines(text, { providerId: 'claude-code-jsonl', root, path: file })
  } catch (cause) {
    return {
      records: [],
      diagnostics: [
        { severity: 'warning', providerId: 'claude-code-jsonl', root, path: file, message: 'Claude Code conversation file cannot be read', cause },
      ],
    }
  }
}

async function summarizeClaudeRecords(
  records: unknown[],
  root: string,
  file: ClaudeConversationFile,
): Promise<AgentConversationSummary | undefined> {
  const messages = claudeMessages(records)
  const summaryRecord = records.find((record) => isRecord(record) && stringField(record, 'customTitle'))
  const sessionRecord = records.find((record) => isRecord(record) && stringField(record, 'sessionId'))
  if (messages.length === 0 && !summaryRecord) return undefined

  const dates = records.map(recordTimestamp).filter((date): date is Date => date !== undefined)
  const canonical = await canonicalPath(file.path)
  const summary = isRecord(summaryRecord) ? summaryRecord : undefined
  const session = isRecord(sessionRecord) ? sessionRecord : undefined
  const id = stringField(session ?? {}, 'sessionId') ?? basename(file.path, '.jsonl')

  return {
    id,
    agentKind: 'claude-code',
    title: summary ? stringField(summary, 'customTitle') : basename(file.path, '.jsonl'),
    titleSource: summary ? 'native' : 'filename',
    projectPath: firstProjectPath(records),
    parentConversationId: file.parentConversationId,
    statusHint: 'unknown',
    createdAt: dates[0],
    updatedAt: dates.at(-1),
    messageCount: messages.length,
    resume: { kind: 'claude-session', value: id },
    source: { providerId: 'claude-code-jsonl', root, path: canonical, relatedPaths: relatedMetaPath(canonical) },
  }
}

function claudeMessages(records: unknown[]): AgentConversationMessage[] {
  const messages: AgentConversationMessage[] = []

  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.message)) continue
    messages.push({
      role: mapConversationRole(record.message.role),
      content: contentToText(record.message.content),
      createdAt: recordTimestamp(record),
      raw: record,
    })
  }

  return messages
}

function firstProjectPath(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record)) continue
    const cwd = stringField(record, 'cwd')
    if (cwd) return cwd
  }
  return undefined
}

function recordTimestamp(record: unknown): Date | undefined {
  return isRecord(record) ? dateField(record, 'timestamp') : undefined
}

function relatedMetaPath(path: string): string[] | undefined {
  if (!basename(path).startsWith('agent-')) return undefined
  return [join(dirname(path), `${basename(path, '.jsonl')}.meta.json`)]
}
```

- [ ] **Step 4: Run the Claude Code provider tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/providers/claude-code.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/providers/claude-code.ts packages/agent-bridge/src/discovery/providers/claude-code.test.ts
git commit -m "feat(agent-bridge): add claude code conversation provider"
```

---

## Task 6: Scanner Orchestration and Lazy Loading

**Files:**
- Create: `packages/agent-bridge/src/discovery/scanner.ts`
- Create: `packages/agent-bridge/src/discovery/index.ts`
- Test: `packages/agent-bridge/src/discovery/scanner.test.ts`

- [ ] **Step 1: Write the failing scanner orchestration tests**

Create `packages/agent-bridge/src/discovery/scanner.test.ts`:

```ts
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadAgentConversation, scanAgentConversations } from './scanner.js'

async function createHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'podium-scan-home-'))
}

async function writeCodexFixture(root: string, id: string, timestamp: string): Promise<void> {
  const file = join(root, 'sessions/2026/06/01', `${id}.jsonl`)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({ timestamp, type: 'session_meta', payload: { id, timestamp, cwd: '/repo/codex' } }),
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: id }] },
      }),
    ].join('\n'),
  )
}

async function writeClaudeFixture(root: string, id: string, timestamp: string): Promise<void> {
  const file = join(root, 'projects/-repo-claude', `${id}.jsonl`)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: id, sessionId: id }),
      JSON.stringify({
        type: 'user',
        timestamp,
        cwd: '/repo/claude',
        sessionId: id,
        message: { role: 'user', content: id },
      }),
    ].join('\n'),
  )
}

describe('scanAgentConversations', () => {
  test('uses known default roots under the supplied home directory', async () => {
    const homeDir = await createHome()
    await writeCodexFixture(join(homeDir, '.codex'), 'codex-default', '2026-06-01T10:00:00.000Z')
    await writeClaudeFixture(join(homeDir, '.claude'), 'claude-default', '2026-06-01T11:00:00.000Z')

    const result = await scanAgentConversations({ homeDir })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations.map((conversation) => conversation.id)).toEqual([
      'claude-default',
      'codex-default',
    ])
  })

  test('disables defaults and scans explicit extra roots', async () => {
    const homeDir = await createHome()
    const codexExtra = join(homeDir, 'archive-codex')
    await writeCodexFixture(join(homeDir, '.codex'), 'codex-default', '2026-06-01T10:00:00.000Z')
    await writeCodexFixture(codexExtra, 'codex-extra', '2026-06-01T12:00:00.000Z')

    const result = await scanAgentConversations({
      homeDir,
      includeDefaults: false,
      extraRoots: { codex: [codexExtra] },
    })

    expect(result.conversations.map((conversation) => conversation.id)).toEqual(['codex-extra'])
  })

  test('filters providers by requested agent kind', async () => {
    const homeDir = await createHome()
    await writeCodexFixture(join(homeDir, '.codex'), 'codex-default', '2026-06-01T10:00:00.000Z')
    await writeClaudeFixture(join(homeDir, '.claude'), 'claude-default', '2026-06-01T11:00:00.000Z')

    const result = await scanAgentConversations({ homeDir, agents: ['codex'] })

    expect(result.conversations.map((conversation) => conversation.agentKind)).toEqual(['codex'])
  })

  test('skips missing roots without diagnostics and dedupes symlinked roots', async () => {
    const homeDir = await createHome()
    const codexRoot = join(homeDir, 'real-codex')
    const codexLink = join(homeDir, 'linked-codex')
    await writeCodexFixture(codexRoot, 'codex-one', '2026-06-01T10:00:00.000Z')
    await symlink(codexRoot, codexLink)

    const result = await scanAgentConversations({
      homeDir,
      includeDefaults: false,
      extraRoots: { codex: [codexRoot, codexLink, join(homeDir, 'missing-codex')] },
    })

    expect(result.diagnostics).toEqual([])
    expect(result.conversations.map((conversation) => conversation.id)).toEqual(['codex-one'])
  })
})

describe('loadAgentConversation', () => {
  test('loads a conversation summary through its recorded provider', async () => {
    const homeDir = await createHome()
    await writeCodexFixture(join(homeDir, '.codex'), 'codex-default', '2026-06-01T10:00:00.000Z')
    const scan = await scanAgentConversations({ homeDir, agents: ['codex'] })
    const summary = scan.conversations[0]
    expect(summary).toBeDefined()

    const conversation = await loadAgentConversation(summary!)

    expect(conversation.messages).toEqual([expect.objectContaining({ role: 'user', content: 'codex-default' })])
  })
})
```

- [ ] **Step 2: Run the scanner tests and verify they fail because the scanner does not exist**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/scanner.test.ts
```

Expected: FAIL with an import error for `./scanner.js`.

- [ ] **Step 3: Add scanner orchestration and discovery exports**

Create `packages/agent-bridge/src/discovery/scanner.ts`:

```ts
import { createClaudeCodeConversationProvider } from './providers/claude-code.js'
import { createCodexConversationProvider } from './providers/codex.js'
import { canonicalPath, expandHome, isDirectory } from './paths.js'
import type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationSummary,
  ConversationProvider,
  ScanAgentConversationsOptions,
  ScanAgentConversationsResult,
} from './types.js'
import { AgentConversationLoadError } from './types.js'

const builtInProviders = [
  createCodexConversationProvider(),
  createClaudeCodeConversationProvider(),
] satisfies ConversationProvider[]

export async function scanAgentConversations(
  options: ScanAgentConversationsOptions = {},
): Promise<ScanAgentConversationsResult> {
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd()
  const requestedAgents = new Set(
    options.agents ?? builtInProviders.map((provider) => provider.agentKind),
  )
  const includeDefaults = options.includeDefaults ?? true
  const conversations: AgentConversationSummary[] = []
  const diagnostics: AgentConversationDiagnostic[] = []
  const scannedRoots = new Set<string>()

  for (const provider of builtInProviders) {
    if (!requestedAgents.has(provider.agentKind)) continue

    const roots = [
      ...(includeDefaults ? provider.defaultRoots({ homeDir }) : []),
      ...(options.extraRoots?.[provider.agentKind] ?? []),
    ]

    for (const rootCandidate of roots) {
      const expandedRoot = expandHome(rootCandidate, homeDir)
      let root: string
      try {
        root = await canonicalPath(expandedRoot)
      } catch (cause) {
        diagnostics.push({
          severity: 'error',
          providerId: provider.id,
          root: expandedRoot,
          message: `Agent data root cannot be resolved: ${expandedRoot}`,
          cause,
        })
        continue
      }

      let rootIsDirectory: boolean
      try {
        rootIsDirectory = await isDirectory(root)
      } catch (cause) {
        diagnostics.push({
          severity: 'error',
          providerId: provider.id,
          root,
          message: `Agent data root cannot be inspected: ${root}`,
          cause,
        })
        continue
      }

      if (!rootIsDirectory) continue

      const dedupeKey = `${provider.id}:${root}`
      if (scannedRoots.has(dedupeKey)) continue
      scannedRoots.add(dedupeKey)

      const result = await provider.scanRoot(root)
      conversations.push(...result.conversations)
      diagnostics.push(...result.diagnostics)
    }
  }

  return {
    conversations: dedupeConversations(conversations).sort(compareConversations),
    diagnostics,
  }
}

export async function loadAgentConversation(
  summary: AgentConversationSummary,
): Promise<AgentConversation> {
  const provider = builtInProviders.find((candidate) => candidate.id === summary.source.providerId)
  if (!provider) {
    throw new AgentConversationLoadError(
      `No conversation provider is registered for ${summary.source.providerId}`,
    )
  }

  return await provider.loadConversation(summary)
}

function dedupeConversations(conversations: AgentConversationSummary[]): AgentConversationSummary[] {
  const bySource = new Map<string, AgentConversationSummary>()
  for (const conversation of conversations) {
    bySource.set(`${conversation.source.providerId}:${conversation.source.path}`, conversation)
  }
  return [...bySource.values()]
}

function compareConversations(left: AgentConversationSummary, right: AgentConversationSummary): number {
  const leftTime = timestampForSort(left)
  const rightTime = timestampForSort(right)
  if (leftTime !== rightTime) return rightTime - leftTime
  return left.source.path.localeCompare(right.source.path)
}

function timestampForSort(conversation: AgentConversationSummary): number {
  return conversation.updatedAt?.getTime() ?? conversation.createdAt?.getTime() ?? 0
}
```

Create `packages/agent-bridge/src/discovery/index.ts`:

```ts
export type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationGitMetadata,
  AgentConversationMessage,
  AgentConversationResumeRef,
  AgentConversationRole,
  AgentConversationSource,
  AgentConversationStatusHint,
  AgentConversationSummary,
  AgentConversationTitleSource,
  AgentKind,
  ConversationProvider,
  ConversationProviderContext,
  ProviderScanResult,
  ScanAgentConversationsOptions,
  ScanAgentConversationsResult,
} from './types.js'
export { AgentConversationLoadError } from './types.js'
export { loadAgentConversation, scanAgentConversations } from './scanner.js'
```

- [ ] **Step 4: Run scanner tests and verify they pass**

Run:

```bash
bun run test -- packages/agent-bridge/src/discovery/scanner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/discovery/scanner.ts packages/agent-bridge/src/discovery/index.ts packages/agent-bridge/src/discovery/scanner.test.ts
git commit -m "feat(agent-bridge): add agent conversation scanner"
```

---

## Task 7: Public Exports and README

**Files:**
- Modify: `packages/agent-bridge/src/index.ts`
- Modify: `packages/agent-bridge/README.md`
- Test: `packages/agent-bridge/src/index.test.ts`

- [ ] **Step 1: Write the failing public export test**

Create `packages/agent-bridge/src/index.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { AgentConversationLoadError, loadAgentConversation, scanAgentConversations } from './index.js'

describe('@podium/agent-bridge public exports', () => {
  test('exports the agent conversation scanner API', () => {
    expect(scanAgentConversations).toEqual(expect.any(Function))
    expect(loadAgentConversation).toEqual(expect.any(Function))
    expect(new AgentConversationLoadError('load failed').name).toBe('AgentConversationLoadError')
  })
})
```

- [ ] **Step 2: Run the public export test and verify it fails because exports are missing**

Run:

```bash
bun run test -- packages/agent-bridge/src/index.test.ts
```

Expected: FAIL because `scanAgentConversations`, `loadAgentConversation`, or `AgentConversationLoadError` are not exported from `src/index.ts`.

- [ ] **Step 3: Export the discovery API from the package entrypoint**

Replace `packages/agent-bridge/src/index.ts` with:

```ts
/**
 * @podium/agent-bridge
 *
 * Node library that wraps coding-agent CLIs and discovers local agent conversations.
 */
export type {
  AgentConversation,
  AgentConversationDiagnostic,
  AgentConversationGitMetadata,
  AgentConversationMessage,
  AgentConversationResumeRef,
  AgentConversationRole,
  AgentConversationSource,
  AgentConversationStatusHint,
  AgentConversationSummary,
  AgentConversationTitleSource,
  AgentKind,
  ConversationProvider,
  ConversationProviderContext,
  ProviderScanResult,
  ScanAgentConversationsOptions,
  ScanAgentConversationsResult,
} from './discovery/index.js'
export {
  AgentConversationLoadError,
  loadAgentConversation,
  scanAgentConversations,
} from './discovery/index.js'
```

- [ ] **Step 4: Document scanner usage in README**

Replace `packages/agent-bridge/README.md` with:

```md
# @podium/agent-bridge

The Node-side coding-agent bridge for Podium.

Current implementation: local conversation discovery for Codex and Claude Code. The
scanner is metadata-first: scanning returns summaries, and full message content is loaded
only when a caller explicitly asks for it.

Planned bridge responsibilities include PTY-backed session spawn/attach, resize,
streaming output, input injection, controller/spectator multi-client control, transcript
extraction, and CLI discovery.

## Conversation Discovery

```ts
import { loadAgentConversation, scanAgentConversations } from '@podium/agent-bridge'

const result = await scanAgentConversations({
  extraRoots: {
    codex: ['/mnt/archive/.codex'],
    'claude-code': ['/mnt/archive/.claude'],
  },
})

for (const summary of result.conversations) {
  console.log(summary.agentKind, summary.title, summary.updatedAt, summary.parentConversationId)
}

const conversation = await loadAgentConversation(result.conversations[0])
console.log(conversation.messages)
```

Defaults:

- Codex: `~/.codex`, scanning `sessions/**/*.jsonl` and enriching from `state_*.sqlite`
  when present.
- Claude Code: `~/.claude`, scanning top-level `projects/*/*.jsonl` and nested
  `projects/*/<session>/subagents/*.jsonl` child conversations.

`extraRoots` are additional agent data directories for the selected provider. They do not
trigger a broad filesystem crawl. Missing roots are skipped. Malformed candidate files and
unreadable roots are returned as diagnostics on the scan result.

The scanner does not generate summaries, embeddings, search indexes, or groupings. It
preserves native metadata and source references so a later indexing layer can build those
features.
```

- [ ] **Step 5: Run the public export test and verify it passes**

Run:

```bash
bun run test -- packages/agent-bridge/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/src/index.ts packages/agent-bridge/src/index.test.ts packages/agent-bridge/README.md
git commit -m "docs(agent-bridge): export and document conversation scanner"
```

---

## Task 8: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all focused agent-bridge tests**

Run:

```bash
bun run test -- packages/agent-bridge/src
```

Expected: PASS for helper tests, path tests, Codex state tests, provider tests, scanner tests, and public export tests. Node may print an experimental `node:sqlite` warning in SQLite tests.

- [ ] **Step 2: Run the package typecheck**

Run:

```bash
bun run --filter '@podium/agent-bridge' typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the package build**

Run:

```bash
bun run --filter '@podium/agent-bridge' build
```

Expected: PASS and `packages/agent-bridge/dist` is emitted by tsup.

- [ ] **Step 4: Run repository lint**

Run:

```bash
bun run lint
```

Expected: PASS with no Biome diagnostics.

- [ ] **Step 5: Run repository tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 6: Commit verification-only formatting changes if any exist**

If Biome formatting changed files, run:

```bash
git add packages/agent-bridge/src packages/agent-bridge/README.md
git commit -m "chore(agent-bridge): format conversation scanner implementation"
```

Expected: commit is created only if formatting changed tracked files.

---

## Self-Review Notes

Spec coverage:

- Known defaults are covered by provider tests and scanner tests.
- Caller-provided extra roots are covered by scanner tests.
- Missing roots, malformed files, dedupe, sorting, provider filtering, and lazy loading are covered by scanner/provider tests.
- Metadata-first scanning is covered by provider tests asserting summaries do not contain `messages`.
- Codex SQLite metadata enrichment is covered by `codex-state.test.ts` and `codex.test.ts`.
- Claude Code child subagent discovery is covered by `claude-code.test.ts`.
- Summaries/search/grouping are explicitly out of scope for this finder; the README and source spec say those belong to a later indexing layer.

Type consistency:

- Public types match the approved spec and add `homeDir` to `ScanAgentConversationsOptions` for deterministic tests and explicit default-root resolution.
- Provider IDs are `codex-jsonl` and `claude-code-jsonl` throughout tests and implementation snippets.
- `titleSource`, `statusHint`, `git`, `resume`, `parentConversationId`, and `source.relatedPaths` are best-effort metadata fields on `AgentConversationSummary`.
