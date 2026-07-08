import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { compactText, dateFromEpochMillis, isRecord } from '../jsonl.js'
import type { AgentConversationDiagnostic, AgentConversationGitMetadata } from '../types.js'

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

  let db: SqlDatabase | undefined
  try {
    db = openDatabase(statePath, { readOnly: true })
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

/**
 * A stateful `readCodexStateMetadata` whose expensive SQLite open+`SELECT *` is
 * skipped while the underlying `state_*.sqlite` file is unchanged. Built for the
 * ~700ms per-session title poller (`observeCodexState`), which otherwise re-opens
 * the state DB and re-reads every thread on every tick on the daemon event loop.
 *
 * The gate is the latest state DB's path + mtime: only when it advances (a Codex
 * write, e.g. a `/rename`) do we re-open and re-query, otherwise the previous
 * result is returned verbatim. The result handed back when content changes is
 * byte-identical to calling `readCodexStateMetadata` directly. On any uncertainty
 * — the latest-DB lookup or stat throws, or the prior read errored — we fall back
 * to a fresh uncached read so stale data is never served on doubt.
 *
 * NOTE: the returned result's Maps are the same objects across cache hits; callers
 * must treat them as read-only (the existing callers only read).
 *
 * `read` is injectable purely so tests can count the expensive reads; production
 * uses the default `readCodexStateMetadata`.
 */
export function createCodexStateMetadataReader(
  read: (root: string) => Promise<CodexStateMetadataResult> = readCodexStateMetadata,
): (root: string) => Promise<CodexStateMetadataResult> {
  let cachedRoot: string | undefined
  let cachedStatePath: string | undefined
  let cachedMtimeMs: number | undefined
  let cachedResult: CodexStateMetadataResult | undefined

  return async (root: string): Promise<CodexStateMetadataResult> => {
    let statePath: string | undefined
    let mtimeMs: number | undefined
    try {
      statePath = await findLatestStateDatabase(root)
      if (statePath) mtimeMs = (await stat(statePath)).mtimeMs
    } catch {
      // Couldn't resolve/stat the state DB — don't trust the cache; do a fresh
      // read (which handles a missing/unreadable DB itself) and don't memoize.
      return read(root)
    }

    // No DB to gate on yet (and the no-DB read is already cheap: a readdir that
    // finds nothing, no sqlite open). Never memoize it, so a DB that appears with
    // a coincidentally-equal mtime can't be missed.
    if (!statePath) return read(root)

    if (
      cachedResult !== undefined &&
      cachedRoot === root &&
      cachedStatePath === statePath &&
      cachedMtimeMs === mtimeMs
    ) {
      return cachedResult
    }

    const result = await read(root)
    cachedRoot = root
    cachedStatePath = statePath
    cachedMtimeMs = mtimeMs
    cachedResult = result
    return result
  }
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

function tableExists(db: SqlDatabase, tableName: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`)
    .all()
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
