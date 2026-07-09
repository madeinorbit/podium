/**
 * Superagent aggregate — owns `superagent_threads` and `superagent_messages`
 * (the 'global' orchestrator thread, per-session 'btw' threads and per-repo
 * 'concierge' intake threads).
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { parseJsonColumn } from './helpers'
import type { SuperagentMessageRow, SuperagentThreadRow, ToolCallRow } from './types'

export class SuperagentRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Per-boot heal: idempotent seed of the always-there 'global' thread. */
  seedGlobalThread(): void {
    const saNow = new Date().toISOString()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO superagent_threads (id, kind, created_at, updated_at)
         VALUES ('global', 'global', ?, ?)`,
      )
      .run(saNow, saNow)
  }

  loadSuperagentMessages(threadId = 'global', limit = 200): SuperagentMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, tool_calls, tool_call_id, tool_name, created_at
         FROM superagent_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(threadId, limit) as Record<string, unknown>[]
    return rows.reverse().map((r) => ({
      id: r.id as number,
      role: r.role as SuperagentMessageRow['role'],
      content: r.content as string,
      toolCalls: parseJsonColumn<ToolCallRow[]>(
        r.tool_calls,
        `superagent msg ${String(r.id)} tool_calls`,
      ),
      toolCallId: (r.tool_call_id as string | null) ?? undefined,
      toolName: (r.tool_name as string | null) ?? undefined,
      createdAt: r.created_at as string,
    }))
  }

  appendSuperagentMessage(
    threadId: string,
    m: Omit<SuperagentMessageRow, 'id' | 'createdAt'>,
  ): SuperagentMessageRow {
    const createdAt = new Date().toISOString()
    const result = this.db
      .prepare(
        `INSERT INTO superagent_messages
           (thread_id, role, content, tool_calls, tool_call_id, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        m.role,
        m.content,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
        m.toolName ?? null,
        createdAt,
      )
    this.db
      .prepare('UPDATE superagent_threads SET updated_at = ? WHERE id = ?')
      .run(createdAt, threadId)
    return { ...m, id: Number(result.lastInsertRowid), createdAt }
  }

  clearSuperagentMessages(threadId = 'global'): void {
    this.db.prepare('DELETE FROM superagent_messages WHERE thread_id = ?').run(threadId)
  }

  listSuperagentThreads(): SuperagentThreadRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM superagent_threads WHERE archived = 0 ORDER BY updated_at DESC`)
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.mapSuperagentThread(r))
  }

  getSuperagentThread(id: string): SuperagentThreadRow | undefined {
    const r = this.db.prepare('SELECT * FROM superagent_threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.mapSuperagentThread(r) : undefined
  }

  upsertSuperagentThread(t: {
    id: string
    kind: 'global' | 'btw' | 'concierge'
    originSessionId?: string
    repoPath?: string
    title?: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO superagent_threads (id, kind, origin_session_id, repo_path, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, title), archived = 0, updated_at = ?`,
      )
      .run(
        t.id,
        t.kind,
        t.originSessionId ?? null,
        t.repoPath ?? null,
        t.title ?? null,
        now,
        now,
        now,
      )
  }

  setThreadWatermark(id: string, itemId: string, ts: string | undefined): void {
    this.db
      .prepare('UPDATE superagent_threads SET watermark_item_id = ?, watermark_ts = ? WHERE id = ?')
      .run(itemId, ts ?? null, id)
  }

  /** Patch the headless-session binding columns on a thread. Only the fields
   *  present in `patch` are written; `terminalSessionId: null` clears the
   *  terminal one-writer lock. */
  updateSuperagentThreadBinding(
    id: string,
    patch: {
      agentKind?: string
      // null clears the binding — used on a harness switch to force a fresh
      // session on the next turn (#199).
      podiumSessionId?: string | null
      harnessSessionId?: string | null
      terminalSessionId?: string | null
    },
  ): void {
    const sets: string[] = []
    const args: (string | null)[] = []
    if (patch.agentKind !== undefined) {
      sets.push('agent_kind = ?')
      args.push(patch.agentKind)
    }
    if (patch.podiumSessionId !== undefined) {
      sets.push('podium_session_id = ?')
      args.push(patch.podiumSessionId)
    }
    if (patch.harnessSessionId !== undefined) {
      sets.push('harness_session_id = ?')
      args.push(patch.harnessSessionId)
    }
    if (patch.terminalSessionId !== undefined) {
      sets.push('terminal_session_id = ?')
      args.push(patch.terminalSessionId)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    args.push(new Date().toISOString())
    this.db
      .prepare(`UPDATE superagent_threads SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  }

  archiveSuperagentThread(id: string): void {
    this.db.prepare('UPDATE superagent_threads SET archived = 1 WHERE id = ?').run(id)
  }

  private mapSuperagentThread(r: Record<string, unknown>): SuperagentThreadRow {
    return {
      id: r.id as string,
      kind: r.kind as 'global' | 'btw' | 'concierge',
      originSessionId: (r.origin_session_id as string | null) ?? undefined,
      repoPath: (r.repo_path as string | null) ?? undefined,
      title: (r.title as string | null) ?? undefined,
      watermarkItemId: (r.watermark_item_id as string | null) ?? undefined,
      watermarkTs: (r.watermark_ts as string | null) ?? undefined,
      agentKind: (r.agent_kind as string | null) ?? undefined,
      podiumSessionId: (r.podium_session_id as string | null) ?? undefined,
      harnessSessionId: (r.harness_session_id as string | null) ?? undefined,
      terminalSessionId: (r.terminal_session_id as string | null) ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      archived: Boolean(r.archived),
    }
  }
}
