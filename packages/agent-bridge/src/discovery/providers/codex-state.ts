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
